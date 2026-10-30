/**
 * Todoist, over its REST API v1 (https://developer.todoist.com/api/v1/).
 *
 * Out: every Catch task becomes a Todoist task in one project (default
 * "Catch", created if missing), labelled with its category's Todoist label,
 * with a real due date, the message draft and a link back.
 *
 * Back: `poll` notices tasks ticked (or deleted) in Todoist and completes
 * them in Catch, which is what moves the contact's follow-up clock. Without
 * it, ticking in Todoist would update nothing and Catch would slowly become
 * fiction.
 */
import type { Integration, IntegrationCall, TaskPayload } from "./types.ts";
import { IntegrationError } from "./types.ts";
import { localToUtc } from "../pipeline/dates.ts";
import { all, one } from "../db/db.ts";
import { completeTask } from "../pipeline/followups.ts";
import { enqueue } from "../jobs/queue.ts";

async function api<T>(call: IntegrationCall, method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const res = await call.ctx.fetch(`${call.ctx.config.todoistApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${call.config.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 401 || res.status === 403) {
    throw new IntegrationError("Todoist rejected the token. Paste a fresh one from Todoist → Settings → Integrations → Developer.", true);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new IntegrationError(`Todoist ${method} ${path} failed: HTTP ${res.status} ${text}`, res.status >= 400 && res.status < 500 && res.status !== 429);
  }
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
}

interface Page<T> {
  results: T[];
  next_cursor: string | null;
}

interface TodoistTask {
  id: string;
  content: string;
  checked?: boolean;
  is_deleted?: boolean;
  completed_at?: string | null;
  due?: { date: string } | null;
}

async function projectId(call: IntegrationCall): Promise<string> {
  const name = call.config.project?.trim() || "Catch";
  if (call.state.projectId && call.state.projectName === name) return String(call.state.projectId);
  let cursor: string | null = null;
  do {
    const page: { data: Page<{ id: string; name: string }> | null } = await api<Page<{ id: string; name: string }>>(
      call, "GET", `/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const data = page.data;
    const found = data?.results.find((p) => p.name === name);
    if (found) {
      call.state.projectId = found.id;
      call.state.projectName = name;
      return found.id;
    }
    cursor = data?.next_cursor ?? null;
  } while (cursor);
  const { data } = await api<{ id: string }>(call, "POST", "/projects", { name });
  if (!data?.id) throw new IntegrationError("Todoist did not return the new project");
  call.state.projectId = data.id;
  call.state.projectName = name;
  return data.id;
}

export function describeTask(task: TaskPayload): string {
  const lines: string[] = [];
  if (task.draft_message) lines.push(`**Draft:** ${task.draft_message}`);
  if (task.link) lines.push(`**Open:** ${task.link}`);
  if (task.contact) lines.push(`**Who:** ${task.contact.name} (${task.contact.stage})`);
  if (task.notes) lines.push(task.notes);
  lines.push(`[Open in Catch](${task.app_url})`);
  return lines.join("\n\n");
}

export const todoist: Integration = {
  kind: "todoist",
  label: "Todoist",
  description: "Every task Catch creates lands in Todoist with a label, a due date and the draft message. Ticking it in Todoist ticks it here.",
  fields: [
    { key: "token", label: "API token", type: "secret", required: true, help: "Todoist → Settings → Integrations → Developer → API token." },
    { key: "project", label: "Project", type: "text", required: false, placeholder: "Catch", help: "Created if it does not exist." },
  ],

  async test(call) {
    const id = await projectId(call);
    return `Connected. Tasks will go to project "${call.state.projectName}" (${id}).`;
  },

  async taskCreated(call, task) {
    const body: Record<string, unknown> = {
      content: task.title,
      description: describeTask(task),
      project_id: await projectId(call),
      priority: task.priority,
      labels: task.categoryLabel ? [task.categoryLabel] : [],
    };
    if (task.due_on && task.due_time) {
      body.due_datetime = localToUtc(task.due_on, task.due_time, call.user.timezone).toISOString().replace(/\.\d{3}Z$/, "Z");
    } else if (task.due_on) {
      body.due_date = task.due_on;
    }
    const { data } = await api<TodoistTask>(call, "POST", "/tasks", body);
    if (!data?.id) throw new IntegrationError("Todoist did not return a task id");
    // Post-condition: a task that silently lost its date is the bug this exists to catch.
    if (task.due_on && !data.due) {
      throw new IntegrationError(`Todoist created "${task.title}" without a due date (sent ${task.due_on}). Task id ${data.id}.`, true);
    }
    return data.id;
  },

  async taskClosed(call, task, externalId) {
    if (!externalId) return;
    if (task.status === "dismissed") {
      await api(call, "DELETE", `/tasks/${externalId}`);
    } else {
      await api(call, "POST", `/tasks/${externalId}/close`);
    }
  },

  async poll(call) {
    const { db } = call.ctx;
    const open = all<{ task_id: string; external_id: string }>(
      db,
      `SELECT d.object_id AS task_id, d.external_id FROM deliveries d JOIN tasks t ON t.id = d.object_id
       WHERE d.user_id = ? AND d.integration = 'todoist' AND d.object_type = 'task' AND d.status = 'sent' AND t.status = 'open'`,
      call.user.id,
    );
    if (open.length === 0) return;
    // One listing call for the common case (still open), one lookup per task
    // that is no longer active to find out whether it was ticked or deleted.
    const active = new Set<string>();
    let cursor: string | null = null;
    const project = await projectId(call);
    do {
      const page: { data: Page<TodoistTask> | null } = await api<Page<TodoistTask>>(
        call, "GET", `/tasks?project_id=${project}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const data = page.data;
      for (const t of data?.results ?? []) active.add(t.id);
      cursor = data?.next_cursor ?? null;
    } while (cursor);

    for (const row of open) {
      if (active.has(row.external_id)) continue;
      const { status, data } = await api<TodoistTask>(call, "GET", `/tasks/${row.external_id}`);
      if (status !== 404 && data && !data.checked && !data.is_deleted && !data.completed_at) continue; // moved project, still open
      const ticked = status !== 404 && !!data && (data.checked || !!data.completed_at) && !data.is_deleted;
      const changed = completeTask(db, row.task_id, { status: ticked ? "done" : "dismissed", source: "Todoist" });
      db.prepare("UPDATE deliveries SET status = 'closed', updated_at = ? WHERE integration = 'todoist' AND object_type = 'task' AND object_id = ?")
        .run(new Date().toISOString(), row.task_id);
      if (changed) enqueue(db, "deliver", { userId: call.user.id, event: "task.closed", objectId: row.task_id, skip: ["todoist"] });
    }
    const still = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open'", call.user.id);
    call.state.lastPollOpen = Number(still?.n ?? 0);
  },
};

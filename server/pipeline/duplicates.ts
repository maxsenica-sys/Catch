/**
 * Finding and removing duplicates that slipped in: the same DM screenshotted
 * twice, or a task Catch already had worded slightly differently.
 *
 * Deliberately conservative, because a wrong removal costs more than a
 * leftover duplicate:
 *
 *   - Tasks: open, for the SAME person (or both for nobody), with titles at
 *     least DUPLICATE_TASK_SIMILARITY alike by word overlap. The oldest is
 *     kept and absorbs the others' stated date (a said date beats a default;
 *     the earliest said date wins) and draft message. The
 *     copies are dismissed, not erased: they vanish from lists and from
 *     Todoist, but stay in the database as the record.
 *   - Captures: only when every screenshot is byte-for-byte identical to an
 *     earlier capture's. The later capture and its files go; the people and
 *     tasks it created stay (task copies are handled by the rule above).
 *   - People are never removed here. "Same person?" is the review queue's job.
 */
import type { Ctx, UserRow } from "../context.ts";
import { type DB, all, id, insert, nowIso, one, run, tx, update, parseJson } from "../db/db.ts";
import { enqueue } from "../jobs/queue.ts";
import { completeTask } from "./followups.ts";
import { DUPLICATE_TASK_SIMILARITY, titleSimilarity } from "./process.ts";

export interface TaskLite { id: string; title: string; due_on: string | null; due_source: string; draft_message: string | null; contact_name: string | null; created_at: string }
export interface CaptureLite { id: string; summary: string | null; created_at: string; images: number }

export interface DuplicateReport {
  tasks: { keep: TaskLite; remove: TaskLite[] }[];
  captures: { keep: CaptureLite; remove: CaptureLite[] }[];
}

export function findDuplicates(db: DB, userId: string): DuplicateReport {
  const tasks = all<TaskLite & { contact_id: string | null }>(
    db,
    `SELECT t.id, t.title, t.due_on, t.due_source, t.draft_message, t.contact_id, t.created_at, c.name AS contact_name
     FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
     WHERE t.user_id = ? AND t.status = 'open' ORDER BY t.created_at, t.id`,
    userId,
  );
  const taskGroups: DuplicateReport["tasks"] = [];
  const byContact = new Map<string, DuplicateReport["tasks"]>();
  for (const t of tasks) {
    const key = t.contact_id ?? "";
    const groups = byContact.get(key) ?? [];
    const group = groups.find((g) => titleSimilarity(g.keep.title, t.title) >= DUPLICATE_TASK_SIMILARITY);
    if (group) group.remove.push(t);
    else {
      const g = { keep: t, remove: [] as TaskLite[] };
      groups.push(g);
      taskGroups.push(g);
    }
    byContact.set(key, groups);
  }

  // A capture's fingerprint is the sorted hashes of its screenshots.
  const caps = all<{ id: string; summary: string | null; created_at: string; status: string; fp: string | null; images: number }>(
    db,
    `SELECT c.id, c.summary, c.created_at, c.status,
       (SELECT group_concat(sha256, ',') FROM (SELECT sha256 FROM capture_files f WHERE f.capture_id = c.id AND f.kind = 'image' ORDER BY sha256)) AS fp,
       (SELECT COUNT(*) FROM capture_files f WHERE f.capture_id = c.id AND f.kind = 'image') AS images
     FROM captures c WHERE c.user_id = ? ORDER BY c.created_at, c.id`,
    userId,
  );
  const capGroups = new Map<string, DuplicateReport["captures"][number]>();
  for (const c of caps) {
    // Only finished captures, and only ones with screenshots: an in-flight one
    // is still being read, and two voice-only captures are not "the same screenshot".
    if (!c.fp || !["done", "review", "failed"].includes(c.status)) continue;
    const g = capGroups.get(c.fp);
    const lite = { id: c.id, summary: c.summary, created_at: c.created_at, images: Number(c.images) };
    if (g) g.remove.push(lite);
    else capGroups.set(c.fp, { keep: lite, remove: [] });
  }

  return {
    tasks: taskGroups.filter((g) => g.remove.length > 0),
    captures: [...capGroups.values()].filter((g) => g.remove.length > 0),
  };
}

export interface CleanResult { tasks: number; captures: number }

export async function removeDuplicates(ctx: Ctx, user: UserRow): Promise<CleanResult> {
  const { db } = ctx;
  const report = findDuplicates(db, user.id);
  const closed: string[] = [];
  const files: string[] = [];
  tx(db, () => {
    for (const g of report.tasks) {
      // The keeper absorbs what the copies knew: the earliest stated date and a draft.
      const stated = [g.keep, ...g.remove].filter((t) => t.due_source === "stated" && t.due_on).map((t) => t.due_on!).sort();
      const patch: Record<string, unknown> = {};
      // A date someone said beats a default; among said dates, the earliest wins.
      if (stated[0] && (g.keep.due_source !== "stated" || !g.keep.due_on || stated[0] < g.keep.due_on)) {
        patch.due_on = stated[0];
        patch.due_source = "stated";
      }
      if (!g.keep.draft_message) patch.draft_message = g.remove.find((t) => t.draft_message)?.draft_message;
      update(db, "tasks", g.keep.id, patch);
      for (const t of g.remove) {
        if (completeTask(db, t.id, { status: "dismissed", source: "duplicate cleanup" })) closed.push(t.id);
        const contact = one<{ contact_id: string | null }>(db, "SELECT contact_id FROM tasks WHERE id = ?", t.id)?.contact_id;
        if (contact) {
          insert(db, "contact_events", { id: id("evt"), contact_id: contact, capture_id: null, kind: "note", body: `Removed duplicate task: ${t.title}`, created_at: nowIso() });
        }
      }
    }
    for (const g of report.captures) {
      for (const c of g.remove) {
        files.push(...all<{ path: string }>(db, "SELECT path FROM capture_files WHERE capture_id = ?", c.id).map((f) => f.path));
        run(db, "DELETE FROM captures WHERE id = ?", c.id);
      }
    }
  });
  // Outside the transaction: tell Todoist (a dismissed task is deleted there) and free the disk.
  for (const taskId of closed) enqueue(db, "deliver", { userId: user.id, event: "task.closed", objectId: taskId });
  await Promise.all(files.map((p) => ctx.storage.remove(p)));
  if (closed.length) ctx.worker.kick();
  return { tasks: closed.length, captures: report.captures.reduce((n, g) => n + g.remove.length, 0) };
}

export function autoDedupeEnabled(user: Pick<UserRow, "settings">): boolean {
  return parseJson<{ autoDedupe?: boolean }>(user.settings, {}).autoDedupe === true;
}

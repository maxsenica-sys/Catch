/**
 * Integration registry and the `deliver` job that fans events out to them.
 *
 * Adding an integration: write a module exporting an `Integration` and add it
 * to INTEGRATIONS. The settings screen, storage of its (encrypted) config,
 * retries and exactly-once delivery all come from here.
 */
import type { Ctx, UserRow } from "../context.ts";
import { type DB, all, id, nowIso, one, parseJson, run } from "../db/db.ts";
import { decrypt, encrypt } from "../crypto.ts";
import type { Integration, IntegrationCall, TaskPayload } from "./types.ts";
import { IntegrationError } from "./types.ts";
import { todoist } from "./todoist.ts";
import { webhook } from "./webhook.ts";
import { PermanentError } from "../jobs/queue.ts";

export const INTEGRATIONS: Record<string, Integration> = { todoist, webhook };

interface IntegrationRow {
  id: string;
  user_id: string;
  kind: string;
  enabled: number;
  config_enc: string;
  state: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export function readConfig(appSecret: string, row: Pick<IntegrationRow, "config_enc">): Record<string, string> {
  if (!row.config_enc) return {};
  try {
    return JSON.parse(decrypt(appSecret, row.config_enc));
  } catch {
    // APP_SECRET changed: the stored config is unreadable, not corrupt data to act on.
    return {};
  }
}

export function saveIntegration(
  db: DB,
  appSecret: string,
  userId: string,
  kind: string,
  patch: { enabled?: boolean; config?: Record<string, string> },
): void {
  const existing = one<IntegrationRow>(db, "SELECT * FROM integrations WHERE user_id = ? AND kind = ?", userId, kind);
  const merged = { ...(existing ? readConfig(appSecret, existing) : {}) };
  for (const [k, v] of Object.entries(patch.config ?? {})) {
    // An empty secret field in the form means "unchanged", not "erase".
    const field = INTEGRATIONS[kind].fields.find((f) => f.key === k);
    if (!field) continue;
    if (field.type === "secret" && v === "") continue;
    merged[k] = v.trim();
  }
  const enc = encrypt(appSecret, JSON.stringify(merged));
  const now = nowIso();
  if (existing) {
    run(
      db,
      "UPDATE integrations SET enabled = ?, config_enc = ?, state = CASE WHEN ? THEN '{}' ELSE state END, updated_at = ? WHERE id = ?",
      patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
      enc,
      // A changed project or URL invalidates cached lookups.
      patch.config ? 1 : 0,
      now,
      existing.id,
    );
  } else {
    run(
      db,
      "INSERT INTO integrations (id, user_id, kind, enabled, config_enc, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id("int"), userId, kind, patch.enabled ? 1 : 0, enc, now,
    );
  }
}

export function missingFields(kind: string, config: Record<string, string>): string[] {
  return INTEGRATIONS[kind].fields.filter((f) => f.required && !config[f.key]).map((f) => f.label);
}

/** For the settings screen: never returns a secret, only whether one is set. */
export function describeIntegrations(db: DB, appSecret: string, userId: string) {
  return Object.values(INTEGRATIONS).map((integ) => {
    const row = one<IntegrationRow>(db, "SELECT * FROM integrations WHERE user_id = ? AND kind = ?", userId, integ.kind);
    const config = row ? readConfig(appSecret, row) : {};
    return {
      kind: integ.kind,
      label: integ.label,
      description: integ.description,
      enabled: !!row?.enabled,
      last_ok_at: row?.last_ok_at ?? null,
      last_error: row?.last_error ?? null,
      fields: integ.fields.map((f) => ({
        ...f,
        value: f.type === "secret" ? "" : config[f.key] ?? "",
        set: !!config[f.key],
      })),
    };
  });
}

function call(ctx: Ctx, user: UserRow, row: IntegrationRow): IntegrationCall {
  return { ctx, user, config: readConfig(ctx.config.appSecret, row), state: parseJson(row.state, {}) };
}

function finish(db: DB, row: IntegrationRow, c: IntegrationCall, error: string | null): void {
  if (error) {
    run(db, "UPDATE integrations SET state = ?, last_error = ?, updated_at = ? WHERE id = ?", JSON.stringify(c.state), error, nowIso(), row.id);
  } else {
    run(db, "UPDATE integrations SET state = ?, last_error = NULL, last_ok_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(c.state), nowIso(), nowIso(), row.id);
  }
}

export async function testIntegration(ctx: Ctx, user: UserRow, kind: string): Promise<string> {
  const row = one<IntegrationRow>(ctx.db, "SELECT * FROM integrations WHERE user_id = ? AND kind = ?", user.id, kind);
  if (!row) throw new IntegrationError("Save the settings first.", true);
  const c = call(ctx, user, row);
  const missing = missingFields(kind, c.config);
  if (missing.length) throw new IntegrationError(`Missing: ${missing.join(", ")}`, true);
  try {
    const message = await INTEGRATIONS[kind].test(c);
    finish(ctx.db, row, c, null);
    return message;
  } catch (err) {
    finish(ctx.db, row, c, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function taskPayload(ctx: Ctx, taskId: string): TaskPayload | null {
  const t = one<Record<string, unknown>>(
    ctx.db,
    `SELECT t.*, c.name AS contact_name, c.stage AS contact_stage, cat.todoist_label AS cat_label
     FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
     LEFT JOIN categories cat ON cat.user_id = t.user_id AND cat.key = t.category
     WHERE t.id = ?`,
    taskId,
  );
  if (!t) return null;
  return {
    id: String(t.id),
    title: String(t.title),
    notes: String(t.notes ?? ""),
    category: (t.category as string) ?? null,
    categoryLabel: (t.cat_label as string) || null,
    channel: (t.channel as string) ?? null,
    link: (t.link as string) ?? null,
    draft_message: (t.draft_message as string) ?? null,
    due_on: (t.due_on as string) ?? null,
    due_time: (t.due_time as string) ?? null,
    priority: Number(t.priority),
    status: String(t.status),
    contact: t.contact_id ? { id: String(t.contact_id), name: String(t.contact_name), stage: String(t.contact_stage) } : null,
    capture_id: (t.capture_id as string) ?? null,
    app_url: `${ctx.config.publicUrl}/#/tasks/${t.id}`,
  };
}

export function capturePayload(ctx: Ctx, captureId: string): Record<string, unknown> | null {
  const cap = one<Record<string, unknown>>(ctx.db, "SELECT id, category, summary, transcript, note, status, captured_at, processed_at FROM captures WHERE id = ?", captureId);
  if (!cap) return null;
  const people = all(ctx.db,
    `SELECT DISTINCT c.id, c.name, c.category, c.stage, c.sport, c.position, c.location, c.email, c.phone
     FROM contact_events e JOIN contacts c ON c.id = e.contact_id WHERE e.capture_id = ? AND e.kind = 'captured'`, captureId);
  const tasks = all<{ id: string }>(ctx.db, "SELECT id FROM tasks WHERE capture_id = ?", captureId).map((t) => taskPayload(ctx, t.id));
  const events = all(ctx.db, "SELECT id, title, date, start_time, end_time, location FROM events WHERE capture_id = ?", captureId);
  return { capture: { ...cap, app_url: `${ctx.config.publicUrl}/#/captures/${captureId}` }, people, tasks, events };
}

function delivered(db: DB, kind: string, type: string, objectId: string): { status: string; external_id: string | null } | undefined {
  return one(db, "SELECT status, external_id FROM deliveries WHERE integration = ? AND object_type = ? AND object_id = ?", kind, type, objectId);
}

function recordDelivery(db: DB, userId: string, kind: string, type: string, objectId: string, externalId: string | null, status: string): void {
  const now = nowIso();
  run(
    db,
    `INSERT INTO deliveries (id, user_id, integration, object_type, object_id, external_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (integration, object_type, object_id) DO UPDATE SET status = excluded.status,
       external_id = COALESCE(excluded.external_id, deliveries.external_id), updated_at = excluded.updated_at`,
    id("dlv"), userId, kind, type, objectId, externalId, status, now, now,
  );
}

/**
 * The `deliver` job. Each enabled integration is attempted independently;
 * successes are recorded before failures are rethrown, so the retry only
 * re-attempts what failed. A permanent failure (bad token) is recorded on the
 * integration — visible in Settings — and not retried.
 */
export async function deliver(ctx: Ctx, payload: { userId: string; event: string; objectId: string; skip?: string[] }): Promise<void> {
  const { db } = ctx;
  const user = one<UserRow>(db, "SELECT * FROM users WHERE id = ?", payload.userId);
  if (!user) return;
  const rows = all<IntegrationRow>(db, "SELECT * FROM integrations WHERE user_id = ? AND enabled = 1", user.id);
  const retryable: string[] = [];

  for (const row of rows) {
    const integ = INTEGRATIONS[row.kind];
    if (!integ || payload.skip?.includes(row.kind)) continue;
    const c = call(ctx, user, row);
    if (missingFields(row.kind, c.config).length) continue;
    try {
      if (payload.event === "task.created" && integ.taskCreated) {
        if (delivered(db, row.kind, "task", payload.objectId)) continue;
        const task = taskPayload(ctx, payload.objectId);
        if (!task || task.status !== "open") continue;
        const externalId = await integ.taskCreated(c, task);
        recordDelivery(db, user.id, row.kind, "task", payload.objectId, externalId, "sent");
      } else if (payload.event === "task.closed" && integ.taskClosed) {
        const prior = delivered(db, row.kind, "task", payload.objectId);
        if (prior?.status === "closed") continue;
        const task = taskPayload(ctx, payload.objectId);
        if (!task) continue;
        await integ.taskClosed(c, task, prior?.external_id ?? null);
        recordDelivery(db, user.id, row.kind, "task", payload.objectId, null, "closed");
      } else if (payload.event === "capture.processed" && integ.captureProcessed) {
        if (delivered(db, row.kind, "capture", payload.objectId)) continue;
        const data = capturePayload(ctx, payload.objectId);
        if (!data) continue;
        await integ.captureProcessed(c, data);
        recordDelivery(db, user.id, row.kind, "capture", payload.objectId, null, "sent");
      } else {
        continue;
      }
      finish(db, row, c, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish(db, row, c, message);
      const permanent = err instanceof IntegrationError && err.permanent;
      if (!permanent) retryable.push(`${row.kind}: ${message}`);
    }
  }
  if (retryable.length) throw new Error(retryable.join("; "));
}

export async function pollIntegrations(ctx: Ctx, userId: string): Promise<void> {
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", userId);
  if (!user) return;
  const rows = all<IntegrationRow>(ctx.db, "SELECT * FROM integrations WHERE user_id = ? AND enabled = 1", userId);
  for (const row of rows) {
    const integ = INTEGRATIONS[row.kind];
    if (!integ?.poll) continue;
    const c = call(ctx, user, row);
    if (missingFields(row.kind, c.config).length) continue;
    try {
      await integ.poll(c);
      finish(ctx.db, row, c, null);
    } catch (err) {
      finish(ctx.db, row, c, err instanceof Error ? err.message : String(err));
      if (err instanceof IntegrationError && err.permanent) throw new PermanentError(err.message);
      throw err;
    }
  }
}

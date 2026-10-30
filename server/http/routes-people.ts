import { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Env } from "./auth.ts";
import { type DB, all, id, insert, nowIso, one, run, tx, update } from "../db/db.ts";
import { enqueue } from "../jobs/queue.ts";
import { STAGES } from "../pipeline/schema.ts";
import { afterContactTouched, completeTask, setStage } from "../pipeline/followups.ts";
import { isIsoDate, isTime, todayIn, addDays } from "../pipeline/dates.ts";
import { csv, vcard, type ContactForCard } from "../feeds.ts";

function cardFor(db: DB, contactId: string): ContactForCard | null {
  const c = one<Record<string, unknown>>(db, "SELECT * FROM contacts WHERE id = ?", contactId);
  if (!c) return null;
  const handles = all<{ platform: string; handle: string; url: string | null }>(db, "SELECT platform, handle, url FROM contact_handles WHERE contact_id = ?", contactId);
  return { ...(c as unknown as ContactForCard), handles };
}

/**
 * Fold `fromId` into `intoId`: handles, tasks, events and history move, blank
 * fields are filled, notes are appended, and `fromId` is deleted. Used to
 * resolve a "possible duplicate".
 */
export function mergeContacts(db: DB, userId: string, fromId: string, intoId: string): void {
  tx(db, () => {
    const from = one<Record<string, string | null>>(db, "SELECT * FROM contacts WHERE id = ? AND user_id = ?", fromId, userId);
    const into = one<Record<string, string | null>>(db, "SELECT * FROM contacts WHERE id = ? AND user_id = ?", intoId, userId);
    if (!from || !into || fromId === intoId) throw new Error("Cannot merge those contacts");
    const patch: Record<string, unknown> = { updated_at: nowIso(), needs_review: 0 };
    for (const k of ["first_name", "last_name", "role", "category", "sport", "position", "level", "location", "organisation", "email", "phone"]) {
      if (!into[k] && from[k]) patch[k] = from[k];
    }
    if (from.notes) patch.notes = [into.notes, from.notes].filter(Boolean).join("\n");
    update(db, "contacts", intoId, patch);
    run(db, "INSERT OR IGNORE INTO contact_handles (id, contact_id, user_id, platform, handle, url) SELECT 'hdl_' || hex(randomblob(9)), ?, user_id, platform, handle, url FROM contact_handles WHERE contact_id = ?", intoId, fromId);
    for (const table of ["tasks", "events", "contact_events"]) {
      run(db, `UPDATE ${table} SET contact_id = ? WHERE contact_id = ?`, intoId, fromId);
    }
    run(db, "UPDATE review_items SET subject_id = ? WHERE subject_id = ?", intoId, fromId);
    run(db, "DELETE FROM contacts WHERE id = ?", fromId);
    insert(db, "contact_events", { id: id("evt"), contact_id: intoId, capture_id: null, kind: "merged", body: `Merged ${from.name} into this contact`, created_at: nowIso() });
  });
}

const ContactPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  first_name: z.string().trim().max(100).nullable().optional(),
  last_name: z.string().trim().max(100).nullable().optional(),
  category: z.string().nullable().optional(),
  stage: z.enum(STAGES).optional(),
  role: z.string().max(40).nullable().optional(),
  sport: z.string().max(80).nullable().optional(),
  position: z.string().max(80).nullable().optional(),
  level: z.string().max(80).nullable().optional(),
  location: z.string().max(120).nullable().optional(),
  organisation: z.string().max(120).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  next_followup_on: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

export function contactRoutes(ctx: Ctx) {
  const app = new Hono<Env>();

  app.get("/", (c) => {
    const user = c.get("user");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const where = ["c.user_id = ?", "c.archived = ?"];
    const params: unknown[] = [user.id, c.req.query("archived") === "1" ? 1 : 0];
    if (c.req.query("category")) { where.push("c.category = ?"); params.push(c.req.query("category")); }
    if (c.req.query("stage")) { where.push("c.stage = ?"); params.push(c.req.query("stage")); }
    if (c.req.query("review") === "1") where.push("c.needs_review = 1");
    if (q) {
      where.push(`(lower(c.name) LIKE ? OR lower(coalesce(c.location,'')) LIKE ? OR lower(coalesce(c.organisation,'')) LIKE ?
        OR EXISTS (SELECT 1 FROM contact_handles h WHERE h.contact_id = c.id AND h.handle LIKE ?))`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/^@/, "")}%`);
    }
    const contacts = all(ctx.db,
      `SELECT c.id, c.name, c.category, c.stage, c.sport, c.position, c.location, c.next_followup_on, c.needs_review, c.updated_at,
         (SELECT COUNT(*) FROM tasks t WHERE t.contact_id = c.id AND t.status = 'open') AS open_tasks,
         (SELECT platform || ':' || handle FROM contact_handles h WHERE h.contact_id = c.id LIMIT 1) AS handle
       FROM contacts c WHERE ${where.join(" AND ")} ORDER BY c.updated_at DESC LIMIT 500`,
      ...params);
    return c.json({ contacts });
  });

  app.get("/:id", (c) => {
    const user = c.get("user");
    const contact = one(ctx.db, "SELECT * FROM contacts WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (!contact) return c.json({ error: "Not found" }, 404);
    const cid = c.req.param("id");
    return c.json({
      contact,
      handles: all(ctx.db, "SELECT id, platform, handle, url FROM contact_handles WHERE contact_id = ?", cid),
      tasks: all(ctx.db, "SELECT * FROM tasks WHERE contact_id = ? ORDER BY status = 'open' DESC, due_on", cid),
      events: all(ctx.db, "SELECT * FROM events WHERE contact_id = ? ORDER BY date DESC", cid),
      timeline: all(ctx.db,
        `SELECT e.id, e.kind, e.body, e.created_at, e.capture_id FROM contact_events e WHERE e.contact_id = ? ORDER BY e.created_at DESC LIMIT 100`, cid),
      duplicates: all(ctx.db,
        `SELECT r.id AS review_id, r.payload FROM review_items r WHERE r.subject_id = ? AND r.kind = 'possible_duplicate' AND r.status = 'open'`, cid),
    });
  });

  app.patch("/:id", async (c) => {
    const user = c.get("user");
    const cid = c.req.param("id");
    const current = one<{ id: string }>(ctx.db, "SELECT id FROM contacts WHERE id = ? AND user_id = ?", cid, user.id);
    if (!current) return c.json({ error: "Not found" }, 404);
    const parsed = ContactPatch.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, 400);
    const { stage, next_followup_on, ...rest } = parsed.data;
    if (next_followup_on !== undefined && next_followup_on !== null && !isIsoDate(next_followup_on)) {
      return c.json({ error: "next_followup_on must be YYYY-MM-DD" }, 400);
    }
    tx(ctx.db, () => {
      update(ctx.db, "contacts", cid, { ...rest, ...(next_followup_on !== undefined ? { next_followup_on } : {}), updated_at: nowIso() });
      if (stage) setStage(ctx.db, cid, user.id, stage);
    });
    return c.json({ contact: one(ctx.db, "SELECT * FROM contacts WHERE id = ?", cid) });
  });

  app.post("/:id/merge", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { into?: string };
    if (!body.into) return c.json({ error: "Say which contact to merge into" }, 400);
    try {
      mergeContacts(ctx.db, c.get("user").id, c.req.param("id"), body.into);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Merge failed" }, 400);
    }
    run(ctx.db, "UPDATE review_items SET status = 'resolved', resolution = 'merged', resolved_at = ? WHERE subject_id = ? AND kind = 'possible_duplicate' AND status = 'open'", nowIso(), body.into);
    return c.json({ ok: true, id: body.into });
  });

  app.get("/:id/vcard", (c) => {
    const owned = one(ctx.db, "SELECT id FROM contacts WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    const card = owned ? cardFor(ctx.db, c.req.param("id")) : null;
    if (!card) return c.json({ error: "Not found" }, 404);
    const filename = card.name.replace(/[^\w .-]/g, "").trim() || "contact";
    return c.body(vcard(card), 200, {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}.vcf"`,
    });
  });

  return app;
}

export function exportRoutes(ctx: Ctx) {
  const app = new Hono<Env>();
  app.get("/contacts.csv", (c) => {
    const rows = all<Record<string, unknown>>(ctx.db,
      `SELECT c.*, (SELECT group_concat(platform || ':' || handle, ' ') FROM contact_handles h WHERE h.contact_id = c.id) AS handles
       FROM contacts c WHERE c.user_id = ? ORDER BY c.name`, c.get("user").id);
    const cols = ["name", "category", "stage", "role", "sport", "position", "level", "location", "organisation", "email", "phone", "handles", "next_followup_on", "notes", "created_at"];
    return c.body(csv(rows, cols), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="catch-contacts.csv"' });
  });
  app.get("/contacts.vcf", (c) => {
    const ids = all<{ id: string }>(ctx.db, "SELECT id FROM contacts WHERE user_id = ? AND archived = 0 ORDER BY name", c.get("user").id);
    const body = ids.map((r) => vcard(cardFor(ctx.db, r.id)!)).join("");
    return c.body(body, 200, { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": 'attachment; filename="catch-contacts.vcf"' });
  });
  return app;
}

const TaskPatch = z.object({
  status: z.enum(["open", "done", "dismissed"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  due_on: z.string().nullable().optional(),
  due_time: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(4).optional(),
  draft_message: z.string().max(5000).nullable().optional(),
  snooze_days: z.number().int().min(1).max(60).optional(),
});

export function taskRoutes(ctx: Ctx) {
  const app = new Hono<Env>();

  app.get("/", (c) => {
    const user = c.get("user");
    const today = todayIn(user.timezone);
    const view = c.req.query("view") ?? "open";
    const base = `SELECT t.*, c.name AS contact_name, c.stage AS contact_stage FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.user_id = ?`;
    let tasks;
    if (view === "done") {
      tasks = all(ctx.db, `${base} AND t.status != 'open' ORDER BY t.completed_at DESC LIMIT 200`, user.id);
    } else if (view === "today") {
      tasks = all(ctx.db, `${base} AND t.status = 'open' AND t.due_on <= ? ORDER BY t.due_on, t.priority DESC, t.due_time`, user.id, today);
    } else {
      tasks = all(ctx.db, `${base} AND t.status = 'open' ORDER BY t.due_on IS NULL, t.due_on, t.priority DESC, t.due_time LIMIT 500`, user.id);
    }
    return c.json({ today, tasks });
  });

  app.patch("/:id", async (c) => {
    const user = c.get("user");
    const task = one<{ id: string; status: string; contact_id: string | null }>(ctx.db, "SELECT id, status, contact_id FROM tasks WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (!task) return c.json({ error: "Not found" }, 404);
    const parsed = TaskPatch.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, 400);
    const p = parsed.data;
    if (p.due_on && !isIsoDate(p.due_on)) return c.json({ error: "due_on must be YYYY-MM-DD" }, 400);
    if (p.due_time && !isTime(p.due_time)) return c.json({ error: "due_time must be HH:MM" }, 400);

    let closed = false;
    tx(ctx.db, () => {
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "due_on", "due_time", "priority", "draft_message"] as const) if (p[k] !== undefined) patch[k] = p[k];
      if (p.snooze_days) patch.due_on = addDays(todayIn(user.timezone), p.snooze_days);
      if (p.due_on !== undefined || p.snooze_days) patch.due_source = "stated";
      update(ctx.db, "tasks", task.id, patch);
      if (p.status && p.status !== "open" && task.status === "open") {
        closed = completeTask(ctx.db, task.id, { status: p.status, source: "Catch" });
      } else if (p.status === "open" && task.status !== "open") {
        update(ctx.db, "tasks", task.id, { status: "open", completed_at: null });
        if (task.contact_id) afterContactTouched(ctx.db, task.contact_id, user.id, { touched: false });
      }
    });
    if (closed) {
      enqueue(ctx.db, "deliver", { userId: user.id, event: "task.closed", objectId: task.id });
      ctx.worker.kick();
    }
    return c.json({ task: one(ctx.db, "SELECT * FROM tasks WHERE id = ?", task.id) });
  });

  return app;
}

export function reviewRoutes(ctx: Ctx) {
  const app = new Hono<Env>();
  app.get("/", (c) => {
    const items = all<Record<string, unknown>>(ctx.db,
      `SELECT r.*, c.summary AS capture_summary FROM review_items r LEFT JOIN captures c ON c.id = r.capture_id
       WHERE r.user_id = ? AND r.status = 'open' ORDER BY r.created_at DESC`, c.get("user").id);
    return c.json({
      items: items.map((r) => {
        const payload = JSON.parse(String(r.payload));
        if (r.kind === "possible_duplicate") {
          payload.subject = one(ctx.db, "SELECT id, name, category, stage, location FROM contacts WHERE id = ?", r.subject_id);
          payload.candidates = (payload.candidates as string[])
            .map((cid) => one(ctx.db, "SELECT id, name, category, stage, location FROM contacts WHERE id = ?", cid))
            .filter(Boolean);
        }
        return { ...r, payload };
      }),
    });
  });

  /** action: "merge" (with `into`) | "keep" (distinct people) | "dismiss" */
  app.post("/:id/resolve", async (c) => {
    const user = c.get("user");
    const item = one<{ id: string; kind: string; subject_id: string | null; capture_id: string | null }>(
      ctx.db, "SELECT id, kind, subject_id, capture_id FROM review_items WHERE id = ? AND user_id = ? AND status = 'open'", c.req.param("id"), user.id);
    if (!item) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; into?: string };
    if (body.action === "merge") {
      if (!item.subject_id || !body.into) return c.json({ error: "Say which contact to merge into" }, 400);
      try {
        mergeContacts(ctx.db, user.id, item.subject_id, body.into);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Merge failed" }, 400);
      }
    } else if (body.action === "keep" && item.subject_id) {
      update(ctx.db, "contacts", item.subject_id, { needs_review: 0 });
    } else if (body.action !== "dismiss" && body.action !== "keep") {
      return c.json({ error: "action must be merge, keep or dismiss" }, 400);
    }
    update(ctx.db, "review_items", item.id, { status: "resolved", resolution: body.action, resolved_at: nowIso() });
    // A capture held for review is done once nothing about it is open.
    if (item.capture_id) {
      const open = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM review_items WHERE capture_id = ? AND status = 'open'", item.capture_id)!.n;
      if (Number(open) === 0) run(ctx.db, "UPDATE captures SET status = 'done' WHERE id = ? AND status = 'review'", item.capture_id);
    }
    return c.json({ ok: true });
  });
  return app;
}

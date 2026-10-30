/**
 * The follow-up loop: the part that stops people going quiet unnoticed.
 *
 * A contact in a chased category always has exactly one of:
 *   - an open task (someone has to do something), or
 *   - a next_followup_on date (nothing to do until then), or
 *   - a stage that ends the chase (booked, client, parked, dead).
 *
 * Completing a task sets the date. The sweep turns a due date into a task.
 * After `maxFollowups` unanswered follow-ups the contact is parked rather
 * than chased for ever — a nag the user learns to ignore is worse than none.
 */
import type { Ctx, UserRow } from "../context.ts";
import { type DB, all, id, insert, nowIso, one, parseJson, run, update } from "../db/db.ts";
import { categoryFor, listCategories } from "../categories.ts";
import { enqueue } from "../jobs/queue.ts";
import { addDays, todayIn, toWeekday } from "./dates.ts";
import { actionLink } from "./resolve.ts";

const CHASED_STAGES = new Set(["new", "contacted"]);

export function userSettings(user: Pick<UserRow, "settings">): { maxFollowups: number; vocabulary: string } {
  const s = parseJson<Record<string, unknown>>(user.settings, {});
  return {
    maxFollowups: typeof s.maxFollowups === "number" && s.maxFollowups >= 0 ? s.maxFollowups : 3,
    vocabulary: typeof s.vocabulary === "string" ? s.vocabulary : "",
  };
}

/**
 * Mark a task done (from the app, the API, or Todoist) and move its contact on.
 * Idempotent: completing a completed task changes nothing and returns false.
 */
export function completeTask(db: DB, taskId: string, opts: { status?: "done" | "dismissed"; source: string }): boolean {
  const task = one<{ id: string; user_id: string; contact_id: string | null; status: string; title: string; kind: string }>(
    db, "SELECT id, user_id, contact_id, status, title, kind FROM tasks WHERE id = ?", taskId,
  );
  if (!task || task.status !== "open") return false;
  const now = nowIso();
  const status = opts.status ?? "done";
  update(db, "tasks", task.id, { status, completed_at: now });
  if (task.contact_id && status === "done") {
    insert(db, "contact_events", {
      id: id("evt"), contact_id: task.contact_id, capture_id: null, kind: "task_done",
      body: `${task.title} (${opts.source})`, created_at: now,
    });
    afterContactTouched(db, task.contact_id, task.user_id);
  } else if (task.contact_id) {
    afterContactTouched(db, task.contact_id, task.user_id, { touched: false });
  }
  return true;
}

/** Recompute a contact's next follow-up after something happened to it. */
export function afterContactTouched(db: DB, contactId: string, userId: string, opts: { touched?: boolean } = {}): void {
  const user = one<UserRow>(db, "SELECT * FROM users WHERE id = ?", userId);
  const c = one<{ stage: string; category: string | null }>(db, "SELECT stage, category FROM contacts WHERE id = ?", contactId);
  if (!user || !c) return;
  const now = nowIso();
  const patch: Record<string, unknown> = { updated_at: now };
  const touched = opts.touched ?? true;
  if (touched) {
    patch.last_touch_at = now;
    if (c.stage === "new") patch.stage = "contacted";
  }
  const open = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE contact_id = ? AND status = 'open'", contactId)!.n;
  const cat = categoryFor(listCategories(db, userId), c.category);
  const stage = String(patch.stage ?? c.stage);
  if (Number(open) === 0 && cat?.tracks_people && CHASED_STAGES.has(stage)) {
    patch.next_followup_on = toWeekday(addDays(todayIn(user.timezone), cat.followup_days));
  } else {
    patch.next_followup_on = null;
  }
  update(db, "contacts", contactId, patch);
}

/** Set a stage by hand. Any stage, forwards or back: the user is the authority. */
export function setStage(db: DB, contactId: string, userId: string, stage: string): void {
  const c = one<{ stage: string }>(db, "SELECT stage FROM contacts WHERE id = ? AND user_id = ?", contactId, userId);
  if (!c || c.stage === stage) return;
  const now = nowIso();
  update(db, "contacts", contactId, { stage, updated_at: now });
  insert(db, "contact_events", { id: id("evt"), contact_id: contactId, capture_id: null, kind: "stage", body: `${c.stage} → ${stage}`, created_at: now });
  if (!CHASED_STAGES.has(stage)) {
    // Ended the chase: nothing should keep nagging about this person.
    update(db, "contacts", contactId, { next_followup_on: null });
  } else {
    afterContactTouched(db, contactId, userId, { touched: false });
  }
}

/** Raise follow-up tasks for every contact whose date has come. Returns the task ids. */
export function sweepFollowups(db: DB, user: UserRow): string[] {
  const today = todayIn(user.timezone);
  const { maxFollowups } = userSettings(user);
  const due = all<{ id: string; name: string; stage: string; category: string | null; last_touch_at: string | null }>(
    db,
    `SELECT id, name, stage, category, last_touch_at FROM contacts
     WHERE user_id = ? AND archived = 0 AND next_followup_on IS NOT NULL AND next_followup_on <= ?
       AND stage IN ('new', 'contacted')
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.contact_id = contacts.id AND t.status = 'open')`,
    user.id, today,
  );
  const cats = listCategories(db, user.id);
  const created: string[] = [];
  const now = nowIso();
  for (const c of due) {
    // Unanswered rounds since the contact last moved stage.
    const lastStage = one<{ at: string }>(db, "SELECT MAX(created_at) AS at FROM contact_events WHERE contact_id = ? AND kind = 'stage'", c.id)?.at ?? "";
    const rounds = Number(one<{ n: number }>(
      db, "SELECT COUNT(*) AS n FROM contact_events WHERE contact_id = ? AND kind = 'followup_raised' AND created_at > ?", c.id, lastStage,
    )!.n);
    if (rounds >= maxFollowups) {
      setStage(db, c.id, user.id, "parked");
      insert(db, "contact_events", { id: id("evt"), contact_id: c.id, capture_id: null, kind: "note", body: `Parked after ${rounds} follow-ups with no reply`, created_at: now });
      continue;
    }
    const cat = categoryFor(cats, c.category);
    const handles = all<{ platform: string; handle: string }>(db, "SELECT platform, handle FROM contact_handles WHERE contact_id = ?", c.id);
    const since = c.last_touch_at ? ` — no reply since ${c.last_touch_at.slice(0, 10)}` : "";
    const taskId = id("tsk");
    insert(db, "tasks", {
      id: taskId, user_id: user.id, capture_id: null, contact_id: c.id, kind: "followup",
      title: `Follow up with ${c.name}${rounds > 0 ? ` (round ${rounds + 1})` : ""}`,
      notes: `Automatic follow-up${since}.`, category: cat?.key ?? null,
      link: actionLink(null, handles, null), due_on: today, due_source: "default", priority: 3, created_at: now,
    });
    update(db, "contacts", c.id, { next_followup_on: null, updated_at: now });
    insert(db, "contact_events", { id: id("evt"), contact_id: c.id, capture_id: null, kind: "followup_raised", body: `Follow-up ${rounds + 1}`, created_at: now });
    created.push(taskId);
  }
  return created;
}

export function runSweepJob(ctx: Ctx, userId: string): void {
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", userId);
  if (!user) return;
  for (const taskId of sweepFollowups(ctx.db, user)) {
    enqueue(ctx.db, "deliver", { userId, event: "task.created", objectId: taskId });
  }
}

export function purgeOldJobs(db: DB): void {
  run(db, "DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", new Date(Date.now() - 7 * 86_400_000).toISOString());
}

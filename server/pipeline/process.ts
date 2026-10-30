/**
 * The capture pipeline: one job per capture.
 *
 *   transcribe the voice note (once; the transcript is saved before extraction
 *   so a retry after an extraction failure does not pay for it twice)
 *   -> extract (model)
 *   -> apply (one DB transaction: people, tasks, appointments, review items)
 *   -> enqueue deliveries to integrations (separate jobs, separately retried,
 *      so a Todoist outage never blocks or re-runs the expensive part).
 */
import type { Ctx, UserRow } from "../context.ts";
import { type DB, all, id, insert, nowIso, one, parseJson, run, tx, update } from "../db/db.ts";
import { categoryFor, listCategories, type CategoryRow } from "../categories.ts";
import { enqueue } from "../jobs/queue.ts";
import { decideDue, describeNow, isIsoDate, isTime, todayIn } from "./dates.ts";
import type { Extraction, Person } from "./schema.ts";
import { actionLink, handleUrl, normaliseHandle, resolvePerson } from "./resolve.ts";

export interface CaptureRow {
  id: string;
  user_id: string;
  client_id: string;
  category_hint: string | null;
  category: string | null;
  note: string;
  status: string;
  transcript: string | null;
  extraction: string | null;
  summary: string | null;
  error: string | null;
  captured_at: string;
  created_at: string;
  processed_at: string | null;
}

interface FileRow {
  id: string;
  kind: "image" | "audio";
  path: string;
  mime: string;
}

export const STAGE_ORDER = ["new", "contacted", "replied", "booked", "client"] as const;

export function stageRank(stage: string): number {
  const i = (STAGE_ORDER as readonly string[]).indexOf(stage);
  return i === -1 ? -1 : i;
}

export interface ApplyResult {
  contactsCreated: string[];
  contactsUpdated: string[];
  tasks: string[];
  events: string[];
  reviews: string[];
}

function vocabularyHint(db: DB, user: UserRow): string {
  // Recent contact names help the transcriber spell them; the user's own
  // vocabulary setting (club names, jargon) goes first.
  const settings = parseJson<{ vocabulary?: string }>(user.settings, {});
  const names = all<{ name: string }>(
    db, "SELECT name FROM contacts WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 40", user.id,
  ).map((r) => r.name);
  return [settings.vocabulary ?? "", names.join(", ")].filter(Boolean).join(". ");
}

export async function processCapture(ctx: Ctx, captureId: string): Promise<void> {
  const { db } = ctx;
  const cap = one<CaptureRow>(db, "SELECT * FROM captures WHERE id = ?", captureId);
  if (!cap) return; // deleted while queued
  if (cap.status === "done" || cap.status === "review") return; // already applied; never apply twice
  const user = one<UserRow>(db, "SELECT * FROM users WHERE id = ?", cap.user_id);
  if (!user) return;

  update(db, "captures", cap.id, { status: "processing" });
  try {
    const files = all<FileRow>(db, "SELECT id, kind, path, mime FROM capture_files WHERE capture_id = ? ORDER BY position", cap.id);

    let transcript = cap.transcript;
    const audio = files.find((f) => f.kind === "audio");
    if (audio && transcript === null) {
      const buf = await ctx.storage.read(audio.path);
      transcript = (await ctx.transcriber.transcribe(buf, audio.mime, vocabularyHint(db, user))) ?? "";
      update(db, "captures", cap.id, { transcript });
    }

    const images = await Promise.all(
      files.filter((f) => f.kind === "image").map(async (f) => ({ mime: f.mime, data: await ctx.storage.read(f.path) })),
    );
    const cats = listCategories(db, user.id);
    const tz = user.timezone;
    const extraction = await ctx.extractor.extract({
      images,
      transcript: transcript || null,
      note: cap.note,
      categoryHint: cap.category_hint,
      categories: cats.map((c) => ({ key: c.key, name: c.name, guidance: c.guidance })),
      now: describeNow(tz),
      today: todayIn(tz),
      dateOrder: user.date_order,
      userName: user.name,
    });

    const result = tx(db, () => applyExtraction(db, user, cap, extraction, cats));
    for (const taskId of result.tasks) {
      enqueue(db, "deliver", { userId: user.id, event: "task.created", objectId: taskId });
    }
    enqueue(db, "deliver", { userId: user.id, event: "capture.processed", objectId: cap.id });
    ctx.worker.kick();
  } catch (err) {
    // Shown in the inbox while the queue retries; replaced by the final error
    // if it gives up (see onFinalFailure in app.ts).
    const message = err instanceof Error ? err.message : String(err);
    update(db, "captures", cap.id, { status: "queued", error: `Retrying: ${message}` });
    throw err;
  }
}

export function applyExtraction(db: DB, user: UserRow, cap: CaptureRow, ex: Extraction, cats: CategoryRow[]): ApplyResult {
  const now = nowIso();
  const today = todayIn(user.timezone);
  const result: ApplyResult = { contactsCreated: [], contactsUpdated: [], tasks: [], events: [], reviews: [] };
  const captureCat = categoryFor(cats, cats.some((c) => c.key === ex.category) ? ex.category : cap.category_hint);
  const validCat = (key: string | null | undefined) => (key && cats.some((c) => c.key === key) ? key : null);

  const review = (kind: string, subjectId: string | null, payload: Record<string, unknown>) => {
    const rid = id("rev");
    insert(db, "review_items", { id: rid, user_id: user.id, capture_id: cap.id, kind, subject_id: subjectId, payload, created_at: now });
    result.reviews.push(rid);
  };

  // People -----------------------------------------------------------------
  const refToContact = new Map<string, string>();
  for (const person of ex.people) {
    const match = resolvePerson(db, user.id, person);
    let contactId: string;
    if (match.kind === "existing") {
      contactId = match.contactId;
      mergeInto(db, contactId, person, validCat(person.category), now);
      if (!result.contactsUpdated.includes(contactId)) result.contactsUpdated.push(contactId);
    } else {
      contactId = id("con");
      const [first, ...rest] = person.name.trim().split(/\s+/);
      insert(db, "contacts", {
        id: contactId,
        user_id: user.id,
        name: person.name.trim(),
        first_name: person.first_name ?? (looksLikeHandle(person.name) ? null : first),
        last_name: person.last_name ?? (looksLikeHandle(person.name) ? null : rest.join(" ") || null),
        role: person.role,
        category: validCat(person.category) ?? captureCat?.key ?? null,
        stage: person.stage ?? "new",
        sport: person.sport,
        position: person.position,
        level: person.level,
        location: person.location,
        organisation: person.organisation,
        email: person.handles.find((h) => h.platform === "email")?.handle.toLowerCase() ?? null,
        phone: person.handles.find((h) => h.platform === "phone")?.handle ?? null,
        notes: person.facts ? `${today}: ${person.facts}` : "",
        needs_review: match.possibleDuplicates.length > 0,
        created_at: now,
        updated_at: now,
      });
      addHandles(db, user.id, contactId, person);
      result.contactsCreated.push(contactId);
      if (match.possibleDuplicates.length > 0) {
        review("possible_duplicate", contactId, { candidates: match.possibleDuplicates, name: person.name });
      }
    }
    refToContact.set(person.ref, contactId);
    insert(db, "contact_events", {
      id: id("evt"), contact_id: contactId, capture_id: cap.id, kind: "captured", body: ex.summary, created_at: now,
    });
  }

  // Actions ----------------------------------------------------------------
  const contactsWithAction = new Set<string>();
  for (const action of ex.actions) {
    const contactId = action.person_ref ? refToContact.get(action.person_ref) ?? null : null;
    const contact = contactId ? one<{ category: string | null }>(db, "SELECT category FROM contacts WHERE id = ?", contactId) : undefined;
    const cat = categoryFor(cats, validCat(action.category) ?? contact?.category ?? captureCat?.key);
    const due = decideDue(action.due_date, today, cat?.followup_days ?? 3);
    const taskId = id("tsk");
    const handles = contactId ? handlesOf(db, contactId) : [];
    insert(db, "tasks", {
      id: taskId,
      user_id: user.id,
      capture_id: cap.id,
      contact_id: contactId,
      kind: "action",
      title: action.title.trim().slice(0, 200),
      notes: action.due_evidence ? `Due because: "${action.due_evidence}"` : "",
      category: cat?.key ?? null,
      channel: action.channel,
      link: actionLink(action.channel, handles, action.draft_message),
      draft_message: action.draft_message,
      due_on: due.due_on,
      due_time: due.source === "stated" && isTime(action.due_time) ? action.due_time : null,
      due_source: due.source,
      priority: action.priority,
      created_at: now,
    });
    result.tasks.push(taskId);
    if (contactId) contactsWithAction.add(contactId);
    if (due.source === "default" && "dropped" in due && due.dropped) {
      review("date_dropped", taskId, { title: action.title, ...due.dropped, used: due.due_on });
    }
  }

  // Every NEW person in a chased category gets something to do, even when the
  // screenshot alone implied no action. Being captured is the signal.
  for (const contactId of result.contactsCreated) {
    if (contactsWithAction.has(contactId)) continue;
    const c = one<{ name: string; category: string | null; stage: string }>(db, "SELECT name, category, stage FROM contacts WHERE id = ?", contactId)!;
    const cat = categoryFor(cats, c.category);
    if (!cat?.tracks_people || stageRank(c.stage) >= stageRank("booked")) continue;
    const due = decideDue(null, today, cat.followup_days);
    const taskId = id("tsk");
    insert(db, "tasks", {
      id: taskId, user_id: user.id, capture_id: cap.id, contact_id: contactId, kind: "followup",
      title: `Reach out to ${c.name}`, category: cat.key, link: actionLink(null, handlesOf(db, contactId), null),
      due_on: due.due_on, due_source: "default", priority: 2, created_at: now,
    });
    result.tasks.push(taskId);
    contactsWithAction.add(contactId);
  }
  // An open task is the follow-up; the sweep's date only matters once it is done.
  for (const contactId of contactsWithAction) update(db, "contacts", contactId, { next_followup_on: null, updated_at: now });

  // Appointments -----------------------------------------------------------
  for (const appt of ex.appointments) {
    if (!isIsoDate(appt.date)) {
      review("date_dropped", null, { title: appt.title, value: appt.date, reason: "appointment without a real date" });
      continue;
    }
    const eventId = id("ev");
    insert(db, "events", {
      id: eventId,
      user_id: user.id,
      capture_id: cap.id,
      contact_id: appt.person_ref ? refToContact.get(appt.person_ref) ?? null : null,
      title: appt.title.trim(),
      date: appt.date,
      start_time: isTime(appt.start_time) ? appt.start_time : null,
      end_time: isTime(appt.start_time) && isTime(appt.end_time) && appt.end_time! > appt.start_time! ? appt.end_time : null,
      location: appt.location,
      created_at: now,
      updated_at: now,
    });
    result.events.push(eventId);
  }

  if (ex.confidence < 0.4 && (ex.people.length > 0 || ex.actions.length > 0)) {
    review("low_confidence", null, { confidence: ex.confidence, summary: ex.summary });
  }

  update(db, "captures", cap.id, {
    category: captureCat?.key ?? null,
    extraction: ex,
    summary: ex.summary,
    status: result.reviews.length > 0 ? "review" : "done",
    error: null,
    processed_at: now,
  });
  return result;
}

/** "jess.sets_07" is a username standing in for a name, not a first name. */
export function looksLikeHandle(name: string): boolean {
  const n = name.trim();
  return !/\s/.test(n) && (/[._\d@]/.test(n) || n === n.toLowerCase());
}

function handlesOf(db: DB, contactId: string): { platform: string; handle: string }[] {
  return all(db, "SELECT platform, handle FROM contact_handles WHERE contact_id = ?", contactId);
}

function addHandles(db: DB, userId: string, contactId: string, person: Person): void {
  for (const h of person.handles) {
    const handle = normaliseHandle(h.platform, h.handle);
    if (!handle) continue;
    run(
      db,
      "INSERT OR IGNORE INTO contact_handles (id, contact_id, user_id, platform, handle, url) VALUES (?, ?, ?, ?, ?, ?)",
      id("hdl"), contactId, userId, h.platform, handle, h.url ?? handleUrl(h.platform, handle),
    );
  }
}

/**
 * Fold new information into a known contact. Fills blanks, never overwrites
 * what is there (the user may have corrected it), appends facts to the notes,
 * and only ever moves the stage forward — a screenshot of an old DM must not
 * demote a client back to "new".
 */
function mergeInto(db: DB, contactId: string, person: Person, category: string | null, now: string): void {
  const c = one<Record<string, string | null>>(db, "SELECT * FROM contacts WHERE id = ?", contactId)!;
  const patch: Record<string, unknown> = { updated_at: now };
  const fill = ["role", "sport", "position", "level", "location", "organisation", "first_name", "last_name"] as const;
  for (const key of fill) {
    const value = person[key];
    if (!c[key] && value) patch[key] = value;
  }
  if (!c.category && category) patch.category = category;
  if (!c.email) patch.email = person.handles.find((h) => h.platform === "email")?.handle.toLowerCase();
  if (!c.phone) patch.phone = person.handles.find((h) => h.platform === "phone")?.handle;
  if (person.facts) {
    const line = `${now.slice(0, 10)}: ${person.facts}`;
    if (!(c.notes ?? "").includes(person.facts)) patch.notes = c.notes ? `${c.notes}\n${line}` : line;
  }
  if (person.stage && stageRank(person.stage) > stageRank(String(c.stage))) {
    patch.stage = person.stage;
    insert(db, "contact_events", {
      id: id("evt"), contact_id: contactId, capture_id: null, kind: "stage", body: `${c.stage} → ${person.stage}`, created_at: now,
    });
  }
  update(db, "contacts", contactId, patch);
  addHandles(db, String(c.user_id), contactId, person);
}

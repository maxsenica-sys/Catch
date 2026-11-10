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
import type { KnownPerson } from "./extract.ts";
import { actionLink, handleUrl, normaliseHandle, normaliseName, resolvePerson } from "./resolve.ts";

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
  /** Existing tasks this capture refined (new wording, date or draft); integrations are told. */
  updatedTasks: string[];
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

    // The same screenshot sent again, with nothing new said about it, is filed
    // as a repeat without reading it a second time: no model call, no cost,
    // and nothing created twice. A new voice note or text is new information
    // ("she replied, booked Saturday") and is processed as normal, where the
    // task-level duplicate check still stops copies of existing tasks.
    const repeat = findRepeat(db, user.id, cap.id, transcript ?? "", cap.note);
    if (repeat) {
      const when = new Date(repeat.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: user.timezone });
      update(db, "captures", cap.id, {
        status: "done",
        summary: `Same screenshot as the capture of ${when}, already filed. Nothing new, so nothing was added.`,
        category: repeat.category,
        error: null,
        processed_at: nowIso(),
      });
      return;
    }

    const images = await Promise.all(
      files.filter((f) => f.kind === "image").map(async (f) => ({ mime: f.mime, data: await ctx.storage.read(f.path) })),
    );
    const cats = listCategories(db, user.id);
    const known = knownPeople(db, user.id);
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
      known: known.list,
    });

    const result = tx(db, () => applyExtraction(db, user, cap, extraction, cats, known.maps));
    for (const taskId of result.tasks) {
      enqueue(db, "deliver", { userId: user.id, event: "task.created", objectId: taskId });
    }
    for (const taskId of result.updatedTasks) {
      enqueue(db, "deliver", { userId: user.id, event: "task.updated", objectId: taskId });
    }
    for (const eventId of result.events) {
      enqueue(db, "deliver", { userId: user.id, event: "event.created", objectId: eventId });
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

export interface KnownMaps {
  contacts: Map<string, string>; // k-ref -> contact id
  tasks: Map<string, string>; // t-ref -> task id
}

/**
 * The people the model is shown as already on file: the 40 most recently
 * active, each with up to 8 open tasks. Short refs (k1, t3) rather than ids,
 * so the model cannot invent a plausible-looking id; refs it did not see map
 * to nothing.
 */
export function knownPeople(db: DB, userId: string): { list: KnownPerson[]; maps: KnownMaps } {
  const maps: KnownMaps = { contacts: new Map(), tasks: new Map() };
  let t = 0;
  const list = all<{ id: string; name: string }>(
    db, "SELECT id, name FROM contacts WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 40", userId,
  ).map((c, i) => {
    const ref = `k${i + 1}`;
    maps.contacts.set(ref, c.id);
    const handles = all<{ platform: string; handle: string }>(db, "SELECT platform, handle FROM contact_handles WHERE contact_id = ? LIMIT 3", c.id)
      .map((h) => `${h.platform}:${h.handle}`).join(", ");
    const tasks = all<{ id: string; title: string; due_on: string | null }>(
      db, "SELECT id, title, due_on FROM tasks WHERE contact_id = ? AND status = 'open' ORDER BY due_on LIMIT 8", c.id,
    ).map((task) => {
      const tref = `t${++t}`;
      maps.tasks.set(tref, task.id);
      return { ref: tref, title: task.title, due_on: task.due_on };
    });
    return { ref, name: c.name, handles, tasks };
  });
  return { list, maps };
}

/** The model's "this is k3" only counts when the first names agree: a cheap check that it did not pick the wrong row. */
function firstNameAgrees(db: DB, contactId: string, person: Person): boolean {
  const c = one<{ name: string; first_name: string | null }>(db, "SELECT name, first_name FROM contacts WHERE id = ?", contactId);
  if (!c) return false;
  const theirs = normaliseName(c.first_name || c.name).split(" ")[0];
  const mine = normaliseName(person.first_name || person.name).split(" ")[0];
  return !!theirs && theirs === mine;
}

export function applyExtraction(db: DB, user: UserRow, cap: CaptureRow, ex: Extraction, cats: CategoryRow[], known: KnownMaps = { contacts: new Map(), tasks: new Map() }): ApplyResult {
  const now = nowIso();
  const today = todayIn(user.timezone);
  const result: ApplyResult = { contactsCreated: [], contactsUpdated: [], tasks: [], updatedTasks: [], events: [], reviews: [] };
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
    let match = resolvePerson(db, user.id, person);
    // The deterministic matcher never merges on a first name alone. The model,
    // which sees the screenshot and who is already on file, may say "this is
    // k3"; that is taken only when the first names agree.
    const hinted = person.known_ref ? known.contacts.get(person.known_ref) : undefined;
    if (match.kind === "new" && hinted && firstNameAgrees(db, hinted, person)) {
      match = { kind: "existing", contactId: hinted, via: "model" };
    }
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
    // The same DM screenshotted twice, or a follow-up capture about the same
    // thing, must not stack up copies of one task. A near-identical open task
    // for the same person absorbs it; a said date beats a default one, and an
    // earlier said date moves it forward.
    // The model recognised this as an open task already on file (reworded or
    // refined): update that task rather than add a second. Only within the same
    // person, and only an open task the model was actually shown.
    const hintedTaskId = action.existing_task ? known.tasks.get(action.existing_task) : undefined;
    const target = hintedTaskId
      ? one<{ id: string; contact_id: string | null; due_on: string | null; due_source: string }>(
          db, "SELECT id, contact_id, due_on, due_source FROM tasks WHERE id = ? AND user_id = ? AND status = 'open'", hintedTaskId, user.id)
      : undefined;
    const twin = target && (!contactId || !target.contact_id || target.contact_id === contactId)
      ? target
      : findSimilarOpenTask(db, user.id, contactId, action.title);
    if (twin) {
      const patch: Record<string, unknown> = {};
      if (twin === target) {
        patch.title = action.title.trim().slice(0, 200);
        if (action.draft_message) patch.draft_message = action.draft_message;
      }
      if (due.source === "stated" && (twin.due_source !== "stated" || !twin.due_on || due.due_on < twin.due_on)) {
        patch.due_on = due.due_on;
        patch.due_source = "stated";
      }
      if (Object.keys(patch).length) {
        update(db, "tasks", twin.id, patch);
        if (!result.updatedTasks.includes(twin.id)) result.updatedTasks.push(twin.id);
      }
      if (contactId) contactsWithAction.add(contactId);
      continue;
    }
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
    const eventContact = appt.person_ref ? refToContact.get(appt.person_ref) ?? null : null;
    // What the calendar entry says when it is opened: who, how to reach them, why.
    const who = eventContact ? one<{ name: string }>(db, "SELECT name FROM contacts WHERE id = ?", eventContact)?.name : null;
    const reach = eventContact ? actionLink(null, handlesOf(db, eventContact), null) : null;
    insert(db, "events", {
      id: eventId,
      user_id: user.id,
      capture_id: cap.id,
      contact_id: eventContact,
      notes: [who ? `With ${who}` : "", reach ?? "", ex.summary].filter(Boolean).join("\n"),
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

/**
 * An earlier filed capture whose screenshots include every screenshot of this
 * one (byte-identical), where this one adds nothing new: no voice or text, or
 * voice/text that says about the same as that capture's did.
 */
export function findRepeat(db: DB, userId: string, capId: string, transcript: string, note: string): { id: string; created_at: string; category: string | null } | undefined {
  const mine = all<{ sha256: string }>(db, "SELECT sha256 FROM capture_files WHERE capture_id = ? AND kind = 'image'", capId).map((f) => f.sha256);
  if (mine.length === 0) return undefined;
  const said = `${transcript} ${note}`.trim();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const earlier = all<{ id: string; created_at: string; category: string | null; transcript: string | null; note: string; shas: string }>(
    db,
    `SELECT c.id, c.created_at, c.category, c.transcript, c.note,
       (SELECT group_concat(f.sha256) FROM capture_files f WHERE f.capture_id = c.id AND f.kind = 'image') AS shas
     FROM captures c
     WHERE c.user_id = ? AND c.id != ? AND c.status IN ('done', 'review') AND c.created_at > ?
       AND EXISTS (SELECT 1 FROM capture_files f WHERE f.capture_id = c.id AND f.kind = 'image' AND f.sha256 = ?)
     ORDER BY c.created_at`,
    userId, capId, since, mine[0],
  );
  return earlier.find((e) => {
    const theirs = new Set((e.shas ?? "").split(","));
    if (!mine.every((h) => theirs.has(h))) return false;
    if (!said) return true;
    const before = `${e.transcript ?? ""} ${e.note}`.trim();
    return !!before && titleSimilarity(said, before) >= DUPLICATE_TASK_SIMILARITY;
  });
}

const STOPWORDS = new Set(["a", "an", "the", "to", "for", "of", "on", "in", "and", "with", "about", "re", "s", "my", "her", "his", "their", "them", "him"]);

export function titleWords(title: string): Set<string> {
  return new Set(
    title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w)),
  );
}

/** Word-overlap similarity (Jaccard) between two task titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export const DUPLICATE_TASK_SIMILARITY = 0.6;

function findSimilarOpenTask(db: DB, userId: string, contactId: string | null, title: string): { id: string; due_on: string | null; due_source: string } | undefined {
  const open = all<{ id: string; title: string; due_on: string | null; due_source: string }>(
    db,
    `SELECT id, title, due_on, due_source FROM tasks WHERE user_id = ? AND status = 'open' AND ${contactId ? "contact_id = ?" : "contact_id IS NULL"}`,
    ...(contactId ? [userId, contactId] : [userId]),
  );
  return open.find((t) => titleSimilarity(t.title, title) >= DUPLICATE_TASK_SIMILARITY);
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

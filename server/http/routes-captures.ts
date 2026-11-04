/**
 * Captures in, captures out.
 *
 * POST /api/captures is the hot path and is built to return fast: it stores
 * the files, writes one row, queues a job and answers 202. Nothing slow
 * (transcription, the model, Todoist) happens before the phone gets its
 * answer, so the user can fire off the next capture immediately.
 *
 * It is idempotent on `client_id`: the phone generates the id when the capture
 * is made and keeps retrying the same upload until it is acknowledged. A
 * retry after a lost response returns the original capture, never a second.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { Env } from "./auth.ts";
import { all, id, insert, nowIso, one, run, tx, update } from "../db/db.ts";
import { enqueue } from "../jobs/queue.ts";
import { IMAGE_EXT, audioExt, sniffImage } from "../storage.ts";
import { listCategories } from "../categories.ts";

const MAX_IMAGES = 10;

function asFiles(v: unknown): File[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((x): x is File => typeof x === "object" && x !== null && "arrayBuffer" in x && (x as File).size > 0);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
}

export function captureSummary(ctx: Ctx, capId: string) {
  const cap = one<Record<string, unknown>>(ctx.db, "SELECT * FROM captures WHERE id = ?", capId);
  if (!cap) return null;
  const files = all<{ id: string; kind: string; mime: string; size: number }>(
    ctx.db, "SELECT id, kind, mime, size FROM capture_files WHERE capture_id = ? ORDER BY position", capId,
  );
  const people = all<{ id: string; name: string; category: string | null; stage: string }>(
    ctx.db,
    `SELECT DISTINCT c.id, c.name, c.category, c.stage FROM contact_events e JOIN contacts c ON c.id = e.contact_id
     WHERE e.capture_id = ? AND e.kind = 'captured'`,
    capId,
  );
  const tasks = all(ctx.db,
    "SELECT id, title, due_on, due_time, due_source, status, link, draft_message, channel, contact_id FROM tasks WHERE capture_id = ? ORDER BY created_at",
    capId);
  const events = all(ctx.db, "SELECT id, title, date, start_time, end_time, location FROM events WHERE capture_id = ?", capId);
  const reviews = all(ctx.db, "SELECT id, kind, subject_id, payload, status FROM review_items WHERE capture_id = ? AND status = 'open'", capId);
  return {
    id: cap.id,
    client_id: cap.client_id,
    status: cap.status,
    category_hint: cap.category_hint,
    category: cap.category,
    note: cap.note,
    transcript: cap.transcript,
    summary: cap.summary,
    error: cap.error,
    captured_at: cap.captured_at,
    created_at: cap.created_at,
    processed_at: cap.processed_at,
    files,
    people,
    tasks,
    events,
    reviews: reviews.map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) })),
  };
}

type Incoming = { buf: Buffer; mime: string };
type Stored = { kind: string; mime: string; position: number; path: string; sha256: string; size: number };

/**
 * Validate every file before storing any, so a bad one rejects the whole
 * capture cleanly instead of leaving half of it on disk.
 */
async function readFiles(images: File[], audio: File | undefined): Promise<{ error: string; status: 400 | 415 } | { images: Incoming[]; audio: Incoming | null }> {
  if (images.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} screenshots per capture.`, status: 400 };
  const out: Incoming[] = [];
  for (const img of images) {
    const buf = Buffer.from(await img.arrayBuffer());
    const mime = sniffImage(buf);
    if (mime === "image/heic") {
      return { error: "HEIC photos are not supported. Screenshots are fine; for camera photos set Camera → Formats → Most Compatible.", status: 415 };
    }
    if (!mime) return { error: `"${img.name}" is not an image Catch can read (PNG, JPEG, GIF or WebP).`, status: 415 };
    out.push({ buf, mime });
  }
  let voice: Incoming | null = null;
  if (audio) {
    const mime = (audio.type || "audio/webm").split(";")[0];
    if (!mime.startsWith("audio/") && !mime.startsWith("video/")) return { error: "The voice note is not audio.", status: 415 };
    voice = { buf: Buffer.from(await audio.arrayBuffer()), mime };
  }
  return { images: out, audio: voice };
}

async function storeFiles(ctx: Ctx, userId: string, files: { images: Incoming[]; audio: Incoming | null }, firstPosition = 0): Promise<Stored[]> {
  return Promise.all([
    ...files.images.map(async (f, i) => ({ kind: "image", mime: f.mime, position: firstPosition + i, ...(await ctx.storage.put(userId, f.buf, IMAGE_EXT[f.mime])) })),
    ...(files.audio ? [(async (a: Incoming) => ({ kind: "audio", mime: a.mime, position: 0, ...(await ctx.storage.put(userId, a.buf, audioExt(a.mime))) }))(files.audio)] : []),
  ]);
}

function insertFiles(ctx: Ctx, capId: string, stored: Stored[]): void {
  const now = nowIso();
  for (const f of stored) {
    insert(ctx.db, "capture_files", {
      id: id("fil"), capture_id: capId, kind: f.kind, path: f.path, mime: f.mime, size: f.size,
      sha256: f.sha256, position: f.position, created_at: now,
    });
  }
}

function categoryFrom(ctx: Ctx, userId: string, raw: string): string | null {
  const key = raw.trim();
  return key && key !== "auto" && listCategories(ctx.db, userId).some((k) => k.key === key) ? key : null;
}

/**
 * A draft is a capture still being assembled from outside the app: the iOS
 * Shortcut started from the Photos share sheet uploads one screenshot per
 * request, then finishes it with the voice note. A draft is open for this
 * long after its last file; after that the sweep files it as it is, so a
 * Shortcut that dies halfway never loses the screenshots it did send.
 */
export const DRAFT_OPEN_MS = 10 * 60 * 1000;

function openDraft(ctx: Ctx, userId: string): { id: string } | undefined {
  const since = new Date(Date.now() - DRAFT_OPEN_MS).toISOString();
  return one<{ id: string }>(
    ctx.db,
    `SELECT c.id FROM captures c WHERE c.user_id = ? AND c.status = 'draft'
       AND COALESCE((SELECT MAX(f.created_at) FROM capture_files f WHERE f.capture_id = c.id), c.created_at) > ?
     ORDER BY c.created_at DESC LIMIT 1`,
    userId, since,
  );
}

/** Drafts nobody finished within DRAFT_OPEN_MS are filed with what they have. */
export function sweepDrafts(ctx: Ctx): number {
  const before = new Date(Date.now() - DRAFT_OPEN_MS).toISOString();
  const stale = all<{ id: string }>(
    ctx.db,
    `SELECT c.id FROM captures c WHERE c.status = 'draft'
       AND COALESCE((SELECT MAX(f.created_at) FROM capture_files f WHERE f.capture_id = c.id), c.created_at) <= ?`,
    before,
  );
  for (const c of stale) queueCapture(ctx, c.id);
  return stale.length;
}

function queueCapture(ctx: Ctx, capId: string): void {
  update(ctx.db, "captures", capId, { status: "queued", error: null });
  enqueue(ctx.db, "process_capture", { captureId: capId }, { dedupeKey: `capture:${capId}`, maxAttempts: 6 });
}

export function captureRoutes(ctx: Ctx) {
  const app = new Hono<Env>();

  const parse = async (c: { req: { parseBody(o: { all: true }): Promise<Record<string, unknown>> } }) => {
    try {
      return await c.req.parseBody({ all: true });
    } catch {
      return null;
    }
  };

  app.post("/", async (c) => {
    const user = c.get("user");
    const body = await parse(c);
    if (!body) return c.json({ error: "Expected multipart/form-data" }, 400);
    const clientId = str(body.client_id).slice(0, 80) || id("cli");

    const existing = one<{ id: string }>(ctx.db, "SELECT id FROM captures WHERE user_id = ? AND client_id = ?", user.id, clientId);
    if (existing) return c.json({ capture: captureSummary(ctx, existing.id), duplicate: true }, 200);

    const images = asFiles(body.image ?? body["image[]"]);
    const audio = asFiles(body.audio)[0];
    const note = str(body.note).slice(0, 10_000).trim();
    if (images.length === 0 && !audio && !note) {
      return c.json({ error: "A capture needs at least a screenshot, a voice note or some text." }, 400);
    }
    const category = categoryFrom(ctx, user.id, str(body.category));
    const capturedRaw = str(body.captured_at);
    const capturedAt = capturedRaw && !Number.isNaN(Date.parse(capturedRaw)) ? new Date(capturedRaw).toISOString() : nowIso();

    const files = await readFiles(images, audio);
    if ("error" in files) return c.json({ error: files.error }, files.status);
    const stored = await storeFiles(ctx, user.id, files);

    const capId = id("cap");
    try {
      tx(ctx.db, () => {
        insert(ctx.db, "captures", {
          id: capId, user_id: user.id, client_id: clientId, category_hint: category, note,
          status: "queued", captured_at: capturedAt, created_at: nowIso(),
        });
        insertFiles(ctx, capId, stored);
        enqueue(ctx.db, "process_capture", { captureId: capId }, { dedupeKey: `capture:${capId}`, maxAttempts: 6 });
      });
    } catch (err) {
      await Promise.all(stored.map((f) => ctx.storage.remove(f.path)));
      // Two uploads of the same capture racing: the other one won.
      const raced = one<{ id: string }>(ctx.db, "SELECT id FROM captures WHERE user_id = ? AND client_id = ?", user.id, clientId);
      if (raced) return c.json({ capture: captureSummary(ctx, raced.id), duplicate: true }, 200);
      throw err;
    }
    ctx.worker.kick();
    return c.json({ capture: captureSummary(ctx, capId) }, 202);
  });

  /** Add screenshots to the open draft (creating one if there is none). Nothing is processed yet. */
  app.post("/draft", async (c) => {
    const user = c.get("user");
    const body = await parse(c);
    if (!body) return c.json({ error: "Expected multipart/form-data" }, 400);
    const images = asFiles(body.image ?? body["image[]"]);
    if (images.length === 0) return c.json({ error: "Send a screenshot in the image field." }, 400);
    const files = await readFiles(images, undefined);
    if ("error" in files) return c.json({ error: files.error }, files.status);

    let draft = openDraft(ctx, user.id);
    const have = draft ? Number(one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM capture_files WHERE capture_id = ? AND kind = 'image'", draft.id)!.n) : 0;
    if (have + files.images.length > MAX_IMAGES) return c.json({ error: `At most ${MAX_IMAGES} screenshots per capture.` }, 400);
    const stored = await storeFiles(ctx, user.id, files, have);
    tx(ctx.db, () => {
      if (!draft) {
        draft = { id: id("cap") };
        insert(ctx.db, "captures", {
          id: draft.id, user_id: user.id, client_id: id("drf"), status: "draft", note: "",
          captured_at: nowIso(), created_at: nowIso(),
        });
      }
      insertFiles(ctx, draft.id, stored);
    });
    return c.json({ capture: captureSummary(ctx, draft!.id) }, 201);
  });

  /**
   * Finish the open draft with the voice note (and optionally a category or
   * note) and send it for processing. With no draft open it simply makes a
   * capture from what it was given, so a Shortcut that sends only a voice note
   * still works. Finishing twice is harmless.
   */
  app.post("/draft/finish", async (c) => {
    const user = c.get("user");
    const body = await parse(c);
    if (!body) return c.json({ error: "Expected multipart/form-data" }, 400);
    const audio = asFiles(body.audio)[0];
    const note = str(body.note).slice(0, 10_000).trim();
    const category = categoryFrom(ctx, user.id, str(body.category));
    const draft = openDraft(ctx, user.id);
    if (!draft && !audio && !note) return c.json({ error: "Nothing to finish: no screenshots are waiting and no voice note was sent." }, 404);

    const files = await readFiles([], audio);
    if ("error" in files) return c.json({ error: files.error }, files.status);
    if (!draft && files.audio) {
      // A retried finish (weak signal, Shortcut re-run) re-sends the same voice
      // note: hand back the capture it already finished rather than a second one.
      const sha = createHash("sha256").update(files.audio.buf).digest("hex");
      const since = new Date(Date.now() - DRAFT_OPEN_MS).toISOString();
      const again = one<{ capture_id: string }>(ctx.db,
        `SELECT f.capture_id FROM capture_files f JOIN captures c ON c.id = f.capture_id
         WHERE c.user_id = ? AND f.kind = 'audio' AND f.sha256 = ? AND f.created_at > ? LIMIT 1`, user.id, sha, since);
      if (again) return c.json({ capture: captureSummary(ctx, again.capture_id), duplicate: true }, 200);
    }
    const stored = await storeFiles(ctx, user.id, files);
    const capId = draft?.id ?? id("cap");
    tx(ctx.db, () => {
      if (draft) {
        update(ctx.db, "captures", capId, { note, category_hint: category });
      } else {
        insert(ctx.db, "captures", {
          id: capId, user_id: user.id, client_id: id("cli"), category_hint: category, note,
          status: "draft", captured_at: nowIso(), created_at: nowIso(),
        });
      }
      insertFiles(ctx, capId, stored);
      queueCapture(ctx, capId);
    });
    ctx.worker.kick();
    return c.json({ capture: captureSummary(ctx, capId) }, 202);
  });

  app.get("/", (c) => {
    const user = c.get("user");
    const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);
    const before = c.req.query("before");
    const rows = all<{ id: string }>(
      ctx.db,
      `SELECT id FROM captures WHERE user_id = ? ${before ? "AND created_at < ?" : ""} ORDER BY created_at DESC LIMIT ?`,
      ...(before ? [user.id, before, limit] : [user.id, limit]),
    );
    return c.json({ captures: rows.map((r) => captureSummary(ctx, r.id)) });
  });

  app.get("/:id", (c) => {
    const cap = one(ctx.db, "SELECT id FROM captures WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    if (!cap) return c.json({ error: "Not found" }, 404);
    return c.json({ capture: captureSummary(ctx, c.req.param("id")) });
  });

  app.post("/:id/retry", (c) => {
    const cap = one<{ id: string; status: string }>(ctx.db, "SELECT id, status FROM captures WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    if (!cap) return c.json({ error: "Not found" }, 404);
    if (cap.status !== "failed") return c.json({ error: "Only a failed capture can be retried." }, 409);
    update(ctx.db, "captures", cap.id, { status: "queued", error: null });
    enqueue(ctx.db, "process_capture", { captureId: cap.id }, { dedupeKey: `capture:${cap.id}`, maxAttempts: 6 });
    ctx.worker.kick();
    return c.json({ capture: captureSummary(ctx, cap.id) });
  });

  /** Deletes the capture and its files. People and tasks it created stay: they are records now. */
  app.delete("/:id", async (c) => {
    const cap = one<{ id: string }>(ctx.db, "SELECT id FROM captures WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    if (!cap) return c.json({ error: "Not found" }, 404);
    const files = all<{ path: string }>(ctx.db, "SELECT path FROM capture_files WHERE capture_id = ?", cap.id);
    run(ctx.db, "DELETE FROM captures WHERE id = ?", cap.id);
    await Promise.all(files.map((f) => ctx.storage.remove(f.path)));
    return c.json({ ok: true });
  });

  return app;
}

export function fileRoutes(ctx: Ctx) {
  const app = new Hono<Env>();
  app.get("/:id", async (c) => {
    const f = one<{ path: string; mime: string }>(
      ctx.db,
      `SELECT f.path, f.mime FROM capture_files f JOIN captures c ON c.id = f.capture_id WHERE f.id = ? AND c.user_id = ?`,
      c.req.param("id"), c.get("user").id,
    );
    if (!f) return c.json({ error: "Not found" }, 404);
    const buf = await ctx.storage.read(f.path);
    return c.body(new Uint8Array(buf), 200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=31536000, immutable" });
  });
  return app;
}

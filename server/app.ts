/**
 * Wiring: build the context, the HTTP app and the job handlers. `createCatch`
 * is what index.ts boots and what the tests construct in-process.
 */
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "./config.ts";
import type { Ctx, UserRow } from "./context.ts";
import { openDb, all, one, update, type DB } from "./db/db.ts";
import { localStorage } from "./storage.ts";
import { createWorker, enqueue, jobStats, recoverStale, type Handler, type Job } from "./jobs/queue.ts";
import { mockTranscriber, openAiTranscriber, type Transcriber } from "./pipeline/transcribe.ts";
import { anthropicExtractor, type Extractor } from "./pipeline/extract.ts";
import { mockExtractor } from "./pipeline/mock-extractor.ts";
import { processCapture } from "./pipeline/process.ts";
import { purgeOldJobs, runSweepJob } from "./pipeline/followups.ts";
import { deliver, pollIntegrations } from "./integrations/index.ts";
import { icalendar, type FeedEvent } from "./feeds.ts";
import { requireUser, type Env } from "./http/auth.ts";
import { authRoutes } from "./http/routes-auth.ts";
import { captureRoutes, fileRoutes } from "./http/routes-captures.ts";
import { contactRoutes, exportRoutes, reviewRoutes, taskRoutes } from "./http/routes-people.ts";
import { settingsRoutes } from "./http/routes-settings.ts";

export interface Catch {
  ctx: Ctx;
  app: Hono;
  startBackground(): void;
  stop(): Promise<void>;
}

export function createCatch(
  config: Config,
  deps: { db?: DB; transcriber?: Transcriber; extractor?: Extractor; fetch?: typeof fetch } = {},
): Catch {
  const db = deps.db ?? openDb(config.dataDir);
  const transcriber = deps.transcriber ?? (config.transcriber === "live"
    ? openAiTranscriber(config.openaiApiKey, config.transcribeModel)
    : mockTranscriber());
  const extractor = deps.extractor ?? (config.extractor === "live"
    ? anthropicExtractor({ apiKey: config.anthropicApiKey, model: config.model, effort: config.effort })
    : mockExtractor());

  const ctx = { config, db, storage: localStorage(config.dataDir), transcriber, extractor, fetch: deps.fetch ?? fetch } as Ctx;

  const handlers: Record<string, Handler> = {
    process_capture: (job) => processCapture(ctx, String(job.payload.captureId)),
    deliver: (job) => deliver(ctx, job.payload as { userId: string; event: string; objectId: string; skip?: string[] }),
    followups_sweep: async (job) => runSweepJob(ctx, String(job.payload.userId)),
    poll_integrations: (job) => pollIntegrations(ctx, String(job.payload.userId)),
    housekeeping: async () => purgeOldJobs(db),
  };
  ctx.worker = createWorker(db, handlers, {
    concurrency: config.workerConcurrency,
    onFinalFailure(job: Job, err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.type === "process_capture") {
        update(db, "captures", String(job.payload.captureId), { status: "failed", error: message });
      }
      console.error(`[job] ${job.type} ${job.id} failed for good: ${message}`);
    },
  });

  const app = new Hono();
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", contentSecurityPolicy: undefined }));
  app.use("/api/*", bodyLimit({ maxSize: config.maxUploadBytes, onError: (c) => c.json({ error: "Upload too large" }, 413) }));

  app.get("/healthz", (c) => {
    one(db, "SELECT 1");
    return c.json({ ok: true, transcriber: transcriber.name, extractor: extractor.name, jobs: jobStats(db) });
  });

  app.route("/api/auth", authRoutes(ctx));
  const api = new Hono<Env>();
  api.use("*", requireUser(ctx));
  api.route("/captures", captureRoutes(ctx));
  api.route("/files", fileRoutes(ctx));
  api.route("/contacts", contactRoutes(ctx));
  api.route("/export", exportRoutes(ctx));
  api.route("/tasks", taskRoutes(ctx));
  api.route("/review", reviewRoutes(ctx));
  api.route("/", settingsRoutes(ctx));
  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // Calendar subscription: secret URL, no cookie (calendar apps have none).
  app.get("/feeds/:token/calendar.ics", (c) => {
    const user = one<UserRow>(db, "SELECT * FROM users WHERE feed_token = ?", c.req.param("token"));
    if (!user) return c.text("Not found", 404);
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const events = all<FeedEvent>(db,
      "SELECT id, title, date, start_time, end_time, location, notes, updated_at FROM events WHERE user_id = ? AND date >= ? ORDER BY date",
      user.id, since);
    if (c.req.query("tasks") === "1") {
      const tasks = all<Record<string, string>>(db,
        "SELECT id, title, due_on, due_time, link, created_at FROM tasks WHERE user_id = ? AND status = 'open' AND due_on IS NOT NULL", user.id);
      for (const t of tasks) {
        events.push({ id: t.id, title: `☐ ${t.title}`, date: t.due_on, start_time: t.due_time || null, end_time: null, location: null, notes: t.link ?? "", updated_at: t.created_at });
      }
    }
    return c.body(icalendar("Catch", user.timezone, events), 200, { "Content-Type": "text/calendar; charset=utf-8" });
  });

  // Android share target posts here when the service worker is not yet in
  // control; the worker normally intercepts it (see web/src/sw.ts).
  app.post("/share", (c) => c.redirect("/#/capture?shared=1", 303));

  serveWeb(app, config.webDist);

  let timers: NodeJS.Timeout[] = [];
  return {
    ctx,
    app,
    startBackground() {
      const stale = recoverStale(db);
      if (stale) console.log(`[worker] requeued ${stale} job(s) left running by the last process`);
      ctx.worker.start();
      if (!config.schedulers) return;
      const everyUser = (type: string, minutes: number, onlyWith?: string) => {
        const fire = () => {
          const users = onlyWith
            ? all<{ user_id: string }>(db, "SELECT DISTINCT user_id FROM integrations WHERE enabled = 1 AND kind = ?", onlyWith).map((r) => r.user_id)
            : all<{ id: string }>(db, "SELECT id FROM users").map((r) => r.id);
          for (const userId of users) enqueue(db, type, { userId }, { dedupeKey: `${type}:${userId}`, maxAttempts: 2 });
          ctx.worker.kick();
        };
        fire();
        timers.push(setInterval(fire, minutes * 60_000));
      };
      everyUser("followups_sweep", 15);
      everyUser("poll_integrations", 5, "todoist");
      timers.push(setInterval(() => enqueue(db, "housekeeping", {}, { dedupeKey: "housekeeping" }), 6 * 60 * 60_000));
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      await ctx.worker.stop();
    },
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

/** The built PWA. Hashed assets cache forever; index.html and the service worker never do. */
function serveWeb(app: Hono, dist: string): void {
  app.get("*", async (c) => {
    if (!fs.existsSync(dist)) {
      return c.text("Catch API is running. The web app is not built: run `npm run build`.", 200);
    }
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const file = path.resolve(dist, `.${urlPath}`);
    if (file.startsWith(dist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const immutable = urlPath.startsWith("/assets/");
      return c.body(new Uint8Array(await fs.promises.readFile(file)), 200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    const index = path.join(dist, "index.html");
    return c.body(await fs.promises.readFile(index, "utf8"), 200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  });
}

import { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Env } from "./auth.ts";
import { createApiToken } from "./auth.ts";
import { all, id, insert, nowIso, one, parseJson, run, update } from "../db/db.ts";
import { listCategories, slugKey } from "../categories.ts";
import { isValidTimeZone, todayIn } from "../pipeline/dates.ts";
import { INTEGRATIONS, describeIntegrations, saveIntegration, testIntegration } from "../integrations/index.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken } from "../crypto.ts";

const MePatch = z.object({
  name: z.string().trim().max(100).optional(),
  timezone: z.string().optional(),
  date_order: z.enum(["DMY", "MDY"]).optional(),
  settings: z.object({
    vocabulary: z.string().max(2000).optional(),
    maxFollowups: z.number().int().min(0).max(20).optional(),
    autoSend: z.boolean().optional(),
    holdToRecord: z.boolean().optional(),
  }).optional(),
});

const CategoryInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  guidance: z.string().max(1000).optional(),
  followup_days: z.number().int().min(0).max(90).optional(),
  todoist_label: z.string().trim().max(60).optional(),
  tracks_people: z.boolean().optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});

export function settingsRoutes(ctx: Ctx) {
  const app = new Hono<Env>();

  app.get("/me", (c) => {
    const u = c.get("user");
    return c.json({
      user: {
        id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, date_order: u.date_order,
        settings: parseJson(u.settings, {}),
      },
      today: todayIn(u.timezone),
      feed_url: `${ctx.config.publicUrl}/feeds/${u.feed_token}/calendar.ics`,
      providers: {
        transcriber: ctx.transcriber.name,
        extractor: ctx.extractor.name,
        offline: ctx.transcriber.name === "mock" || ctx.extractor.name === "mock",
      },
    });
  });

  app.patch("/me", async (c) => {
    const u = c.get("user");
    const parsed = MePatch.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, 400);
    const p = parsed.data;
    if (p.timezone && !isValidTimeZone(p.timezone)) return c.json({ error: `Unknown time zone ${p.timezone}` }, 400);
    update(ctx.db, "users", u.id, {
      name: p.name,
      timezone: p.timezone,
      date_order: p.date_order,
      settings: p.settings ? { ...parseJson(u.settings, {}), ...p.settings } : undefined,
    });
    return c.json({ ok: true });
  });

  /** Badge counts for the tab bar; cheap enough to poll. */
  app.get("/summary", (c) => {
    const u = c.get("user");
    const today = todayIn(u.timezone);
    const n = (sql: string, ...p: unknown[]) => Number(one<{ n: number }>(ctx.db, sql, ...p)!.n);
    return c.json({
      today,
      due: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open' AND due_on <= ?", u.id, today),
      overdue: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open' AND due_on < ?", u.id, today),
      review: n("SELECT COUNT(*) AS n FROM review_items WHERE user_id = ? AND status = 'open'", u.id),
      processing: n("SELECT COUNT(*) AS n FROM captures WHERE user_id = ? AND status IN ('queued', 'processing')", u.id),
      failed: n("SELECT COUNT(*) AS n FROM captures WHERE user_id = ? AND status = 'failed'", u.id),
      integration_errors: all<{ kind: string; last_error: string }>(ctx.db,
        "SELECT kind, last_error FROM integrations WHERE user_id = ? AND enabled = 1 AND last_error IS NOT NULL", u.id),
    });
  });

  // Categories -------------------------------------------------------------
  app.get("/categories", (c) => c.json({ categories: listCategories(ctx.db, c.get("user").id, c.req.query("all") === "1") }));

  app.post("/categories", async (c) => {
    const u = c.get("user");
    const parsed = CategoryInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, 400);
    let key = slugKey(parsed.data.name);
    for (let i = 2; one(ctx.db, "SELECT id FROM categories WHERE user_id = ? AND key = ?", u.id, key); i++) key = `${slugKey(parsed.data.name)}-${i}`;
    const maxSort = Number(one<{ s: number }>(ctx.db, "SELECT COALESCE(MAX(sort), 0) AS s FROM categories WHERE user_id = ?", u.id)!.s);
    const catId = id("cat");
    insert(ctx.db, "categories", {
      id: catId, user_id: u.id, key, name: parsed.data.name,
      color: parsed.data.color ?? "#64748b", guidance: parsed.data.guidance ?? "",
      followup_days: parsed.data.followup_days ?? 3, todoist_label: parsed.data.todoist_label ?? parsed.data.name,
      tracks_people: parsed.data.tracks_people ?? true, sort: parsed.data.sort ?? maxSort + 1, created_at: nowIso(),
    });
    return c.json({ category: one(ctx.db, "SELECT * FROM categories WHERE id = ?", catId) }, 201);
  });

  /** The key never changes once created: it is what captures and contacts point at. */
  app.patch("/categories/:id", async (c) => {
    const u = c.get("user");
    const cat = one(ctx.db, "SELECT id FROM categories WHERE id = ? AND user_id = ?", c.req.param("id"), u.id);
    if (!cat) return c.json({ error: "Not found" }, 404);
    const parsed = CategoryInput.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, 400);
    update(ctx.db, "categories", c.req.param("id"), parsed.data);
    return c.json({ category: one(ctx.db, "SELECT * FROM categories WHERE id = ?", c.req.param("id")) });
  });

  // Integrations -----------------------------------------------------------
  app.get("/integrations", (c) => {
    const u = c.get("user");
    return c.json({
      integrations: describeIntegrations(ctx.db, ctx.config.appSecret, u.id),
      calendar_feed: `${ctx.config.publicUrl}/feeds/${u.feed_token}/calendar.ics`,
    });
  });

  app.put("/integrations/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!INTEGRATIONS[kind]) return c.json({ error: "Unknown integration" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; config?: Record<string, unknown> };
    const config = Object.fromEntries(Object.entries(body.config ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    saveIntegration(ctx.db, ctx.config.appSecret, c.get("user").id, kind, { enabled: body.enabled, config: body.config ? config : undefined });
    return c.json({ integrations: describeIntegrations(ctx.db, ctx.config.appSecret, c.get("user").id) });
  });

  app.post("/integrations/:kind/test", async (c) => {
    const kind = c.req.param("kind");
    if (!INTEGRATIONS[kind]) return c.json({ error: "Unknown integration" }, 404);
    try {
      return c.json({ ok: true, message: await testIntegration(ctx, c.get("user"), kind) });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Push every open task that has not reached an integration yet (e.g. after connecting Todoist). */
  app.post("/integrations/:kind/backfill", (c) => {
    const u = c.get("user");
    const kind = c.req.param("kind");
    const tasks = all<{ id: string }>(ctx.db,
      `SELECT t.id FROM tasks t WHERE t.user_id = ? AND t.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.integration = ? AND d.object_type = 'task' AND d.object_id = t.id)`, u.id, kind);
    for (const t of tasks) enqueue(ctx.db, "deliver", { userId: u.id, event: "task.created", objectId: t.id });
    ctx.worker.kick();
    return c.json({ queued: tasks.length });
  });

  // API tokens -------------------------------------------------------------
  app.get("/tokens", (c) => c.json({
    tokens: all(ctx.db, "SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC", c.get("user").id),
  }));

  app.post("/tokens", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const { id: tokenId, token } = createApiToken(ctx, c.get("user").id, String(body.name ?? "Token"));
    // The only time the token is ever shown.
    return c.json({ id: tokenId, token }, 201);
  });

  app.delete("/tokens/:id", (c) => {
    run(ctx.db, "DELETE FROM api_tokens WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });

  app.post("/feed/rotate", (c) => {
    update(ctx.db, "users", c.get("user").id, { feed_token: randomToken("", 24) });
    return c.json({ ok: true });
  });

  return app;
}

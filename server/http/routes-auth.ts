import { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { id, insert, nowIso, one } from "../db/db.ts";
import { hashPassword, verifyPassword, randomToken } from "../crypto.ts";
import { seedCategories } from "../categories.ts";
import { isValidTimeZone } from "../pipeline/dates.ts";
import { createSession, destroySession, rateLimiter } from "./auth.ts";

const Signup = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(100).default(""),
  timezone: z.string().default("UTC"),
  invite: z.string().optional(),
});

const Login = z.object({ email: z.string().trim().toLowerCase(), password: z.string() });

export function authRoutes(ctx: Ctx) {
  const app = new Hono();
  const limited = rateLimiter(20, 15 * 60 * 1000);
  const ip = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";

  app.get("/config", (c) => {
    const users = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users")!.n;
    const firstUser = Number(users) === 0;
    return c.json({
      signup: firstUser || ctx.config.signupMode !== "closed",
      needsInvite: !firstUser && ctx.config.signupMode === "invite",
      firstUser,
    });
  });

  app.post("/signup", async (c) => {
    if (!limited(`signup:${ip(c)}`)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const parsed = Signup.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Enter an email and a password of at least 8 characters." }, 400);
    const input = parsed.data;
    const firstUser = Number(one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users")!.n) === 0;
    if (!firstUser) {
      if (ctx.config.signupMode === "closed") return c.json({ error: "Sign-ups are closed on this server." }, 403);
      if (ctx.config.signupMode === "invite" && (!ctx.config.inviteCode || input.invite?.trim() !== ctx.config.inviteCode)) {
        return c.json({ error: "That invite code is not right." }, 403);
      }
    }
    if (one(ctx.db, "SELECT id FROM users WHERE email = ?", input.email)) {
      return c.json({ error: "An account with that email already exists." }, 409);
    }
    const userId = id("usr");
    insert(ctx.db, "users", {
      id: userId,
      email: input.email,
      name: input.name,
      password_hash: hashPassword(input.password),
      role: firstUser ? "owner" : "member",
      timezone: isValidTimeZone(input.timezone) ? input.timezone : "UTC",
      feed_token: randomToken("", 24),
      created_at: nowIso(),
    });
    seedCategories(ctx.db, userId);
    createSession(ctx, c, userId);
    return c.json({ ok: true }, 201);
  });

  app.post("/login", async (c) => {
    if (!limited(`login:${ip(c)}`)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const parsed = Login.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Enter your email and password." }, 400);
    const user = one<{ id: string; password_hash: string }>(ctx.db, "SELECT id, password_hash FROM users WHERE email = ?", parsed.data.email);
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      return c.json({ error: "Email or password is wrong." }, 401);
    }
    createSession(ctx, c, user.id);
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    destroySession(ctx, c);
    return c.json({ ok: true });
  });

  return app;
}

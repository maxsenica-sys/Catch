/**
 * Two ways in:
 *   - a session cookie, for the app (90 days, renewed on use — a phone app
 *     that logs you out is a capture tool you stop using);
 *   - a personal API token (`Authorization: Bearer catch_...`), for iOS
 *     Shortcuts, scripts and other apps.
 *
 * Cookie-authenticated writes must carry `X-Catch: 1`. A cross-site form
 * cannot set a custom header, so that header plus SameSite=Lax is the CSRF
 * defence; token-authenticated calls do not need it.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Ctx, UserRow } from "../context.ts";
import { id, nowIso, one, run, insert } from "../db/db.ts";
import { randomToken, sha256 } from "../crypto.ts";

export const SESSION_COOKIE = "catch_session";
const SESSION_DAYS = 90;

export type Env = { Variables: { user: UserRow; via: "cookie" | "token" } };

export function createSession(ctx: Ctx, c: Context, userId: string): void {
  const token = randomToken("", 32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  insert(ctx.db, "sessions", {
    id: sha256(token), user_id: userId, created_at: nowIso(), expires_at: expires.toISOString(),
    user_agent: c.req.header("user-agent")?.slice(0, 200) ?? null,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "Lax", secure: ctx.config.secureCookies, path: "/", expires,
  });
}

export function destroySession(ctx: Ctx, c: Context): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) run(ctx.db, "DELETE FROM sessions WHERE id = ?", sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function createApiToken(ctx: Ctx, userId: string, name: string): { id: string; token: string } {
  const token = randomToken("catch_", 24);
  const tokenId = id("tok");
  insert(ctx.db, "api_tokens", {
    id: tokenId, user_id: userId, name: name.slice(0, 60) || "Token", token_hash: sha256(token),
    prefix: token.slice(0, 12), created_at: nowIso(),
  });
  return { id: tokenId, token };
}

export function userFromRequest(ctx: Ctx, c: Context): { user: UserRow; via: "cookie" | "token" } | null {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const hash = sha256(auth.slice(7).trim());
    const row = one<{ id: string; user_id: string }>(ctx.db, "SELECT id, user_id FROM api_tokens WHERE token_hash = ?", hash);
    if (!row) return null;
    run(ctx.db, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
    const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", row.user_id);
    return user ? { user, via: "token" } : null;
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = one<{ id: string; user_id: string; expires_at: string }>(
    ctx.db, "SELECT id, user_id, expires_at FROM sessions WHERE id = ?", sha256(token),
  );
  if (!session || session.expires_at < nowIso()) return null;
  // Sliding expiry, written at most once a day.
  const renewed = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  if (Date.parse(session.expires_at) < renewed.getTime() - 86_400_000) {
    run(ctx.db, "UPDATE sessions SET expires_at = ? WHERE id = ?", renewed.toISOString(), session.id);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: ctx.config.secureCookies, path: "/", expires: renewed });
  }
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", session.user_id);
  return user ? { user, via: "cookie" } : null;
}

export function requireUser(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    const found = userFromRequest(ctx, c);
    if (!found) return c.json({ error: "Not signed in" }, 401);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (mutating && found.via === "cookie" && c.req.header("x-catch") !== "1") {
      return c.json({ error: "Missing X-Catch header" }, 403);
    }
    c.set("user", found.user);
    c.set("via", found.via);
    await next();
  };
}

/** Per-IP attempt counter for login/signup. In memory: it resets on restart, which is fine for its job. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

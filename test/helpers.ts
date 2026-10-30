import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../server/config.ts";
import { createCatch, type Catch } from "../server/app.ts";
import type { Extractor, ExtractInput } from "../server/pipeline/extract.ts";
import type { Extraction, Person, Action } from "../server/pipeline/schema.ts";
import { MOCK_TRANSCRIPT_MARKER } from "../server/pipeline/transcribe.ts";

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
export const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

export interface TestApp extends Catch {
  dir: string;
  extractCalls: ExtractInput[];
  setExtraction(e: Extraction | ((input: ExtractInput) => Extraction)): void;
  close(): Promise<void>;
}

/** A Catch instance in a temp dir with a scripted extractor and an injectable fetch. */
export function makeApp(opts: { config?: Partial<Config>; fetch?: typeof fetch; extractor?: Extractor } = {}): TestApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catch-test-"));
  let next: Extraction | ((input: ExtractInput) => Extraction) = extraction({});
  const extractCalls: ExtractInput[] = [];
  const extractor: Extractor = opts.extractor ?? {
    name: "scripted",
    async extract(input) {
      extractCalls.push(input);
      return typeof next === "function" ? next(input) : next;
    },
  };
  const config = loadConfig({ dataDir: dir, schedulers: false, webDist: path.join(dir, "no-web"), signupMode: "open", transcriber: "mock", extractor: "mock", ...opts.config });
  const app = createCatch(config, { extractor, fetch: opts.fetch });
  return Object.assign(app, {
    dir,
    extractCalls,
    setExtraction(e: Extraction | ((input: ExtractInput) => Extraction)) {
      next = e;
    },
    async close() {
      await app.stop();
      app.ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}

export function person(p: Partial<Person> & { ref: string; name: string }): Person {
  return {
    first_name: null, last_name: null, handles: [], role: null, sport: null, position: null, level: null,
    location: null, organisation: null, category: null, stage: null, facts: null, ...p,
  };
}

export function action(a: Partial<Action> & { title: string }): Action {
  return {
    person_ref: null, channel: null, due_date: null, due_time: null, due_evidence: null, priority: 2,
    draft_message: null, category: null, ...a,
  };
}

export function extraction(e: Partial<Extraction>): Extraction {
  return { summary: "Test capture", category: "coaching", confidence: 0.9, people: [], actions: [], appointments: [], notes: null, ...e };
}

export interface Session {
  cookie: string;
  req(p: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  json<T = any>(p: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  capture(fields?: { note?: string; category?: string; client_id?: string; images?: Buffer[]; transcript?: string }): Promise<any>;
}

export async function signup(app: Catch, email = "max@example.com", extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await app.app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "Max", timezone: "Europe/Istanbul", ...extra }),
  });
  if (res.status !== 201) throw new Error(`signup failed ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const req = (p: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    if (!headers.has("x-catch")) headers.set("x-catch", "1");
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return Promise.resolve(app.app.request(p, { ...init, headers, body }));
  };
  const json = async (p: string, init?: RequestInit & { json?: unknown }): Promise<any> => (await req(p, init)).json();
  return {
    cookie,
    req,
    json,
    async capture(fields = {}) {
      const fd = new FormData();
      fd.append("client_id", fields.client_id ?? crypto.randomUUID());
      if (fields.category) fd.append("category", fields.category);
      if (fields.note) fd.append("note", fields.note);
      for (const img of fields.images ?? [PNG]) fd.append("image", new Blob([new Uint8Array(img)], { type: "image/png" }), "s.png");
      if (fields.transcript) {
        fd.append("audio", new Blob([Buffer.from(MOCK_TRANSCRIPT_MARKER + fields.transcript)], { type: "audio/mp4" }), "v.m4a");
      }
      const res = await req("/api/captures", { method: "POST", body: fd });
      return { status: res.status, ...((await res.json()) as Record<string, any>) };
    },
  };
}

/** Run every runnable job until the queue is quiet. */
export async function settle(app: Catch): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await app.ctx.worker.drain()) === 0) return;
  }
}

/** A fake fetch that routes by "METHOD path" and records every call. */
export function fakeFetch(routes: Record<string, (body: any, url: URL) => { status?: number; json?: unknown } | undefined>) {
  const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw ? JSON.parse(raw) : undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method, url: url.toString(), body, headers });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && new RegExp(`^${p}$`).test(url.pathname);
    });
    const out = key ? routes[key](body, url) : { status: 404 };
    const status = out?.status ?? 200;
    return new Response(out?.json === undefined ? "" : JSON.stringify(out.json), { status });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

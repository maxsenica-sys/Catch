/**
 * Everything the server reads from the environment, read once.
 *
 * The rule throughout: a missing key degrades to a working offline mode and
 * says so (see `providers` in /api/me and /healthz); a *malformed* value fails
 * at boot. A silent fallback on a typo is the failure that costs a week.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ProviderMode = "live" | "mock";
export type SignupMode = "open" | "invite" | "closed";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string;
  appSecret: string;
  signupMode: SignupMode;
  inviteCode: string;
  maxUploadBytes: number;
  workerConcurrency: number;
  anthropicApiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  openaiApiKey: string;
  transcribeModel: string;
  transcriber: ProviderMode;
  extractor: ProviderMode;
  todoistApiBase: string;
  webDist: string;
  secureCookies: boolean;
  /** Turns the in-process schedulers off; tests drive jobs by hand. */
  schedulers: boolean;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}=${raw} is not a non-negative integer`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name}=${raw} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/** `auto` means live when the key is present, mock when it is not. */
function provider(name: string, key: string): ProviderMode {
  const mode = oneOf(name, ["auto", "live", "mock"] as const, "auto");
  if (mode === "live" && !key) throw new Error(`${name}=live but its API key is not set`);
  if (mode === "auto") return key ? "live" : "mock";
  return mode;
}

/**
 * APP_SECRET encrypts integration tokens at rest. In production it must be set
 * explicitly (losing it means re-entering every token). For local runs one is
 * generated once and kept beside the database so restarts do not lose it.
 */
function appSecret(dataDir: string): string {
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SECRET is required when NODE_ENV=production (openssl rand -hex 32)");
  }
  const file = path.join(dataDir, ".app-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  fs.mkdirSync(dataDir, { recursive: true });
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const port = int("PORT", 8787);
  const publicUrl = (process.env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, "");

  const config: Config = {
    port,
    host: process.env.HOST?.trim() || "0.0.0.0",
    dataDir,
    publicUrl,
    appSecret: appSecret(dataDir),
    signupMode: oneOf("SIGNUP_MODE", ["open", "invite", "closed"] as const, "invite"),
    inviteCode: process.env.INVITE_CODE?.trim() ?? "",
    maxUploadBytes: int("MAX_UPLOAD_MB", 40) * 1024 * 1024,
    workerConcurrency: Math.max(1, int("WORKER_CONCURRENCY", 2)),
    anthropicApiKey,
    model: process.env.CATCH_MODEL?.trim() || "claude-opus-5-5",
    effort: oneOf("CATCH_EFFORT", ["low", "medium", "high", "xhigh", "max"] as const, "medium"),
    openaiApiKey,
    transcribeModel: process.env.TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
    transcriber: provider("TRANSCRIBER", openaiApiKey),
    extractor: provider("EXTRACTOR", anthropicApiKey),
    todoistApiBase: (process.env.TODOIST_API_BASE?.trim() || "https://api.todoist.com/api/v1").replace(/\/$/, ""),
    webDist: path.resolve(process.env.WEB_DIST ?? "./web/dist"),
    secureCookies: publicUrl.startsWith("https://"),
    schedulers: true,
    ...overrides,
  };
  // SIGNUP_MODE=invite with no INVITE_CODE is not an error: the first account
  // can always be created (bootstrap), and after that nobody else can join.
  return config;
}

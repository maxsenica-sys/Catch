import type { Config } from "./config.ts";
import type { DB } from "./db/db.ts";
import type { Storage } from "./storage.ts";
import type { Transcriber } from "./pipeline/transcribe.ts";
import type { Extractor } from "./pipeline/extract.ts";
import type { Worker } from "./jobs/queue.ts";

/** Everything a route or a job needs, built once in app.ts and passed down. */
export interface Ctx {
  config: Config;
  db: DB;
  storage: Storage;
  transcriber: Transcriber;
  extractor: Extractor;
  worker: Worker;
  /** Injectable for tests; integrations use it for every outbound call. */
  fetch: typeof fetch;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  date_order: "DMY" | "MDY";
  feed_token: string;
  settings: string;
  created_at: string;
}

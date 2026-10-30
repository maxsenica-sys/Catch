/**
 * A persistent job queue in the same SQLite file as everything else.
 *
 * Why not in-memory: the whole point of the app is that a capture, once the
 * phone has handed it over, is never lost. A process restart mid-processing
 * must resume the job, not drop it. Jobs left `running` by a crash are put
 * back on the queue at boot.
 */
import { type DB, id, nowIso, one, run, all, insert } from "../db/db.ts";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type Handler = (job: Job) => Promise<void>;

/** Retryable unless marked otherwise. A permanent error fails the job at once. */
export class PermanentError extends Error {
  readonly permanent = true;
}

export function enqueue(
  db: DB,
  type: string,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {},
): string | null {
  const jobId = id("job");
  const now = nowIso();
  try {
    insert(db, "jobs", {
      id: jobId,
      type,
      payload,
      dedupe_key: opts.dedupeKey ?? null,
      max_attempts: opts.maxAttempts ?? 5,
      run_after: new Date(Date.now() + (opts.delayMs ?? 0)).toISOString(),
      created_at: now,
      updated_at: now,
    });
    return jobId;
  } catch (err) {
    // An identical job is already waiting; that one will do.
    if (opts.dedupeKey && String(err).includes("UNIQUE")) return null;
    throw err;
  }
}

export function recoverStale(db: DB): number {
  return run(db, "UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ? WHERE status = 'running'", nowIso()).changes;
}

function claim(db: DB): Job | null {
  const now = nowIso();
  const row = one<Record<string, unknown>>(
    db,
    `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after LIMIT 1)
     RETURNING id, type, payload, attempts, max_attempts`,
    now,
    now,
    now,
  );
  if (!row) return null;
  return {
    id: String(row.id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
  };
}

/** 30s, 2m, 8m, 32m ... capped at 2h. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 2 * 60 * 60 * 1000);
}

export interface Worker {
  /** Process everything currently runnable, then resolve. Used by tests and by the poll loop. */
  drain(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  kick(): void;
}

export function createWorker(
  db: DB,
  handlers: Record<string, Handler>,
  opts: { concurrency: number; pollMs?: number; onFinalFailure?: (job: Job, err: unknown) => void },
): Worker {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let active: Promise<number> | null = null;

  async function runOne(job: Job): Promise<void> {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new PermanentError(`no handler for job type ${job.type}`);
      await handler(job);
      run(db, "UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?", nowIso(), job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentError;
      if (permanent || job.attempts >= job.max_attempts) {
        run(db, "UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?", message, nowIso(), job.id);
        opts.onFinalFailure?.(job, err);
      } else {
        const after = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
        run(db, "UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", message, after, nowIso(), job.id);
      }
    }
  }

  async function drainInner(): Promise<number> {
    let done = 0;
    const lanes = Array.from({ length: opts.concurrency }, async () => {
      for (let job = claim(db); job; job = claim(db)) {
        await runOne(job);
        done++;
      }
    });
    await Promise.all(lanes);
    return done;
  }

  function drain(): Promise<number> {
    // One drain at a time; a kick during a drain is picked up by its loop.
    if (!active) active = drainInner().finally(() => (active = null));
    return active;
  }

  const tick = async () => {
    if (!running) return;
    await drain().catch((err) => console.error("[worker] drain failed", err));
    if (running) timer = setTimeout(tick, opts.pollMs ?? 1000);
  };

  return {
    drain,
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await active;
    },
    kick() {
      if (running) void drain();
    },
  };
}

export function jobStats(db: DB): Record<string, number> {
  const rows = all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

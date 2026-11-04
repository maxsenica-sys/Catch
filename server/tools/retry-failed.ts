/**
 * Put every failed capture back on the queue. For use after fixing whatever
 * made them fail (a bad key, a schema the API refused):
 *
 *   node server/tools/retry-failed.ts          # all users
 *
 * Runs beside the live server: it only writes rows; the server's worker polls
 * the jobs table and picks them up within a second. Transcripts already saved
 * are kept, so voice notes are not transcribed (or paid for) twice.
 */
import { loadConfig } from "../config.ts";
import { openDb, all, run } from "../db/db.ts";
import { enqueue } from "../jobs/queue.ts";

const config = loadConfig({ schedulers: false });
const db = openDb(config.dataDir);
const failed = all<{ id: string }>(db, "SELECT id FROM captures WHERE status = 'failed'");
for (const c of failed) {
  run(db, "UPDATE captures SET status = 'queued', error = NULL WHERE id = ?", c.id);
  enqueue(db, "process_capture", { captureId: c.id }, { dedupeKey: `capture:${c.id}`, maxAttempts: 6 });
}
console.log(`requeued ${failed.length} failed capture(s)`);
db.close();

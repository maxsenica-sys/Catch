/**
 * Remove duplicates for every user, the same as Settings → Duplicates → Remove.
 * Runs beside the live server: dismissed tasks are delivered to Todoist by the
 * server's worker, which polls the jobs table.
 *
 *   node server/tools/clean-duplicates.ts
 */
import { loadConfig } from "../config.ts";
import { openDb, all } from "../db/db.ts";
import { localStorage } from "../storage.ts";
import type { Ctx, UserRow } from "../context.ts";
import { removeDuplicates } from "../pipeline/duplicates.ts";

const config = loadConfig({ schedulers: false });
const db = openDb(config.dataDir);
const ctx = { config, db, storage: localStorage(config.dataDir), worker: { kick() {} } } as unknown as Ctx;
for (const user of all<UserRow>(db, "SELECT * FROM users")) {
  const r = await removeDuplicates(ctx, user);
  console.log(`${user.email}: removed ${r.tasks} duplicate task(s), ${r.captures} duplicate capture(s)`);
}
db.close();

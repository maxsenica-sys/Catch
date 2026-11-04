import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PNG, action, extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { all, id, insert, nowIso, one } from "../server/db/db.ts";
import { enqueue } from "../server/jobs/queue.ts";

const OTHER_PNG = Buffer.concat([PNG, Buffer.from("different bytes")]);

async function setup() {
  const app = makeApp();
  const s = await signup(app);
  app.setExtraction(extraction({
    people: [person({ ref: "p1", name: "Riley Palmer", handles: [{ platform: "instagram", handle: "riley.p", url: null }] })],
    actions: [action({ title: "Upload Riley's 5-star Project V review to the website", person_ref: "p1" })],
  }));
  await s.capture({ images: [PNG] });
  await s.capture({ images: [PNG] }); // the same screenshot sent twice
  await s.capture({ images: [OTHER_PNG] });
  await settle(app);
  const user = one<any>(app.ctx.db, "SELECT * FROM users")!;
  const riley = one<any>(app.ctx.db, "SELECT id FROM contacts")!.id;
  // A copy that slipped past the import-time check (e.g. created before it existed).
  const sneak = (title: string, extra: Record<string, unknown> = {}) => {
    const taskId = id("tsk");
    insert(app.ctx.db, "tasks", { id: taskId, user_id: user.id, contact_id: riley, title, due_on: "2026-12-20", due_source: "default", created_at: nowIso(), ...extra });
    return taskId;
  };
  return { app, s, user, riley, sneak };
}

test("finds near-identical tasks for the same person and identical screenshots, and nothing else", async () => {
  const { app, s, sneak } = await setup();
  try {
    sneak("Upload Riley Palmer's 5-star review to the Project V website", { due_on: "2026-12-07", due_source: "stated", draft_message: "Thanks Riley!" });
    sneak("Invoice Riley for the shoulder program");
    // Identical wording for a DIFFERENT person is not a duplicate.
    const sam = id("con");
    insert(app.ctx.db, "contacts", { id: sam, user_id: one<any>(app.ctx.db, "SELECT id FROM users")!.id, name: "Sam Lee", created_at: nowIso(), updated_at: nowIso() });
    sneak("Upload Riley's 5-star Project V review to the website", { contact_id: sam });
    const report = await s.json("/api/duplicates");
    assert.equal(report.tasks.length, 1, JSON.stringify(report.tasks));
    assert.equal(report.tasks[0].remove.length, 1);
    assert.match(report.tasks[0].remove[0].title, /Riley Palmer's 5-star/);
    assert.equal(report.captures.length, 1, "only the byte-identical pair");
    assert.equal(report.captures[0].remove.length, 1);
    // Checking removes nothing.
    assert.equal(all(app.ctx.db, "SELECT id FROM tasks WHERE status = 'open'").length, 4);
    assert.equal(all(app.ctx.db, "SELECT id FROM captures").length, 3);
  } finally {
    await app.close();
  }
});

test("removing keeps the oldest, gives it the earlier date and the draft, dismisses the copy and tells Todoist", async () => {
  const { app, s, sneak } = await setup();
  try {
    const copy = sneak("Upload Riley Palmer's 5-star review to the Project V website", { due_on: "2026-12-07", due_source: "stated", draft_message: "Thanks Riley!" });
    const keepFiles = all<any>(app.ctx.db, "SELECT path FROM capture_files").map((f) => f.path);
    const r = await s.json("/api/duplicates/clean", { method: "POST" });
    assert.deepEqual(r, { tasks: 1, captures: 1 });

    const keeper = one<any>(app.ctx.db, "SELECT * FROM tasks WHERE title LIKE 'Upload Riley''s%'")!;
    assert.equal(keeper.status, "open");
    assert.equal(keeper.due_on, "2026-12-07");
    assert.equal(keeper.draft_message, "Thanks Riley!");
    assert.equal(one<any>(app.ctx.db, "SELECT status FROM tasks WHERE id = ?", copy)!.status, "dismissed", "dismissed, not erased");
    assert.ok(all<any>(app.ctx.db, "SELECT payload FROM jobs WHERE type = 'deliver'").some((j) => j.payload.includes(copy) && j.payload.includes("task.closed")));

    assert.equal(all(app.ctx.db, "SELECT id FROM captures").length, 2);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM contacts")!.n, 1, "people are never removed");
    const gone = keepFiles.filter((p) => !fs.existsSync(path.join(app.dir, "files", p)));
    assert.equal(gone.length, 1, "the duplicate capture's screenshot file was deleted from disk");

    assert.deepEqual(await s.json("/api/duplicates/clean", { method: "POST" }), { tasks: 0, captures: 0 }, "a second run finds nothing");
  } finally {
    await app.close();
  }
});

test("automatic removal runs with the 15-minute sweep only when switched on", async () => {
  const { app, s, user, sneak } = await setup();
  try {
    const copy = sneak("Upload Riley Palmer's 5-star review to the Project V website");
    enqueue(app.ctx.db, "followups_sweep", { userId: user.id });
    await settle(app);
    assert.equal(one<any>(app.ctx.db, "SELECT status FROM tasks WHERE id = ?", copy)!.status, "open", "off by default");

    await s.req("/api/me", { method: "PATCH", json: { settings: { autoDedupe: true } } });
    enqueue(app.ctx.db, "followups_sweep", { userId: user.id });
    await settle(app);
    assert.equal(one<any>(app.ctx.db, "SELECT status FROM tasks WHERE id = ?", copy)!.status, "dismissed");
    assert.equal(all(app.ctx.db, "SELECT id FROM captures").length, 2);
  } finally {
    await app.close();
  }
});

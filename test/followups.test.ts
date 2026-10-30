import { test } from "node:test";
import assert from "node:assert/strict";
import { action, extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { all, one, run } from "../server/db/db.ts";
import { sweepFollowups } from "../server/pipeline/followups.ts";
import { todayIn, addDays } from "../server/pipeline/dates.ts";

async function withLead() {
  const app = makeApp();
  const s = await signup(app);
  app.setExtraction(extraction({
    category: "lead",
    people: [person({ ref: "p1", name: "Kai Brown", handles: [{ platform: "instagram", handle: "kai.b", url: null }] })],
    actions: [action({ title: "DM Kai", person_ref: "p1", channel: "instagram" })],
  }));
  await s.capture({});
  await settle(app);
  const contact = one<any>(app.ctx.db, "SELECT * FROM contacts")!;
  const task = one<any>(app.ctx.db, "SELECT * FROM tasks")!;
  const user = one<any>(app.ctx.db, "SELECT * FROM users")!;
  return { app, s, contact, task, user };
}

test("ticking a task moves New -> Contacted and starts the follow-up clock", async () => {
  const { app, s, contact, task } = await withLead();
  try {
    assert.equal((await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } })).status, 200);
    const c = one<any>(app.ctx.db, "SELECT * FROM contacts WHERE id = ?", contact.id)!;
    assert.equal(c.stage, "contacted");
    assert.ok(c.next_followup_on > todayIn("Europe/Istanbul"));
    const events = all<any>(app.ctx.db, "SELECT kind FROM contact_events WHERE contact_id = ?", contact.id).map((e) => e.kind);
    assert.ok(events.includes("task_done"));
    // Idempotent: ticking again changes nothing.
    await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } });
    assert.equal(all(app.ctx.db, "SELECT 1 FROM contact_events WHERE kind = 'task_done'").length, 1);
  } finally {
    await app.close();
  }
});

test("the sweep raises one follow-up when the date comes, never a second while one is open", async () => {
  const { app, s, contact, task, user } = await withLead();
  try {
    await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } });
    const today = todayIn(user.timezone);
    assert.deepEqual(sweepFollowups(app.ctx.db, user), [], "not due yet");
    run(app.ctx.db, "UPDATE contacts SET next_followup_on = ? WHERE id = ?", addDays(today, -1), contact.id);
    const raised = sweepFollowups(app.ctx.db, user);
    assert.equal(raised.length, 1);
    const t = one<any>(app.ctx.db, "SELECT * FROM tasks WHERE id = ?", raised[0])!;
    assert.match(t.title, /Follow up with Kai Brown/);
    assert.equal(t.due_on, today);
    assert.equal(t.link, "https://instagram.com/kai.b");
    assert.deepEqual(sweepFollowups(app.ctx.db, user), [], "no duplicate while the follow-up is open");
    // Even if the date is set again by hand while that task is still open.
    run(app.ctx.db, "UPDATE contacts SET next_followup_on = ? WHERE id = ?", addDays(today, -1), contact.id);
    assert.deepEqual(sweepFollowups(app.ctx.db, user), [], "an open task always blocks a second follow-up");
  } finally {
    await app.close();
  }
});

test("after maxFollowups unanswered rounds the contact is parked, not nagged for ever", async () => {
  const { app, s, contact, task, user } = await withLead();
  try {
    await s.req("/api/me", { method: "PATCH", json: { settings: { maxFollowups: 2 } } });
    const u = one<any>(app.ctx.db, "SELECT * FROM users")!;
    await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } });
    const past = addDays(todayIn(user.timezone), -1);
    for (let round = 1; round <= 2; round++) {
      run(app.ctx.db, "UPDATE contacts SET next_followup_on = ? WHERE id = ?", past, contact.id);
      const [id] = sweepFollowups(app.ctx.db, u);
      assert.ok(id, `round ${round} raised`);
      await s.req(`/api/tasks/${id}`, { method: "PATCH", json: { status: "done" } });
    }
    run(app.ctx.db, "UPDATE contacts SET next_followup_on = ? WHERE id = ?", past, contact.id);
    assert.deepEqual(sweepFollowups(app.ctx.db, u), []);
    const c = one<any>(app.ctx.db, "SELECT * FROM contacts WHERE id = ?", contact.id)!;
    assert.equal(c.stage, "parked");
    assert.equal(c.next_followup_on, null);
  } finally {
    await app.close();
  }
});

test("a reply ends the chase: moving to Replied/Booked clears the follow-up date", async () => {
  const { app, s, contact, task } = await withLead();
  try {
    await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } });
    assert.ok(one<any>(app.ctx.db, "SELECT next_followup_on FROM contacts")!.next_followup_on);
    await s.req(`/api/contacts/${contact.id}`, { method: "PATCH", json: { stage: "booked" } });
    assert.equal(one<any>(app.ctx.db, "SELECT next_followup_on FROM contacts")!.next_followup_on, null);
  } finally {
    await app.close();
  }
});

test("snoozing and dismissing", async () => {
  const { app, s, task, user } = await withLead();
  try {
    const r = await s.json(`/api/tasks/${task.id}`, { method: "PATCH", json: { snooze_days: 7 } });
    assert.equal(r.task.due_on, addDays(todayIn(user.timezone), 7));
    await s.req(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: "dismissed" } });
    const c = one<any>(app.ctx.db, "SELECT * FROM contacts")!;
    assert.equal(c.stage, "new", "dismissing is not contacting");
  } finally {
    await app.close();
  }
});

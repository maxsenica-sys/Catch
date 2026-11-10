import { test } from "node:test";
import assert from "node:assert/strict";
import { action, extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { all, one } from "../server/db/db.ts";
import { todayIn } from "../server/pipeline/dates.ts";

test("a capture becomes a contact, a task with a link and draft, and a timeline entry", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      summary: "DM from a Brisbane setter asking about private sessions",
      people: [person({ ref: "p1", name: "Jess Taylor", position: "setter", location: "Brisbane", handles: [{ platform: "instagram", handle: "@Jess.Sets", url: null }] })],
      actions: [action({ title: "DM Jess re trial session", person_ref: "p1", channel: "instagram", due_date: "2026-12-07", draft_message: "Hey Jess! Keen to set up a trial." })],
    }));
    const res = await s.capture({ category: "coaching", transcript: "Jess wants sessions, DM her on the 7th" });
    assert.equal(res.status, 202);
    await settle(app);

    const cap = await s.json(`/api/captures/${res.capture.id}`);
    assert.equal(cap.capture.status, "done");
    assert.equal(cap.capture.transcript, "Jess wants sessions, DM her on the 7th");
    assert.equal(cap.capture.people[0].name, "Jess Taylor");
    const task = cap.capture.tasks[0];
    assert.equal(task.due_on, "2026-12-07");
    assert.equal(task.due_source, "stated");
    assert.equal(task.link, "https://instagram.com/jess.sets");
    assert.equal(task.draft_message, "Hey Jess! Keen to set up a trial.");

    // What the model was told.
    const call = app.extractCalls[0];
    assert.equal(call.categoryHint, "coaching");
    assert.equal(call.transcript, "Jess wants sessions, DM her on the 7th");
    assert.equal(call.images.length, 1);
    assert.equal(call.today, todayIn("Europe/Istanbul"));
    assert.ok(call.categories.some((c) => c.key === "lead"));
  } finally {
    await app.close();
  }
});

test("the same person captured again is updated, not duplicated; the stage only moves forward", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Jess Taylor", handles: [{ platform: "instagram", handle: "jess.sets", url: null }], stage: "booked" })],
    }));
    await s.capture({});
    await settle(app);
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "jess.sets", sport: "volleyball", stage: "new", facts: "U18 state team",
        handles: [{ platform: "instagram", handle: "https://instagram.com/jess.sets/" }, { platform: "email", handle: "Jess@Example.com", url: null }] as any })],
    }));
    await s.capture({});
    await settle(app);

    const contacts = all<any>(app.ctx.db, "SELECT * FROM contacts");
    assert.equal(contacts.length, 1, "matched on the Instagram handle despite a different name and URL form");
    const c = contacts[0];
    assert.equal(c.name, "Jess Taylor", "existing name is not overwritten");
    assert.equal(c.sport, "volleyball", "blank field filled");
    assert.equal(c.stage, "booked", "an old screenshot never demotes a contact");
    assert.equal(c.email, "jess@example.com");
    assert.match(c.notes, /U18 state team/);
    const handles = all<any>(app.ctx.db, "SELECT platform, handle FROM contact_handles ORDER BY platform");
    assert.deepEqual(handles.map((h) => `${h.platform}:${h.handle}`), ["email:jess@example.com", "instagram:jess.sets"]);
  } finally {
    await app.close();
  }
});

test("a first-name-only match creates a new contact and asks, rather than merging", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Sam Lee" })] }));
    await s.capture({});
    await settle(app);
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Sam" })] }));
    const res = await s.capture({});
    await settle(app);

    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM contacts")!.n, 2);
    const cap = await s.json(`/api/captures/${res.capture.id}`);
    assert.equal(cap.capture.status, "review");
    const review = await s.json("/api/review");
    assert.equal(review.items.length, 1);
    assert.equal(review.items[0].kind, "possible_duplicate");
    assert.equal(review.items[0].payload.candidates[0].name, "Sam Lee");

    // One tap: same person -> merged, capture done.
    const r = await s.req(`/api/review/${review.items[0].id}/resolve`, { method: "POST", json: { action: "merge", into: review.items[0].payload.candidates[0].id } });
    assert.equal(r.status, 200);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM contacts")!.n, 1);
    assert.equal((await s.json(`/api/captures/${res.capture.id}`)).capture.status, "done");
  } finally {
    await app.close();
  }
});

test("same full name with a different handle on the same platform is a namesake, not a match", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Alex Smith", handles: [{ platform: "instagram", handle: "alex.one", url: null }] })] }));
    await s.capture({});
    await settle(app);
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Alex Smith", handles: [{ platform: "instagram", handle: "alex.two", url: null }] })] }));
    await s.capture({});
    await settle(app);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM contacts")!.n, 2);
  } finally {
    await app.close();
  }
});

test("no stated date: the category's default applies; a new chased person always gets something to do", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      category: "lead",
      people: [person({ ref: "p1", name: "Kai Brown" }), person({ ref: "p2", name: "Mia Chen" })],
      actions: [action({ title: "Send Kai the price list", person_ref: "p1" })],
    }));
    await s.capture({});
    await settle(app);
    const tasks = all<any>(app.ctx.db, "SELECT t.*, c.name FROM tasks t JOIN contacts c ON c.id = t.contact_id ORDER BY t.title");
    assert.equal(tasks.length, 2);
    const kai = tasks.find((t) => t.name === "Kai Brown");
    const mia = tasks.find((t) => t.name === "Mia Chen");
    assert.equal(kai.due_source, "default");
    assert.equal(mia.title, "Reach out to Mia Chen");
    assert.equal(mia.kind, "followup");
    const contacts = all<any>(app.ctx.db, "SELECT next_followup_on FROM contacts");
    assert.ok(contacts.every((c) => c.next_followup_on === null), "an open task is the follow-up; no date until it is done");
  } finally {
    await app.close();
  }
});

test("program-type captures do not chase people", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({ category: "program", people: [person({ ref: "p1", name: "Coach Dan" })] }));
    await s.capture({});
    await settle(app);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM tasks")!.n, 0);
  } finally {
    await app.close();
  }
});

test("an implausible date is dropped and reported, appointments are filed, low confidence asks", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      confidence: 0.2,
      people: [person({ ref: "p1", name: "Ruby Park" })],
      actions: [action({ title: "Invoice Ruby", person_ref: "p1", due_date: "2099-01-01" })],
      appointments: [
        { title: "Trial session with Ruby", person_ref: "p1", date: "2026-12-05", start_time: "09:00", end_time: "10:00", location: "Gym" },
        { title: "Mystery", person_ref: null, date: "next week", start_time: null, end_time: null, location: null },
      ],
    }));
    const res = await s.capture({});
    await settle(app);
    const cap = (await s.json(`/api/captures/${res.capture.id}`)).capture;
    assert.equal(cap.status, "review");
    assert.deepEqual(cap.reviews.map((r: any) => r.kind).sort(), ["date_dropped", "date_dropped", "low_confidence"]);
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].start_time, "09:00");
    const notes = one<any>(app.ctx.db, "SELECT notes FROM events")!.notes;
    assert.match(notes, /With Ruby Park/, "the calendar entry says who it is with");
    assert.equal(cap.tasks[0].due_source, "default");
  } finally {
    await app.close();
  }
});

test("upload is idempotent on client_id, and a capture is never applied twice", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Zoe King" })], actions: [action({ title: "Call Zoe", person_ref: "p1" })] }));
    const a = await s.capture({ client_id: "same-id" });
    const b = await s.capture({ client_id: "same-id" });
    assert.equal(a.status, 202);
    assert.equal(b.status, 200);
    assert.equal(b.duplicate, true);
    assert.equal(a.capture.id, b.capture.id);
    await settle(app);
    // Force the job to run again, as a crash-and-retry would.
    const { processCapture } = await import("../server/pipeline/process.ts");
    await processCapture(app.ctx, a.capture.id);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM captures")!.n, 1);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM tasks")!.n, 1);
    assert.equal(app.extractCalls.length, 1);
  } finally {
    await app.close();
  }
});

test("a failing extractor retries, then marks the capture failed with the reason; retry recovers it", async () => {
  let fail = true;
  const app = makeApp({
    extractor: {
      name: "flaky",
      async extract() {
        if (fail) throw new Error("model overloaded");
        return extraction({ summary: "Recovered" });
      },
    },
  });
  try {
    const s = await signup(app);
    const res = await s.capture({ transcript: "hello" });
    for (let i = 0; i < 6; i++) {
      await app.ctx.worker.drain();
      app.ctx.db.prepare("UPDATE jobs SET run_after = ? WHERE status = 'queued'").run(new Date(0).toISOString());
    }
    let cap = (await s.json(`/api/captures/${res.capture.id}`)).capture;
    assert.equal(cap.status, "failed");
    assert.match(cap.error, /overloaded/);
    assert.equal(cap.transcript, "hello", "the transcript is kept, so a retry does not pay for it twice");

    fail = false;
    assert.equal((await s.req(`/api/captures/${res.capture.id}/retry`, { method: "POST" })).status, 200);
    await settle(app);
    cap = (await s.json(`/api/captures/${res.capture.id}`)).capture;
    assert.equal(cap.status, "done");
    assert.equal(cap.summary, "Recovered");
  } finally {
    await app.close();
  }
});

test("the same task captured twice is not created twice; a different task for the same person is", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    const riley = person({ ref: "p1", name: "Riley Palmer", handles: [{ platform: "instagram", handle: "riley.p", url: null }] });
    app.setExtraction(extraction({ people: [riley], actions: [action({ title: "Upload Riley's 5-star Project V review to the website", person_ref: "p1", due_date: "2026-12-09" })] }));
    await s.capture({});
    await settle(app);
    app.setExtraction(extraction({ people: [riley], actions: [
      action({ title: "Upload Riley Palmer's 5-star review to the Project V website", person_ref: "p1", due_date: "2026-12-07" }),
      action({ title: "Create content around Riley's Project V shoulder program review", person_ref: "p1" }),
    ] }));
    await s.capture({});
    await settle(app);
    const tasks = all<any>(app.ctx.db, "SELECT title, due_on FROM tasks ORDER BY created_at");
    assert.equal(tasks.length, 2, JSON.stringify(tasks));
    assert.equal(tasks[0].due_on, "2026-12-07", "the earlier stated date moved the existing task forward");
    assert.match(tasks[1].title, /Create content/);
  } finally {
    await app.close();
  }
});

test("Instagram is a channel, not a category: shipped default migrated, customised rows left alone", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../server/db/migrations.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS[0]);
  const ins = db.prepare("INSERT INTO users (id, email, password_hash, feed_token, created_at) VALUES (?, ?, 'x', ?, 'now')");
  ins.run("u1", "a@x", "f1");
  ins.run("u2", "b@x", "f2");
  const cat = db.prepare("INSERT INTO categories (id, user_id, key, name, guidance, todoist_label, created_at) VALUES (?, ?, 'instagram', 'Instagram', ?, 'Instagram', 'now')");
  cat.run("c1", "u1", "DMs, comments and mentions on Instagram that need a reply, plus content ideas seen there.");
  cat.run("c2", "u2", "My own words about Instagram");
  db.exec(MIGRATIONS[1]);
  const rows = db.prepare("SELECT user_id, name, todoist_label, tracks_people, guidance FROM categories ORDER BY user_id").all() as any[];
  assert.equal(rows[0].name, "Instagram content");
  assert.equal(rows[0].todoist_label, "Content");
  assert.equal(rows[0].tracks_people, 0);
  assert.match(rows[0].guidance, /NOT people who message/);
  assert.equal(rows[1].name, "Instagram", "a category the user rewrote is theirs");
  assert.equal(rows[1].guidance, "My own words about Instagram");

  const { SYSTEM_PROMPT } = await import("../server/pipeline/extract.ts");
  assert.match(SYSTEM_PROMPT, /Category is WHAT it is about; channel is WHERE to reply/);
  const { DEFAULT_CATEGORIES } = await import("../server/categories.ts");
  assert.equal(DEFAULT_CATEGORIES.find((c) => c.key === "instagram")!.guidance, rows[0].guidance, "new accounts and migrated accounts agree");
});

test("the model sees people and open tasks on file: a refined request updates the existing task and person", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Billy Hart", first_name: "Billy", handles: [{ platform: "instagram", handle: "billy.h", url: null }] })],
      actions: [action({ title: "Build 4-6 week vertical jump program for Billy", person_ref: "p1" })],
    }));
    await s.capture({});
    await settle(app);

    app.setExtraction((input) => {
      const billy = input.known!.find((k) => k.name === "Billy Hart")!;
      assert.ok(billy, "Billy is listed as on file");
      assert.equal(billy.tasks[0].title, "Build 4-6 week vertical jump program for Billy");
      return extraction({
        people: [person({ ref: "p1", name: "Billy", known_ref: billy.ref })],
        actions: [
          action({ title: "Design original arm-swing and vertical program for Billy", person_ref: "p1", existing_task: billy.tasks[0].ref, due_date: "2026-12-04" }),
          action({ title: "Send Billy his program on Instagram", person_ref: "p1", channel: "instagram" }),
        ],
      });
    });
    const second = await s.capture({});
    await settle(app);

    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM contacts")!.n, 1, "first name only, but the model placed him and the names agree");
    assert.equal((await s.json(`/api/captures/${second.capture.id}`)).capture.status, "done", "no 'same person?' question needed");
    const tasks = all<any>(app.ctx.db, "SELECT title, due_on FROM tasks ORDER BY created_at");
    assert.equal(tasks.length, 2, JSON.stringify(tasks));
    assert.equal(tasks[0].title, "Design original arm-swing and vertical program for Billy", "the existing task took the refined wording");
    assert.equal(tasks[0].due_on, "2026-12-04");
    assert.ok(all<any>(app.ctx.db, "SELECT payload FROM jobs WHERE type = 'deliver'").some((j) => j.payload.includes("task.updated")), "integrations are told");
  } finally {
    await app.close();
  }
});

test("model matches are checked: a wrong name is not merged, and a task is never moved to another person", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Billy Hart" })],
      actions: [action({ title: "Build Billy's vertical jump program", person_ref: "p1" })],
    }));
    await s.capture({});
    await settle(app);
    app.setExtraction((input) => {
      const billy = input.known![0];
      return extraction({
        people: [person({ ref: "p1", name: "Sam", known_ref: billy.ref })],
        actions: [action({ title: "Send Sam the price list", person_ref: "p1", existing_task: billy.tasks[0].ref })],
      });
    });
    await s.capture({});
    await settle(app);
    const people = all<any>(app.ctx.db, "SELECT name FROM contacts ORDER BY created_at").map((c) => c.name);
    assert.deepEqual(people, ["Billy Hart", "Sam"]);
    const tasks = all<any>(app.ctx.db, "SELECT title FROM tasks ORDER BY created_at").map((t) => t.title);
    assert.deepEqual(tasks, ["Build Billy's vertical jump program", "Send Sam the price list"]);
  } finally {
    await app.close();
  }
});

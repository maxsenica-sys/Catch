/**
 * Google Calendar via Apps Script. The generated script itself is executed in a
 * vm with stand-ins for Google's CalendarApp, so both halves are under test:
 * what Catch sends, and what the script does with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { all, one, run } from "../server/db/db.ts";
import { enqueue } from "../server/jobs/queue.ts";

const URL_ = "https://script.google.com/macros/s/TEST/exec";

function fakeGoogle(scriptTz = "Europe/Istanbul") {
  const events: { id: string; title: string; start?: Date; end?: Date; day?: Date; opts: any }[] = [];
  const props = new Map<string, string>();
  const cal = {
    getName: () => "maxsenica@hotmail.com",
    createEvent: (title: string, start: Date, end: Date, opts: any) => add({ title, start, end, opts }),
    createAllDayEvent: (title: string, day: Date, opts: any) => add({ title, day, opts }),
    getEventById: (id: string) => {
      const i = events.findIndex((e) => e.id === id);
      return i === -1 ? null : { deleteEvent() { events.splice(i, 1); } };
    },
  };
  let made = 0;
  function add(e: any) {
    const ev = { id: `g${++made}@google.com`, ...e };
    events.push(ev);
    return { getId: () => ev.id };
  }
  const sandbox: any = {
    CalendarApp: { getDefaultCalendar: () => cal, getCalendarById: () => cal },
    Session: { getScriptTimeZone: () => scriptTz },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t: string) => ({ text: t, setMimeType() { return this; } }) },
  };
  vm.createContext(sandbox);
  let html = false;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== URL_) return new Response("not found", { status: 404 });
    if (html) return new Response("<html>Sign in - Google Accounts</html>", { status: 200 });
    return new Response(sandbox.doPost({ postData: { contents: String(init!.body) } }).text);
  }) as typeof globalThis.fetch;
  return {
    events, sandbox, fetch,
    load(script: string) { vm.runInContext(script, sandbox); },
    serveSignInPage() { html = true; },
  };
}

async function connected(scriptTz?: string) {
  const g = fakeGoogle(scriptTz);
  const app = makeApp({ fetch: g.fetch });
  const s = await signup(app);
  const script = await (await s.req("/api/integrations/google_calendar/script")).text();
  g.load(script);
  await s.req("/api/integrations/google_calendar", { method: "PUT", json: { enabled: true, config: { url: URL_ } } });
  return { app, s, g, script };
}

test("the script carries a per-user key that stays the same, and is never returned in settings", async () => {
  const { app, s, script } = await connected();
  try {
    const again = await (await s.req("/api/integrations/google_calendar/script")).text();
    assert.equal(script, again, "fetching it twice gives the same key");
    const key = script.match(/var KEY = '([^']+)'/)![1];
    assert.ok(key.length >= 24);
    assert.ok(!JSON.stringify(await s.json("/api/integrations")).includes(key));
    assert.match(script, /Time zone must be Europe\/Istanbul/);
  } finally {
    await app.close();
  }
});

test("connect test checks the script's time zone against the user's", async () => {
  const ok = await connected("Europe/Istanbul");
  try {
    const r = await ok.s.json("/api/integrations/google_calendar/test", { method: "POST" });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally {
    await ok.app.close();
  }
  const off = await connected("America/Los_Angeles");
  try {
    const r = await off.s.json("/api/integrations/google_calendar/test", { method: "POST" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Project Settings, set the time zone to Europe\/Istanbul/);
  } finally {
    await off.app.close();
  }
});

test("appointments land in Google instantly: right instant, all-day on the right day, who it is with", async () => {
  const { app, s, g } = await connected();
  try {
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Kai Brown", handles: [{ platform: "instagram", handle: "kai.hits", url: null }] })],
      appointments: [
        { title: "Private coaching session with Kai Brown", person_ref: "p1", date: "2026-12-05", start_time: "09:00", end_time: "10:30", location: "Gabba courts" },
        { title: "Trial day", person_ref: null, date: "2026-12-06", start_time: null, end_time: null, location: null },
      ],
    }));
    await s.capture({});
    await settle(app);
    const bookings = () => g.events.filter((e) => !e.title.startsWith("☐"));
    assert.equal(bookings().length, 2);
    const timed = bookings().find((e) => e.start)!;
    assert.equal(timed.start!.toISOString(), "2026-12-05T06:00:00.000Z", "09:00 Istanbul");
    assert.equal(timed.end!.toISOString(), "2026-12-05T07:30:00.000Z");
    assert.equal(timed.opts.location, "Gabba courts");
    assert.match(timed.opts.description, /With Kai Brown/);
    assert.match(timed.opts.description, /instagram\.com\/kai\.hits/);
    const day = bookings().find((e) => e.day)!;
    assert.deepEqual([day.day!.getFullYear(), day.day!.getMonth() + 1, day.day!.getDate()], [2026, 12, 6], "built from its parts, not an instant");

    // The .ics feed no longer lists what Google already has.
    const me = await s.json("/api/me");
    const ics = await (await app.app.request(new URL(me.feed_url).pathname)).text();
    assert.ok(!ics.includes("Kai Brown") && !ics.includes("Trial day"), ics);

    // A create retried after a lost response: the script returns the same event.
    run(app.ctx.db, "DELETE FROM deliveries WHERE integration = 'google_calendar'");
    const { deliver } = await import("../server/integrations/index.ts");
    const userId = one<any>(app.ctx.db, "SELECT id FROM users")!.id;
    for (const e of all<any>(app.ctx.db, "SELECT id FROM events")) await deliver(app.ctx, { userId, event: "event.created", objectId: e.id });
    assert.equal(bookings().length, 2, "no second copy in the calendar");
  } finally {
    await app.close();
  }
});

test("a wrong key or a deployment that is not public is reported plainly, and not retried for ever", async () => {
  const { app, s, g } = await connected();
  try {
    g.sandbox.KEY = "something-else";
    let r = await s.json("/api/integrations/google_calendar/test", { method: "POST" });
    assert.match(r.error, /wrong key/);
    g.serveSignInPage();
    r = await s.json("/api/integrations/google_calendar/test", { method: "POST" });
    assert.match(r.error, /Who has access: Anyone/);
  } finally {
    await app.close();
  }
});

test("tasks show as to-dos on their due day, move when snoozed, leave when done, and obey the switch", async () => {
  const { app, s, g } = await connected();
  try {
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Riley Palmer" })],
      actions: [{ ...extraction({}).actions[0], title: "DM Riley to thank him", existing_task: null, person_ref: "p1", channel: "instagram", due_date: "2026-12-07", due_time: null, due_evidence: null, priority: 2, draft_message: "Thanks Riley!", category: null } as any],
    }));
    await s.capture({});
    await settle(app);
    const todos = () => g.events.filter((e) => e.title.startsWith("☐"));
    assert.equal(todos().length, 1);
    assert.equal(todos()[0].title, "☐ DM Riley to thank him");
    assert.deepEqual([todos()[0].day!.getFullYear(), todos()[0].day!.getMonth() + 1, todos()[0].day!.getDate()], [2026, 12, 7]);
    assert.match(todos()[0].opts.description, /Draft: Thanks Riley!/);

    const taskId = one<any>(app.ctx.db, "SELECT id FROM tasks")!.id;
    await s.req(`/api/tasks/${taskId}`, { method: "PATCH", json: { due_on: "2026-12-09" } });
    await settle(app);
    assert.equal(todos().length, 1, "moved, not copied");
    assert.equal(todos()[0].day!.getDate(), 9);

    await s.req(`/api/tasks/${taskId}`, { method: "PATCH", json: { status: "done" } });
    await settle(app);
    assert.equal(todos().length, 0, "ticked off: gone from the calendar");

    // Switched off: new tasks stay off the calendar; switched back on: the backfill adds them.
    await s.req("/api/me", { method: "PATCH", json: { settings: { tasksOnCalendar: false } } });
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Kai Brown" })] }));
    await s.capture({});
    await settle(app);
    assert.equal(todos().length, 0);
    await s.req("/api/me", { method: "PATCH", json: { settings: { tasksOnCalendar: true } } });
    await s.req("/api/integrations/google_calendar/backfill", { method: "POST" });
    await settle(app);
    assert.equal(todos().length, 1);
    assert.match(todos()[0].title, /Reach out to Kai Brown/);
  } finally {
    await app.close();
  }
});

test("overdue to-dos go on today, say so, and move forward once a day until ticked", async () => {
  const { app, s, g } = await connected();
  try {
    const { todayIn, addDays } = await import("../server/pipeline/dates.ts");
    const today = todayIn("Europe/Istanbul");
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Billy Hart" })],
      actions: [{ title: "Send Billy his program", existing_task: null, person_ref: "p1", channel: "instagram", due_date: addDays(today, -3), due_time: null, due_evidence: null, priority: 2, draft_message: null, category: null } as any],
    }));
    await s.capture({});
    await settle(app);
    const todos = () => g.events.filter((e) => e.title.startsWith("☐"));
    // decideDue clamps a past stated date to today; make it genuinely overdue, as tasks become after their day passes.
    const taskId = one<any>(app.ctx.db, "SELECT id FROM tasks")!.id;
    run(app.ctx.db, "UPDATE tasks SET due_on = ? WHERE id = ?", addDays(today, -3), taskId);
    run(app.ctx.db, "DELETE FROM deliveries WHERE integration = 'google_calendar'");
    for (const e of [...todos()]) g.events.splice(g.events.indexOf(e), 1);
    await s.req("/api/integrations/google_calendar/backfill", { method: "POST" });
    await settle(app);
    assert.equal(todos().length, 1);
    const day = todos()[0].day!;
    assert.equal(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`, today, "placed on today, not on its past due day");
    assert.match(todos()[0].title, /\(overdue since /);

    const user = one<any>(app.ctx.db, "SELECT * FROM users")!;
    const placedId = () => one<any>(app.ctx.db, "SELECT external_id FROM deliveries WHERE integration = 'google_calendar' AND object_id = ?", taskId)!.external_id;
    const first = placedId();
    enqueue(app.ctx.db, "followups_sweep", { userId: user.id });
    await settle(app);
    assert.equal(placedId(), first, "already on today: not moved again");

    run(app.ctx.db, "UPDATE deliveries SET updated_at = ? WHERE integration = 'google_calendar'", new Date(Date.now() - 2 * 86_400_000).toISOString());
    enqueue(app.ctx.db, "followups_sweep", { userId: user.id });
    await settle(app);
    assert.notEqual(placedId(), first, "yesterday's to-do was moved onto today");
    assert.equal(todos().length, 1, "moved, not copied");
  } finally {
    await app.close();
  }
});

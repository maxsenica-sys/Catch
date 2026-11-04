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

const URL_ = "https://script.google.com/macros/s/TEST/exec";

function fakeGoogle(scriptTz = "Europe/Istanbul") {
  const events: { id: string; title: string; start?: Date; end?: Date; day?: Date; opts: any }[] = [];
  const props = new Map<string, string>();
  const cal = {
    getName: () => "maxsenica@hotmail.com",
    createEvent: (title: string, start: Date, end: Date, opts: any) => add({ title, start, end, opts }),
    createAllDayEvent: (title: string, day: Date, opts: any) => add({ title, day, opts }),
    getEventById: (id: string) => events.find((e) => e.id === id) ? { deleteEvent() {} } : null,
  };
  function add(e: any) {
    const ev = { id: `g${events.length + 1}@google.com`, ...e };
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
    assert.equal(g.events.length, 2);
    const timed = g.events.find((e) => e.start)!;
    assert.equal(timed.start!.toISOString(), "2026-12-05T06:00:00.000Z", "09:00 Istanbul");
    assert.equal(timed.end!.toISOString(), "2026-12-05T07:30:00.000Z");
    assert.equal(timed.opts.location, "Gabba courts");
    assert.match(timed.opts.description, /With Kai Brown/);
    assert.match(timed.opts.description, /instagram\.com\/kai\.hits/);
    const day = g.events.find((e) => e.day)!;
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
    assert.equal(g.events.length, 2, "no second copy in the calendar");
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

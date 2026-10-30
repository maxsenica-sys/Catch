import { test } from "node:test";
import assert from "node:assert/strict";
import { HEIC, PNG, extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { csv } from "../server/feeds.ts";

test("first account is owner; invite mode gates the rest; wrong password is refused", async () => {
  const app = makeApp({ config: { signupMode: "invite", inviteCode: "volley" } });
  try {
    await signup(app, "owner@example.com");
    const denied = await app.app.request("/api/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b@example.com", password: "password123", invite: "nope" }),
    });
    assert.equal(denied.status, 403);
    await signup(app, "b@example.com", { invite: "volley" });
    const bad = await app.app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "b@example.com", password: "wrong-password" }),
    });
    assert.equal(bad.status, 401);
    const owner = await app.app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "OWNER@example.com", password: "password123" }),
    });
    assert.equal(owner.status, 200, "email is case-insensitive");
  } finally {
    await app.close();
  }
});

test("cookie writes need X-Catch (CSRF); API tokens work without it and can be revoked", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    const noHeader = await s.req("/api/me", { method: "PATCH", json: { name: "x" }, headers: { "x-catch": "0" } });
    assert.equal(noHeader.status, 403);
    const { token, id } = await s.json("/api/tokens", { method: "POST", json: { name: "Shortcut" } });
    assert.match(token, /^catch_/);
    const fd = new FormData();
    fd.append("note", "Call Sam tomorrow");
    const viaToken = await app.app.request("/api/captures", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd });
    assert.equal(viaToken.status, 202);
    await s.req(`/api/tokens/${id}`, { method: "DELETE" });
    const revoked = await app.app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(revoked.status, 401);
  } finally {
    await app.close();
  }
});

test("one user can never see another's captures, files or contacts", async () => {
  const app = makeApp();
  try {
    const a = await signup(app, "a@example.com");
    const b = await signup(app, "b@example.com");
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Private Person" })] }));
    const cap = await a.capture({});
    await settle(app);
    const full = (await a.json(`/api/captures/${cap.capture.id}`)).capture;
    assert.equal((await b.req(`/api/captures/${cap.capture.id}`)).status, 404);
    assert.equal((await b.req(`/api/files/${full.files[0].id}`)).status, 404);
    assert.equal((await b.req(`/api/contacts/${full.people[0].id}`)).status, 404);
    assert.equal((await b.json("/api/contacts")).contacts.length, 0);
    assert.equal((await b.req(`/api/contacts/${full.people[0].id}/vcard`)).status, 404);
    assert.equal((await a.req(`/api/files/${full.files[0].id}`)).status, 200);
  } finally {
    await app.close();
  }
});

test("uploads: HEIC and non-images are refused clearly; an empty capture is refused", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    const heic = await s.capture({ images: [HEIC] });
    assert.equal(heic.status, 415);
    assert.match(heic.error, /HEIC/);
    const junk = await s.capture({ images: [Buffer.from("not an image at all")] });
    assert.equal(junk.status, 415);
    const fd = new FormData();
    fd.append("client_id", "x");
    assert.equal((await s.req("/api/captures", { method: "POST", body: fd })).status, 400);
    const ok = await s.capture({ images: [PNG] });
    assert.equal(ok.status, 202);
  } finally {
    await app.close();
  }
});

test("calendar feed: secret URL, timed events in UTC, all-day as bare dates; vCard and CSV exports", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Jess Taylor", handles: [{ platform: "instagram", handle: "jess.sets", url: null }, { platform: "phone", handle: "+61 400 111 222", url: null }] })],
      appointments: [
        { title: "Trial, Jess", person_ref: "p1", date: "2026-12-05", start_time: "09:00", end_time: "10:30", location: "Gym; court 2" },
        { title: "Camp", person_ref: null, date: "2026-12-06", start_time: null, end_time: null, location: null },
      ],
    }));
    await s.capture({});
    await settle(app);
    const me = await s.json("/api/me");
    const path = new URL(me.feed_url).pathname;
    const ics = await (await app.app.request(path)).text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /DTSTART:20261205T060000Z/, "09:00 Istanbul");
    assert.match(ics, /DTEND:20261205T073000Z/);
    assert.match(ics, /LOCATION:Gym\\; court 2/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261206/);
    assert.match(ics, /DTEND;VALUE=DATE:20261207/);
    assert.equal((await app.app.request("/feeds/wrong-token/calendar.ics")).status, 404);

    const contactId = (await s.json("/api/contacts")).contacts[0].id;
    const card = await (await s.req(`/api/contacts/${contactId}/vcard`)).text();
    assert.match(card, /FN:Jess Taylor/);
    assert.match(card, /TEL;TYPE=CELL:\+61400111222/);
    assert.match(card, /X-SOCIALPROFILE;TYPE=instagram:https:\/\/instagram.com\/jess.sets/);
    const exported = await (await s.req("/api/export/contacts.csv")).text();
    assert.match(exported, /Jess Taylor/);
  } finally {
    await app.close();
  }
});

test("CSV export neutralises spreadsheet formulas", () => {
  const out = csv([{ name: "=HYPERLINK(\"http://x\")", notes: "a,b" }], ["name", "notes"]);
  assert.match(out, /^name,notes\r\n"'=HYPERLINK\(""http:\/\/x""\)","a,b"/);
});

test("healthz reports which providers are live", async () => {
  const app = makeApp();
  try {
    const h = (await (await app.app.request("/healthz")).json()) as any;
    assert.equal(h.ok, true);
    assert.equal(h.transcriber, "mock");
  } finally {
    await app.close();
  }
});

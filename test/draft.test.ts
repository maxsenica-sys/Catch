/**
 * The Photos share-sheet route: an iOS Shortcut uploads screenshots one at a
 * time to an open draft, then finishes it with the voice note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG, action, extraction, makeApp, person, settle, signup } from "./helpers.ts";
import { MOCK_TRANSCRIPT_MARKER } from "../server/pipeline/transcribe.ts";
import { sweepDrafts } from "../server/http/routes-captures.ts";
import { all, one, run } from "../server/db/db.ts";

function form(fields: { image?: Buffer; audio?: string; category?: string }) {
  const fd = new FormData();
  if (fields.image) fd.append("image", new Blob([new Uint8Array(fields.image)], { type: "image/jpeg" }), "s.jpg");
  if (fields.audio) fd.append("audio", new Blob([Buffer.from(MOCK_TRANSCRIPT_MARKER + fields.audio)], { type: "audio/x-m4a" }), "Recording.m4a");
  if (fields.category) fd.append("category", fields.category);
  return fd;
}

test("screenshots sent one by one join one draft; finishing with voice files it once", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    const { token } = await s.json("/api/tokens", { method: "POST", json: { name: "Shortcut" } });
    const bearer = { authorization: `Bearer ${token}` };
    const post = (path: string, body: FormData) => app.app.request(path, { method: "POST", headers: bearer, body });

    const a = await (await post("/api/captures/draft", form({ image: PNG }))).json() as any;
    const b = await (await post("/api/captures/draft", form({ image: PNG }))).json() as any;
    assert.equal(a.capture.id, b.capture.id, "the second screenshot joins the open draft");
    assert.equal(b.capture.status, "draft");
    assert.equal(b.capture.files.length, 2);
    await settle(app);
    assert.equal(app.extractCalls.length, 0, "a draft is not processed");

    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "Jess Taylor" })], actions: [action({ title: "DM Jess", person_ref: "p1" })] }));
    const fin = await post("/api/captures/draft/finish", form({ audio: "This is Jess, DM her Monday", category: "lead" }));
    assert.equal(fin.status, 202);
    await settle(app);
    const cap = (await s.json(`/api/captures/${a.capture.id}`)).capture;
    assert.equal(cap.status, "done");
    assert.equal(cap.category_hint, "lead");
    assert.equal(cap.transcript, "This is Jess, DM her Monday");
    assert.equal(app.extractCalls.length, 1);
    assert.equal(app.extractCalls[0].images.length, 2);

    // The Shortcut retrying the finish on weak signal: same capture back, nothing new.
    const again = await post("/api/captures/draft/finish", form({ audio: "This is Jess, DM her Monday" }));
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as any).capture.id, a.capture.id);
    assert.equal(one<any>(app.ctx.db, "SELECT COUNT(*) AS n FROM captures")!.n, 1);

    // Nothing open and nothing sent: a clear 404, not an empty capture.
    assert.equal((await post("/api/captures/draft/finish", new FormData())).status, 404);
  } finally {
    await app.close();
  }
});

test("a draft nobody finished is filed with its screenshots after 10 minutes", async () => {
  const app = makeApp();
  try {
    const s = await signup(app);
    const r = await s.req("/api/captures/draft", { method: "POST", body: form({ image: PNG }) });
    const draftId = ((await r.json()) as any).capture.id;
    assert.equal(sweepDrafts(app.ctx), 0, "still open");
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    run(app.ctx.db, "UPDATE capture_files SET created_at = ?", old);
    run(app.ctx.db, "UPDATE captures SET created_at = ?", old);
    assert.equal(sweepDrafts(app.ctx), 1);
    await settle(app);
    assert.equal(one<any>(app.ctx.db, "SELECT status FROM captures WHERE id = ?", draftId)!.status, "done");

    // And a new screenshot after that starts a fresh draft rather than reopening a filed one.
    const next = await s.req("/api/captures/draft", { method: "POST", body: form({ image: PNG }) });
    assert.notEqual(((await next.json()) as any).capture.id, draftId);
    assert.equal(all(app.ctx.db, "SELECT id FROM captures").length, 2);
  } finally {
    await app.close();
  }
});

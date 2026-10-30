/**
 * The live extractor, pointed at a local stand-in for the Anthropic API, so
 * the request Catch sends and its handling of every kind of answer are checked
 * without a key or the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { anthropicExtractor } from "../server/pipeline/extract.ts";
import { mockExtractor } from "../server/pipeline/mock-extractor.ts";
import { EXTRACTION_JSON_SCHEMA, Extraction } from "../server/pipeline/schema.ts";
import { PermanentError } from "../server/jobs/queue.ts";
import { PNG, extraction } from "./helpers.ts";

const input = {
  images: [{ mime: "image/png", data: PNG }, { mime: "image/heic", data: PNG }],
  transcript: "This is Jess, DM her Monday",
  note: "",
  categoryHint: null,
  categories: [{ key: "coaching", name: "Coaching", guidance: "Athletes" }],
  now: "Friday 30 October 2026, 12:00 (Europe/Istanbul)",
  today: "2026-10-30",
  dateOrder: "DMY" as const,
  userName: "Max",
};

async function withApi(respond: (body: any, headers: http.IncomingHttpHeaders) => { status?: number; json: unknown }) {
  const seen: { body: any; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const out = respond(body, req.headers);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

const message = (text: string, stop_reason = "end_turn", extra: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason, stop_sequence: null,
  content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, ...extra,
});

test("request: model, effort, JSON schema, fallbacks, images (HEIC skipped) then context text", async () => {
  const api = await withApi(() => ({ json: message(JSON.stringify(extraction({ summary: "ok" }))) }));
  try {
    const ex = anthropicExtractor({ apiKey: "sk-test", model: "claude-opus-5-5", effort: "medium", baseURL: api.url });
    const out = await ex.extract(input);
    assert.equal(out.summary, "ok");
    const { body, headers } = api.seen[0];
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.output_config.effort, "medium");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.deepEqual(body.output_config.format.schema, JSON.parse(JSON.stringify(EXTRACTION_JSON_SCHEMA)));
    assert.equal(body.fallbacks, "default");
    assert.match(String(headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    // SDK 1.x sends the key as a bearer token; older versions used x-api-key.
    assert.ok(headers.authorization === "Bearer sk-test" || headers["x-api-key"] === "sk-test");
    const content = body.messages[0].content;
    assert.equal(content.filter((b: any) => b.type === "image").length, 1, "HEIC is not sent");
    assert.equal(content.at(-1).type, "text");
    assert.match(content.at(-1).text, /Today is 2026-10-30/);
    assert.match(content.at(-1).text, /day first/);
    assert.match(content.at(-1).text, /DM her Monday/);
    assert.equal(typeof body.system, "string");
    assert.ok(!body.system.includes("2026"), "system prompt is static (cacheable)");
  } finally {
    await api.close();
  }
});

test("a refusal or a bad key is permanent; overload and malformed output are retryable", async () => {
  const cases: [string, () => { status?: number; json: unknown }, (e: unknown) => boolean][] = [
    ["refusal", () => ({ json: message("", "refusal", { stop_details: { type: "refusal", category: null, explanation: "no" } }) }), (e) => e instanceof PermanentError],
    ["401", () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad key" } } }), (e) => e instanceof PermanentError && /API key/.test((e as Error).message)],
    ["400", () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "nope" } } }), (e) => e instanceof PermanentError],
    ["not json", () => ({ json: message("I think this is Jess") }), (e) => !(e instanceof PermanentError) && /not valid JSON/.test((e as Error).message)],
    ["wrong shape", () => ({ json: message(JSON.stringify({ summary: "x" })) }), (e) => !(e instanceof PermanentError) && /schema/.test((e as Error).message)],
    ["max_tokens", () => ({ json: message("{", "max_tokens") }), (e) => !(e instanceof PermanentError)],
  ];
  for (const [name, respond, ok] of cases) {
    const api = await withApi(respond);
    try {
      const ex = anthropicExtractor({ apiKey: "sk-test", model: "claude-opus-5-5", effort: "medium", baseURL: api.url });
      await assert.rejects(ex.extract(input), (e) => ok(e), name);
    } finally {
      await api.close();
    }
  }
});

test("the JSON schema stays inside the structured-outputs subset: every object closed, every key required", () => {
  const walk = (node: any, path: string) => {
    if (node && typeof node === "object") {
      if (node.type === "object") {
        assert.equal(node.additionalProperties, false, `${path} must set additionalProperties: false`);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} must require every key`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  walk(EXTRACTION_JSON_SCHEMA, "schema");
  // And the zod contract agrees with it on the top-level keys.
  assert.deepEqual(Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort(), Object.keys(Extraction.shape).sort());
});

test("the offline extractor meets the same contract and finds people, dates and channels in text", async () => {
  const out = await mockExtractor().extract({ ...input, transcript: "This is Jess Taylor in Brisbane, a setter. DM her Monday @jess.sets" });
  assert.ok(Extraction.safeParse(out).success);
  assert.equal(out.people.length, 1);
  assert.equal(out.people[0].name, "Jess Taylor");
  assert.equal(out.people[0].handles[0].handle, "jess.sets");
  assert.equal(out.actions[0].channel, "instagram");
  assert.equal(out.actions[0].due_date, "2026-11-02");
  assert.match(out.summary, /offline mode/);
});

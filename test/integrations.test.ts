import { test } from "node:test";
import assert from "node:assert/strict";
import { action, extraction, fakeFetch, makeApp, person, settle, signup } from "./helpers.ts";
import { all, one } from "../server/db/db.ts";
import { hmac } from "../server/crypto.ts";

function todoistServer(opts: { dropDue?: boolean } = {}) {
  const tasks = new Map<string, any>();
  let n = 0;
  const projects = [{ id: "p-inbox", name: "Inbox" }];
  const fake = fakeFetch({
    "GET /api/v1/projects": () => ({ json: { results: projects, next_cursor: null } }),
    "POST /api/v1/projects": (body) => {
      const p = { id: `p-${projects.length}`, name: body.name };
      projects.push(p);
      return { json: p };
    },
    "POST /api/v1/tasks": (body) => {
      const id = `t${++n}`;
      const due = opts.dropDue ? null : body.due_date ? { date: body.due_date } : body.due_datetime ? { date: body.due_datetime } : null;
      tasks.set(id, { id, ...body, due, checked: false });
      return { json: tasks.get(id) };
    },
    "GET /api/v1/tasks": (_b, url) => ({
      json: { results: [...tasks.values()].filter((t) => !t.checked && !t.deleted && t.project_id === url.searchParams.get("project_id")), next_cursor: null },
    }),
    "GET /api/v1/tasks/[^/]+": (_b, url) => {
      const t = tasks.get(url.pathname.split("/").pop()!);
      return t && !t.deleted ? { json: t } : { status: 404 };
    },
    "POST /api/v1/tasks/[^/]+/close": (_b, url) => {
      tasks.get(url.pathname.split("/")[4])!.checked = true;
      return { status: 204 };
    },
  });
  return { ...fake, tasks, projects };
}

async function connectedApp(fetchImpl: typeof fetch) {
  const app = makeApp({ fetch: fetchImpl, config: { todoistApiBase: "https://todoist.test/api/v1" } });
  const s = await signup(app);
  await s.req("/api/integrations/todoist", { method: "PUT", json: { enabled: true, config: { token: "tok-123", project: "Catch" } } });
  return { app, s };
}

test("Todoist: tasks arrive in the Catch project with label, priority, due date, draft and link", async () => {
  const td = todoistServer();
  const { app, s } = await connectedApp(td.fetch);
  try {
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "Jess Taylor", handles: [{ platform: "instagram", handle: "jess.sets", url: null }] })],
      actions: [
        action({ title: "DM Jess", person_ref: "p1", channel: "instagram", due_date: "2026-12-07", priority: 3, draft_message: "Hey Jess!" }),
        action({ title: "Call Jess", person_ref: "p1", due_date: "2026-12-08", due_time: "17:00" }),
      ],
    }));
    await s.capture({ category: "coaching" });
    await settle(app);

    assert.equal(td.projects.find((p) => p.name === "Catch")?.id, "p-1", "project created once");
    const sent = [...td.tasks.values()];
    assert.equal(sent.length, 2);
    const dm = sent.find((t) => t.content === "DM Jess")!;
    assert.equal(dm.project_id, "p-1");
    assert.deepEqual(dm.labels, ["Coaching"]);
    assert.equal(dm.priority, 3);
    assert.equal(dm.due_date, "2026-12-07");
    assert.match(dm.description, /Hey Jess!/);
    assert.match(dm.description, /instagram\.com\/jess\.sets/);
    const call = sent.find((t) => t.content === "Call Jess")!;
    assert.equal(call.due_datetime, "2026-12-08T14:00:00Z", "17:00 Istanbul is 14:00 UTC");
    assert.equal(td.calls[0].headers.authorization, "Bearer tok-123");

    // Exactly once: re-running deliveries sends nothing new.
    const ids = all<any>(app.ctx.db, "SELECT id FROM tasks").map((t) => t.id);
    const { deliver } = await import("../server/integrations/index.ts");
    for (const id of ids) await deliver(app.ctx, { userId: one<any>(app.ctx.db, "SELECT id FROM users")!.id, event: "task.created", objectId: id });
    assert.equal(td.tasks.size, 2);
  } finally {
    await app.close();
  }
});

test("Todoist: ticking in Catch closes it there; ticking there completes it here", async () => {
  const td = todoistServer();
  const { app, s } = await connectedApp(td.fetch);
  try {
    app.setExtraction(extraction({
      people: [person({ ref: "p1", name: "A One" }), person({ ref: "p2", name: "B Two" })],
      actions: [action({ title: "Task A", person_ref: "p1" }), action({ title: "Task B", person_ref: "p2" })],
    }));
    await s.capture({});
    await settle(app);
    const a = one<any>(app.ctx.db, "SELECT id FROM tasks WHERE title = 'Task A'")!;
    await s.req(`/api/tasks/${a.id}`, { method: "PATCH", json: { status: "done" } });
    await settle(app);
    assert.equal([...td.tasks.values()].find((t) => t.content === "Task A").checked, true);

    // Tick B in Todoist, then poll.
    [...td.tasks.values()].find((t) => t.content === "Task B").checked = true;
    const { pollIntegrations } = await import("../server/integrations/index.ts");
    await pollIntegrations(app.ctx, one<any>(app.ctx.db, "SELECT id FROM users")!.id);
    const b = one<any>(app.ctx.db, "SELECT * FROM tasks WHERE title = 'Task B'")!;
    assert.equal(b.status, "done");
    const contact = one<any>(app.ctx.db, "SELECT * FROM contacts WHERE id = ?", b.contact_id)!;
    assert.equal(contact.stage, "contacted", "a tick in Todoist moves the contact on too");
  } finally {
    await app.close();
  }
});

test("Todoist: a task deleted there is dismissed here, not counted as contact", async () => {
  const td = todoistServer();
  const { app, s } = await connectedApp(td.fetch);
  try {
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "C Three" })], actions: [action({ title: "Task C", person_ref: "p1" })] }));
    await s.capture({});
    await settle(app);
    [...td.tasks.values()][0].deleted = true;
    const { pollIntegrations } = await import("../server/integrations/index.ts");
    await pollIntegrations(app.ctx, one<any>(app.ctx.db, "SELECT id FROM users")!.id);
    assert.equal(one<any>(app.ctx.db, "SELECT status FROM tasks")!.status, "dismissed");
    assert.equal(one<any>(app.ctx.db, "SELECT stage FROM contacts")!.stage, "new");
  } finally {
    await app.close();
  }
});

test("Todoist: a task that comes back without its due date is an error, recorded on the connection", async () => {
  const td = todoistServer({ dropDue: true });
  const { app, s } = await connectedApp(td.fetch);
  try {
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "D Four" })], actions: [action({ title: "Task D", person_ref: "p1", due_date: "2026-12-01" })] }));
    await s.capture({});
    await settle(app);
    const integ = (await s.json("/api/integrations")).integrations.find((i: any) => i.kind === "todoist");
    assert.match(integ.last_error, /without a due date/);
    const summary = await s.json("/api/summary");
    assert.equal(summary.integration_errors[0].kind, "todoist");
  } finally {
    await app.close();
  }
});

test("Todoist: a rejected token is permanent (no retry storm) and shown in settings", async () => {
  const fake = fakeFetch({ "GET /api/v1/projects": () => ({ status: 401 }) });
  const { app, s } = await connectedApp(fake.fetch);
  try {
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "E Five" })] }));
    await s.capture({});
    await settle(app);
    const failedJobs = all<any>(app.ctx.db, "SELECT * FROM jobs WHERE type = 'deliver' AND status = 'queued'");
    assert.equal(failedJobs.length, 0, "not re-queued");
    const test = await s.req("/api/integrations/todoist/test", { method: "POST" });
    assert.equal(test.status, 400);
    assert.match(((await test.json()) as { error: string }).error, /rejected the token/);
  } finally {
    await app.close();
  }
});

test("secrets are encrypted at rest and never returned by the API", async () => {
  const td = todoistServer();
  const { app, s } = await connectedApp(td.fetch);
  try {
    const row = one<any>(app.ctx.db, "SELECT config_enc FROM integrations WHERE kind = 'todoist'")!;
    assert.ok(!row.config_enc.includes("tok-123"));
    const body = JSON.stringify(await s.json("/api/integrations"));
    assert.ok(!body.includes("tok-123"));
    assert.match(body, /"set":true/);
    // Saving the form with the secret left blank keeps it.
    await s.req("/api/integrations/todoist", { method: "PUT", json: { enabled: true, config: { token: "", project: "Other" } } });
    const t = await s.json("/api/integrations/todoist/test", { method: "POST" });
    assert.equal(t.ok, true, JSON.stringify(t));
  } finally {
    await app.close();
  }
});

test("webhook: signed capture.processed with people and tasks; only failed integrations retry", async () => {
  let failWebhook = true;
  const received: any[] = [];
  const td = todoistServer();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://hooks.test/")) {
      if (failWebhook) return new Response("down", { status: 503 });
      received.push({ headers: Object.fromEntries(new Headers(init!.headers).entries()), body: String(init!.body) });
      return new Response("ok");
    }
    return td.fetch(input, init);
  }) as typeof fetch;
  const { app, s } = await connectedApp(fetchImpl);
  try {
    await s.req("/api/integrations/webhook", { method: "PUT", json: { enabled: true, config: { url: "https://hooks.test/catch", secret: "shh" } } });
    app.setExtraction(extraction({ people: [person({ ref: "p1", name: "F Six" })], actions: [action({ title: "Task F", person_ref: "p1" })] }));
    await s.capture({});
    await settle(app);
    assert.equal(td.tasks.size, 1);
    assert.equal(received.length, 0);

    failWebhook = false;
    app.ctx.db.prepare("UPDATE jobs SET run_after = ? WHERE status = 'queued'").run(new Date(0).toISOString());
    await settle(app);
    assert.equal(td.tasks.size, 1, "Todoist was not sent the task a second time");
    const processed = received.find((r) => r.headers["x-catch-event"] === "capture.processed");
    assert.ok(processed);
    assert.equal(processed.headers["x-catch-signature"], `sha256=${hmac("shh", processed.body)}`);
    const payload = JSON.parse(processed.body);
    assert.equal(payload.data.people[0].name, "F Six");
    assert.equal(payload.data.tasks[0].title, "Task F");
  } finally {
    await app.close();
  }
});

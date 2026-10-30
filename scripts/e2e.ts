/**
 * End-to-end: the real server, the real built PWA, a real Chromium with a fake
 * microphone. Offline providers, so no keys and no network.
 *
 * Walks the path that matters: sign up -> attach a screenshot -> tap a chip ->
 * hold the mic -> release (auto-send) -> the capture is filed -> the person
 * and the task exist. Then the outbox: capture while offline, come back
 * online, and it uploads exactly once.
 *
 *   npm run build && npm run test:e2e
 *
 * Needs Playwright with Chromium: `npm i --no-save playwright && npx playwright install chromium`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium: any;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright is not installed: npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

if (!fs.existsSync("web/dist/index.html")) {
  console.error("Build the web app first: npm run build");
  process.exit(1);
}

const port = 8700 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catch-e2e-"));
const shotsDir = process.env.E2E_SCREENSHOTS ?? "";
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["server/index.ts"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, TRANSCRIBER: "mock", EXTRACTOR: "mock", PUBLIC_URL: base, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures.push(name);
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
try {
  await waitForServer();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false, permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (err: Error) => check(`no page errors (${err.message})`, false));
  const shot = async (name: string) => shotsDir && page.screenshot({ path: path.join(shotsDir, `${name}.png`) });

  await page.goto(base);
  await page.getByPlaceholder("Your name").fill("Max");
  await page.getByPlaceholder("Email").fill("max@example.com");
  await page.getByPlaceholder("Password (8+ characters)").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("radio", { name: /Auto/ }).waitFor();
  check("first account signs up and lands on Capture", true);
  await shot("1-capture-empty");

  await page.locator("[data-testid=file-input]").setInputFiles("web/public/icon-512.png");
  await page.getByRole("radio", { name: /Coaching/ }).click();
  await page.getByRole("button", { name: "+ Type a note instead" }).click();
  await page.getByPlaceholder("Type a note (optional)").fill("This is Jess Taylor, a setter in Brisbane, wants private sessions. DM her Monday @jess.sets");
  check("screenshot attached", (await page.locator(".shot img").count()) === 1);
  await shot("2-capture-filled");

  // Hold the mic for 1.5s, release: auto-send.
  const mic = page.locator("[data-testid=mic]");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator(".rec-status").waitFor({ timeout: 5000 });
  await shot("3-recording");
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await page.locator(".toast", { hasText: "Caught" }).waitFor({ timeout: 5000 });
  check("release sends and confirms instantly", true);
  check("form clears for the next capture", (await page.locator(".shot img").count()) === 0);

  await page.goto(`${base}/#/inbox`);
  await page.locator("[data-testid=capture-card] .status.done").first().waitFor({ timeout: 15000 });
  check("capture is filed in the Inbox", true);
  const card = await page.locator("[data-testid=capture-card]").first().innerText();
  check("Inbox shows the person", card.includes("Jess Taylor"), card);
  check("Inbox shows the task with a due date", /DM Jess Taylor/.test(card) && /Mon|Tomorrow|Today/.test(card), card);
  await shot("4-inbox");

  // The voice note reached the server as audio.
  const api = await page.evaluate(async () => (await fetch("/api/captures")).json());
  const files = api.captures[0].files as { kind: string; mime: string }[];
  check("voice note uploaded as audio", files.some((f) => f.kind === "audio" && f.mime.startsWith("audio/")), JSON.stringify(files));
  check("screenshot uploaded as an image", files.some((f) => f.kind === "image"), JSON.stringify(files));

  await page.goto(`${base}/#/people`);
  await page.getByText("Jess Taylor").first().click();
  await page.getByRole("button", { name: "Message" }).waitFor();
  check("person page opens with a Message button (Instagram link)", true);
  const vcardHref = await page.getByRole("link", { name: "Save to Contacts" }).getAttribute("href");
  const vcard = await page.evaluate(async (href: string) => (await fetch(href)).text(), vcardHref);
  check("Save to Contacts serves a vCard", vcard.startsWith("BEGIN:VCARD") && vcard.includes("Jess Taylor"), vcard.slice(0, 120));
  await shot("5-person");

  await page.goto(`${base}/#/tasks`);
  await page.getByRole("button", { name: "All open" }).click();
  await page.getByText("DM Jess Taylor").waitFor();
  await shot("6-tasks");
  await page.getByRole("button", { name: "Mark done" }).first().click();
  await page.locator(".toast", { hasText: "Done" }).waitFor();
  const person = await page.evaluate(async () => {
    const list = await (await fetch("/api/contacts")).json();
    return (await (await fetch(`/api/contacts/${list.contacts[0].id}`)).json()).contact;
  });
  check("ticking the task moves the person to Contacted", person.stage === "contacted", person.stage);
  check("…and schedules their follow-up", typeof person.next_followup_on === "string", String(person.next_followup_on));

  // Offline: the capture waits on the phone, then uploads exactly once.
  await page.goto(`${base}/#/capture`);
  await context.setOffline(true);
  await page.getByRole("button", { name: "+ Type a note instead" }).click();
  await page.getByPlaceholder("Type a note (optional)").fill("Call Sam Lee tomorrow about the program");
  await page.getByRole("button", { name: /Send without voice/ }).click();
  await page.locator("[data-testid=outbox-pill]").waitFor({ timeout: 5000 });
  const pill = await page.locator("[data-testid=outbox-pill]").innerText();
  check("offline capture waits in the outbox", /waiting|sending/.test(pill), pill);
  await shot("7-offline");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.locator("[data-testid=outbox-pill]").waitFor({ state: "detached", timeout: 20000 });
  const count = await page.evaluate(async () => (await (await fetch("/api/captures")).json()).captures.length);
  check("back online it uploads exactly once", count === 2, `captures=${count}`);
} catch (err) {
  check("e2e run completed", false, err instanceof Error ? err.stack ?? err.message : String(err));
  console.error(serverLog.slice(-3000));
} finally {
  await browser.close();
  server.kill("SIGTERM");
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} e2e check(s) failed` : "\nAll e2e checks passed");
process.exit(failures.length ? 1 : 0);

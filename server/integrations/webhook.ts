/**
 * A signed JSON POST for every event. The universal adapter: point it at
 * Zapier, Make, n8n, a Google Apps Script or your own server and Catch can
 * reach anything without Catch knowing it exists.
 *
 * Headers:
 *   X-Catch-Event:     capture.processed | task.created | task.closed | ping
 *   X-Catch-Delivery:  unique id; receivers can dedupe on it
 *   X-Catch-Signature: sha256=<hex HMAC of the raw body with your secret>
 */
import crypto from "node:crypto";
import type { Integration, IntegrationCall } from "./types.ts";
import { IntegrationError } from "./types.ts";
import { hmac } from "../crypto.ts";

async function post(call: IntegrationCall, event: string, data: unknown): Promise<void> {
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Catch-Webhook/1",
    "X-Catch-Event": event,
    "X-Catch-Delivery": crypto.randomUUID(),
  };
  if (call.config.secret) headers["X-Catch-Signature"] = `sha256=${hmac(call.config.secret, body)}`;
  let res: Response;
  try {
    res = await call.ctx.fetch(call.config.url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new IntegrationError(`webhook unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new IntegrationError(`webhook answered HTTP ${res.status}`, res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408);
  }
}

export const webhook: Integration = {
  kind: "webhook",
  label: "Webhook",
  description: "POSTs signed JSON for every processed capture and every task, to Zapier, Make, n8n or your own endpoint.",
  fields: [
    { key: "url", label: "URL", type: "url", required: true, placeholder: "https://hooks.zapier.com/..." },
    { key: "secret", label: "Signing secret", type: "secret", required: false, help: "If set, every request carries X-Catch-Signature: sha256=HMAC(body)." },
  ],
  async test(call) {
    await post(call, "ping", { message: "Catch webhook test" });
    return "Delivered a ping event.";
  },
  async taskCreated(call, task) {
    await post(call, "task.created", task);
    return null;
  },
  async taskClosed(call, task) {
    await post(call, "task.closed", task);
  },
  async captureProcessed(call, payload) {
    await post(call, "capture.processed", payload);
  },
};

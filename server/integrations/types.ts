import type { Ctx, UserRow } from "../context.ts";
import type { EventPayload } from "./gcal.ts";

export interface Field {
  key: string;
  label: string;
  type: "secret" | "text" | "url";
  required: boolean;
  help?: string;
  placeholder?: string;
}

export interface TaskPayload {
  id: string;
  title: string;
  notes: string;
  category: string | null;
  categoryLabel: string | null;
  channel: string | null;
  link: string | null;
  draft_message: string | null;
  due_on: string | null;
  due_time: string | null;
  priority: number;
  status: string;
  contact: { id: string; name: string; stage: string } | null;
  capture_id: string | null;
  app_url: string;
}

export interface IntegrationCall {
  ctx: Ctx;
  user: UserRow;
  config: Record<string, string>;
  /** Non-secret bookkeeping the integration may read and replace. */
  state: Record<string, unknown>;
}

/**
 * An outbound connection. Every hook is optional; the dispatcher (index.ts)
 * records each delivery so a retry never sends the same thing twice.
 */
export interface Integration {
  kind: string;
  label: string;
  description: string;
  fields: Field[];
  test(call: IntegrationCall): Promise<string>;
  /**
   * Returns the external id to remember (e.g. the Todoist task id), null when
   * there is none, or undefined for "not sent" — nothing is recorded, so a
   * later backfill (after a setting is switched on) still sends it.
   */
  taskCreated?(call: IntegrationCall, task: TaskPayload): Promise<string | null | undefined>;
  taskClosed?(call: IntegrationCall, task: TaskPayload, externalId: string | null): Promise<void>;
  /** The task's wording, date or draft changed. Returns a new external id if the old one was replaced. */
  taskUpdated?(call: IntegrationCall, task: TaskPayload, externalId: string): Promise<string | null>;
  captureProcessed?(call: IntegrationCall, payload: Record<string, unknown>): Promise<void>;
  /** An appointment was filed. Returns the external id to remember. */
  eventCreated?(call: IntegrationCall, event: EventPayload): Promise<string | null>;
  /** Pull changes made on the other side (e.g. tasks ticked in Todoist). */
  poll?(call: IntegrationCall): Promise<void>;
}

export class IntegrationError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

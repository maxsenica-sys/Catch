import type { Ctx, UserRow } from "../context.ts";

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
  /** Returns the external id to remember (e.g. the Todoist task id). */
  taskCreated?(call: IntegrationCall, task: TaskPayload): Promise<string | null>;
  taskClosed?(call: IntegrationCall, task: TaskPayload, externalId: string | null): Promise<void>;
  captureProcessed?(call: IntegrationCall, payload: Record<string, unknown>): Promise<void>;
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

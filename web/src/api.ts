/** Every call carries X-Catch: 1 — the server's CSRF check for cookie-authenticated writes. */

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Listener = () => void;
const unauthorised = new Set<Listener>();
export function onUnauthorised(fn: Listener): () => void {
  unauthorised.add(fn);
  return () => unauthorised.delete(fn);
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Catch", "1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  if (res.status === 401 && !path.startsWith("/api/auth")) unauthorised.forEach((fn) => fn());
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError((data && (data as any).error) || `HTTP ${res.status}`, res.status);
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export interface Category {
  id: string;
  key: string;
  name: string;
  color: string;
  guidance: string;
  followup_days: number;
  todoist_label: string;
  tracks_people: number;
  sort: number;
  archived: number;
}

export interface Me {
  user: { id: string; email: string; name: string; role: string; timezone: string; date_order: "DMY" | "MDY"; settings: { autoSend?: boolean; vocabulary?: string; maxFollowups?: number } };
  today: string;
  feed_url: string;
  providers: { transcriber: string; extractor: string; offline: boolean };
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  category: string | null;
  channel: string | null;
  link: string | null;
  draft_message: string | null;
  due_on: string | null;
  due_time: string | null;
  due_source: string;
  priority: number;
  status: string;
  kind: string;
  contact_id: string | null;
  contact_name?: string | null;
  capture_id: string | null;
}

export interface CaptureView {
  id: string;
  client_id: string;
  status: "queued" | "processing" | "done" | "review" | "failed";
  category: string | null;
  category_hint: string | null;
  note: string;
  transcript: string | null;
  summary: string | null;
  error: string | null;
  captured_at: string;
  files: { id: string; kind: string; mime: string }[];
  people: { id: string; name: string; category: string | null; stage: string }[];
  tasks: Task[];
  events: { id: string; title: string; date: string; start_time: string | null }[];
  reviews: { id: string; kind: string }[];
}

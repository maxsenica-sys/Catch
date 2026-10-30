/**
 * The outbox: every capture is written to IndexedDB on the phone first, then
 * uploaded. The user is done the moment it is written — there is no spinner to
 * wait on — and a capture made in a sports hall with no signal uploads when the
 * signal comes back. Each item carries a client_id the server dedupes on, so a
 * retry after a lost response can never create a second capture.
 *
 * iOS suspends a backgrounded web app, so an upload interrupted by switching
 * apps resumes the next time Catch is opened. The pill in the header says how
 * many are waiting, so that is never invisible.
 */

export interface OutboxItem {
  client_id: string;
  category: string;
  note: string;
  images: Blob[];
  audio: Blob | null;
  captured_at: string;
  state: "pending" | "uploading" | "rejected";
  attempts: number;
  error: string | null;
  next_try: number;
}

const DB_NAME = "catch";
const STORE = "outbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "client_id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const listeners = new Set<(items: OutboxItem[]) => void>();
export function subscribe(fn: (items: OutboxItem[]) => void): () => void {
  listeners.add(fn);
  void list().then(fn);
  return () => listeners.delete(fn);
}
async function notify() {
  const items = await list();
  listeners.forEach((fn) => fn(items));
}

export async function list(): Promise<OutboxItem[]> {
  const items = await tx<OutboxItem[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxItem[]>);
  return items.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

export async function add(item: Pick<OutboxItem, "category" | "note" | "images" | "audio">): Promise<string> {
  const client_id = crypto.randomUUID();
  await tx("readwrite", (s) => s.put({
    ...item, client_id, captured_at: new Date().toISOString(), state: "pending", attempts: 0, error: null, next_try: 0,
  } satisfies OutboxItem));
  await notify();
  void pump();
  return client_id;
}

export async function discard(clientId: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(clientId));
  await notify();
}

export async function retry(clientId: string): Promise<void> {
  const items = await list();
  const item = items.find((i) => i.client_id === clientId);
  if (!item) return;
  await tx("readwrite", (s) => s.put({ ...item, state: "pending", error: null, next_try: 0 }));
  await notify();
  void pump();
}

/**
 * Re-encode as JPEG, long edge at most 2400px. A full-resolution iPhone
 * screenshot is several MB of PNG; this keeps uploads quick on mobile data
 * while leaving text sharp. It also turns HEIC camera photos into something
 * the server accepts, because Safari can decode HEIC even though the API cannot.
 */
async function shrink(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size < 1_500_000 && /png|jpeg|webp/.test(blob.type)) return blob;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? blob), "image/jpeg", 0.86));
  } catch {
    return blob;
  }
}

const BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];
let pumping = false;
let signedOut = false;

export function setSignedOut(value: boolean) {
  signedOut = value;
  if (!value) void pump();
}

export async function pump(): Promise<void> {
  if (pumping || signedOut) return;
  pumping = true;
  try {
    for (;;) {
      const now = Date.now();
      const next = (await list()).find((i) => i.state !== "rejected" && i.next_try <= now);
      if (!next || !navigator.onLine) break;
      await tx("readwrite", (s) => s.put({ ...next, state: "uploading" }));
      await notify();
      const form = new FormData();
      form.append("client_id", next.client_id);
      form.append("category", next.category);
      form.append("note", next.note);
      form.append("captured_at", next.captured_at);
      for (const [i, img] of next.images.entries()) {
        const small = await shrink(img);
        form.append("image", small, `screenshot-${i + 1}.${small.type === "image/jpeg" ? "jpg" : "png"}`);
      }
      if (next.audio) form.append("audio", next.audio, `voice.${next.audio.type.includes("mp4") ? "m4a" : "webm"}`);

      let outcome: "done" | "retry" | "rejected" | "auth" = "retry";
      let error: string | null = null;
      try {
        const res = await fetch("/api/captures", { method: "POST", body: form, headers: { "X-Catch": "1" }, credentials: "same-origin" });
        if (res.ok) outcome = "done";
        else if (res.status === 401) outcome = "auth";
        else if ([400, 413, 415].includes(res.status)) {
          outcome = "rejected";
          error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
        } else error = `Server answered ${res.status}`;
      } catch {
        error = "No connection";
      }

      if (outcome === "done") {
        await tx("readwrite", (s) => s.delete(next.client_id));
      } else if (outcome === "auth") {
        await tx("readwrite", (s) => s.put({ ...next, state: "pending" }));
        signedOut = true;
      } else {
        const attempts = next.attempts + 1;
        await tx("readwrite", (s) => s.put({
          ...next, attempts, error, state: outcome === "rejected" ? "rejected" : "pending",
          next_try: Date.now() + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)],
        }));
      }
      await notify();
      if (outcome === "auth") break;
    }
  } finally {
    pumping = false;
  }
}

export function startPumping(): void {
  window.addEventListener("online", () => void pump());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pump();
  });
  setInterval(() => void pump(), 10_000);
  // Anything left "uploading" by a killed page is just pending.
  void list().then(async (items) => {
    for (const i of items) if (i.state === "uploading") await tx("readwrite", (s) => s.put({ ...i, state: "pending" }));
    await notify();
    void pump();
  });
}

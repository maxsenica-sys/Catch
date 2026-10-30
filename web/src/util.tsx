import { useEffect, useState } from "preact/hooks";
import type { Category } from "./api";

/** "Today", "Tomorrow", "Mon 3 Nov", "2d overdue" — relative to the user's today, not the phone's. */
export function dueLabel(due: string | null, today: string, time?: string | null): { text: string; tone: "overdue" | "today" | "soon" | "later" } {
  if (!due) return { text: "No date", tone: "later" };
  const d = Date.parse(`${due}T12:00:00Z`);
  const t = Date.parse(`${today}T12:00:00Z`);
  const diff = Math.round((d - t) / 86_400_000);
  const at = time ? ` ${time}` : "";
  if (diff < 0) return { text: `${-diff}d overdue`, tone: "overdue" };
  if (diff === 0) return { text: `Today${at}`, tone: "today" };
  if (diff === 1) return { text: `Tomorrow${at}`, tone: "soon" };
  const label = new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return { text: `${label}${at}`, tone: diff <= 6 ? "soon" : "later" };
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function catOf(cats: Category[], key: string | null | undefined): Category | undefined {
  return cats.find((c) => c.key === key);
}

export function Dot({ color }: { color: string }) {
  return <span class="dot" style={{ background: color }} />;
}

export const STAGE_LABEL: Record<string, string> = {
  new: "New", contacted: "Contacted", replied: "Replied", booked: "Booked", client: "Client", parked: "Parked", dead: "Dead",
};

type ToastMsg = { id: number; text: string; tone: "ok" | "error" };
let toasts: ToastMsg[] = [];
const toastListeners = new Set<(t: ToastMsg[]) => void>();
export function toast(text: string, tone: "ok" | "error" = "ok") {
  const t = { id: Date.now() + Math.random(), text, tone };
  toasts = [...toasts, t];
  toastListeners.forEach((fn) => fn(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((fn) => fn(toasts));
  }, tone === "error" ? 5000 : 2200);
}

export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => <div key={t.id} class={`toast ${t.tone}`}>{t.text}</div>)}
    </div>
  );
}

export function vibrate(ms = 25) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported (iOS) */
  }
}

/** Copy a draft, then open the link: Instagram has no "compose with text" URL, so the draft rides the clipboard. */
export async function copyAndOpen(draft: string | null, link: string | null) {
  if (draft) {
    try {
      await navigator.clipboard.writeText(draft);
      toast("Draft copied — paste it in");
    } catch {
      /* clipboard blocked; opening the link still helps */
    }
  }
  if (link) window.open(link, "_blank", "noopener");
}

export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

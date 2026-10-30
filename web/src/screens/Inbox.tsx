/**
 * What happened to everything you sent. Captures still on the phone appear
 * first, so a capture is visible from the instant it is made; then each
 * capture's result — who it found, what it filed, what needs a look.
 */
import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../main";
import { api, type CaptureView } from "../api";
import { Dot, catOf, dueLabel, timeAgo, toast, usePoll } from "../util";
import { OutboxPill } from "./OutboxPill";

const STATUS: Record<string, string> = {
  queued: "Queued", processing: "Reading…", done: "Filed", review: "Needs a look", failed: "Failed",
};

export function InboxScreen({ state }: { state: AppState }) {
  const [captures, setCaptures] = useState<CaptureView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => api<{ captures: CaptureView[] }>("/api/captures?limit=50").then((r) => setCaptures(r.captures)).catch(() => {});
  useEffect(() => void load(), [state.outbox.length]);
  const busy = !!captures?.some((c) => c.status === "queued" || c.status === "processing") || state.outbox.length > 0;
  usePoll(() => {
    void load();
    void state.refresh();
  }, 2500, busy);

  return (
    <div>
      <header class="bar">
        <h1>Inbox</h1>
        <OutboxPill items={state.outbox} />
      </header>
      {state.summary.review > 0 && (
        <a class="banner" href="#/review">{state.summary.review} thing{state.summary.review === 1 ? "" : "s"} need a quick look →</a>
      )}
      {state.summary.integration_errors.map((e) => (
        <a key={e.kind} class="banner warn" href="#/settings">{e.kind}: {e.last_error}</a>
      ))}
      {state.outbox.map((o) => (
        <div class="card pending" key={o.client_id}>
          <div class="card-head"><span class="status queued">On phone</span><span class="muted">{timeAgo(o.captured_at)}</span></div>
          <div class="muted">{o.images.length} screenshot{o.images.length === 1 ? "" : "s"}{o.audio ? " + voice note" : ""}{o.note ? " + note" : ""} — uploading</div>
        </div>
      ))}
      {captures === null && <p class="muted pad">Loading…</p>}
      {captures?.length === 0 && state.outbox.length === 0 && (
        <p class="empty">Nothing yet. Captures show up here as they are filed.</p>
      )}
      {captures?.map((c) => {
        const cat = catOf(state.categories, c.category ?? c.category_hint);
        const expanded = open === c.id;
        return (
          <div class={`card ${c.status}`} key={c.id} data-testid="capture-card">
            <div class="card-head" onClick={() => setOpen(expanded ? null : c.id)}>
              {cat && <><Dot color={cat.color} /> <strong>{cat.name}</strong></>}
              <span class={`status ${c.status}`}>{STATUS[c.status]}</span>
              <span class="muted grow-right">{timeAgo(c.captured_at)}</span>
            </div>
            <div class="summary" onClick={() => setOpen(expanded ? null : c.id)}>
              {c.summary ?? (c.status === "failed" ? "Could not be read" : "Reading the screenshots and voice note…")}
            </div>
            {c.error && c.status !== "done" && <div class={c.status === "failed" ? "error-text" : "muted small-text"}>{c.error}</div>}
            {c.people.length > 0 && (
              <div class="people-chips">
                {c.people.map((p) => <a key={p.id} class="person-chip" href={`#/people/${p.id}`}>{p.name}</a>)}
              </div>
            )}
            {c.tasks.length > 0 && (
              <ul class="mini-tasks">
                {c.tasks.map((t) => {
                  const d = dueLabel(t.due_on, state.me.today, t.due_time);
                  return <li key={t.id} class={t.status !== "open" ? "done" : ""}>{t.title} <span class={`due ${d.tone}`}>{d.text}</span></li>;
                })}
              </ul>
            )}
            {c.events.length > 0 && (
              <ul class="mini-tasks">{c.events.map((e) => <li key={e.id}>📅 {e.title} — {e.date}{e.start_time ? ` ${e.start_time}` : ""}</li>)}</ul>
            )}
            {expanded && (
              <div class="detail">
                {c.files.filter((f) => f.kind === "image").length > 0 && (
                  <div class="thumbs">
                    {c.files.filter((f) => f.kind === "image").map((f) => (
                      <a key={f.id} href={`/api/files/${f.id}`} target="_blank"><img src={`/api/files/${f.id}`} loading="lazy" alt="" /></a>
                    ))}
                  </div>
                )}
                {c.files.some((f) => f.kind === "audio") && (
                  <audio controls preload="none" src={`/api/files/${c.files.find((f) => f.kind === "audio")!.id}`} />
                )}
                {c.transcript && <p class="quote">“{c.transcript}”</p>}
                {c.note && <p class="quote">{c.note}</p>}
                <div class="row-actions">
                  {c.status === "failed" && (
                    <button class="small primary" onClick={() => api(`/api/captures/${c.id}/retry`, { method: "POST" }).then(load).catch((e) => toast(e.message, "error"))}>Retry</button>
                  )}
                  <button class="small danger" onClick={() => confirm("Delete this capture and its screenshots? People and tasks it created are kept.") &&
                    api(`/api/captures/${c.id}`, { method: "DELETE" }).then(load)}>Delete capture</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The short list of things Catch would rather ask than guess: a person who may
 * already exist, a date it could not use, a capture it was unsure about.
 * Each one is a single tap.
 */
import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../main";
import { api } from "../api";
import { toast } from "../util";

interface Item {
  id: string;
  kind: string;
  capture_summary: string | null;
  payload: any;
}

export function ReviewScreen({ state }: { state: AppState }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const load = () => api<{ items: Item[] }>("/api/review").then((r) => setItems(r.items));
  useEffect(() => void load(), []);

  async function resolve(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/review/${id}/resolve`, { method: "POST", json: body });
      await load();
      void state.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    }
  }

  return (
    <div>
      <header class="bar"><a href="#/inbox" class="back">‹ Inbox</a></header>
      <h1 class="pad-x">Quick checks</h1>
      {items?.length === 0 && <p class="empty">All clear.</p>}
      {items?.map((item) => (
        <div class="card" key={item.id}>
          {item.kind === "possible_duplicate" && item.payload.subject && (
            <>
              <p><strong>{item.payload.subject.name}</strong> was just added. Same person as…</p>
              {item.payload.candidates.map((c: any) => (
                <div class="dup-row" key={c.id}>
                  <div>{c.name} <span class="muted">{[c.location, c.stage].filter(Boolean).join(" · ")}</span></div>
                  <button class="small primary" onClick={() => void resolve(item.id, { action: "merge", into: c.id })}>Same person</button>
                </div>
              ))}
              <button class="small" onClick={() => void resolve(item.id, { action: "keep" })}>Different people</button>
            </>
          )}
          {item.kind === "date_dropped" && (
            <>
              <p>“{item.payload.title}” mentioned <strong>{item.payload.value}</strong> ({item.payload.reason}).
                {item.payload.used ? ` It is due ${item.payload.used} instead — change it in Tasks if that is wrong.` : " It was not added."}</p>
              <button class="small" onClick={() => void resolve(item.id, { action: "dismiss" })}>OK</button>
            </>
          )}
          {item.kind === "low_confidence" && (
            <>
              <p>Not sure I read this one right: <em>{item.payload.summary}</em></p>
              <div class="row-actions">
                <a class="button small" href="#/inbox">Check the capture</a>
                <button class="small" onClick={() => void resolve(item.id, { action: "dismiss" })}>Looks fine</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

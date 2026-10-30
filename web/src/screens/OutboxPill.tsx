import { useState } from "preact/hooks";
import { discard, pump, retry, type OutboxItem } from "../outbox";

/** "2 sending" / "3 waiting for signal" / "1 rejected". Tap for the list. Invisible when empty. */
export function OutboxPill({ items }: { items: OutboxItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const rejected = items.filter((i) => i.state === "rejected").length;
  const offline = !navigator.onLine;
  const label = rejected ? `${rejected} need attention` : offline ? `${items.length} waiting for signal` : `${items.length} sending…`;
  return (
    <>
      <button class={`pill ${rejected ? "bad" : ""}`} onClick={() => setOpen(true)} data-testid="outbox-pill">{label}</button>
      {open && (
        <div class="sheet-backdrop" onClick={() => setOpen(false)}>
          <div class="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>On this phone, not yet uploaded</h2>
            <p class="muted">These are safe here and upload by themselves. Keep Catch open for a moment if you are on weak signal.</p>
            {items.map((i) => (
              <div class="outbox-row" key={i.client_id}>
                <div>
                  <div>{new Date(i.captured_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {i.images.length} screenshot{i.images.length === 1 ? "" : "s"}{i.audio ? " · voice" : ""}</div>
                  <div class={i.state === "rejected" ? "error-text" : "muted"}>{i.state === "rejected" ? i.error : i.error ? `Retrying (${i.error})` : i.state}</div>
                </div>
                <div class="row-actions">
                  {i.state === "rejected" && <button class="small" onClick={() => void retry(i.client_id)}>Retry</button>}
                  <button class="small danger" onClick={() => confirm("Throw this capture away?") && void discard(i.client_id)}>Discard</button>
                </div>
              </div>
            ))}
            <button class="primary" onClick={() => { void pump(); setOpen(false); }}>Try now</button>
          </div>
        </div>
      )}
    </>
  );
}

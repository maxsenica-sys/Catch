import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../main";
import { api, type Task } from "../api";
import { Dot, STAGE_LABEL, catOf, copyAndOpen, dueLabel, timeAgo, toast } from "../util";
import { TaskRow } from "./TaskRow";

interface ContactRow {
  id: string;
  name: string;
  category: string | null;
  stage: string;
  sport: string | null;
  position: string | null;
  location: string | null;
  next_followup_on: string | null;
  needs_review: number;
  open_tasks: number;
  handle: string | null;
}

const STAGES = ["new", "contacted", "replied", "booked", "client", "parked", "dead"];

export function PeopleScreen({ state }: { state: AppState }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [stage, setStage] = useState("");
  const [rows, setRows] = useState<ContactRow[] | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    if (stage) params.set("stage", stage);
    const t = setTimeout(() => void api(`/api/contacts?${params}`).then((r) => setRows(r.contacts)).catch(() => {}), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, category, stage]);

  return (
    <div>
      <header class="bar">
        <h1>People</h1>
        <a class="small-link" href="/api/export/contacts.csv">Export CSV</a>
      </header>
      <input class="search" type="search" placeholder="Search names, handles, places" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="chips">
        <button class={`chip ${category === "" ? "on" : ""}`} onClick={() => setCategory("")}>All</button>
        {state.categories.filter((c) => c.tracks_people).map((c) => (
          <button key={c.key} class={`chip ${category === c.key ? "on" : ""}`} onClick={() => setCategory(category === c.key ? "" : c.key)}>
            <Dot color={c.color} /> {c.name}
          </button>
        ))}
      </div>
      <div class="chips">
        {STAGES.map((s) => (
          <button key={s} class={`chip small ${stage === s ? "on" : ""}`} onClick={() => setStage(stage === s ? "" : s)}>{STAGE_LABEL[s]}</button>
        ))}
      </div>
      {rows?.length === 0 && <p class="empty">No one here yet. Everyone in your captures lands in this list.</p>}
      {rows?.map((r) => {
        const cat = catOf(state.categories, r.category);
        const sub = [r.position, r.sport, r.location].filter(Boolean).join(" · ") || r.handle?.replace(":", " @") || "";
        return (
          <a class="person-row" key={r.id} href={`#/people/${r.id}`}>
            {cat ? <Dot color={cat.color} /> : <Dot color="#475569" />}
            <div class="grow">
              <div class="person-name">{r.name} {r.needs_review ? <span class="tag warn">check</span> : null}</div>
              <div class="muted small-text">{sub}</div>
            </div>
            <div class="right">
              <span class={`stage ${r.stage}`}>{STAGE_LABEL[r.stage]}</span>
              {r.open_tasks > 0 ? <div class="muted small-text">{r.open_tasks} to do</div>
                : r.next_followup_on ? <div class="muted small-text">chase {dueLabel(r.next_followup_on, state.me.today).text.toLowerCase()}</div> : null}
            </div>
          </a>
        );
      })}
    </div>
  );
}

interface PersonData {
  contact: Record<string, any>;
  handles: { id: string; platform: string; handle: string; url: string | null }[];
  tasks: Task[];
  events: { id: string; title: string; date: string; start_time: string | null }[];
  timeline: { id: string; kind: string; body: string; created_at: string }[];
  duplicates: { review_id: string; payload: string }[];
}

const FIELDS: [string, string][] = [
  ["position", "Position"], ["sport", "Sport"], ["level", "Level / age"], ["location", "Location"],
  ["organisation", "Club / org"], ["email", "Email"], ["phone", "Phone"],
];

export function PersonScreen({ state, id }: { state: AppState; id: string }) {
  const [data, setData] = useState<PersonData | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const load = () => api<PersonData>(`/api/contacts/${id}`).then(setData).catch((e) => toast(e.message, "error"));
  useEffect(() => void load(), [id]);
  if (!data) return <p class="muted pad">Loading…</p>;
  const c = data.contact;
  const cat = catOf(state.categories, c.category);
  const best = data.handles.find((h) => h.url);

  async function save(patch: Record<string, unknown>) {
    try {
      await api(`/api/contacts/${id}`, { method: "PATCH", json: patch });
      await load();
      void state.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    }
  }

  return (
    <div>
      <header class="bar">
        <a href="#/people" class="back">‹ People</a>
      </header>
      <div class="person-head">
        <h1>{c.name}</h1>
        <div class="muted">{[c.position, c.sport, c.level, c.location].filter(Boolean).join(" · ")}</div>
      </div>

      <div class="row-actions wide">
        {best && <button class="primary" onClick={() => void copyAndOpen(null, best.url)}>Message</button>}
        <a class="button" href={`/api/contacts/${id}/vcard`}>Save to Contacts</a>
      </div>

      {data.duplicates.length > 0 && <a class="banner" href="#/review">This might be someone you already have — check →</a>}

      <section>
        <label class="field-label">Category</label>
        <div class="chips">
          {state.categories.map((k) => (
            <button key={k.key} class={`chip small ${c.category === k.key ? "on" : ""}`} onClick={() => void save({ category: k.key })}>
              <Dot color={k.color} /> {k.name}
            </button>
          ))}
        </div>
        <label class="field-label">Stage</label>
        <div class="chips">
          {STAGES.map((s) => (
            <button key={s} class={`chip small ${c.stage === s ? "on" : ""}`} onClick={() => void save({ stage: s })}>{STAGE_LABEL[s]}</button>
          ))}
        </div>
        {c.next_followup_on && <p class="muted">Next chase: {dueLabel(c.next_followup_on, state.me.today).text}</p>}
      </section>

      {data.handles.length > 0 && (
        <section>
          <h2>Where to reach them</h2>
          {data.handles.map((h) => (
            <div key={h.id} class="handle-row">
              <span class="muted">{h.platform}</span>
              {h.url ? <a href={h.url} target="_blank" rel="noopener">{h.handle}</a> : <span>{h.handle}</span>}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>To do</h2>
        {data.tasks.filter((t) => t.status === "open").length === 0 && <p class="muted">Nothing open.</p>}
        {data.tasks.filter((t) => t.status === "open").map((t) => (
          <TaskRow key={t.id} task={t} today={state.me.today} onChange={() => { void load(); void state.refresh(); }} showContact={false} />
        ))}
      </section>

      {data.events.length > 0 && (
        <section>
          <h2>Booked</h2>
          {data.events.map((e) => <div key={e.id}>📅 {e.title} — {e.date}{e.start_time ? ` ${e.start_time}` : ""}</div>)}
        </section>
      )}

      <section>
        <div class="section-head">
          <h2>Details</h2>
          <button class="small" onClick={() => {
            if (editing) void save(draft).then(() => setEditing(false));
            else {
              setDraft(Object.fromEntries([["name", c.name], ...FIELDS.map(([k]) => [k, c[k] ?? ""]), ["notes", c.notes ?? ""]]));
              setEditing(true);
            }
          }}>{editing ? "Save" : "Edit"}</button>
        </div>
        {editing ? (
          <div class="stack">
            <input value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} />
            {FIELDS.map(([k, label]) => (
              <input key={k} placeholder={label} value={draft[k]} onInput={(e) => setDraft({ ...draft, [k]: (e.target as HTMLInputElement).value || null })} />
            ))}
            <textarea rows={5} placeholder="Notes" value={draft.notes} onInput={(e) => setDraft({ ...draft, notes: (e.target as HTMLTextAreaElement).value })} />
            <button class="small danger" onClick={() => confirm(`Archive ${c.name}? They stop appearing and stop being chased.`) && void save({ archived: true }).then(() => (location.hash = "#/people"))}>Archive</button>
          </div>
        ) : (
          <dl class="details">
            {FIELDS.filter(([k]) => c[k]).map(([k, label]) => (<><dt>{label}</dt><dd>{c[k]}</dd></>))}
            {cat && (<><dt>Category</dt><dd>{cat.name}</dd></>)}
            {c.notes && (<><dt>Notes</dt><dd class="pre">{c.notes}</dd></>)}
          </dl>
        )}
      </section>

      <section>
        <h2>History</h2>
        {data.timeline.map((e) => (
          <div key={e.id} class="timeline-row"><span class="muted">{timeAgo(e.created_at)}</span> {e.body}</div>
        ))}
      </section>
    </div>
  );
}

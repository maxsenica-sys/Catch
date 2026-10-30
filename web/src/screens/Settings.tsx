import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../main";
import { api, type Category } from "../api";
import { Dot, toast } from "../util";

interface IntegrationView {
  kind: string;
  label: string;
  description: string;
  enabled: boolean;
  last_ok_at: string | null;
  last_error: string | null;
  fields: { key: string; label: string; type: string; required: boolean; help?: string; placeholder?: string; value: string; set: boolean }[];
}

export function SettingsScreen({ state }: { state: AppState }) {
  const { me } = state;
  return (
    <div>
      <header class="bar"><h1>Settings</h1></header>
      {me.providers.offline && (
        <div class="callout warn">
          <strong>Offline mode.</strong> Captures are stored and filed, but screenshots are not read
          {me.providers.transcriber === "mock" ? " and voice notes are not transcribed" : ""}. Set
          <code>ANTHROPIC_API_KEY</code>{me.providers.transcriber === "mock" ? <> and <code>OPENAI_API_KEY</code></> : null} on the server and restart.
        </div>
      )}
      <Profile state={state} />
      <Categories state={state} />
      <Integrations />
      <Tokens />
      <section>
        <h2>Export</h2>
        <div class="row-actions">
          <a class="button small" href="/api/export/contacts.csv">Contacts (CSV)</a>
          <a class="button small" href="/api/export/contacts.vcf">Contacts (vCard)</a>
        </div>
      </section>
      <section>
        <p class="muted small-text">Reading with {me.providers.extractor}; voice with {me.providers.transcriber}. Signed in as {me.user.email}.</p>
        <button class="small" onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => location.reload())}>Sign out</button>
      </section>
    </div>
  );
}

function Profile({ state }: { state: AppState }) {
  const u = state.me.user;
  const [name, setName] = useState(u.name);
  const [timezone, setTimezone] = useState(u.timezone);
  const [dateOrder, setDateOrder] = useState(u.date_order);
  const [autoSend, setAutoSend] = useState(u.settings.autoSend !== false);
  const [vocabulary, setVocabulary] = useState(u.settings.vocabulary ?? "");
  const [maxFollowups, setMaxFollowups] = useState(u.settings.maxFollowups ?? 3);
  const zones: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? [u.timezone];

  async function save() {
    try {
      await api("/api/me", { method: "PATCH", json: { name, timezone, date_order: dateOrder, settings: { autoSend, vocabulary, maxFollowups } } });
      await state.refresh();
      toast("Saved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    }
  }

  return (
    <section class="stack">
      <h2>You</h2>
      <label class="field-label">Name</label>
      <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <label class="field-label">Time zone — "Monday" means Monday here</label>
      <select value={timezone} onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}>
        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
      <label class="field-label">Dates like 05/08 mean</label>
      <select value={dateOrder} onChange={(e) => setDateOrder((e.target as HTMLSelectElement).value as "DMY" | "MDY")}>
        <option value="DMY">5 August (day first)</option>
        <option value="MDY">May 8 (month first)</option>
      </select>
      <label class="toggle"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend((e.target as HTMLInputElement).checked)} /> Send as soon as I stop talking</label>
      <label class="field-label">Words Catch should spell right (names, clubs, jargon)</label>
      <textarea rows={2} placeholder="e.g. Project V, Suppstackd, libero, Keykubat" value={vocabulary} onInput={(e) => setVocabulary((e.target as HTMLTextAreaElement).value)} />
      <label class="field-label">Stop chasing someone after this many follow-ups with no reply</label>
      <input type="number" min={0} max={20} value={maxFollowups} onInput={(e) => setMaxFollowups(Number((e.target as HTMLInputElement).value))} />
      <button class="primary" onClick={() => void save()}>Save</button>
    </section>
  );
}

function Categories({ state }: { state: AppState }) {
  const [editing, setEditing] = useState<Partial<Category> | null>(null);

  async function save() {
    if (!editing) return;
    const body = {
      name: editing.name, color: editing.color, guidance: editing.guidance, followup_days: Number(editing.followup_days),
      todoist_label: editing.todoist_label, tracks_people: !!editing.tracks_people,
    };
    try {
      if (editing.id) await api(`/api/categories/${editing.id}`, { method: "PATCH", json: body });
      else await api("/api/categories", { method: "POST", json: body });
      setEditing(null);
      await state.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    }
  }

  return (
    <section>
      <div class="section-head">
        <h2>Categories</h2>
        <button class="small" onClick={() => setEditing({ name: "", color: "#0ea5e9", guidance: "", followup_days: 3, todoist_label: "", tracks_people: 1 })}>Add</button>
      </div>
      <p class="muted small-text">The description is what Catch reads to decide where things go. Write it like you would brief an assistant.</p>
      {state.categories.map((c) => (
        <div class="cat-row" key={c.id} onClick={() => setEditing(c)}>
          <Dot color={c.color} />
          <div class="grow">
            <div>{c.name}</div>
            <div class="muted small-text">{c.guidance || "No description"}</div>
          </div>
          <span class="muted small-text">{c.tracks_people ? `chase in ${c.followup_days}d` : "no chasing"}</span>
        </div>
      ))}
      {editing && (
        <div class="sheet-backdrop" onClick={() => setEditing(null)}>
          <div class="sheet stack" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.id ? "Edit category" : "New category"}</h2>
            <input placeholder="Name" value={editing.name} onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })} />
            <label class="field-label">Colour</label>
            <input type="color" value={editing.color} onInput={(e) => setEditing({ ...editing, color: (e.target as HTMLInputElement).value })} />
            <label class="field-label">What belongs here (read by Catch)</label>
            <textarea rows={3} value={editing.guidance} onInput={(e) => setEditing({ ...editing, guidance: (e.target as HTMLTextAreaElement).value })} />
            <label class="toggle"><input type="checkbox" checked={!!editing.tracks_people} onChange={(e) => setEditing({ ...editing, tracks_people: (e.target as HTMLInputElement).checked ? 1 : 0 })} /> Chase people in this category until they reply</label>
            <label class="field-label">Default deadline / follow-up after (days)</label>
            <input type="number" min={0} max={90} value={editing.followup_days} onInput={(e) => setEditing({ ...editing, followup_days: Number((e.target as HTMLInputElement).value) })} />
            <label class="field-label">Todoist label</label>
            <input value={editing.todoist_label} onInput={(e) => setEditing({ ...editing, todoist_label: (e.target as HTMLInputElement).value })} />
            <div class="row-actions">
              <button class="primary" onClick={() => void save()}>Save</button>
              {editing.id && (
                <button class="small danger" onClick={() => api(`/api/categories/${editing.id}`, { method: "PATCH", json: { archived: true } }).then(() => { setEditing(null); void state.refresh(); })}>Archive</button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Integrations() {
  const [list, setList] = useState<IntegrationView[]>([]);
  const [feed, setFeed] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const load = () => api("/api/integrations").then((r) => {
    setList(r.integrations);
    setFeed(r.calendar_feed);
  });
  useEffect(() => void load(), []);

  async function save(kind: string, enabled: boolean) {
    try {
      await api(`/api/integrations/${kind}`, { method: "PUT", json: { enabled, config: values[kind] ?? {} } });
      setValues({ ...values, [kind]: {} });
      await load();
      if (enabled) {
        const r = await api(`/api/integrations/${kind}/test`, { method: "POST" }).catch((e) => ({ ok: false, error: e.message }));
        toast(r.ok ? r.message : r.error, r.ok ? "ok" : "error");
        await load();
      } else toast("Saved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    }
  }

  return (
    <section>
      <h2>Connections</h2>
      {list.map((integ) => (
        <div class="card" key={integ.kind}>
          <div class="card-head">
            <strong>{integ.label}</strong>
            <span class={`status ${integ.enabled ? (integ.last_error ? "failed" : "done") : "queued"}`}>
              {integ.enabled ? (integ.last_error ? "Error" : "On") : "Off"}
            </span>
          </div>
          <p class="muted small-text">{integ.description}</p>
          {integ.last_error && <p class="error-text">{integ.last_error}</p>}
          <div class="stack">
            {integ.fields.map((f) => (
              <div key={f.key}>
                <label class="field-label">{f.label}{f.required ? "" : " (optional)"}</label>
                <input type={(f.type === "secret" ? "password" : f.type === "url" ? "url" : "text") as "text"}
                  placeholder={f.type === "secret" && f.set ? "•••••• saved — leave blank to keep" : f.placeholder ?? ""}
                  value={values[integ.kind]?.[f.key] ?? (f.type === "secret" ? "" : f.value)}
                  onInput={(e) => setValues({ ...values, [integ.kind]: { ...values[integ.kind], [f.key]: (e.target as HTMLInputElement).value } })} />
                {f.help && <div class="muted small-text">{f.help}</div>}
              </div>
            ))}
            <div class="row-actions">
              <button class="primary small" onClick={() => void save(integ.kind, true)}>{integ.enabled ? "Save & test" : "Connect"}</button>
              {integ.enabled && <button class="small" onClick={() => void save(integ.kind, false)}>Turn off</button>}
              {integ.enabled && integ.kind === "todoist" && (
                <button class="small" onClick={() => api(`/api/integrations/${integ.kind}/backfill`, { method: "POST" }).then((r) => toast(`Sending ${r.queued} open task(s)`))}>Send existing tasks</button>
              )}
            </div>
          </div>
        </div>
      ))}
      <div class="card">
        <div class="card-head"><strong>Calendar feed</strong><span class="status done">Ready</span></div>
        <p class="muted small-text">Appointments Catch files (sessions booked, calls set). Subscribe once: Google Calendar → Other calendars → From URL, or iPhone Settings → Calendar → Accounts → Add Subscribed Calendar. Add <code>?tasks=1</code> to also show due tasks.</p>
        <input readOnly value={feed} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <div class="row-actions">
          <button class="small" onClick={() => navigator.clipboard.writeText(feed).then(() => toast("Copied"))}>Copy</button>
          <button class="small" onClick={() => confirm("Make a new feed URL? The old one stops working.") && api("/api/feed/rotate", { method: "POST" }).then(load)}>New URL</button>
        </div>
      </div>
    </section>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<{ id: string; name: string; prefix: string; last_used_at: string | null }[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => api("/api/tokens").then((r) => setTokens(r.tokens));
  useEffect(() => void load(), []);
  return (
    <section>
      <div class="section-head">
        <h2>API tokens</h2>
        <button class="small" onClick={async () => {
          const name = prompt("Name this token (e.g. iPhone Shortcut)") ?? "";
          if (!name) return;
          const r = await api("/api/tokens", { method: "POST", json: { name } });
          setFresh(r.token);
          await load();
        }}>New</button>
      </div>
      <p class="muted small-text">For iOS Shortcuts and other apps: send captures with <code>Authorization: Bearer &lt;token&gt;</code>. See docs/API.md.</p>
      {fresh && (
        <div class="callout">
          Copy this now — it is not shown again:
          <input readOnly value={fresh} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <button class="small" onClick={() => navigator.clipboard.writeText(fresh).then(() => toast("Copied"))}>Copy</button>
        </div>
      )}
      {tokens.map((t) => (
        <div class="cat-row" key={t.id}>
          <div class="grow">{t.name} <span class="muted small-text">{t.prefix}… {t.last_used_at ? `used ${t.last_used_at.slice(0, 10)}` : "never used"}</span></div>
          <button class="small danger" onClick={() => confirm(`Revoke "${t.name}"?`) && api(`/api/tokens/${t.id}`, { method: "DELETE" }).then(load)}>Revoke</button>
        </div>
      ))}
    </section>
  );
}

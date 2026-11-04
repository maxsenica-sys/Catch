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
      <ShareShortcut />
      <Duplicates state={state} />
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

/**
 * The fastest capture route on an iPhone: start in Photos, select screenshots,
 * Share → Catch, talk, tap. No app to open and no "Photo Library / Take Photo"
 * menu, which iOS shows for every web photo picker and no web app can skip.
 * The Shortcut uploads each screenshot to the open draft, records, and finishes it.
 */
function ShareShortcut() {
  const [token, setToken] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const base = location.origin;
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`));
  return (
    <section>
      <div class="card">
        <div class="card-head"><strong>Share from Photos (iPhone)</strong></div>
        <p class="muted small-text">
          The quickest way in: in <b>Photos</b>, select screenshots → <b>Share</b> → <b>Catch</b> → talk → tap to stop.
          No app to open, no photo menu. Takes about 5 minutes to set up, once.
        </p>
        {!open ? (
          <button class="primary small" onClick={() => setOpen(true)}>Show me how</button>
        ) : (
          <div class="stack">
            <p><b>1.</b> Create the key the Shortcut uses:</p>
            {token ? (
              <div class="row-actions">
                <input readOnly value={`Bearer ${token}`} onFocus={(e) => (e.target as HTMLInputElement).select()} />
                <button class="small" onClick={() => void copy(`Bearer ${token}`, "Key")}>Copy key</button>
              </div>
            ) : (
              <button class="small" onClick={async () => {
                const r = await api("/api/tokens", { method: "POST", json: { name: "Share to Catch (iPhone)" } });
                setToken(r.token);
              }}>Create key</button>
            )}
            <p class="muted small-text">Shown once. Paste it straight into the Shortcut; if you lose it, make another.</p>
            <p><b>2.</b> Open the <b>Shortcuts</b> app → <b>+</b> → name it <b>Catch</b>. Tap <b>ⓘ</b> → turn on <b>Show in Share Sheet</b>, and set it to receive <b>Images</b>.</p>
            <p><b>3.</b> Add <b>Repeat with Each</b> (item: <i>Shortcut Input</i>). Inside it add:</p>
            <ul class="small-text">
              <li><b>Convert Image</b> → <i>Repeat Item</i> to <b>JPEG</b></li>
              <li><b>Get Contents of URL</b> → URL below, Method <b>POST</b>, Header <b>Authorization</b> = your key, Request Body <b>Form</b>, add a <b>File</b> field named <code>image</code> = <i>Converted Image</i></li>
            </ul>
            <div class="row-actions">
              <input readOnly value={`${base}/api/captures/draft`} />
              <button class="small" onClick={() => void copy(`${base}/api/captures/draft`, "URL")}>Copy URL</button>
            </div>
            <p><b>4.</b> After <b>End Repeat</b>, add <b>Record Audio</b> → Start Recording <b>Immediately</b>, Finish Recording <b>On Tap</b>.</p>
            <p><b>5.</b> Add another <b>Get Contents of URL</b> → URL below, Method <b>POST</b>, same <b>Authorization</b> header, Form with a <b>File</b> field named <code>audio</code> = <i>Recorded Audio</i>.</p>
            <div class="row-actions">
              <input readOnly value={`${base}/api/captures/draft/finish`} />
              <button class="small" onClick={() => void copy(`${base}/api/captures/draft/finish`, "URL")}>Copy URL</button>
            </div>
            <p><b>6.</b> Add <b>Show Notification</b> → “Caught”. Done.</p>
            <p class="muted small-text">
              Use it: Photos → select screenshots → Share → Catch → talk → tap the stop button. It appears in your Inbox
              seconds later. If you skip the recording, the screenshots are filed by themselves after 10 minutes.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

interface DupReport {
  tasks: { keep: { id: string; title: string; contact_name: string | null }; remove: { id: string; title: string }[] }[];
  captures: { keep: { id: string; summary: string | null }; remove: { id: string; summary: string | null; created_at: string }[] }[];
}

/**
 * Check, show, then remove. Nothing goes without being listed first, unless
 * the user has switched on automatic removal (checked every 15 minutes).
 */
function Duplicates({ state }: { state: AppState }) {
  const [auto, setAuto] = useState(state.me.user.settings.autoDedupe === true);
  const [report, setReport] = useState<DupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const count = report ? report.tasks.reduce((n, g) => n + g.remove.length, 0) + report.captures.reduce((n, g) => n + g.remove.length, 0) : 0;

  async function toggle(value: boolean) {
    setAuto(value);
    await api("/api/me", { method: "PATCH", json: { settings: { autoDedupe: value } } }).catch(() => setAuto(!value));
    await state.refresh();
    toast(value ? "Duplicates will be removed automatically" : "Automatic removal off");
  }

  async function clean() {
    setBusy(true);
    try {
      const r = await api("/api/duplicates/clean", { method: "POST" });
      toast(`Removed ${r.tasks} task${r.tasks === 1 ? "" : "s"} and ${r.captures} capture${r.captures === 1 ? "" : "s"}`);
      setReport(await api("/api/duplicates"));
      void state.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div class="card">
        <div class="card-head"><strong>Duplicates</strong></div>
        <p class="muted small-text">
          Finds tasks for the same person that say nearly the same thing, and captures whose screenshots are identical.
          The oldest is kept (with the earliest deadline and any draft); copies disappear from your lists and Todoist.
          People are never removed here.
        </p>
        <label class="toggle"><input type="checkbox" checked={auto} onChange={(e) => void toggle((e.target as HTMLInputElement).checked)} /> Remove duplicates automatically</label>
        <div class="row-actions">
          <button class="small" disabled={busy} onClick={() => void api("/api/duplicates").then(setReport)}>Check now</button>
          {count > 0 && <button class="small primary" disabled={busy} onClick={() => void clean()}>Remove {count} duplicate{count === 1 ? "" : "s"}</button>}
        </div>
        {report && count === 0 && <p class="muted small-text">No duplicates. All clean.</p>}
        {report?.tasks.map((g) => (
          <div class="dup-group" key={g.keep.id}>
            <div class="small-text"><b>Keep:</b> {g.keep.title}{g.keep.contact_name ? ` — ${g.keep.contact_name}` : ""}</div>
            {g.remove.map((t) => <div class="small-text muted" key={t.id}>Remove: {t.title}</div>)}
          </div>
        ))}
        {report?.captures.map((g) => (
          <div class="dup-group" key={g.keep.id}>
            <div class="small-text"><b>Keep capture:</b> {g.keep.summary ?? "(no summary)"}</div>
            {g.remove.map((c) => <div class="small-text muted" key={c.id}>Remove the same screenshot sent again: {c.summary ?? "(no summary)"}</div>)}
          </div>
        ))}
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

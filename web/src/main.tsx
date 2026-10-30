import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api, onUnauthorised, type Category, type Me } from "./api";
import { setSignedOut, startPumping, subscribe, type OutboxItem } from "./outbox";
import { Toasts } from "./util";
import { AuthScreen } from "./screens/Auth";
import { CaptureScreen } from "./screens/Capture";
import { InboxScreen } from "./screens/Inbox";
import { TasksScreen } from "./screens/Tasks";
import { PeopleScreen, PersonScreen } from "./screens/People";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import "./styles.css";

export interface AppState {
  me: Me;
  categories: Category[];
  summary: { due: number; overdue: number; review: number; processing: number; failed: number; integration_errors: { kind: string; last_error: string }[] };
  outbox: OutboxItem[];
  refresh: () => Promise<void>;
}

function useHashRoute(): [string, URLSearchParams] {
  const read = () => {
    const raw = location.hash.replace(/^#/, "") || "/capture";
    const [path, query] = raw.split("?");
    return [path, new URLSearchParams(query ?? "")] as [string, URLSearchParams];
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const TABS = [
  { path: "/capture", label: "Capture", icon: "●" },
  { path: "/inbox", label: "Inbox", icon: "☰" },
  { path: "/tasks", label: "Tasks", icon: "✓" },
  { path: "/people", label: "People", icon: "◎" },
  { path: "/settings", label: "Settings", icon: "⚙" },
];

function App() {
  const [phase, setPhase] = useState<"loading" | "auth" | "ready">("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [summary, setSummary] = useState<AppState["summary"]>({ due: 0, overdue: 0, review: 0, processing: 0, failed: 0, integration_errors: [] });
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [path, query] = useHashRoute();

  const refresh = useCallback(async () => {
    const [m, c, s] = await Promise.all([api<Me>("/api/me"), api<{ categories: Category[] }>("/api/categories"), api("/api/summary")]);
    setMe(m);
    setCategories(c.categories);
    setSummary(s);
  }, []);

  useEffect(() => {
    startPumping();
    const unsub = subscribe(setOutbox);
    const off = onUnauthorised(() => {
      setSignedOut(true);
      setPhase("auth");
    });
    refresh().then(() => setPhase("ready")).catch(() => {
      setSignedOut(true);
      setPhase("auth");
    });
    return () => {
      unsub();
      off();
    };
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    const t = setInterval(() => void api("/api/summary").then(setSummary).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [phase]);

  if (phase === "loading") return <div class="splash">Catch</div>;
  if (phase === "auth" || !me) {
    return (
      <AuthScreen
        onDone={async () => {
          await refresh();
          setSignedOut(false);
          setPhase("ready");
        }}
      />
    );
  }

  const state: AppState = { me, categories, summary, outbox, refresh };
  const [, section, sub] = path.split("/");
  let screen;
  switch (section) {
    case "inbox": screen = <InboxScreen state={state} />; break;
    case "tasks": screen = <TasksScreen state={state} />; break;
    case "people": screen = sub ? <PersonScreen state={state} id={sub} /> : <PeopleScreen state={state} />; break;
    case "review": screen = <ReviewScreen state={state} />; break;
    case "settings": screen = <SettingsScreen state={state} />; break;
    default: screen = <CaptureScreen state={state} initialCategory={query.get("category")} shared={query.get("shared") === "1"} />;
  }
  const badge = (p: string) =>
    p === "/tasks" ? summary.due : p === "/inbox" ? summary.review + summary.failed + outbox.length : 0;

  return (
    <div class="shell">
      {me.providers.offline && section !== "settings" && (
        <a class="banner warn" href="#/settings">Offline mode: screenshots and voice are not read until API keys are set →</a>
      )}
      <main class="screen">{screen}</main>
      <nav class="tabs">
        {TABS.map((t) => (
          <a key={t.path} href={`#${t.path}`} class={`tab ${`/${section || "capture"}` === t.path ? "active" : ""}`}>
            <span class="tab-icon">{t.icon}</span>
            <span>{t.label}</span>
            {badge(t.path) > 0 && <span class="badge">{badge(t.path)}</span>}
          </a>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

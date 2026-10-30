import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../main";
import { api, type Task } from "../api";
import { TaskRow } from "./TaskRow";

const VIEWS = [
  { key: "today", label: "Due" },
  { key: "open", label: "All open" },
  { key: "done", label: "Done" },
] as const;

export function TasksScreen({ state }: { state: AppState }) {
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("today");
  const [data, setData] = useState<{ today: string; tasks: Task[] } | null>(null);
  const load = () => api(`/api/tasks?view=${view}`).then(setData).catch(() => {});
  useEffect(() => void load(), [view]);

  const changed = () => {
    void load();
    void state.refresh();
  };

  return (
    <div>
      <header class="bar"><h1>Tasks</h1></header>
      <div class="segmented">
        {VIEWS.map((v) => (
          <button key={v.key} class={view === v.key ? "on" : ""} onClick={() => setView(v.key)}>
            {v.label}{v.key === "today" && state.summary.due ? ` (${state.summary.due})` : ""}
          </button>
        ))}
      </div>
      {data?.tasks.length === 0 && (
        <p class="empty">{view === "today" ? "Nothing due. Nice." : view === "done" ? "Nothing done yet." : "No open tasks."}</p>
      )}
      {data?.tasks.map((t) => <TaskRow key={t.id} task={t} today={data.today} onChange={changed} />)}
    </div>
  );
}

import { useState } from "preact/hooks";
import { api, type Task } from "../api";
import { copyAndOpen, dueLabel, toast, vibrate } from "../util";

/** One task: tick it, open the conversation (draft on the clipboard), or push it back a day. */
export function TaskRow({ task, today, onChange, showContact = true }: { task: Task; today: string; onChange: () => void; showContact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const due = dueLabel(task.due_on, today, task.due_time);
  const done = task.status !== "open";

  async function patch(body: Record<string, unknown>, message?: string) {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", json: body });
      if (message) toast(message);
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={`task ${done ? "done" : ""}`}>
      <button class={`check ${done ? "on" : ""}`} disabled={busy} aria-label={done ? "Reopen" : "Mark done"}
        onClick={() => {
          vibrate(15);
          void patch({ status: done ? "open" : "done" }, done ? "Reopened" : "Done");
        }}>
        {done ? "✓" : ""}
      </button>
      <div class="task-body">
        <div class="task-title">{task.title}</div>
        <div class="task-meta">
          {!done && <span class={`due ${due.tone}`}>{due.text}</span>}
          {showContact && task.contact_name && task.contact_id && <a href={`#/people/${task.contact_id}`}>{task.contact_name}</a>}
          {task.kind === "followup" && <span class="muted">auto follow-up</span>}
        </div>
        {task.draft_message && !done && <div class="draft">“{task.draft_message}”</div>}
        {!done && (
          <div class="row-actions">
            {(task.link || task.draft_message) && (
              <button class="small primary" onClick={() => void copyAndOpen(task.draft_message, task.link)}>
                {task.link ? (task.draft_message ? "Copy draft & open" : "Open") : "Copy draft"}
              </button>
            )}
            <button class="small" disabled={busy} onClick={() => void patch({ snooze_days: 1 }, "Moved to tomorrow")}>Tomorrow</button>
            <button class="small" disabled={busy} onClick={() => void patch({ snooze_days: 7 }, "Moved a week")}>+1 week</button>
          </div>
        )}
      </div>
    </div>
  );
}

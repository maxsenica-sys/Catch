"""
Mutation check: break the code on purpose, one place at a time, and confirm
the named test file goes red. A test that has never failed is not known to
work. Run from the repo root: python3 scripts/mutation-check.py
Each case restores the file afterwards, even on failure.
"""
import subprocess, sys
cases = [
  ("overdue to-do placed on its past day", "server/integrations/gcal.ts", "const day = overdue ? today : task.due_on;", "const day = task.due_on;", "test/gcal.test.ts"),
  ("overdue to-dos never roll forward", "server/app.ts", "if (user && rollOverdueTodos(db, user) > 0) ctx.worker.kick();", "", "test/gcal.test.ts"),
  ("roll moves a to-do every sweep", "server/integrations/gcal.ts", ").filter((r) => todayIn(user.timezone, new Date(r.placed)) < today);", ");", "test/gcal.test.ts"),
  ("model person match trusted without name check", "server/pipeline/process.ts", "if (match.kind === \"new\" && hinted && firstNameAgrees(db, hinted, person)) {", "if (match.kind === \"new\" && hinted) {", "test/pipeline.test.ts"),
  ("model task match crosses people", "server/pipeline/process.ts", "const twin = target && (!contactId || !target.contact_id || target.contact_id === contactId)", "const twin = target", "test/pipeline.test.ts"),
  ("model task match ignored", "server/pipeline/process.ts", "const hintedTaskId = action.existing_task ? known.tasks.get(action.existing_task) : undefined;", "const hintedTaskId = undefined as string | undefined;", "test/pipeline.test.ts"),
  ("calendar to-dos ignore the switch", "server/integrations/gcal.ts", "if (!tasksOnCalendar(c.user)) return undefined;", "", "test/gcal.test.ts"),
  ("ticked task stays on calendar", "server/integrations/gcal.ts", 'if (externalId) await call(c, { action: "delete", id: externalId });\n  },', "},", "test/gcal.test.ts"),
  ("task edits not sent anywhere", "server/http/routes-people.ts", 'enqueue(ctx.db, "deliver", { userId: user.id, event: "task.updated", objectId: task.id });', "", "test/integrations.test.ts"),
  ("repeated screenshot read again", "server/pipeline/process.ts", "    if (repeat) {", "    if (false) {", "test/duplicates.test.ts"),
  ("repeat check ignores new voice", "server/pipeline/process.ts", "    if (!said) return true;", "    return true;", "test/duplicates.test.ts"),
  ("calendar create not idempotent in the script", "server/integrations/gcal.ts", "if (seen && cal.getEventById(seen))", "if (false)", "test/gcal.test.ts"),
  ("calendar sent wall-clock, not an instant", "server/integrations/gcal.ts", "const start = localToUtc(ev.date, ev.start_time, c.user.timezone);", "const start = new Date(`${ev.date}T${ev.start_time}:00Z`);", "test/gcal.test.ts"),
  ("events never sent to the calendar", "server/pipeline/process.ts", 'enqueue(db, "deliver", { userId: user.id, event: "event.created", objectId: eventId });', "", "test/gcal.test.ts"),
  ("feed still lists events Google has", "server/app.ts", "AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.integration = 'google_calendar'", "AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.integration = 'nothing'", "test/gcal.test.ts"),
  ("script time zone not checked", "server/integrations/gcal.ts", "if (tz && tz !== c.user.timezone) {", "if (false) {", "test/gcal.test.ts"),
  ("channel label dropped", "server/integrations/todoist.ts", "labels: [task.categoryLabel, task.channel ? CHANNEL_LABELS[task.channel] : null]", "labels: [task.categoryLabel, null]", "test/integrations.test.ts"),
  ("migration overwrites customised category", "server/db/migrations.ts", " WHERE key = 'instagram' AND guidance = ", " WHERE key = 'instagram' OR guidance = ", "test/pipeline.test.ts"),
  ("duplicate cleanup does nothing", "server/pipeline/duplicates.ts", "    if (group) group.remove.push(t);", "    if (false) group.remove.push(t);", "test/duplicates.test.ts"),
  ("cleanup removes people's tasks across people", "server/pipeline/duplicates.ts", 'const key = t.contact_id ?? "";', 'const key = "";', "test/duplicates.test.ts"),
  ("auto cleanup ignores the setting", "server/app.ts", "if (user && autoDedupeEnabled(user))", "if (user)", "test/duplicates.test.ts"),
  ("duplicate tasks not merged", "server/pipeline/process.ts", "return open.find((t) => titleSimilarity(t.title, title) >= DUPLICATE_TASK_SIMILARITY);", "return undefined;", "test/pipeline.test.ts"),
  ("draft finish not idempotent", "server/http/routes-captures.ts", "if (again) return c.json(", "if (false) return c.json(", "test/draft.test.ts"),
  ("stale drafts never filed", "server/http/routes-captures.ts", "for (const c of stale) queueCapture(ctx, c.id);", "", "test/draft.test.ts"),
  ("schema back to unions", "server/pipeline/schema.ts", 'const nstr = { type: "string" };', 'const nstr = { anyOf: [{ type: "string" }, { type: "null" }] };', "test/extract.test.ts"),
  ("handle match skipped", "server/pipeline/resolve.ts", "if (rows.length > 0) return", "if (false) return", "test/pipeline.test.ts"),
  ("stage may regress", "server/pipeline/process.ts", "stageRank(person.stage) > stageRank(String(c.stage))", "person.stage !== c.stage", "test/pipeline.test.ts"),
  ("past due not clamped", "server/pipeline/dates.ts", "if (stated < today) return { due_on: today, source: \"stated\" };", "", "test/dates.test.ts"),
  ("CSRF header not required", "server/http/auth.ts", "c.req.header(\"x-catch\") !== \"1\"", "false", "test/api.test.ts"),
  ("delivery not deduped", "server/integrations/index.ts", "if (delivered(db, row.kind, \"task\", payload.objectId)) continue;", "", "test/integrations.test.ts"),
  ("sweep ignores open task", "server/pipeline/followups.ts", "AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.contact_id = contacts.id AND t.status = 'open')", "", "test/followups.test.ts"),
  ("files not scoped to user", "server/http/routes-captures.ts", "WHERE f.id = ? AND c.user_id = ?`,\n      c.req.param(\"id\"), c.get(\"user\").id,", "WHERE f.id = ?`,\n      c.req.param(\"id\"),", "test/api.test.ts"),
  ("namesake merged", "server/pipeline/resolve.ts", "if (!contradicts) return", "return", "test/pipeline.test.ts"),
  ("idempotency dropped (both guards)", "server/http/routes-captures.ts", "if (existing) return c.json(", "if (false) return c.json(", "test/pipeline.test.ts"),
  ("todoist due post-condition removed", "server/integrations/todoist.ts", "if (task.due_on && !data.due) {", "if (false) {", "test/integrations.test.ts"),
]
missed = 0
for name, path, old, new, test in cases:
    src = open(path).read()
    assert old in src, f"{name}: pattern not found"
    mod = src.replace(old, new, 1)
    if "both guards" in name:
        mod = mod.replace("if (raced) return c.json(", "if (false) return c.json(")
    open(path, "w").write(mod)
    try:
        r = subprocess.run(["node", "--test", "--test-concurrency=1", test], capture_output=True, text=True, timeout=200)
        fails = [l for l in r.stdout.splitlines() if l.startswith("not ok")]
        missed += 0 if fails else 1
        print(("CAUGHT " if fails else "MISSED ") + name + ("  -> " + fails[0][7:90] if fails else ""))
    finally:
        open(path, "w").write(src)

sys.exit(1 if missed else 0)

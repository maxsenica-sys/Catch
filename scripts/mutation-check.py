"""
Mutation check: break the code on purpose, one place at a time, and confirm
the named test file goes red. A test that has never failed is not known to
work. Run from the repo root: python3 scripts/mutation-check.py
Each case restores the file afterwards, even on failure.
"""
import subprocess, sys
cases = [
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

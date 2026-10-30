# Catch: conventions for working on this repo

Read `docs/ARCHITECTURE.md` first. These are the rules that are easy to break
without noticing.

## Checks before every push

```bash
npm run typecheck && npm test && npm run build && npm run test:e2e
```

`npm run check` runs all four. The e2e needs Playwright with Chromium
(`npm i --no-save playwright && npx playwright install chromium`).

A test that has never failed is not known to work. When adding a test, break
the code it guards and watch it go red; add the case to
`scripts/mutation-check.py`. If an injected bug is *not* caught, find out
whether a second guard masked it (the upload-idempotency case in the script
only goes red with both guards removed) before concluding the test is fine.

## Rules

- **The model judges, the server decides.** Do not move matching, dates or
  stage logic into the prompt. The prompt says what is in the screenshot;
  `resolve.ts`, `dates.ts`, `process.ts` and `followups.ts` decide what that
  means, with tests.
- **Nothing invents a date.** No date stated means `due_source: "default"` from
  the category's `followup_days`, never a guess dressed up as stated. A dropped
  date is a review item, never silent.
- **A duplicate beats a wrong merge.** First-name-only matches are never merged
  automatically.
- **Merges only add, stages only advance** (from captures; the user can set any
  stage by hand).
- **Exactly once outward.** Every integration call goes through `deliver()` and
  the `deliveries` ledger. Never call Todoist (or anything) directly from a
  route or the pipeline.
- **The phone never waits.** `POST /api/captures` stores and queues; nothing
  slow happens before the 202. Do not add synchronous work to that route.
- **Uploads are idempotent on `client_id`.** Keep it that way: the outbox
  retries blindly.
- **Time zone is the user's.** Never compute "today" with `new Date()` in UTC;
  use `todayIn(user.timezone)`. Dates the user thinks in are `YYYY-MM-DD`
  strings.
- **Two schema definitions, kept in step.** `schema.ts` has the JSON Schema the
  model is constrained to and the zod schema the server trusts. Change both;
  `test/extract.test.ts` checks they agree.
- **Migrations are append-only.** Never edit an entry in `MIGRATIONS` that has
  shipped.
- **Every query is scoped by `user_id`.** `test/api.test.ts` has an isolation
  test; extend it when adding a route that reads user data.
- **Recording codec is detected, never assumed.** iOS records mp4, Chrome webm.
  The upload filename extension must match (`audioExt`).
- **Secrets never leave the server.** Integration config is encrypted with
  `APP_SECRET` and the API returns only whether a secret is set.

## Model

`claude-opus-5-5` by default (`CATCH_MODEL`), effort `medium` (`CATCH_EFFORT`),
structured output via `output_config.format`, and server-side refusal
fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). The
SDK sends the key as `Authorization: Bearer` in 1.x.

## Deploying

Claude deploys; Max does not. Keys come from the Claude Code environment
(`FLY_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and reach the app only
through `flyctl secrets set`; never echo or commit them. From a session:

```bash
flyctl apps create catch-maxsenica-sys --org personal            # first time only
flyctl volumes create catch_data --size 1 --region fra --app catch-maxsenica-sys --yes   # first time only
flyctl secrets set --app catch-maxsenica-sys --stage APP_SECRET=$(openssl rand -hex 32) \
  PUBLIC_URL=https://catch-maxsenica-sys.fly.dev                  # APP_SECRET first time only: changing it orphans saved tokens
flyctl secrets set --app catch-maxsenica-sys --stage ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY"
flyctl deploy --remote-only --app catch-maxsenica-sys --ha=false
curl -fsS https://catch-maxsenica-sys.fly.dev/healthz              # extractor must not say "mock"
```

`.github/workflows/deploy.yml` does the same from GitHub Actions if a
`FLY_API_TOKEN` repository secret is ever added; until then it skips, green.
Always one machine (`--ha=false`): SQLite and the job queue are in-process.

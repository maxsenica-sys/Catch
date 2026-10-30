# Deploying Catch

Catch is one container with one persistent volume. It needs:

- **HTTPS.** Phones only allow the microphone on `https://` pages (and
  `localhost`). Every option below gives you HTTPS.
- **A persistent disk** at `DATA_DIR` for the SQLite database and uploads.
- **Exactly one instance.** The job queue runs in-process against SQLite; two
  instances would both pick up the same work. Scale up, not out.

## Environment

See `.env.example` for everything. The minimum for a real deployment:

| Variable | |
|---|---|
| `APP_SECRET` | `openssl rand -hex 32`. Encrypts integration tokens. Required when `NODE_ENV=production`. |
| `PUBLIC_URL` | The https address, e.g. `https://catch-app.fly.dev`. |
| `ANTHROPIC_API_KEY` | Reads screenshots. Without it: offline mode. |
| `OPENAI_API_KEY` | Transcribes voice notes. Without it: voice is stored, not read. |
| `SIGNUP_MODE` / `INVITE_CODE` | `invite` + a code to let others join; `closed` for just you. The first account can always be created. |

Check what is live at `GET /healthz`: it names the transcriber and extractor in
use (`mock` means offline).

## Option A: Fly.io, deployed by GitHub (recommended)

`.github/workflows/deploy.yml` deploys after every green CI run on `main`. The
first run creates the app, its 1 GB volume and `APP_SECRET`; later runs only
deploy. Keys live in GitHub's encrypted secrets and Fly's, never in the repo.

1. Make a Fly.io account (a card is required) at https://fly.io/app/sign-up.
2. Fly dashboard → **Tokens** → create an **org token**. Copy it.
3. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**:
   - `FLY_API_TOKEN`: the token (required)
   - `ANTHROPIC_API_KEY`: reads screenshots (optional; offline mode without it)
   - `OPENAI_API_KEY`: transcribes voice (optional)
   - `INVITE_CODE`: lets other people join (optional)
4. **Actions → Deploy → Run workflow.** About three minutes. The run ends with
   `Catch is live at https://catch-<owner>.fly.dev`.

Optional repository *variables* (same page, Variables tab): `FLY_APP` to
choose the name, `FLY_REGION` for the region (default `fra`, Frankfurt;
`syd` for Sydney).

Adding or changing a key later: update the GitHub secret, then run the Deploy
workflow again.

`fly.toml` keeps one machine always running (`auto_stop_machines = "off"`):
the follow-up sweep and Todoist sync run on timers inside the process, so a
stopped machine would stop chasing people.

### By hand, if you prefer

```bash
fly apps create catch-<you> && fly volumes create catch_data --size 1 --region fra --app catch-<you>
fly secrets set --app catch-<you> APP_SECRET=$(openssl rand -hex 32) PUBLIC_URL=https://catch-<you>.fly.dev \
  ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-...
fly deploy --app catch-<you> --ha=false
```

## Option B: Railway / Render

Create a service from the GitHub repo (it finds the `Dockerfile`), add a
volume mounted at `/data`, set the variables above, and deploy. Set the
instance count to 1.

## Option C: any Docker host

```bash
cp .env.example .env    # fill it in
docker compose up -d
```

Then put HTTPS in front: Caddy (`caddy reverse-proxy --from catch.example.com
--to localhost:8787`), a Cloudflare Tunnel, or your host's proxy.

## Backups

Everything is in the volume: `catch.db` (plus its `-wal` file) and `files/`.
For a consistent copy of a live database:

```bash
sqlite3 /data/catch.db ".backup /data/backup-$(date +%F).db"
```

Keep `APP_SECRET` with the backup, or integration tokens will need re-entering
after a restore (they are encrypted with it; nothing else is).

## Upgrading

`fly deploy` / redeploy the container. Migrations run at boot and are
append-only. Jobs that were running when the old process stopped are put back
on the queue by the new one, so nothing in flight is lost.

## Costs, roughly

Per capture: one Claude call with one to three screenshots (a few cents on
`claude-opus-5-5`; set `CATCH_EFFORT=low` or a cheaper `CATCH_MODEL` to trade
quality for cost) plus a few seconds of transcription (fractions of a cent).
Hosting: a shared-CPU machine with a 1 GB volume.

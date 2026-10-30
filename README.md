# Catch

**Screenshot it, say it, forget it.**

Catch is a capture app for people whose work arrives as messages: coaches,
trainers, small-business owners. Take a screenshot (a DM, a comment, a profile,
an email, a booking form), open Catch, hold the mic, say what it is, let go.
That's the whole job. Catch then:

- **works out who is in it** and files them in a contacts database, with their
  handles, sport, position, location and what they asked for, matched against
  people you already have so nobody is duplicated;
- **categorises it** (Coaching, Lead, Instagram, Program, Follow-up,
  Partnership, or categories you write yourself);
- **turns it into dated tasks** with a ready-to-send draft message and a link
  that opens the right conversation;
- **chases people for you**: anyone in a chased category who has not replied
  gets a follow-up task on schedule, and is parked after a few unanswered
  rounds instead of being nagged for ever;
- **sends tasks to Todoist** (and ticks in Todoist flow back), puts booked
  sessions on your calendar, and posts everything to a webhook if you want it
  anywhere else.

Nothing is ever sent in your name. Catch drafts; you press send.

## How a capture flows

```
 phone                         server                               out
 ─────                         ──────                               ───
 screenshots ┐                 ┌─ transcribe voice (OpenAI)
 chip        ├─► outbox ─POST─►├─ read it all (Claude, vision)  ─► Todoist
 voice note  ┘   (IndexedDB)   ├─ match people, apply dates     ─► calendar feed (.ics)
                 retries until ├─ tasks + follow-up clock       ─► webhook (Zapier/Make/n8n)
                 acknowledged  └─ inbox shows what it filed     ─► vCard / CSV
```

The phone never waits on the server. A capture is saved on the phone the
instant you let go of the mic, and uploads in the background, including later
if you had no signal. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it locally (2 minutes, no keys)

```bash
npm install
npm run build        # the phone app
npm run dev          # the server, on http://localhost:8787
```

Open http://localhost:8787 and create the first account; it becomes the owner.
With no API keys Catch runs in **offline mode**: everything works end to end,
but it reads only typed notes, not screenshots or voice. Every screen says so.

To make it real, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`
(reads screenshots) and `OPENAI_API_KEY` (transcribes voice). Restart.

## Put it on your phone

Catch needs to be on an `https://` address, because phones only allow the
microphone there. [docs/DEPLOY.md](docs/DEPLOY.md) covers Fly.io, Railway and
any Docker host. Then:

- **iPhone:** open the address in Safari → Share → **Add to Home Screen**.
- **Android:** open in Chrome → menu → **Install app**. Catch then appears in
  the share sheet, so you can share screenshots straight into it.
- **One-tap from a screenshot on iPhone:** [docs/IOS-SHORTCUT.md](docs/IOS-SHORTCUT.md).

## Connect your tools

Settings → Connections:

| | What it does |
|---|---|
| **Todoist** | Every task lands in a "Catch" project with its category label, due date, draft and link. Ticking it in Todoist ticks it in Catch and moves the contact on. |
| **Calendar feed** | A private `.ics` URL. Subscribe once in Google or Apple Calendar; booked sessions appear there. |
| **Webhook** | Signed JSON for every capture and task, to Zapier, Make, n8n or your own server. The universal adapter. |
| **API tokens** | For iOS Shortcuts and scripts: `POST /api/captures` with a bearer token. [docs/API.md](docs/API.md). |
| **Export** | Contacts as CSV (spreadsheets, CRMs) or vCard (phone contacts). |

## Develop

```bash
npm run dev            # server with reload
npm run dev:web        # phone app with hot reload on :5173 (proxies /api)
npm run typecheck
npm test               # 38 tests: pipeline, matching, follow-ups, integrations, auth, API
npm run test:e2e       # real Chromium, fake mic: hold-to-record → filed → offline outbox
python3 scripts/mutation-check.py   # breaks the code 10 ways, proves the tests notice
npm run check          # all of the above except mutation
```

Read [CLAUDE.md](CLAUDE.md) before changing anything: it records the rules the
design depends on.

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the pipeline, the data model and why each piece is the way it is
- [DEPLOY.md](docs/DEPLOY.md): hosting, HTTPS, backups, keys
- [API.md](docs/API.md): every endpoint, for Shortcuts and other apps
- [IOS-SHORTCUT.md](docs/IOS-SHORTCUT.md): screenshot → Catch in one tap on iPhone
- [ROADMAP.md](docs/ROADMAP.md): what is next, and what was deliberately left out

# API

Everything the app does goes through this API, so anything else can do it too:
an iOS Shortcut, a script, another app.

## Authentication

- **API token** (scripts, Shortcuts): create one in Settings → API tokens, then
  send `Authorization: Bearer catch_...`. Shown once; revoke any time.
- **Session cookie** (the app). Cookie-authenticated writes must also send
  `X-Catch: 1` (the CSRF check). Token requests do not need it.

Errors are `{"error": "human-readable message"}` with a 4xx/5xx status.

## Captures

### `POST /api/captures` (multipart/form-data)

| Field | |
|---|---|
| `image` | 0–10 files (repeat the field). PNG, JPEG, GIF or WebP. HEIC is refused with a 415 naming the fix. |
| `audio` | 0–1 file. Any `audio/*` (iOS `audio/mp4`, Chrome `audio/webm`). |
| `note` | optional text |
| `category` | optional category key (`coaching`, `lead`, …) or `auto` |
| `client_id` | **send one.** Any unique string per capture; retries with the same id return the original instead of a duplicate. |
| `captured_at` | optional ISO timestamp, default now |

At least one of image, audio or note. Answers **202** immediately with the
queued capture; processing happens in the background. Same `client_id` again:
**200** with `"duplicate": true`.

```bash
curl -X POST https://catch.example.com/api/captures \
  -H "Authorization: Bearer $CATCH_TOKEN" \
  -F client_id=$(uuidgen) -F category=lead \
  -F image=@screenshot.png -F note="Wants a trial session, DM Monday"
```

### `GET /api/captures?limit=30&before=<iso>`
Newest first. Each capture includes `status`, `summary`, `transcript`,
`files`, `people`, `tasks`, `events` and open `reviews`.

### `GET /api/captures/:id` · `POST /api/captures/:id/retry` (failed only) · `DELETE /api/captures/:id`
Deleting removes the capture and its files; people and tasks it created stay.

### `GET /api/files/:id`
A capture's image or audio (owner only).

## Contacts

- `GET /api/contacts?q=&category=&stage=&review=1&archived=1`
- `GET /api/contacts/:id`: contact, handles, tasks, events, timeline, duplicate suggestions
- `PATCH /api/contacts/:id`: any of `name, first_name, last_name, category, stage, role, sport, position, level, location, organisation, email, phone, notes, next_followup_on, archived`. Setting `stage` to `booked`, `client`, `parked` or `dead` ends the chase.
- `POST /api/contacts/:id/merge` `{"into": "<contact id>"}`
- `GET /api/contacts/:id/vcard`: opens the phone's Add Contact sheet
- `GET /api/export/contacts.csv` · `GET /api/export/contacts.vcf`

Stages: `new → contacted → replied → booked → client`, plus `parked`, `dead`.

## Tasks

- `GET /api/tasks?view=today|open|done`. `today` means due today or overdue.
- `PATCH /api/tasks/:id`: `status` (`open|done|dismissed`), `title`, `due_on`, `due_time`, `priority` (1–4), `draft_message`, or `snooze_days`.
  Marking done moves the contact from `new` to `contacted` and schedules their next follow-up.

## Review

- `GET /api/review`
- `POST /api/review/:id/resolve` `{"action": "merge", "into": "<id>"}` | `{"action": "keep"}` | `{"action": "dismiss"}`

## Settings

- `GET /api/me` · `PATCH /api/me` `{name, timezone, date_order, settings: {autoSend, vocabulary, maxFollowups}}`
- `GET /api/summary`: badge counts (due, overdue, review, processing, failed) and integration errors
- `GET/POST /api/categories` · `PATCH /api/categories/:id` (the `key` never changes; `archived: true` hides it)
- `GET /api/integrations` · `PUT /api/integrations/:kind` `{enabled, config}` · `POST /api/integrations/:kind/test` · `POST /api/integrations/:kind/backfill`
- `GET/POST /api/tokens` · `DELETE /api/tokens/:id`
- `POST /api/feed/rotate`: new calendar-feed URL

## Calendar feed

`GET /feeds/<secret>/calendar.ics`: appointments from the last 60 days onward.
Add `?tasks=1` to include open tasks with due dates. No cookie: the secret in
the URL is the credential; rotate it from Settings if it leaks.

## Webhook payloads

`POST` to your URL with `X-Catch-Event`, `X-Catch-Delivery` (unique) and, if
a secret is set, `X-Catch-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.

```json
{
  "event": "capture.processed",
  "sent_at": "2026-10-30T10:00:00.000Z",
  "data": {
    "capture": { "id": "cap_…", "category": "coaching", "summary": "…", "transcript": "…", "app_url": "…" },
    "people": [{ "id": "con_…", "name": "Jess Taylor", "category": "coaching", "stage": "new", "location": "Brisbane" }],
    "tasks": [{ "id": "tsk_…", "title": "DM Jess re trial", "due_on": "2026-11-02", "link": "https://instagram.com/jess.sets", "draft_message": "…" }],
    "events": []
  }
}
```

Other events: `task.created`, `task.closed` (data is the task), `ping`.
Verify the signature over the raw body before parsing it.

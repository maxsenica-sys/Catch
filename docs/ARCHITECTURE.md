# Architecture

One Node process, one SQLite file, one folder of uploads. Deliberately small:
a single machine with a volume can serve one coach or a few hundred, it can be
backed up by copying a directory, and there is no queue service, cache or
second database to keep alive.

```
web/                      the phone app (Preact PWA, built by Vite into web/dist)
  src/screens/Capture     the hot path: chips, screenshots, hold-to-talk
  src/outbox.ts           IndexedDB queue on the phone; uploads with retries
  src/recorder.ts         MediaRecorder with codec detection (webm vs iOS mp4)
  src/sw.ts               offline shell + Android share target
server/
  index.ts                boot
  app.ts                  wiring: context, routes, job handlers, schedulers
  config.ts               every environment variable, validated once
  db/                     node:sqlite, migrations keyed by PRAGMA user_version
  jobs/queue.ts           persistent job queue in the same database
  pipeline/
    transcribe.ts         voice -> text (OpenAI, or offline mock)
    extract.ts            screenshots + text -> Extraction (Claude, structured output)
    mock-extractor.ts     offline extractor: same contract, text only
    schema.ts             the Extraction contract (JSON Schema for the model, zod for the server)
    process.ts            applies an Extraction: people, tasks, events, review items
    resolve.ts            "is this someone we already know?" + deep links
    followups.ts          the chase: task done -> date -> sweep -> follow-up task
    dates.ts              calendar arithmetic in the user's time zone
  integrations/           Todoist, webhook; registry + exactly-once delivery
  http/                   routes, auth (cookie sessions + API tokens)
  feeds.ts                vCard, iCalendar, CSV
test/                     node:test suites, run in-process against a temp database
scripts/e2e.ts            real browser, real server, fake microphone
```

## The capture pipeline

1. **Phone.** Releasing the mic writes `{client_id, category, note, images,
   audio}` to IndexedDB and clears the form. That is the moment the user is
   done. `outbox.ts` uploads in the background: JPEG-shrinks screenshots to a
   2400px long edge (fast on mobile data, converts HEIC as a side effect),
   retries with backoff on network errors, and keeps anything the server
   rejects (bad file) visible with its reason instead of retrying for ever.

2. **`POST /api/captures`** validates every file (sniffs bytes; refuses HEIC
   by name), stores them, inserts one `captures` row and one job in a single
   transaction, and answers **202** at once. It is idempotent on
   `(user, client_id)`: a retry after a lost response returns the original.

3. **`process_capture` job.** Transcribes the voice note and *saves the
   transcript before going on*, so an extraction failure retried later does
   not pay for transcription twice. Then one Claude call: screenshots as image
   blocks, then a text block with today's date in the user's zone, how they
   write dates, their categories (with the descriptions they wrote), the chip
   they tapped, the transcript and note. Output is constrained to
   `EXTRACTION_JSON_SCHEMA` and re-validated with zod.

4. **Apply** (`process.ts`, one transaction):
   - each person goes through `resolvePerson` (below) and is created or merged;
   - each action becomes a task: due date via `decideDue`, link via
     `actionLink`, the draft message kept verbatim;
   - every *new* person in a chased category without an action gets
     "Reach out to …": being captured is the signal;
   - appointments with a real date become events (the calendar feed);
   - anything doubtful becomes a **review item** instead of a guess.

5. **Deliver.** One `deliver` job per new task and per processed capture.
   Each enabled integration is attempted independently; each success is
   recorded in `deliveries` before any failure is rethrown, so a retry only
   repeats what failed and nothing is ever sent twice.

## Rules the design depends on

**The model judges, the server decides.** Claude reads the screenshot and
says who and what. Whether that person already exists, what date a task gets,
whether a stage may change: all of that is deterministic code with tests.

**Nothing invents a date.** The model is told to return a date only when one
is stated or clearly implied, and to quote the words (`due_evidence`). With no
date, the category's `followup_days` applies and the task is marked
`due_source: default`, so it is distinguishable. A stated date in the past
becomes today (overdue is urgent, not wrong); one more than 18 months out is
dropped *and reported*.

**Matching prefers a duplicate to a wrong merge.** A shared handle, email or
phone is a match. Same full name is a match unless a handle on the same
platform contradicts it (two different "Alex Smith"s). First-name-only is
never merged automatically: a new contact plus a one-tap "same person?" review
item. A duplicate costs one tap; a wrong merge silently corrupts two people's
history.

**Merging only adds.** A known contact gets blanks filled, facts appended,
handles added. Existing values are never overwritten (the user may have
corrected them), and the stage only moves forward: a screenshot of an old DM
must not demote a client to "new".

**One owner per follow-up.** A chased contact always has exactly one of: an
open task, a `next_followup_on` date, or a stage that ends the chase. Completing
a task (in Catch or in Todoist) sets the date; the 15-minute sweep turns a due
date into a task; an open task always blocks a second; after `maxFollowups`
unanswered rounds the contact is parked.

**Time zone is the user's.** "Monday" means Monday where the user is. Dates
are stored as `YYYY-MM-DD` in the user's zone and never pass through a UTC
`Date`; arithmetic uses noon-UTC anchors so DST cannot shift a day.
`localToUtc` converts only at the edge (Todoist `due_datetime`, ICS).

**Nothing is sent in the user's name.** Drafts are drafts. Instagram has no
public API for sending DMs to people who have not messaged you first within 24
hours, and nothing here tries to work around that: the task copies the draft
and opens the profile.

## Data model

| Table | What |
|---|---|
| `users` | one per person; time zone, date order, settings, calendar-feed secret |
| `categories` | per user, editable; `guidance` is read by the model; `followup_days`, `todoist_label`, `tracks_people` |
| `captures` / `capture_files` | the raw record: files, transcript, validated extraction, status |
| `contacts` / `contact_handles` / `contact_events` | the people database and its timeline |
| `tasks` | `action` (from a capture) or `followup` (from the chase) |
| `events` | appointments with a real date, served as the calendar feed |
| `review_items` | possible duplicates, dropped dates, low-confidence reads |
| `jobs` | the persistent queue |
| `integrations` / `deliveries` | encrypted config per user; exactly-once ledger |

Statuses a capture moves through: `queued → processing → done | review | failed`.
`review` means it was filed but something needs one tap; it becomes `done` when
its review items are resolved.

## Adding things

- **A category:** Settings, no code. Write the description as you would brief
  an assistant; it is what the model reads.
- **An integration:** a module exporting an `Integration` (see
  `server/integrations/types.ts`), added to `INTEGRATIONS`. The settings UI,
  encrypted storage, retries and exactly-once delivery come from the registry.
- **A field the model extracts:** add it to *both* definitions in `schema.ts`
  (the JSON Schema and the zod object); `test/extract.test.ts` checks they
  agree and that the JSON Schema stays inside the structured-outputs subset.
- **A migration:** append to `MIGRATIONS`. Never edit one that has shipped.

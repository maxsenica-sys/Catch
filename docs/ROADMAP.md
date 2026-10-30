# Roadmap

What exists is the full loop: capture → read → people, tasks, dates →
follow-up chase → Todoist / calendar / webhook. Next, roughly in order of
value per effort.

## Next

1. **First real week, then tune the prompt.** The extraction prompt
   (`server/pipeline/extract.ts`) was written before any real capture went
   through it. Keep twenty real captures (with permission) and their correct
   answers as a fixture set; change the prompt only against that set.
2. **Daily digest.** A morning push/email: due today, overdue, gone quiet.
   Web Push works for installed PWAs on iOS 16.4+ and Android.
3. **Google Contacts sync (opt-in).** If the phone's contacts live in Google,
   the People API can create/update contacts with no tap. iCloud has no such
   API, which is why vCard "Save to Contacts" is the default.
4. **Gmail drafts.** For email actions, create the draft in Gmail so sending
   is one tap. Needs Google OAuth; the integration interface already fits.
5. **Google Calendar (direct).** The `.ics` feed works everywhere with no
   OAuth, but Google refreshes subscribed feeds slowly (hours). A direct
   integration would make booked sessions appear in seconds.
6. **Todoist webhooks** instead of 5-minute polling, once Catch is registered
   as a Todoist app.
7. **Search inside captures** (transcripts, summaries) from the People screen.

## Later, for other people

- **Teams/workspaces.** Today every account is fully separate. Shared
  contacts for a coaching business with several coaches would add a
  `workspace_id` beside `user_id`; the queries are already all scoped by user,
  which is the hard part.
- **Per-account API keys**, so a hosted Catch can let each user bring their
  own Anthropic/OpenAI key and pay their own way.
- **Postgres** behind the same `db.ts` helpers if one instance stops being
  enough. Not before.

## Deliberately not doing

- **Sending DMs automatically.** Instagram/Facebook only allow business
  accounts to reply to people who messaged first, within 24 hours. Anything
  that tries harder breaks their terms and risks the account. Catch drafts and
  opens the conversation; sending stays a human tap.
- **Reading the phone's contacts silently.** A web app cannot, and a native
  app that does would need a reason Apple accepts. "Save to Contacts" keeps
  the user in control.
- **A native app** before the PWA is shown to fall short. Everything the
  capture loop needs (mic, camera roll, offline storage, home-screen icon)
  works in the browser on both platforms.

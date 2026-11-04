/**
 * Google Calendar, instantly, through a small Apps Script web app that runs in
 * the user's own Google account ("Execute as: Me").
 *
 * Why not the Calendar API: that needs a Google Cloud project, an OAuth consent
 * screen and refresh tokens — a setup a person will not finish. Google already
 * knows who the script's owner is, so the script can write to their calendar
 * with no credentials anywhere but a shared random key. Same design as the
 * second-brain vault's planner bridge, which has run without trouble.
 *
 * The user pastes the script Catch generates (key already inside), deploys it
 * as a web app, and pastes its URL back. From then on every appointment Catch
 * files is created in their calendar within seconds, and the .ics feed stops
 * listing it so a calendar subscribed to both does not show it twice.
 *
 * Timed events travel as UTC instants (no zone to misread); all-day events as
 * a bare date built in the script's zone. The script refuses to run when its
 * zone differs from the user's, because that moves every all-day event a day.
 */
import type { Integration, IntegrationCall } from "./types.ts";
import { IntegrationError } from "./types.ts";
import { localToUtc } from "../pipeline/dates.ts";

export interface EventPayload {
  id: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string;
}

async function call(c: IntegrationCall, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await c.ctx.fetch(c.config.url, {
      method: "POST",
      // text/plain: Apps Script cannot answer a CORS preflight. Its 302 to
      // googleusercontent.com is followed by fetch on its own.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ key: c.config.key, ...body }),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new IntegrationError(`Google Calendar script unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(text);
  } catch {
    // A sign-in page instead of JSON means the deployment is not "Anyone".
    throw new IntegrationError(
      /<html|accounts\.google/i.test(text)
        ? "Google answered with a sign-in page. In Apps Script, redeploy with Who has access: Anyone."
        : `Google Calendar script answered HTTP ${res.status} with something that is not JSON.`,
      true,
    );
  }
  if (out.ok !== true) {
    const msg = String(out.error ?? "unknown error");
    throw new IntegrationError(`Google Calendar script: ${msg}`, /key/i.test(msg));
  }
  return out;
}

export const googleCalendar: Integration = {
  kind: "google_calendar",
  label: "Google Calendar (instant)",
  description: "Booked sessions appear in your Google Calendar within seconds. Uses a small script in your own Google account; nothing else to sign in to.",
  fields: [
    { key: "url", label: "Web app URL", type: "url", required: true, placeholder: "https://script.google.com/macros/s/…/exec", help: "From Apps Script → Deploy → Web app." },
    { key: "key", label: "Script key", type: "secret", required: true, help: "Already inside the script Catch gives you. Only change it if you changed the script." },
  ],

  async test(c) {
    const out = await call(c, { action: "ping" });
    const tz = String(out.timeZone ?? "");
    if (tz && tz !== c.user.timezone) {
      throw new IntegrationError(
        `The script runs in ${tz} but Catch is set to ${c.user.timezone}. In Apps Script → Project Settings, set the time zone to ${c.user.timezone}, then test again.`,
        true,
      );
    }
    return `Connected to "${out.calendar}". New sessions will appear there instantly.`;
  },

  async eventCreated(c, ev) {
    const body: Record<string, unknown> = {
      action: "create",
      ref: ev.id, // the script remembers it, so a retried create returns the same event
      title: ev.title,
      location: ev.location ?? "",
      description: ev.notes ?? "",
    };
    if (ev.start_time) {
      const start = localToUtc(ev.date, ev.start_time, c.user.timezone);
      const end = ev.end_time ? localToUtc(ev.date, ev.end_time, c.user.timezone) : new Date(start.getTime() + 60 * 60 * 1000);
      body.start = start.toISOString();
      body.end = end.toISOString();
    } else {
      body.allDay = true;
      body.date = ev.date;
    }
    const out = await call(c, body);
    return String(out.id ?? "") || null;
  },
};

/** The Apps Script the user pastes. The key is generated per user and baked in. */
export function appsScript(key: string, timezone: string): string {
  return `/**
 * Catch → Google Calendar. Paste all of this into a new Apps Script project
 * (script.google.com), Save, then Deploy → New deployment → Web app:
 *   Execute as: Me     Who has access: Anyone
 * Copy the Web app URL into Catch → Settings → Google Calendar.
 *
 * Project Settings → Time zone must be ${timezone}.
 * The key below is private to you. Don't share this script.
 */
var KEY = '${key}';
var CALENDAR_ID = 'default'; // or a calendar's ID from Google Calendar → Settings

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.key !== KEY) return out_({ ok: false, error: 'wrong key' });
    var cal = CALENDAR_ID === 'default' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return out_({ ok: false, error: 'no calendar ' + CALENDAR_ID });
    if (req.action === 'ping') return out_({ ok: true, calendar: cal.getName(), timeZone: Session.getScriptTimeZone() });
    if (req.action === 'create') return out_(create_(cal, req));
    if (req.action === 'delete') {
      var ev = cal.getEventById(req.id);
      if (ev) ev.deleteEvent();
      return out_({ ok: true });
    }
    return out_({ ok: false, error: 'unknown action ' + req.action });
  } catch (x) {
    return out_({ ok: false, error: String(x && x.message || x) });
  }
}

function doGet() {
  return out_({ ok: true, service: 'catch-calendar' });
}

function create_(cal, req) {
  var props = PropertiesService.getScriptProperties();
  var seen = req.ref ? props.getProperty('ref:' + req.ref) : null;
  if (seen && cal.getEventById(seen)) return { ok: true, id: seen, existing: true };
  var opts = { description: req.description || '', location: req.location || '' };
  var ev;
  if (req.allDay) {
    // Built from its parts in the script's zone: an offset here files the event a day early.
    var p = String(req.date).split('-');
    ev = cal.createAllDayEvent(req.title, new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])), opts);
  } else {
    var s = new Date(req.start), en = new Date(req.end);
    if (isNaN(s.getTime()) || isNaN(en.getTime()) || en <= s) return { ok: false, error: 'bad start/end' };
    ev = cal.createEvent(req.title, s, en, opts);
  }
  if (req.ref) props.setProperty('ref:' + req.ref, ev.getId());
  return { ok: true, id: ev.getId() };
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

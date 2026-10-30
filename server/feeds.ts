/**
 * Formats other apps already read, so Catch reaches them with no OAuth at all.
 *
 * - vCard: "Save to Contacts" on a phone. iOS opens its native Add Contact
 *   sheet pre-filled; the user chooses, Catch never writes their address book.
 * - iCalendar feed: subscribe once in Google Calendar / Apple Calendar and
 *   every appointment Catch files appears there. Read-only, behind a secret URL.
 *   Google refreshes subscribed feeds on its own schedule (hours, not minutes);
 *   Apple Calendar can be set to every 5 minutes.
 * - CSV: the whole contacts database, for a spreadsheet or a CRM import.
 */
import { localToUtc, addDays } from "./pipeline/dates.ts";

export interface ContactForCard {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  organisation: string | null;
  role: string | null;
  sport: string | null;
  position: string | null;
  location: string | null;
  category: string | null;
  notes: string;
  handles: { platform: string; handle: string; url: string | null }[];
}

function vEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** RFC 5545/6350 line folding: 75 octets, continuation lines start with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    let end = Math.min(start + (first ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // never split a UTF-8 sequence
    out.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

export function vcard(c: ContactForCard): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  lines.push(`FN:${vEscape(c.name)}`);
  lines.push(`N:${vEscape(c.last_name ?? "")};${vEscape(c.first_name ?? (c.last_name ? "" : c.name))};;;`);
  if (c.organisation) lines.push(`ORG:${vEscape(c.organisation)}`);
  const title = [c.position, c.sport, c.role].filter(Boolean).join(" · ");
  if (title) lines.push(`TITLE:${vEscape(title)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(c.email)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${vEscape(c.phone)}`);
  for (const h of c.handles) {
    if (h.platform === "email" && h.handle !== c.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(h.handle)}`);
    else if ((h.platform === "phone" || h.platform === "whatsapp") && h.handle !== c.phone) lines.push(`TEL;TYPE=CELL:${vEscape(h.handle)}`);
    else if (h.url && h.platform !== "email" && h.platform !== "phone") {
      lines.push(`X-SOCIALPROFILE;TYPE=${h.platform}:${vEscape(h.url)}`);
      lines.push(`URL;TYPE=${h.platform}:${vEscape(h.url)}`);
    }
  }
  if (c.location) lines.push(`ADR;TYPE=HOME:;;;${vEscape(c.location)};;;`);
  const note = [c.category ? `Catch: ${c.category}` : "", c.notes].filter(Boolean).join("\n");
  if (note) lines.push(`NOTE:${vEscape(note)}`);
  lines.push(`UID:catch-${c.id}`);
  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export interface FeedEvent {
  id: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string;
  updated_at: string;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function icalendar(name: string, tz: string, events: FeedEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Catch//Catch//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${vEscape(name)}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.id}@catch`);
    lines.push(`DTSTAMP:${stamp(new Date(e.updated_at))}`);
    if (e.start_time) {
      const start = localToUtc(e.date, e.start_time, tz);
      const end = e.end_time ? localToUtc(e.date, e.end_time, tz) : new Date(start.getTime() + 60 * 60 * 1000);
      lines.push(`DTSTART:${stamp(start)}`);
      lines.push(`DTEND:${stamp(end)}`);
    } else {
      // All-day: bare dates, no zone, or the event lands a day early somewhere.
      lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, "")}`);
    }
    lines.push(`SUMMARY:${vEscape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${vEscape(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${vEscape(e.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // A cell starting with = + - @ is a formula to Excel/Sheets; neutralise it.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

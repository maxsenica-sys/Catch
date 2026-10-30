/**
 * Calendar arithmetic in the user's own time zone.
 *
 * Dates the user thinks in ("Monday", "the 5th") are plain YYYY-MM-DD strings
 * and never pass through a UTC Date, because 23:30 in Istanbul is already
 * tomorrow in Brisbane and yesterday in Los Angeles. Arithmetic is done on
 * noon-UTC anchors so no DST shift can move a day.
 */

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(date: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

export function todayIn(tz: string, now = new Date()): string {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Friday 30 October 2026, 14:05 (Europe/Istanbul)" — what the model is told "now" is. */
export function describeNow(tz: string, now = new Date()): string {
  const p = parts(now, tz);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "long" }).format(now);
  return `${p.weekday} ${Number(p.day)} ${month} ${p.year}, ${p.hour}:${p.minute} (${tz})`;
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isTime(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

/** The next occurrence of a weekday strictly after today ("Monday" said on a Monday means next week). */
export function nextWeekday(today: string, weekday: (typeof WEEKDAYS)[number]): string {
  const target = WEEKDAYS.indexOf(weekday);
  const current = WEEKDAYS.indexOf(weekdayOf(today));
  const delta = (target - current + 7) % 7 || 7;
  return addDays(today, delta);
}

/** Skip Saturday/Sunday when a default lands on one: a default follow-up is a working-day thing. */
export function toWeekday(date: string): string {
  const w = weekdayOf(date);
  if (w === "saturday") return addDays(date, 2);
  if (w === "sunday") return addDays(date, 1);
  return date;
}

export type DueDecision =
  | { due_on: string; source: "stated" }
  | { due_on: string; source: "default"; dropped?: { value: string; reason: string } };

/**
 * Decide a task's due date. A stated date wins if it is plausible. A stated
 * date in the past is clamped to today (it is overdue, which is urgent, not
 * wrong). One absurdly far out is dropped, the default applies, and the caller
 * raises a review item — never silently.
 */
export function decideDue(stated: string | null | undefined, today: string, defaultDays: number): DueDecision {
  const fallback = toWeekday(addDays(today, Math.max(0, defaultDays)));
  if (stated == null || stated === "") return { due_on: fallback, source: "default" };
  if (!isIsoDate(stated)) return { due_on: fallback, source: "default", dropped: { value: String(stated), reason: "not a real date" } };
  if (stated < today) return { due_on: today, source: "stated" };
  if (daysBetween(today, stated) > 548) {
    return { due_on: fallback, source: "default", dropped: { value: stated, reason: "more than 18 months away" } };
  }
  return { due_on: stated, source: "stated" };
}

/**
 * Wall-clock time in a zone -> UTC instant. Integrations that want an instant
 * (Todoist's due_datetime, an ICS DTSTART in UTC) get it from here; the offset
 * is found by asking Intl what the guess looks like locally and correcting,
 * twice, which settles across a DST boundary.
 */
export function localToUtc(date: string, time: string, tz: string): Date {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), tz);
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    guess += target - seen;
  }
  return new Date(guess);
}

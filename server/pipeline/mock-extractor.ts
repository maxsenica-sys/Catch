/**
 * Offline extractor: no API key, no network, deterministic.
 *
 * It exists so the whole app runs end to end before any key is set — sign up,
 * capture, see a person and a task appear — and so tests exercise the real
 * pipeline. It reads only text (the transcript and typed note); it cannot
 * read screenshots, and its summary says so, so offline mode is never
 * mistaken for the real thing.
 *
 * Heuristics, in order: @handles and emails become people; "this is NAME" /
 * "NAME is" / "message NAME" name people; weekday and relative-date words set
 * the due date; verbs (message, DM, call, email, follow up, send) make actions.
 */
import type { Extractor, ExtractInput } from "./extract.ts";
import type { Extraction, Person, Action } from "./schema.ts";
import { WEEKDAYS, addDays, nextWeekday, isIsoDate } from "./dates.ts";

const STOP = new Set([
  "I", "He", "She", "They", "We", "This", "That", "The", "A", "An", "And", "But", "Monday", "Tuesday",
  "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Today", "Tomorrow", "Instagram", "TikTok",
  "Brisbane", "Next", "Send", "Message", "Call", "Email", "DM", "Follow", "Hey", "Hi", "Ok", "Okay",
]);

function resolveDate(text: string, today: string, dateOrder: "DMY" | "MDY"): { date: string; evidence: string } | null {
  const lower = text.toLowerCase();
  const patterns: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [/\btomorrow\b/, () => addDays(today, 1)],
    [/\btoday\b|\btonight\b/, () => today],
    [/\bnext week\b/, () => nextWeekday(today, "monday")],
    [/\bin (\d{1,2}) days?\b/, (m) => addDays(today, Number(m[1]))],
    [new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`), (m) => nextWeekday(today, m[1] as (typeof WEEKDAYS)[number])],
    [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const [day, month] = dateOrder === "DMY" ? [a, b] : [b, a];
      let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
      let iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!m[3] && iso < today) iso = `${++year}${iso.slice(4)}`;
      return isIsoDate(iso) ? iso : null;
    }],
  ];
  for (const [re, fn] of patterns) {
    const m = lower.match(re);
    if (m) {
      const date = fn(m);
      if (date) return { date, evidence: m[0] };
    }
  }
  return null;
}

function channelOf(text: string): Action["channel"] {
  const t = text.toLowerCase();
  if (/\b(dm|instagram|insta|ig)\b/.test(t)) return "instagram";
  if (/\bwhatsapp\b/.test(t)) return "whatsapp";
  if (/\bemail\b/.test(t)) return "email";
  if (/\b(text|sms)\b/.test(t)) return "sms";
  if (/\bcall|ring\b/.test(t)) return "call";
  return null;
}

function categoryFromText(text: string, input: ExtractInput): string | null {
  const t = text.toLowerCase();
  for (const c of input.categories) {
    if (t.includes(c.key.toLowerCase()) || t.includes(c.name.toLowerCase())) return c.key;
  }
  return null;
}

export function mockExtractor(): Extractor {
  return {
    name: "mock",
    async extract(input: ExtractInput): Promise<Extraction> {
      const text = [input.transcript ?? "", input.note].filter(Boolean).join("\n");
      const people: Person[] = [];
      const blank = (ref: string, name: string): Person => ({
        ref, name, first_name: null, last_name: null, handles: [], role: null, sport: null, position: null,
        level: null, location: null, organisation: null, category: null, stage: null, facts: null,
      });

      for (const m of text.matchAll(/@([a-z0-9._]{2,30})/gi)) {
        const p = blank(`p${people.length + 1}`, m[1]);
        p.handles.push({ platform: "instagram", handle: m[1].toLowerCase(), url: null });
        people.push(p);
      }
      for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g)) {
        const p = blank(`p${people.length + 1}`, m[0].split("@")[0]);
        p.handles.push({ platform: "email", handle: m[0].toLowerCase(), url: null });
        people.push(p);
      }
      const nameRe = /\b(?:[Tt]his is|[Tt]hat's|[Tt]hats|[Mm]essage|DM|dm|[Cc]all|[Ee]mail|[Tt]ext|[Cc]hase|[Ff]ollow up with|[Ff]rom)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g;
      for (const m of text.matchAll(nameRe)) {
        const name = m[1];
        if (STOP.has(name.split(" ")[0])) continue;
        if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
        const p = blank(`p${people.length + 1}`, name);
        const [first, ...rest] = name.split(" ");
        p.first_name = first;
        p.last_name = rest.join(" ") || null;
        people.push(p);
      }
      // One handle and one spoken name in the same capture are almost always the same person.
      const handled = people.filter((p) => p.handles.length > 0);
      const named = people.filter((p) => p.handles.length === 0);
      if (handled.length === 1 && named.length === 1) {
        named[0].handles.push(...handled[0].handles);
        people.splice(people.indexOf(handled[0]), 1);
        people.forEach((p, i) => (p.ref = `p${i + 1}`));
      }
      if (/\bsetter\b|\blibero\b|\bhitter\b|\bmiddle\b|\boutside\b/i.test(text)) {
        const pos = text.match(/\b(setter|libero|hitter|middle|outside)\b/i)?.[1].toLowerCase() ?? null;
        for (const p of people) {
          p.position = pos;
          p.role = "athlete";
        }
      }
      const loc = text.match(/\bin ([A-Z][a-z]+)\b/)?.[1] ?? null;
      if (loc && !STOP.has(loc)) for (const p of people) p.location = loc;

      const due = resolveDate(text, input.today, input.dateOrder);
      const actions: Action[] = [];
      const wantsAction = /\b(message|dm|call|email|text|follow up|chase|reply|send|book|remind)\b/i.test(text);
      if (wantsAction || people.length > 0) {
        const channel = channelOf(text);
        const targets = people.length ? people : [null];
        for (const p of targets) {
          const verb = channel === "instagram" ? "DM" : channel === "email" ? "Email" : channel === "call" ? "Call" : "Follow up with";
          actions.push({
            title: p ? `${verb} ${p.name}` : (text.split(/[.\n]/)[0] || "Follow up").slice(0, 80),
            person_ref: p?.ref ?? null,
            channel,
            due_date: due?.date ?? null,
            due_time: null,
            due_evidence: due?.evidence ?? null,
            priority: /\burgent|asap|today\b/i.test(text) ? 4 : 2,
            draft_message: p && channel ? `Hey ${p.first_name ?? p.name}, thanks for reaching out — keen to chat. When suits you?` : null,
            category: null,
          });
        }
      }

      const category = input.categoryHint ?? categoryFromText(text, input) ?? input.categories[0]?.key ?? "other";
      const offline = input.images.length ? ` (offline mode: ${input.images.length} screenshot${input.images.length > 1 ? "s" : ""} not read)` : " (offline mode)";
      return {
        summary: (text.trim() ? text.trim().split(/[.\n]/)[0].slice(0, 120) : "Capture with no voice note or text") + offline,
        category,
        confidence: text.trim() ? 0.5 : 0.1,
        people,
        actions,
        appointments: [],
        notes: null,
      };
    },
  };
}

/**
 * The shape the extractor must return.
 *
 * Two definitions of the same thing, deliberately: `EXTRACTION_JSON_SCHEMA` is
 * what the model is constrained to (structured outputs accept a subset of JSON
 * Schema, so it is hand-written within that subset), and `Extraction` (zod) is
 * what the server trusts. Everything the model returns is re-validated, and the
 * mock extractor is held to the same zod schema, so a test that passes on the
 * mock exercises the same contract the live model has to meet.
 */
import { z } from "zod";

export const PLATFORMS = [
  "instagram", "tiktok", "facebook", "x", "linkedin", "youtube", "snapchat",
  "whatsapp", "email", "phone", "website", "other",
] as const;
export const ROLES = ["athlete", "parent", "coach", "client", "prospect", "partner", "other"] as const;
export const STAGES = ["new", "contacted", "replied", "booked", "client", "parked", "dead"] as const;
export const CHANNELS = ["instagram", "tiktok", "facebook", "email", "whatsapp", "sms", "call", "in_person", "other"] as const;

// The model is constrained to plain strings, with "" meaning "not known" (see
// the JSON Schema below). The server still accepts null, so the offline
// extractor and tests can say null, and normalises both to null.
const nullableString = z.string().nullable().transform((v) => (v && v.trim() ? v : null));
const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.literal(""), z.null()]).transform((v) => (v ? v : null));

export const Handle = z.object({
  platform: z.enum(PLATFORMS),
  handle: z.string().min(1),
  url: nullableString,
});

export const Person = z.object({
  ref: z.string().min(1),
  known_ref: nullableString,
  name: z.string().min(1),
  first_name: nullableString,
  last_name: nullableString,
  handles: z.array(Handle),
  role: nullableEnum(ROLES),
  sport: nullableString,
  position: nullableString,
  level: nullableString,
  location: nullableString,
  organisation: nullableString,
  category: nullableString,
  stage: nullableEnum(STAGES),
  facts: nullableString,
});

export const Action = z.object({
  title: z.string().min(1),
  existing_task: nullableString,
  person_ref: nullableString,
  channel: nullableEnum(CHANNELS),
  due_date: nullableString,
  due_time: nullableString,
  due_evidence: nullableString,
  // Clamped rather than rejected: a priority of 5 is not worth losing a capture over.
  priority: z.number().transform((n) => Math.min(4, Math.max(1, Math.round(n)))),
  draft_message: nullableString,
  category: nullableString,
});

export const Appointment = z.object({
  title: z.string().min(1),
  person_ref: nullableString,
  date: z.string(),
  start_time: nullableString,
  end_time: nullableString,
  location: nullableString,
});

export const Extraction = z.object({
  summary: z.string().min(1),
  category: z.string().min(1),
  confidence: z.number().transform((n) => Math.min(1, Math.max(0, n))),
  people: z.array(Person),
  actions: z.array(Action),
  appointments: z.array(Appointment),
  notes: nullableString,
});

export type Extraction = z.infer<typeof Extraction>;
export type Person = z.infer<typeof Person>;
export type Action = z.infer<typeof Action>;
export type Appointment = z.infer<typeof Appointment>;

const str = { type: "string" };
// No unions at all. Structured outputs refuse a schema with more than 16
// union-typed parameters (anyOf, or a type array) because they compile
// exponentially, and this one had 24 — every live capture failed with a 400.
// So "unknown" is an empty string, not null, and enums carry "" as a member.
// The zod schema above turns "" back into null. test/extract.test.ts counts
// unions so this cannot creep back.
const nstr = { type: "string" };
const nenum = (values: readonly string[]) => ({ type: "string", enum: [...values, ""] });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const EXTRACTION_JSON_SCHEMA = obj({
  summary: { ...str, description: "One line, past tense, what this capture was. E.g. 'Instagram DM from a Brisbane setter asking about private sessions.'" },
  category: { ...str, description: "Key of the category this capture belongs to." },
  confidence: { type: "number", description: "0 to 1: how sure you are of the people and actions you extracted." },
  people: {
    type: "array",
    items: obj({
      ref: { ...str, description: "Local id like p1, p2 — used by actions and appointments to point at this person." },
      known_ref: { ...str, description: "If this is someone already on file (the k-ids listed under 'People already on file'), their k-id. Empty if new or unsure." },
      name: { ...str, description: "Best display name. A handle is acceptable if no real name is visible." },
      first_name: nstr,
      last_name: nstr,
      handles: {
        type: "array",
        items: obj({
          platform: { type: "string", enum: [...PLATFORMS] },
          handle: { ...str, description: "Username without @, email address, or phone number exactly as shown." },
          url: nstr,
        }),
      },
      role: nenum(ROLES),
      sport: nstr,
      position: nstr,
      level: { ...nstr, description: "Age group, grade, team level or experience, if stated." },
      location: nstr,
      organisation: { ...nstr, description: "Club, school or company." },
      category: { ...nstr, description: "Category key for this person if different from the capture's." },
      stage: { ...nenum(STAGES), description: "Only when the capture shows it: e.g. they replied, booked, became a client. Otherwise an empty string." },
      facts: { ...nstr, description: "Anything else worth remembering about them, terse." },
    }),
  },
  actions: {
    type: "array",
    items: obj({
      title: { ...str, description: "Imperative, specific, under 80 characters. 'DM Jess about a trial session', not 'Follow up'." },
      existing_task: { ...str, description: "If this is the same piece of work as an open task already on file (a t-id), that t-id — even when reworded or refined. Empty for genuinely new work." },
      person_ref: nstr,
      channel: nenum(CHANNELS),
      due_date: { ...nstr, description: "YYYY-MM-DD, only if the voice note, text or screenshot states or clearly implies a date. Otherwise an empty string — never guess." },
      due_time: { ...nstr, description: "HH:MM 24h, only if stated." },
      due_evidence: { ...nstr, description: "The words that gave the date, quoted. Empty if due_date is empty." },
      priority: { type: "integer", description: "1 to 4: 4 urgent, 3 high, 2 normal, 1 low." },
      draft_message: { ...nstr, description: "If the action is to message someone: a short, friendly, ready-to-send first draft in the user's voice. Otherwise an empty string." },
      category: nstr,
    }),
  },
  appointments: {
    type: "array",
    items: obj({
      title: str,
      person_ref: nstr,
      date: { ...str, description: "YYYY-MM-DD. Only include an appointment whose date is actually known." },
      start_time: nstr,
      end_time: nstr,
      location: nstr,
    }),
  },
  notes: { ...nstr, description: "Anything else in the capture worth keeping that fits nowhere above." },
});

/**
 * Categories are per user and fully editable — these are only the starting
 * set a new account gets. `guidance` is read by the model, so it is where a
 * user teaches Catch what belongs where ("Coaching = Brisbane private and
 * small-group sessions, athletes and their parents").
 */
import { type DB, id, insert, nowIso, all } from "./db/db.ts";

export interface CategoryRow {
  id: string;
  user_id: string;
  key: string;
  name: string;
  color: string;
  guidance: string;
  followup_days: number;
  todoist_label: string;
  tracks_people: number;
  sort: number;
  archived: number;
}

export const DEFAULT_CATEGORIES: Omit<CategoryRow, "id" | "user_id" | "archived">[] = [
  { key: "coaching", name: "Coaching", color: "#2563eb", followup_days: 2, todoist_label: "Coaching", tracks_people: 1, sort: 0,
    guidance: "Athletes, parents and clients for private, small-group or remote coaching: enquiries, bookings, session times, progress." },
  { key: "lead", name: "Lead", color: "#16a34a", followup_days: 2, todoist_label: "Lead", tracks_people: 1, sort: 1,
    guidance: "Prospective clients or customers who have shown interest but not committed: enquiries, comments asking about prices or availability." },
  { key: "instagram", name: "Instagram", color: "#db2777", followup_days: 1, todoist_label: "Instagram", tracks_people: 1, sort: 2,
    guidance: "DMs, comments and mentions on Instagram that need a reply, plus content ideas seen there." },
  { key: "program", name: "Program", color: "#9333ea", followup_days: 3, todoist_label: "Program", tracks_people: 0, sort: 3,
    guidance: "Program and content building: drills, sessions, training plans, product ideas, things to write or film." },
  { key: "followup", name: "Follow-up", color: "#ea580c", followup_days: 1, todoist_label: "Follow-up", tracks_people: 1, sort: 4,
    guidance: "Anything the user explicitly wants to chase: unanswered messages, promised replies, payments, check-ins." },
  { key: "partnership", name: "Partnership", color: "#0891b2", followup_days: 4, todoist_label: "Partnership", tracks_people: 1, sort: 5,
    guidance: "Brands, clubs, other coaches and collaborators: sponsorships, collaborations, referrals." },
  { key: "other", name: "Other", color: "#64748b", followup_days: 3, todoist_label: "", tracks_people: 0, sort: 6,
    guidance: "Anything that fits nowhere else." },
];

export function seedCategories(db: DB, userId: string): void {
  for (const c of DEFAULT_CATEGORIES) {
    insert(db, "categories", { id: id("cat"), user_id: userId, ...c, created_at: nowIso() });
  }
}

export function listCategories(db: DB, userId: string, includeArchived = false): CategoryRow[] {
  return all<CategoryRow>(
    db,
    `SELECT * FROM categories WHERE user_id = ? ${includeArchived ? "" : "AND archived = 0"} ORDER BY sort, name`,
    userId,
  );
}

/** Lookup that never fails: an unknown key resolves to "other", then to the first category. */
export function categoryFor(cats: CategoryRow[], key: string | null | undefined): CategoryRow | undefined {
  return cats.find((c) => c.key === key) ?? cats.find((c) => c.key === "other") ?? cats[0];
}

export function slugKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "category";
}

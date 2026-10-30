/**
 * Who is this? Matching an extracted person against the contacts database.
 *
 * Deterministic on purpose. The model says who is in the screenshot; this
 * decides whether that is someone already known. Strongest evidence first:
 *
 *   1. a shared handle on the same platform (instagram:jess.sets) — certain;
 *   2. a shared email or phone — certain;
 *   3. the same full name (case/space/accent-insensitive) — likely, but two
 *      different "Jess Taylor"s exist, so a name-only match with no
 *      contradicting handle merges, and one WITH a contradicting handle on the
 *      same platform is a different person;
 *   4. first-name-only matches are never merged automatically — they create a
 *      new contact and raise a "possible duplicate" review item, because a
 *      wrong merge silently corrupts two people's history and a duplicate is
 *      one tap to fix.
 */
import { type DB, all } from "../db/db.ts";
import type { Person } from "./schema.ts";

export function normaliseHandle(platform: string, raw: string): string {
  const h = raw.trim();
  if (platform === "phone" || platform === "whatsapp") return h.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (platform === "email") return h.toLowerCase();
  if (platform === "website") return h.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return h
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?[a-z.]+\.(com|net)\/(@)?/, "")
    .replace(/[/?#].*$/, "");
}

export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type Match =
  | { kind: "existing"; contactId: string; via: "handle" | "name" }
  | { kind: "new"; possibleDuplicates: string[] };

export function resolvePerson(db: DB, userId: string, person: Person): Match {
  const handles = person.handles.map((h) => ({ platform: h.platform, handle: normaliseHandle(h.platform, h.handle) }))
    .filter((h) => h.handle.length > 0);

  for (const h of handles) {
    const rows = all<{ contact_id: string }>(
      db,
      `SELECT ch.contact_id FROM contact_handles ch JOIN contacts c ON c.id = ch.contact_id
       WHERE ch.user_id = ? AND ch.platform = ? AND ch.handle = ? AND c.archived = 0`,
      userId, h.platform, h.handle,
    );
    if (rows.length > 0) return { kind: "existing", contactId: rows[0].contact_id, via: "handle" };
  }

  const name = normaliseName(person.name);
  if (!name) return { kind: "new", possibleDuplicates: [] };
  const candidates = all<{ id: string; name: string }>(
    db, "SELECT id, name FROM contacts WHERE user_id = ? AND archived = 0", userId,
  );
  const handlePlatforms = new Set(handles.map((h) => h.platform));

  const fullMatches = name.includes(" ")
    ? candidates.filter((c) => normaliseName(c.name) === name)
    : [];
  for (const c of fullMatches) {
    // Same name, but a different handle on a platform both have: a namesake.
    const theirs = all<{ platform: string; handle: string }>(
      db, "SELECT platform, handle FROM contact_handles WHERE contact_id = ?", c.id,
    );
    const contradicts = theirs.some((t) => handlePlatforms.has(t.platform as never) &&
      !handles.some((h) => h.platform === t.platform && h.handle === t.handle));
    if (!contradicts) return { kind: "existing", contactId: c.id, via: "name" };
  }

  const first = name.split(" ")[0];
  const possible = candidates
    .filter((c) => {
      const n = normaliseName(c.name);
      return n === name || n.split(" ")[0] === first;
    })
    .map((c) => c.id);
  return { kind: "new", possibleDuplicates: possible };
}

/** Canonical deep link for a handle, so a task can open the right app in one tap. */
export function handleUrl(platform: string, handle: string): string | null {
  switch (platform) {
    case "instagram": return `https://instagram.com/${handle}`;
    case "tiktok": return `https://www.tiktok.com/@${handle}`;
    case "x": return `https://x.com/${handle}`;
    case "facebook": return `https://facebook.com/${handle}`;
    case "youtube": return `https://youtube.com/@${handle}`;
    case "snapchat": return `https://snapchat.com/add/${handle}`;
    case "linkedin": return handle.startsWith("in/") ? `https://linkedin.com/${handle}` : `https://linkedin.com/in/${handle}`;
    case "whatsapp": return `https://wa.me/${handle.replace(/^\+/, "")}`;
    case "email": return `mailto:${handle}`;
    case "phone": return `tel:${handle}`;
    case "website": return `https://${handle}`;
    default: return null;
  }
}

/**
 * The link a task should open: on the channel the action names if the person
 * has a handle there, else their best handle. A WhatsApp/SMS/email link carries
 * the draft so sending is one tap; Instagram has no compose-with-text link, so
 * the app copies the draft to the clipboard instead.
 */
export function actionLink(
  channel: string | null,
  handles: { platform: string; handle: string }[],
  draft: string | null,
): string | null {
  const by = (p: string) => handles.find((h) => h.platform === p);
  const text = draft ? encodeURIComponent(draft) : "";
  if (channel === "whatsapp" && by("whatsapp")) return `https://wa.me/${by("whatsapp")!.handle.replace(/^\+/, "")}${text ? `?text=${text}` : ""}`;
  if (channel === "whatsapp" && by("phone")) return `https://wa.me/${by("phone")!.handle.replace(/^\+/, "")}${text ? `?text=${text}` : ""}`;
  if (channel === "sms" && by("phone")) return `sms:${by("phone")!.handle}${text ? `&body=${text}` : ""}`;
  if (channel === "email" && by("email")) return `mailto:${by("email")!.handle}${text ? `?body=${text}` : ""}`;
  if (channel === "call" && by("phone")) return `tel:${by("phone")!.handle}`;
  if (channel && by(channel)) return handleUrl(channel, by(channel)!.handle);
  const order = ["instagram", "whatsapp", "phone", "email", "tiktok", "facebook", "x", "linkedin", "youtube", "snapchat", "website"];
  for (const p of order) {
    const h = by(p);
    if (h) return handleUrl(p, h.handle);
  }
  return null;
}

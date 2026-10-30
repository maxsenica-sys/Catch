/**
 * Screenshots + voice transcript + typed note -> structured Extraction.
 *
 * One Claude call per capture with vision input and a JSON-schema-constrained
 * output. The model judges; the server validates (schema.ts) and applies
 * policy (dates.ts, resolve.ts). The model is never trusted to have done the
 * server's job: a date it returns is checked, a person it returns is matched
 * against the database deterministically, and the result is re-validated even
 * though the API already constrained it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Extraction, EXTRACTION_JSON_SCHEMA } from "./schema.ts";
import { PermanentError } from "../jobs/queue.ts";

export interface CategoryBrief {
  key: string;
  name: string;
  guidance: string;
}

export interface ExtractInput {
  images: { mime: string; data: Buffer }[];
  transcript: string | null;
  note: string;
  categoryHint: string | null;
  categories: CategoryBrief[];
  now: string; // human-readable, in the user's zone
  today: string; // YYYY-MM-DD
  dateOrder: "DMY" | "MDY";
  userName: string;
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<Extraction>;
}

/**
 * Static, so it is byte-identical on every call (cache-friendly). Everything
 * that varies — the user, their categories, the time — goes in the user turn.
 */
export const SYSTEM_PROMPT = `You are the filing clerk inside Catch, an app a busy sports coach and small-business owner uses to make sure no client, lead or message slips through. They capture something in a few seconds — screenshots, a short voice note, sometimes a typed note and a category chip — and walk away. You turn it into people, actions and appointments so they never have to think about it again.

What you receive
- Zero or more screenshots: Instagram/TikTok DMs and comments, profiles, emails, texts, WhatsApp, spreadsheets, booking forms, highlight clips, anything.
- A voice-note transcript and/or typed note. This is the user talking to you. When it conflicts with the screenshot, the user wins. Transcripts contain recognition errors; prefer spellings visible in the screenshot.
- The category chip they tapped, or "auto" if they did not.

People
- Include everyone the user would want to reach, chase or remember: the other side of a DM thread (the name/handle at the top), a commenter asking about coaching, an athlete or parent named in the voice note, a partner or brand contact.
- Exclude the user themselves, famous people mentioned in passing, and anyone who is only background.
- Copy handles, emails and phone numbers exactly as shown. Never invent or complete contact details. A person with only a first name is fine.
- Put useful facts (age group, goals, what they asked for, budget, availability) in facts, briefly.
- Set stage only on evidence: replied when the screenshot shows them replying, booked when a session or call is agreed, client when they pay or train regularly. Otherwise null.

Actions
- One action per concrete thing the user must do. Anyone awaiting a reply gets an action to reply on the right channel.
- If the user said what to do, do exactly that. Do not add generic "follow up" actions on top of specific ones.
- Titles are imperative and specific: "DM Jess re trial session times", not "Follow up".
- due_date only when stated or clearly implied ("Monday", "tomorrow", "end of the week", "before the 12th"). Resolve relative dates against today's date given below; "next week" means the Monday of next week; a bare weekday means its next occurrence after today. Otherwise null — the app applies the user's default follow-up interval, so do not guess one.
- draft_message: for message actions, write a ready-to-send draft in the user's voice: first person, warm, direct, 1-3 short sentences, matching the language and tone of the conversation. No sign-off, no placeholders like [Name] — use the real name or leave it out.

Appointments
- Only fixed commitments with a known date: a session booked, a call scheduled, a trial on Saturday at 9. Not deadlines — those are actions.

Category
- If a chip was tapped, file the capture under it unless the content plainly cannot belong there. If "auto", choose the best fit from the user's categories. A person may carry a different category from the capture when that is clearly right.

If there is nothing actionable, still return a useful summary with empty lists. Set confidence low when the screenshot is unreadable or it is unclear who is who.`;

export function buildUserText(input: ExtractInput): string {
  const cats = input.categories
    .map((c) => `- ${c.key}: ${c.name}${c.guidance ? ` — ${c.guidance}` : ""}`)
    .join("\n");
  return [
    `User: ${input.userName || "the user"}`,
    `Now: ${input.now}. Today is ${input.today}.`,
    `The user writes numeric dates ${input.dateOrder === "DMY" ? "day first (05/08 is 5 August)" : "month first (05/08 is 8 May)"}.`,
    "",
    "Categories:",
    cats,
    "",
    `Chip tapped: ${input.categoryHint ?? "auto"}`,
    `Screenshots attached: ${input.images.length}`,
    "",
    `Voice note transcript: ${input.transcript ? `"""${input.transcript}"""` : "(none)"}`,
    `Typed note: ${input.note ? `"""${input.note}"""` : "(none)"}`,
  ].join("\n");
}

const SUPPORTED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function anthropicExtractor(opts: {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  baseURL?: string;
}): Extractor {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 });
  return {
    name: `anthropic:${opts.model}`,
    async extract(input) {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const img of input.images) {
        if (!SUPPORTED_IMAGE.has(img.mime)) continue;
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mime as "image/png", data: img.data.toString("base64") },
        });
      }
      content.push({ type: "text", text: buildUserText(input) });

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model: opts.model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content }],
          output_config: { effort: opts.effort, format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA } },
          // On a policy decline the API re-runs the request on a fallback model
          // it chooses, instead of handing back a refusal.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new PermanentError(`Anthropic rejected the API key (${err.status}). Check ANTHROPIC_API_KEY.`);
        }
        if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
          throw new PermanentError(`Anthropic refused the request (${err.status}): ${err.message}`);
        }
        // Rate limits, overloads, 5xx and network errors: retried by the job queue.
        throw err;
      }

      if (response.stop_reason === "refusal") {
        throw new PermanentError(`The model declined this capture${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ""}.`);
      }
      if (response.stop_reason === "max_tokens") throw new Error("extraction was cut off at max_tokens");

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`extraction was not valid JSON: ${text.slice(0, 200)}`);
      }
      const result = Extraction.safeParse(parsed);
      if (!result.success) throw new Error(`extraction did not match the schema: ${result.error.message.slice(0, 500)}`);
      return result.data;
    },
  };
}

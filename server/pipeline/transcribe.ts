/**
 * Voice note -> text.
 *
 * Live: OpenAI's transcription endpoint. The default model is
 * gpt-4o-mini-transcribe (fast, cheap); `whisper-1` also works, set
 * TRANSCRIBE_MODEL. The upload's filename extension must match the real codec
 * — iPhones record mp4/aac, Chrome records webm — or the decoder guesses wrong
 * and fails quietly on exactly the device that matters.
 *
 * Mock: returns no transcript (the capture still processes, from images and
 * the typed note) unless the audio is a test fixture that carries its own text.
 */
import { PermanentError } from "../jobs/queue.ts";
import { audioExt } from "../storage.ts";

export interface Transcriber {
  readonly name: string;
  transcribe(audio: Buffer, mime: string, hint: string): Promise<string | null>;
}

export const MOCK_TRANSCRIPT_MARKER = "CATCH-MOCK-TRANSCRIPT:";

export function mockTranscriber(): Transcriber {
  return {
    name: "mock",
    async transcribe(audio) {
      const head = audio.subarray(0, MOCK_TRANSCRIPT_MARKER.length).toString("utf8");
      if (head === MOCK_TRANSCRIPT_MARKER) return audio.subarray(MOCK_TRANSCRIPT_MARKER.length).toString("utf8").trim();
      return null;
    },
  };
}

export function openAiTranscriber(apiKey: string, model: string, base = "https://api.openai.com/v1"): Transcriber {
  return {
    name: `openai:${model}`,
    async transcribe(audio, mime, hint) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `voice.${audioExt(mime)}`);
      form.append("model", model);
      form.append("response_format", "json");
      // A vocabulary hint (names, clubs, jargon) measurably improves proper nouns.
      if (hint) form.append("prompt", hint.slice(0, 800));
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        const msg = `transcription failed: HTTP ${res.status} ${body}`;
        // 4xx other than rate limiting will not get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) throw new PermanentError(msg);
        throw new Error(msg);
      }
      const json = (await res.json()) as { text?: string };
      const text = (json.text ?? "").trim();
      return text || null;
    },
  };
}

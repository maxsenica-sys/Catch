/**
 * The screen that matters. Designed for one-handed use in under ten seconds:
 *
 *   tap Screenshots -> pick -> (optionally tap a chip) -> tap mic, talk, tap again.
 *
 * The second tap sends it. There is no confirm step and nothing to wait for:
 * the capture goes into the phone's outbox, the form clears, and the next
 * capture can start immediately. Everything slow happens on the server.
 *
 * Tap to start, tap to stop — Max asked for that over hold-to-talk, which
 * needs a thumb pinned to the glass for the whole note. (The fastest route of
 * all skips this screen: Photos → Share → Catch, see docs/IOS-SHORTCUT.md.)
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../main";
import { add } from "../outbox";
import { recordingSupported, startRecording, type Recording } from "../recorder";
import { toast, vibrate, Dot } from "../util";
import { OutboxPill } from "./OutboxPill";

const MAX_SECONDS = 180;

interface Picked {
  blob: Blob;
  url: string;
}

export function CaptureScreen({ state, initialCategory, shared }: { state: AppState; initialCategory: string | null; shared: boolean }) {
  const { categories, me } = state;
  const autoSend = me.user.settings.autoSend !== false;
  const [category, setCategory] = useState<string>(initialCategory && categories.some((c) => c.key === initialCategory) ? initialCategory : "auto");
  const [images, setImages] = useState<Picked[]>([]);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [recState, setRecState] = useState<"idle" | "starting" | "recording">("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [heldAudio, setHeldAudio] = useState<Blob | null>(null);
  const rec = useRef<Recording | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tick = useRef<number | undefined>(undefined);

  // Images handed over by the Android share sheet (see sw.ts).
  useEffect(() => {
    if (!shared || !("caches" in window)) return;
    void (async () => {
      const cache = await caches.open("catch-share");
      const keys = await cache.keys();
      const blobs: Blob[] = [];
      for (const k of keys) {
        const res = await cache.match(k);
        if (res) blobs.push(await res.blob());
        await cache.delete(k);
      }
      if (blobs.length) setImages((cur) => [...cur, ...blobs.map((blob) => ({ blob, url: URL.createObjectURL(blob) }))]);
    })();
  }, [shared]);

  // Paste screenshots on desktop.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => () => window.clearInterval(tick.current), []);

  function addFiles(files: File[] | FileList) {
    const list = [...files].filter((f) => f.type.startsWith("image/") || f.type === "");
    setImages((cur) => [...cur, ...list.map((blob) => ({ blob, url: URL.createObjectURL(blob) }))].slice(0, 10));
  }

  function reset() {
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setImages([]);
    setNote("");
    setShowNote(false);
    setHeldAudio(null);
    setSeconds(0);
    if (!initialCategory) setCategory("auto");
  }

  async function send(audio: Blob | null) {
    const imgs = images.map((i) => i.blob);
    if (!audio && imgs.length === 0 && !note.trim()) {
      toast("Add a screenshot, a voice note or some text", "error");
      return;
    }
    await add({ category, note: note.trim(), images: imgs, audio });
    vibrate(30);
    const cat = categories.find((c) => c.key === category);
    toast(`Caught${cat ? ` · ${cat.name}` : ""}. Filing it now.`);
    reset();
  }

  async function begin() {
    if (!recordingSupported()) {
      toast("This browser cannot record audio", "error");
      return;
    }
    setRecState("starting");
    try {
      rec.current = await startRecording();
    } catch {
      setRecState("idle");
      toast("Microphone permission is needed for voice notes", "error");
      return;
    }
    vibrate(15);
    setRecState("recording");
    setSeconds(0);
    const started = Date.now();
    tick.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      setLevel(rec.current?.level() ?? 0);
      if (s >= MAX_SECONDS) void finish();
    }, 100);
  }

  async function finish() {
    window.clearInterval(tick.current);
    const r = rec.current;
    rec.current = null;
    setRecState("idle");
    setLevel(0);
    if (!r) return;
    const audio = await r.stop();
    if (!audio) return;
    if (autoSend) await send(audio);
    else {
      setHeldAudio(audio);
      toast("Voice note attached — tap Send");
    }
  }

  function cancel() {
    window.clearInterval(tick.current);
    rec.current?.cancel();
    rec.current = null;
    setRecState("idle");
    setLevel(0);
    toast("Recording discarded");
  }

  // One tap starts, the next sends. Taps while the mic is still starting (the
  // first time, iOS is showing its permission prompt) are ignored.
  const onMic = () => {
    if (recState === "idle") void begin();
    else if (recState === "recording") void finish();
  };

  const recording = recState === "recording";
  const mm = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const hasContent = images.length > 0 || note.trim().length > 0 || heldAudio;

  return (
    <div class="capture">
      <header class="bar">
        <h1>Catch</h1>
        <OutboxPill items={state.outbox} />
      </header>

      <div class="chips" role="radiogroup" aria-label="Category">
        <button class={`chip ${category === "auto" ? "on" : ""}`} onClick={() => setCategory("auto")} role="radio" aria-checked={category === "auto"}>
          ✦ Auto
        </button>
        {categories.map((c) => (
          <button key={c.key} class={`chip ${category === c.key ? "on" : ""}`} style={category === c.key ? { background: c.color, borderColor: c.color } : {}}
            onClick={() => setCategory(category === c.key ? "auto" : c.key)} role="radio" aria-checked={category === c.key}>
            <Dot color={c.color} /> {c.name}
          </button>
        ))}
      </div>

      <div class="shots">
        {images.map((img, i) => (
          <div class="shot" key={img.url}>
            <img src={img.url} alt={`Screenshot ${i + 1}`} />
            <button class="shot-x" aria-label="Remove" onClick={() => setImages((cur) => cur.filter((x) => x !== img))}>×</button>
          </div>
        ))}
        <button class="shot add" onClick={() => fileInput.current?.click()}>
          <span class="plus">＋</span>
          <span>{images.length ? "More" : "Screenshots"}</span>
        </button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden data-testid="file-input"
          onChange={(e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) addFiles(files);
            (e.target as HTMLInputElement).value = "";
          }} />
      </div>

      {showNote ? (
        <textarea class="note" placeholder="Type a note (optional)" value={note} rows={3} autoFocus
          onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      ) : (
        <button class="link-btn" onClick={() => setShowNote(true)}>+ Type a note instead</button>
      )}

      <div class="mic-area">
        {recording ? (
          <div class="rec-status">
            <span class="rec-dot" /> {mm} · {autoSend ? "tap again to send" : "tap again to stop"}
            <button class="link-btn" onClick={cancel}>Discard</button>
          </div>
        ) : (
          <div class="rec-hint">{heldAudio ? "Voice note attached" : recState === "starting" ? "Starting the mic…" : "Tap to talk"}</div>
        )}
        <button
          class={`mic ${recording ? "live" : ""}`}
          style={{ "--level": String(level) } as any}
          aria-label={recording ? (autoSend ? "Stop and send" : "Stop recording") : "Record voice note"}
          data-testid="mic"
          onClick={onMic}
          onContextMenu={(e) => e.preventDefault()}
        >
          {recording ? (
            <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
              <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
            </svg>
          )}
        </button>
        {hasContent && !recording && (
          <button class="send" data-testid="send" onClick={() => void send(heldAudio)}>
            Send {heldAudio ? "with voice" : "without voice"}
          </button>
        )}
      </div>
    </div>
  );
}

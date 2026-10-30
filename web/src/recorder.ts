/**
 * Voice recording that starts the instant the button is pressed.
 *
 * The microphone stream is kept open between recordings for a short while so
 * the second, third and tenth capture in a row start with no permission
 * round-trip, then released so the phone's mic indicator does not stay on.
 *
 * The container format is detected, never assumed: Chrome records webm/opus,
 * Safari/iOS records mp4/aac. Hardcoding webm is exactly how recording breaks
 * on iPhone and nowhere else.
 */

const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const IDLE_RELEASE_MS = 30_000;

let stream: MediaStream | null = null;
let releaseTimer: number | undefined;

async function getStream(): Promise<MediaStream> {
  window.clearTimeout(releaseTimer);
  if (stream && stream.getAudioTracks().some((t) => t.readyState === "live")) return stream;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  return stream;
}

function scheduleRelease() {
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }, IDLE_RELEASE_MS);
}

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export interface Recording {
  stop(): Promise<Blob | null>;
  cancel(): void;
  level(): number;
}

export async function startRecording(): Promise<Recording> {
  const s = await getStream();
  const mimeType = CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(s, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  rec.start(250);

  // A cheap level meter so the button visibly reacts to speech.
  let analyser: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(s).connect(analyser);
  } catch {
    analyser = null;
  }
  const buf = new Uint8Array(128);

  const finish = (keep: boolean) =>
    new Promise<Blob | null>((resolve) => {
      rec.onstop = () => {
        void audioCtx?.close();
        scheduleRelease();
        const type = rec.mimeType || mimeType || "audio/webm";
        resolve(keep && chunks.length ? new Blob(chunks, { type: type.split(";")[0] }) : null);
      };
      if (rec.state !== "inactive") rec.stop();
      else rec.onstop?.(new Event("stop"));
    });

  return {
    stop: () => finish(true),
    cancel: () => void finish(false),
    level() {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 64);
    },
  };
}

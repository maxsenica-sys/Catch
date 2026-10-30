/**
 * Uploaded files on local disk under DATA_DIR/files. Behind an interface so an
 * S3/R2 backend can replace it without the pipeline noticing; local disk is
 * the default because a single mounted volume is the simplest thing that can
 * be backed up.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Storage {
  put(userId: string, data: Buffer, ext: string): Promise<{ path: string; sha256: string; size: number }>;
  read(relPath: string): Promise<Buffer>;
  remove(relPath: string): Promise<void>;
}

export function localStorage(dataDir: string): Storage {
  const root = path.join(dataDir, "files");
  fs.mkdirSync(root, { recursive: true });

  const resolve = (relPath: string): string => {
    const full = path.resolve(root, relPath);
    // A stored path is ours, but a path that escapes the root is never read.
    if (!full.startsWith(root + path.sep)) throw new Error(`refusing path outside storage: ${relPath}`);
    return full;
  };

  return {
    async put(userId, data, ext) {
      const month = new Date().toISOString().slice(0, 7);
      const name = `${crypto.randomBytes(12).toString("base64url")}${ext ? `.${ext}` : ""}`;
      const rel = path.join(userId, month, name);
      const full = resolve(rel);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, data);
      return { path: rel, sha256: crypto.createHash("sha256").update(data).digest("hex"), size: data.length };
    },
    async read(relPath) {
      return fs.promises.readFile(resolve(relPath));
    },
    async remove(relPath) {
      await fs.promises.rm(resolve(relPath), { force: true });
    },
  };
}

/**
 * Sniff the real type from the first bytes. The phone names the file; the
 * bytes say what it is. iPhones produce HEIC, which the vision API refuses,
 * so it is identified by name rather than failing somewhere downstream.
 */
export function sniffImage(buf: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/heic" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heic";
  }
  return null;
}

/** Audio: the extension must match the codec or the transcriber guesses wrong (iOS records mp4). */
export function audioExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}

export const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

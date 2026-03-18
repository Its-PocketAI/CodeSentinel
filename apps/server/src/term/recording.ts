import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../paths.js";

const sizeCache = new Map<string, number>();

export function initSessionRecording(sessionId: string): string {
  const controlDir = path.join(getDataDir(), "term", sessionId);
  fs.mkdirSync(controlDir, { recursive: true });
  const stdoutPath = path.join(controlDir, "stdout");
  if (!fs.existsSync(stdoutPath)) {
    fs.writeFileSync(stdoutPath, "");
  }
  try {
    const st = fs.statSync(stdoutPath);
    sizeCache.set(stdoutPath, st.size);
  } catch {
    sizeCache.set(stdoutPath, 0);
  }
  return stdoutPath;
}

export function appendRecording(stdoutPath: string, data: string, maxBytes?: number): void {
  if (!data) return;
  try {
    const limit = typeof maxBytes === "number" && Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;
    let size = sizeCache.get(stdoutPath);
    if (size == null) {
      try {
        size = fs.statSync(stdoutPath).size;
      } catch {
        size = 0;
      }
    }
    if (limit > 0 && size >= limit) return;
    const buf = Buffer.from(data, "utf8");
    let toWrite = buf;
    if (limit > 0 && size + buf.length > limit) {
      const left = Math.max(0, limit - size);
      if (left === 0) return;
      toWrite = buf.subarray(0, left);
    }
    if (toWrite.length === 0) return;
    fs.appendFileSync(stdoutPath, toWrite);
    sizeCache.set(stdoutPath, size + toWrite.length);
  } catch {}
}

export type SessionMeta = {
  cwd?: string;
  mode?: string;
  createdAt?: number;
};

export function writeSessionMeta(sessionId: string, meta: SessionMeta): void {
  try {
    const controlDir = path.join(getDataDir(), "term", sessionId);
    fs.mkdirSync(controlDir, { recursive: true });
    const metaPath = path.join(controlDir, "meta.json");
    const payload = { ...meta, createdAt: meta.createdAt ?? Date.now() };
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2));
  } catch {}
}

export function readSessionMeta(sessionId: string): SessionMeta | null {
  try {
    const metaPath = path.join(getDataDir(), "term", sessionId, "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as SessionMeta;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

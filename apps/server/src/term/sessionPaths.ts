import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../paths.js";
import type { RunAsUser } from "../userRunAs.js";

function chownIfPossible(targetPath: string, runAs?: RunAsUser | null) {
  if (!runAs || process.platform === "win32") return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  try {
    fs.chownSync(targetPath, runAs.uid, runAs.gid);
  } catch {}
}

function ensureWritableDir(dirPath: string, runAs?: RunAsUser | null) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  chownIfPossible(dirPath, runAs);
}

function isSafeExternalControlDir(sessionId: string, controlDir: string) {
  const resolved = path.resolve(controlDir);
  if (path.basename(resolved) !== sessionId) return false;
  const termDir = path.dirname(resolved);
  if (path.basename(termDir) !== "term") return false;
  return path.basename(path.dirname(termDir)) === ".codesentinel";
}

export function getTermSessionsBaseDir() {
  return path.join(getDataDir(), "term");
}

export function getTermSessionDataDir(sessionId: string) {
  return path.join(getTermSessionsBaseDir(), sessionId);
}

export function resolveTermSessionControlDir(sessionId: string, runAs?: RunAsUser | null) {
  const baseDataDir = runAs?.home?.trim()
    ? path.join(runAs.home, ".codesentinel")
    : getDataDir();
  const termDir = path.join(baseDataDir, "term");
  const controlDir = path.join(termDir, sessionId);
  ensureWritableDir(baseDataDir, runAs);
  ensureWritableDir(termDir, runAs);
  ensureWritableDir(controlDir, runAs);
  return controlDir;
}

export function removeTermSessionArtifacts(sessionId: string, controlDir?: string | null) {
  const dataDir = getTermSessionDataDir(sessionId);
  let removedRecording = false;
  let removedControlDir = false;

  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    removedRecording = true;
  }

  if (controlDir && isSafeExternalControlDir(sessionId, controlDir)) {
    const resolvedControlDir = path.resolve(controlDir);
    if (resolvedControlDir !== path.resolve(dataDir) && fs.existsSync(resolvedControlDir)) {
      fs.rmSync(resolvedControlDir, { recursive: true, force: true });
      removedControlDir = true;
    }
  }

  return { removedRecording, removedControlDir };
}

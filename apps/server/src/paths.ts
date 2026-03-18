import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedDataDir: string | null = null;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveHomeDir() {
  return typeof os.homedir === "function" ? os.homedir() : process.env.HOME || process.env.USERPROFILE || ".";
}

export function getDataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  const envDirRaw = process.env.CODESENTINEL_DATA_DIR;
  if (envDirRaw && envDirRaw.trim()) {
    const envDir = envDirRaw.trim();
    ensureDir(envDir);
    cachedDataDir = envDir;
    return envDir;
  }

  const homeDir = resolveHomeDir();
  const dataDir = path.join(homeDir, ".codesentinel");
  ensureDir(dataDir);
  cachedDataDir = dataDir;
  return dataDir;
}

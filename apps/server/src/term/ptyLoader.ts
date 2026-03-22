import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type Pty = {
  spawn: (file: string, args: string[] | string, opts: any) => {
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode?: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
    pid?: number;
  };
};

export type PtySpawnOptions = {
  useConpty?: boolean;
};

type PtyLoadResult = {
  pty: Pty;
  spawnOptions: PtySpawnOptions;
};

type Candidate = {
  label: string;
  modulePath: string;
  packageDir: string;
};

const require = createRequire(import.meta.url);

function fileExists(p: string) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function getLocalPackageDir(): string | null {
  try {
    return path.dirname(require.resolve("@homebridge/node-pty-prebuilt-multiarch/package.json"));
  } catch {
    return null;
  }
}

function getFallbackPackageDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceParent = path.resolve(__dirname, "..", "..", "..", "..", "..");
  return path.join(workspaceParent, "my-remote", "node_modules", "@homebridge", "node-pty-prebuilt-multiarch");
}

function getCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const localDir = getLocalPackageDir();
  if (localDir) {
    out.push({
      label: "local",
      modulePath: "@homebridge/node-pty-prebuilt-multiarch",
      packageDir: localDir,
    });
  }

  const fallbackDir = getFallbackPackageDir();
  if (fileExists(fallbackDir)) {
    out.push({
      label: "fallback",
      modulePath: path.join(fallbackDir, "lib", "index.js"),
      packageDir: fallbackDir,
    });
  }
  return out;
}

function getWindowsBinaryState(packageDir: string) {
  const releaseDir = path.join(packageDir, "build", "Release");
  const debugDir = path.join(packageDir, "build", "Debug");
  const hasConpty =
    fileExists(path.join(releaseDir, "conpty.node")) ||
    fileExists(path.join(debugDir, "conpty.node"));
  const hasWinpty =
    fileExists(path.join(releaseDir, "pty.node")) ||
    fileExists(path.join(debugDir, "pty.node"));
  return { hasConpty, hasWinpty };
}

export function formatTerminalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  return firstLine ?? "Unknown error";
}

export async function loadPty(): Promise<PtyLoadResult> {
  const candidates = getCandidates();
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      const mod = (await import(candidate.modulePath)) as any;
      if (!mod?.spawn) continue;

      if (process.platform !== "win32") {
        return { pty: mod as Pty, spawnOptions: {} };
      }

      const binaries = getWindowsBinaryState(candidate.packageDir);
      if (binaries.hasConpty) {
        return { pty: mod as Pty, spawnOptions: {} };
      }
      if (binaries.hasWinpty) {
        return { pty: mod as Pty, spawnOptions: { useConpty: false } };
      }

      lastError = new Error("Windows PTY binaries are unavailable (missing conpty.node and pty.node).");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw new Error(formatTerminalError(lastError));
  }
  throw new Error("Failed to load node-pty module.");
}

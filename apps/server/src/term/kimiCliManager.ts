import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { appendRecording, initSessionRecording, writeSessionMeta } from "./recording.js";
import { snapshotManager } from "./snapshotManager.js";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";

export type TermSend = (msg: any) => void;

type Pty = {
  spawn: (file: string, args: string[], opts: any) => {
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode?: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
  };
};

type KimiPtySession = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: ReturnType<Pty["spawn"]>;
  stdoutPath: string;
};

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fileExists(p: string) {
  try {
    if (process.platform === "win32") {
      return fs.existsSync(p);
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(binName: string, envPATH?: string): Promise<string | null> {
  try {
    const env = envPATH != null ? { ...process.env, PATH: envPATH } : process.env;
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const r = await execa(cmd, [binName], { env, timeout: 3000 });
    const p = r.stdout.trim().split("\n")[0];
    if (p && fileExists(p)) return p;
  } catch {}
  return null;
}

function buildHomeCandidates(home: string | undefined | null) {
  if (!home) return [];
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "share", "pnpm"),
  ];
}

function findInDirs(dirs: string[], exeNames: string[]): string | null {
  for (const dir of dirs) {
    for (const exe of exeNames) {
      const full = path.join(dir, exe);
      if (fileExists(full)) return full;
    }
  }
  return null;
}

function findInNvm(home: string | undefined | null, exeNames: string[]): string | null {
  if (!home) return null;
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      for (const exe of exeNames) {
        const full = path.join(base, entry, "bin", exe);
        if (fileExists(full)) return full;
      }
    }
  } catch {}
  return null;
}

async function resolveKimiBin(runAs?: RunAsUser | null, overrideBin?: string): Promise<string> {
  const explicit = overrideBin || process.env.KIMI_BIN;
  if (explicit && fileExists(explicit)) return explicit;

  const exeNames =
    process.platform === "win32"
      ? ["kimi.exe", "kimi.cmd", "kimi.bat", "kimi"]
      : ["kimi"];

  const homeDirs = Array.from(
    new Set([process.env.HOME, process.env.USERPROFILE, runAs?.home].filter(Boolean) as string[]),
  );
  const extraDirs = homeDirs.flatMap(buildHomeCandidates);
  const extraPath = [...extraDirs, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

  const kimi = await which("kimi", extraPath);
  if (kimi) return kimi;

  const direct = findInDirs(extraDirs, exeNames);
  if (direct) return direct;

  for (const home of homeDirs) {
    const nvm = findInNvm(home, exeNames);
    if (nvm) return nvm;
  }

  throw new Error('Cannot find "kimi". Install Kimi Code CLI or set KIMI_BIN=/absolute/path/to/kimi.');
}

async function loadPty(): Promise<Pty> {
  try {
    const m = (await import("@homebridge/node-pty-prebuilt-multiarch")) as any;
    if (m?.spawn) return m as Pty;
  } catch {}

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const remotecodingDir = path.resolve(__dirname, "..", "..", "..", "..", "..");
  const fallback = path.join(
    remotecodingDir,
    "my-remote",
    "node_modules",
    "@homebridge",
    "node-pty-prebuilt-multiarch",
    "lib",
    "index.js",
  );
  const m2 = (await import(fallback)) as any;
  if (m2?.spawn) return m2 as Pty;
  throw new Error("Failed to load node-pty module");
}

export class KimiCliManager {
  private sessions = new Map<string, KimiPtySession>();

  constructor(
    private opts: {
      maxSessions: number;
      validateCwd: (cwd: string) => Promise<string>;
      send: TermSend;
      termLogMaxBytes?: number;
      binOverride?: string;
    },
  ) {}

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  async open(cwd: string, cols = 120, rows = 30, runAs?: RunAsUser | null) {
    if (this.sessions.size >= this.opts.maxSessions) throw new Error("Too many sessions");
    const realCwd = await this.opts.validateCwd(cwd);
    const sessionId = `kimi_${randomId()}`;

    const pty = await loadPty();
    const kimiBin = await resolveKimiBin(runAs ?? null, this.opts.binOverride);

    const kimiReal = (() => {
      try {
        return fs.realpathSync(kimiBin);
      } catch {
        return kimiBin;
      }
    })();

    const cmd = kimiReal.endsWith(".js") || kimiReal.endsWith(".cjs") || kimiReal.endsWith(".mjs") ? process.execPath : kimiBin;
    const args = cmd === process.execPath ? [kimiReal] : [];

    const spawnPath = [path.dirname(kimiBin), path.dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

    const term = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: realCwd,
      env: buildRunAsEnv({
        ...process.env,
        PATH: spawnPath,
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor",
      }, runAs ?? null),
      uid: runAs?.uid,
      gid: runAs?.gid,
    });

    const stdoutPath = initSessionRecording(sessionId);
    writeSessionMeta(sessionId, { cwd: realCwd, mode: "kimi" });
    await snapshotManager.create(sessionId, cols, rows);
    const s: KimiPtySession = { id: sessionId, cwd: realCwd, cols, rows, pty: term, stdoutPath };
    this.sessions.set(sessionId, s);

    this.opts.send({
      t: "term.data",
      sessionId,
      data: `[kimi] PTY 已启动，等待 kimi 输出…\r\n`,
    });

    term.onData((chunk: string) => {
      appendRecording(stdoutPath, chunk, this.opts.termLogMaxBytes);
      snapshotManager.write(sessionId, chunk);
      this.opts.send({ t: "term.data", sessionId, data: chunk });
    });
    term.onExit((e: any) => {
      this.sessions.delete(sessionId);
      snapshotManager.dispose(sessionId);
      this.opts.send({ t: "term.exit", sessionId, code: e?.exitCode ?? 0, signal: e?.signal });
    });

    return s;
  }

  close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    snapshotManager.dispose(sessionId);
    try {
      s.pty.kill();
    } catch {}
  }

  resize(sessionId: string, cols: number, rows: number) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    try {
      s.pty.resize(cols, rows);
    } catch {}
    snapshotManager.resize(sessionId, cols, rows);
  }
}

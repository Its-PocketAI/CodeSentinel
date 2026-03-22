import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { appendRecording, initSessionRecording, writeSessionMeta } from "./recording.js";
import { snapshotManager } from "./snapshotManager.js";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";
import { loadPty, type Pty } from "./ptyLoader.js";

export type TermSend = (msg: any) => void;

type ClaudePtySession = {
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

async function which(binName: string): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const r = await execa(cmd, [binName]);
    const p = r.stdout.trim().split("\n")[0];
    if (p && fileExists(p)) return p;
  } catch {}
  return null;
}

async function resolveClaudeBin(): Promise<string> {
  const override = process.env.CLAUDE_BIN;
  if (override && fileExists(override)) return override;

  const claude = await which("claude");
  if (claude) return claude;

  throw new Error('Cannot find "claude". Install Claude Code (https://code.claude.com/docs/en/quickstart) or set CLAUDE_BIN=/absolute/path/to/claude.');
}

export class ClaudeCliManager {
  private sessions = new Map<string, ClaudePtySession>();

  constructor(
    private opts: {
      maxSessions: number;
      validateCwd: (cwd: string) => Promise<string>;
      send: TermSend;
      termLogMaxBytes?: number;
    },
  ) {}

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  async open(cwd: string, cols = 120, rows = 30, runAs?: RunAsUser | null) {
    if (this.sessions.size >= this.opts.maxSessions) throw new Error("Too many sessions");
    const realCwd = await this.opts.validateCwd(cwd);
    const sessionId = `claude_${randomId()}`;

    const { pty, spawnOptions } = await loadPty();
    const claudeBin = await resolveClaudeBin();

    const claudeReal = (() => {
      try {
        return fs.realpathSync(claudeBin);
      } catch {
        return claudeBin;
      }
    })();

    const cmd = claudeReal.endsWith(".js") || claudeReal.endsWith(".cjs") || claudeReal.endsWith(".mjs") ? process.execPath : claudeBin;
    const args = cmd === process.execPath ? [claudeReal] : [];

    const spawnPath = [path.dirname(claudeBin), path.dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

    const term = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: realCwd,
      ...spawnOptions,
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
    writeSessionMeta(sessionId, { cwd: realCwd, mode: "claude" });
    await snapshotManager.create(sessionId, cols, rows);
    const s: ClaudePtySession = { id: sessionId, cwd: realCwd, cols, rows, pty: term, stdoutPath };
    this.sessions.set(sessionId, s);

    this.opts.send({
      t: "term.data",
      sessionId,
      data: `[claude] PTY started, waiting for claude output...\r\n`,
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

  stdin(sessionId: string, data: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    s.pty.write(data);
  }
}

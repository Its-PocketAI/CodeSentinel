import fs from "node:fs";
import { execa } from "execa";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";
import type { Limits } from "./session.js";
import { buildCliPath, resolveCliBinary, resolveCliSpawnCommand, selectCliRuntime } from "./cliRuntime.js";

export type TermSend = (msg: any) => void;

type CodexSession = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  lineBuf: string;
  queue: string[];
  running: boolean;
  child?: ReturnType<typeof execa>;
  binPath: string;
  pathEnv: string;
  runAs?: RunAsUser | null;
};

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function clampChunk(text: string, maxBytesLeft: number) {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytesLeft) return { text, bytes: buf.byteLength, truncated: false };
  return { text: buf.subarray(0, maxBytesLeft).toString("utf8"), bytes: maxBytesLeft, truncated: true };
}

async function resolveCodexBin(runAs?: RunAsUser | null) {
  return await resolveCliBinary({
    binName: "codex",
    runAs: runAs ?? null,
    overrideBin: process.env.CODEX_BIN,
  });
}

export class CodexManager {
  private sessions = new Map<string, CodexSession>();

  constructor(
    private opts: {
      maxSessions: number;
      limits: Limits;
      validateCwd: (cwd: string) => Promise<string>;
      send: TermSend;
    },
  ) {}

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  async open(cwd: string, cols = 120, rows = 30, runAs?: RunAsUser | null) {
    if (this.sessions.size >= this.opts.maxSessions) throw new Error("Too many sessions");
    const realCwd = await this.opts.validateCwd(cwd);
    const runtime = await selectCliRuntime({
      displayName: "Codex",
      runAs,
      smokeArgs: ["--version"],
      resolveBin: resolveCodexBin,
    });
    const id = `x_${randomId()}`;
    const s: CodexSession = {
      id,
      cwd: realCwd,
      cols,
      rows,
      lineBuf: "",
      queue: [],
      running: false,
      binPath: runtime.binPath,
      pathEnv: runtime.pathEnv,
      runAs: runtime.runAs,
    };
    this.sessions.set(id, s);
    this.opts.send({
      t: "term.data",
      sessionId: id,
      data:
        `[codex] ready (non-interactive exec mode)\r\n` +
        `[codex] cwd: ${realCwd}\r\n` +
        (runtime.notice ? `[codex] ${runtime.notice}\r\n` : "") +
        `Type your instruction, press Enter.\r\n`,
    });
    return s;
  }

  close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.child?.kill("SIGKILL");
    } catch {}
    this.sessions.delete(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    s.cols = cols;
    s.rows = rows;
  }

  async stdin(sessionId: string, data: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    const normalized = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const ch of normalized) {
      if (ch === "\n") {
        const line = s.lineBuf;
        s.lineBuf = "";
        s.queue.push(line);
      } else if (ch === "\b" || ch === "\x7f") {
        s.lineBuf = s.lineBuf.slice(0, -1);
      } else {
        s.lineBuf += ch;
      }
    }
    await this.pump(s);
  }

  private async pump(s: CodexSession) {
    if (s.running) return;
    const next = s.queue.shift();
    if (next === undefined) return;
    s.running = true;
    try {
      await this.runLine(s, next);
    } finally {
      s.running = false;
      if (s.queue.length) await this.pump(s);
    }
  }

  private async runLine(s: CodexSession, rawLine: string) {
    const line = rawLine.trim();
    if (!line) {
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 0 });
      return;
    }

    const timeoutMs = Math.max(1, this.opts.limits.timeoutSec) * 1000;
    let bytesLeft = this.opts.limits.maxOutputBytes;
    const spawn = resolveCliSpawnCommand(s.binPath);

    // Use `codex exec` which is designed for non-interactive runs.
    const child = execa(spawn.cmd, [...spawn.args, "exec", "--skip-git-repo-check", line], {
      cwd: s.cwd,
      timeout: timeoutMs,
      all: true,
      reject: false,
      stdin: "ignore",
      env: buildRunAsEnv({
        ...process.env,
        PATH: buildCliPath(s.binPath, s.runAs ?? null, s.pathEnv),
        FORCE_COLOR: "0",
      }, s.runAs ?? null),
      uid: s.runAs?.uid,
      gid: s.runAs?.gid,
    });
    s.child = child;

    child.all?.on("data", (buf: Buffer) => {
      if (bytesLeft <= 0) return;
      const chunk = buf.toString("utf8");
      const clamped = clampChunk(chunk, bytesLeft);
      bytesLeft -= clamped.bytes;
      if (clamped.text) this.opts.send({ t: "term.data", sessionId: s.id, data: clamped.text });
      if (clamped.truncated) {
        this.opts.send({ t: "term.data", sessionId: s.id, data: `\r\n[truncated] output exceeded limit\r\n` });
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });

    const res = await child;
    s.child = undefined;
    const code = typeof res.exitCode === "number" ? res.exitCode : 0;
    this.opts.send({ t: "term.exit", sessionId: s.id, code });
  }
}

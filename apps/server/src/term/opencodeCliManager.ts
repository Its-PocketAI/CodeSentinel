import fs from "node:fs";
import path from "node:path";
import { appendRecording, initSessionRecording, writeSessionMeta } from "./recording.js";
import { snapshotManager } from "./snapshotManager.js";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";
import { loadPty, type Pty } from "./ptyLoader.js";
import { buildCliPath, resolveCliBinary, resolveCliSpawnCommand, selectCliRuntime } from "./cliRuntime.js";

export type TermSend = (msg: any) => void;

type OpencodePtySession = {
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

async function resolveOpencodeBin(runAs?: RunAsUser | null, overrideBin?: string): Promise<string> {
  const resolved = await resolveCliBinary({
    binName: "opencode",
    runAs: runAs ?? null,
    overrideBin: overrideBin || process.env.OPENCODE_BIN,
  });
  if (resolved) return resolved;
  throw new Error('Cannot find "opencode". Install OpenCode (https://opencode.ai/docs/) or set OPENCODE_BIN=/absolute/path/to/opencode.');
}

export class OpencodeCliManager {
  private sessions = new Map<string, OpencodePtySession>();

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
    const sessionId = `opencode_${randomId()}`;

    const { pty, spawnOptions } = await loadPty();
    const runtime = await selectCliRuntime({
      displayName: "OpenCode",
      runAs,
      smokeArgs: ["--version"],
      resolveBin: (candidate) => resolveOpencodeBin(candidate, this.opts.binOverride),
    });
    const spawn = resolveCliSpawnCommand(runtime.binPath);
    const args = [...spawn.args, realCwd];

    const term = pty.spawn(spawn.cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: realCwd,
      ...spawnOptions,
      env: buildRunAsEnv({
        ...process.env,
        PATH: buildCliPath(runtime.binPath, runtime.runAs, runtime.pathEnv),
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor",
      }, runtime.runAs),
      uid: runtime.runAs?.uid,
      gid: runtime.runAs?.gid,
    });

    const stdoutPath = initSessionRecording(sessionId);
    writeSessionMeta(sessionId, { cwd: realCwd, mode: "opencode" });
    await snapshotManager.create(sessionId, cols, rows);
    const s: OpencodePtySession = { id: sessionId, cwd: realCwd, cols, rows, pty: term, stdoutPath };
    this.sessions.set(sessionId, s);

    this.opts.send({
      t: "term.data",
      sessionId,
      data: `[opencode] PTY started, waiting for opencode output...\r\n`,
    });
    if (runtime.notice) {
      this.opts.send({
        t: "term.data",
        sessionId,
        data: `[opencode] ${runtime.notice}\r\n`,
      });
    }

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

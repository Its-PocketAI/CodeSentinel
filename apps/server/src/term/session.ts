import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";

export type Limits = {
  timeoutSec: number;
  maxOutputBytes: number;
};

export type CommandWhitelist = Record<string, { title?: string }>;

export type TermSend = (msg: any) => void;

export type Session = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  lineBuf: string;
  queue: string[];
  running: boolean;
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

function isDisallowedMetachar(s: string) {
  // Keep it intentionally strict: disallow typical shell metacharacters.
  // Users can still run normal commands like `git status` or `node -v`.
  return /[|&;<>()$`\\\n\r]/.test(s) || /[<>]/.test(s);
}

function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error("Unclosed quote");
  if (cur.length) out.push(cur);
  return out;
}

function commonPrefix(items: string[]) {
  if (items.length === 0) return "";
  let out = items[0] ?? "";
  for (let i = 1; i < items.length; i++) {
    const cur = items[i] ?? "";
    let j = 0;
    while (j < out.length && j < cur.length && out[j] === cur[j]) j++;
    out = out.slice(0, j);
    if (!out) break;
  }
  return out;
}

async function cmdLs(targetPath: string) {
  const st = await fs.stat(targetPath);
  if (st.isDirectory()) {
    const names = await fs.readdir(targetPath);
    names.sort((a, b) => a.localeCompare(b));
    return names.join("\r\n") + (names.length ? "\r\n" : "");
  }
  return path.basename(targetPath) + "\r\n";
}

export class TermManager {
  private sessions = new Map<string, Session>();

  constructor(
    private opts: {
      maxSessions: number;
      whitelist: CommandWhitelist;
      denylist: string[];
      limits: Limits;
      validateCwd: (cwd: string) => Promise<string>;
      send: TermSend;
    },
  ) {}

  open(cwd: string, cols = 120, rows = 30, runAs?: RunAsUser | null) {
    if (this.sessions.size >= this.opts.maxSessions) throw new Error("Too many sessions");
    const id = `s_${randomId()}`;
    const s: Session = { id, cwd, cols, rows, lineBuf: "", queue: [], running: false, runAs };
    this.sessions.set(id, s);
    return s;
  }

  close(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number) {
    const s = this.mustGet(sessionId);
    s.cols = cols;
    s.rows = rows;
  }

  async stdin(sessionId: string, data: string) {
    const s = this.mustGet(sessionId);
    // Normalize CRLF, but preserve user-intended newlines as command submit.
    const normalized = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const ch of normalized) {
      if (ch === "\n") {
        const line = s.lineBuf;
        s.lineBuf = "";
        s.queue.push(line);
      } else if (ch === "\t") {
        await this.completePathOnTab(s);
      } else if (ch === "\b" || ch === "\x7f") {
        // Backspace / DEL
        s.lineBuf = s.lineBuf.slice(0, -1);
      } else {
        s.lineBuf += ch;
      }
    }
    await this.pump(s);
  }

  private async completePathOnTab(s: Session) {
    const line = s.lineBuf;
    if (!line) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    // Only do path completion in command argument context (after first token),
    // or when token already looks like a path.
    const m = /^(.*?)([^\s]*)$/.exec(line);
    const head = m?.[1] ?? "";
    const token = m?.[2] ?? "";
    const hasWhitespace = /\s/.test(line);
    const pathLike = hasWhitespace || token.includes("/") || token.startsWith(".") || token.startsWith("~");
    if (!pathLike) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    if ((token.startsWith("'") && !token.endsWith("'")) || (token.startsWith("\"") && !token.endsWith("\""))) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    const slash = token.lastIndexOf("/");
    const tokenDirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const tokenNamePart = slash >= 0 ? token.slice(slash + 1) : token;
    const dirInput = tokenDirPart || ".";

    let absDir = "";
    if (token.startsWith("~")) {
      const home = process.env.HOME || "";
      if (!home) {
        this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
        return;
      }
      const rest = dirInput.replace(/^~\/?/, "");
      absDir = path.resolve(home, rest);
    } else if (path.isAbsolute(dirInput)) {
      absDir = path.resolve(dirInput);
    } else {
      absDir = path.resolve(s.cwd, dirInput);
    }

    let realDir = "";
    try {
      realDir = await this.opts.validateCwd(absDir);
    } catch {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(realDir, { withFileTypes: true });
    } catch {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    const matches = entries
      .filter((ent) => ent.name.startsWith(tokenNamePart))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ent) => `${tokenDirPart}${ent.name}${ent.isDirectory() ? "/" : ""}`);

    if (!matches.length) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\u0007" });
      return;
    }

    if (matches.length === 1) {
      const only = matches[0]!;
      const completed = only.endsWith("/") ? only : `${only} `;
      const delta = completed.slice(token.length);
      s.lineBuf = `${head}${completed}`;
      if (delta) this.opts.send({ t: "term.data", sessionId: s.id, data: delta });
      return;
    }

    const prefix = commonPrefix(matches);
    if (prefix.length > token.length) {
      const delta = prefix.slice(token.length);
      s.lineBuf = `${head}${prefix}`;
      if (delta) this.opts.send({ t: "term.data", sessionId: s.id, data: delta });
    }

    const maxList = 120;
    const shown = matches.slice(0, maxList);
    const more = matches.length > shown.length ? ` ... (+${matches.length - shown.length})` : "";
    this.opts.send({
      t: "term.data",
      sessionId: s.id,
      data: `\r\n${shown.join("  ")}${more}\r\n$ ${s.lineBuf}`,
    });
  }

  private mustGet(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Unknown session");
    return s;
  }

  private async pump(s: Session) {
    if (s.running) return;
    const next = s.queue.shift();
    if (next === undefined) return;
    s.running = true;
    try {
      await this.runLine(s, next);
    } finally {
      s.running = false;
      // Continue pumping if more queued.
      if (s.queue.length) await this.pump(s);
    }
  }

  private async runLine(s: Session, rawLine: string) {
    const line = rawLine.trim();
    if (!line) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: "\r\n" });
      return;
    }

    // Reject common shell injection metacharacters early.
    if (isDisallowedMetachar(line)) {
      this.opts.send({
        t: "term.data",
        sessionId: s.id,
        data: `\r\n[blocked] Unsupported shell operator/metacharacters.\r\n`,
      });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 2 });
      return;
    }

    let argv: string[];
    try {
      argv = parseArgs(line);
    } catch (e: any) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: `\r\n[error] ${e?.message ?? String(e)}\r\n` });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 2 });
      return;
    }
    const cmd = argv[0]!;
    const args = argv.slice(1);

    // Enforce policy checks before handling any built-in command.
    // This keeps `pwd/cd/ls` behavior consistent with custom commands.
    const whitelistKeys = Object.keys(this.opts.whitelist ?? {});
    if (whitelistKeys.length > 0 && !this.opts.whitelist[cmd]) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: `\r\n[blocked] Command not allowed: ${cmd}\r\n` });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 127 });
      return;
    }

    const deny = (this.opts.denylist ?? []).includes(cmd);
    if (deny) {
      this.opts.send({ t: "term.data", sessionId: s.id, data: `\r\n[blocked] Dangerous command: ${cmd}\r\n` });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 127 });
      return;
    }

    if (cmd === "pwd") {
      this.opts.send({ t: "term.data", sessionId: s.id, data: s.cwd + "\r\n" });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 0 });
      return;
    }

    if (cmd === "cd") {
      const target = args[0] ?? "";
      const next = target ? path.resolve(s.cwd, target) : s.cwd;
      try {
        const real = await this.opts.validateCwd(next);
        const st = await fs.stat(real);
        if (!st.isDirectory()) throw new Error("Not a directory");
        s.cwd = real;
        this.opts.send({ t: "term.data", sessionId: s.id, data: `\r\n$ cd ${real}\r\n` });
        this.opts.send({ t: "term.exit", sessionId: s.id, code: 0 });
      } catch (e: any) {
        this.opts.send({
          t: "term.data",
          sessionId: s.id,
          data: `\r\n[error] cd: ${e?.message ?? String(e)}\r\n`,
        });
        this.opts.send({ t: "term.exit", sessionId: s.id, code: 1 });
      }
      return;
    }

    if (cmd === "ls") {
      const target = args[0] ?? ".";
      const next = path.resolve(s.cwd, target);
      try {
        const real = await this.opts.validateCwd(next);
        const out = await cmdLs(real);
        this.opts.send({ t: "term.data", sessionId: s.id, data: out });
        this.opts.send({ t: "term.exit", sessionId: s.id, code: 0 });
      } catch (e: any) {
        this.opts.send({
          t: "term.data",
          sessionId: s.id,
          data: `\r\n[error] ls: ${e?.message ?? String(e)}\r\n`,
        });
        this.opts.send({ t: "term.exit", sessionId: s.id, code: 1 });
      }
      return;
    }

    const timeoutMs = Math.max(1, this.opts.limits.timeoutSec) * 1000;
    let bytesLeft = this.opts.limits.maxOutputBytes;
    try {
      const child = execa(cmd, args, {
        cwd: s.cwd,
        timeout: timeoutMs,
        all: true,
        reject: false,
        env: buildRunAsEnv({
          ...process.env,
          // reduce noisy coloring issues in terminals
          FORCE_COLOR: "0",
        }, s.runAs ?? null),
        uid: s.runAs?.uid,
        gid: s.runAs?.gid,
      });

      child.all?.on("data", (buf: Buffer) => {
        if (bytesLeft <= 0) return;
        const chunk = buf.toString("utf8");
        const clamped = clampChunk(chunk, bytesLeft);
        bytesLeft -= clamped.bytes;
        if (clamped.text) this.opts.send({ t: "term.data", sessionId: s.id, data: clamped.text });
        if (clamped.truncated) {
          this.opts.send({
            t: "term.data",
            sessionId: s.id,
            data: `\r\n[truncated] output exceeded limit\r\n`,
          });
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      });

      const res = await child;
      const code = typeof res.exitCode === "number" ? res.exitCode : 0;
      this.opts.send({ t: "term.exit", sessionId: s.id, code });
    } catch (e: any) {
      this.opts.send({
        t: "term.data",
        sessionId: s.id,
        data: `\r\n[error] ${e?.message ?? String(e)}\r\n`,
      });
      this.opts.send({ t: "term.exit", sessionId: s.id, code: 1 });
    }
  }
}

import type http from "node:http";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { TermClientMsg, TermServerMsg } from "@codesentinel/protocol";
import type { CommandWhitelist, Limits } from "./session.js";
import { TermManager } from "./session.js";
import { NativeShellManager } from "./nativeShellManager.js";
import { CodexManager } from "./codexManager.js";
import { PtyCodexManager } from "./ptyCodexManager.js";
import { CursorCliManager } from "./cursorCliManager.js";
import { ClaudeCliManager } from "./claudeCliManager.js";
import { OpencodeCliManager } from "./opencodeCliManager.js";
import { GeminiCliManager } from "./geminiCliManager.js";
import { KimiCliManager } from "./kimiCliManager.js";
import { QwenCliManager } from "./qwenCliManager.js";
import type { RunAsUser } from "../userRunAs.js";

type ActiveSessionMeta = { sessionId: string; cwd: string; mode: string };
let activeSessionRef: Map<string, { cwd: string; mode: string }> | null = null;
type TerminalSessionManager = {
  close: (sessionId: string) => void | Promise<void>;
  resize: (sessionId: string, cols: number, rows: number) => void | Promise<void>;
  stdin: (sessionId: string, data: string) => void | Promise<void>;
};
type SessionOwnerRef = { manager: TerminalSessionManager; mode: string };
let activeSessionOwnerRef: Map<string, SessionOwnerRef> | null = null;
let activeSessionCleanupRef: ((sessionId: string) => void) | null = null;

export function listActiveTermSessions(): ActiveSessionMeta[] {
  const ref = activeSessionRef;
  if (!ref) return [];
  const rows: ActiveSessionMeta[] = [];
  for (const [sessionId, meta] of ref.entries()) {
    rows.push({ sessionId, cwd: meta.cwd, mode: meta.mode });
  }
  return rows;
}

export function closeActiveTermSession(sessionId: string): boolean {
  const owners = activeSessionOwnerRef;
  const cleanup = activeSessionCleanupRef;
  if (!owners || !cleanup) return false;
  const owner = owners.get(sessionId);
  if (!owner) return false;
  try {
    owner.manager.close(sessionId);
  } catch {}
  cleanup(sessionId);
  return true;
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function attachTermWs(opts: {
  server: http.Server;
  path: string;
  whitelist: CommandWhitelist;
  denylist: string[];
  limits: Limits;
  maxSessions: number;
  termLogMaxBytes?: number;
  resolveRunAs?: (cwd: string) => RunAsUser | null;
  tooling?: { bins?: { opencode?: string; gemini?: string; kimi?: string; qwen?: string } };
  sessionPolicy?: { idleTtlMs?: number; sweepIntervalMs?: number };
  validateCwd: (cwd: string) => Promise<string>;
  authorize?: (req: http.IncomingMessage) => Promise<{ ok: true } | { ok: false; error?: string }>;
}) {
  const wss = new WebSocketServer({ server: opts.server, path: opts.path });

  const sessionSubs = new Map<string, Set<WebSocket>>();
  const sessionMeta = new Map<string, { cwd: string; mode: string }>();
  const sessionOwners = new Map<string, SessionOwnerRef>();
  const sessionActiveAt = new Map<string, number>();

  const send = (ws: WebSocket, msg: TermServerMsg) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  const shouldCleanupOnExit = (mode: string) => {
    return !(mode === "restricted-exec" || mode === "native");
  };

  const cleanupSession = (sessionId: string) => {
    sessionSubs.delete(sessionId);
    sessionOwners.delete(sessionId);
    sessionMeta.delete(sessionId);
    sessionActiveAt.delete(sessionId);
  };

  const touchSession = (sessionId: string) => {
    if (!sessionMeta.has(sessionId)) return;
    sessionActiveAt.set(sessionId, Date.now());
  };

  const broadcast = (msg: TermServerMsg) => {
    if ((msg as any)?.sessionId) {
      const sessionId = (msg as any).sessionId as string;
      if (msg.t === "term.data") {
        touchSession(sessionId);
      }
      const subs = sessionSubs.get(sessionId);
      if (subs && subs.size > 0) {
        for (const ws of subs) send(ws, msg);
      }
      if (msg.t === "term.exit") {
        const meta = sessionMeta.get(sessionId);
        if (meta && shouldCleanupOnExit(meta.mode)) {
          cleanupSession(sessionId);
        }
      }
    }
  };

  const attachSession = (ws: WebSocket, sessionId: string) => {
    const set = sessionSubs.get(sessionId) ?? new Set<WebSocket>();
    set.add(ws);
    sessionSubs.set(sessionId, set);
    touchSession(sessionId);
  };

  const detachWs = (ws: WebSocket) => {
    for (const [sessionId, set] of sessionSubs.entries()) {
      set.delete(ws);
      if (set.size === 0) sessionSubs.delete(sessionId);
    }
  };

  const registerSession = (
    sessionId: string,
    cwd: string,
    mode: string,
    manager: TerminalSessionManager,
    ws?: WebSocket,
  ) => {
    sessionOwners.set(sessionId, { manager, mode });
    sessionMeta.set(sessionId, { cwd, mode });
    sessionActiveAt.set(sessionId, Date.now());
    if (ws) attachSession(ws, sessionId);
  };

  // Expose current active sessions to the HTTP layer (read-only).
  activeSessionRef = sessionMeta;
  activeSessionOwnerRef = sessionOwners;
  activeSessionCleanupRef = cleanupSession;

  // Global managers (shared across websocket connections).
  const term = new TermManager({
    maxSessions: opts.maxSessions,
    whitelist: opts.whitelist,
    denylist: opts.denylist,
    limits: opts.limits,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
  });
  const nativeMgr = new NativeShellManager({
    maxSessions: opts.maxSessions,
    limits: opts.limits,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
  });
  const codexMgr = new CodexManager({
    maxSessions: opts.maxSessions,
    limits: opts.limits,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
  });
  const codexPtyMgr = new PtyCodexManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
  });
  const cursorCliMgr = new CursorCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
  });
  const claudeCliMgr = new ClaudeCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
  });
  const opencodeCliMgr = new OpencodeCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
    binOverride: opts.tooling?.bins?.opencode,
  });
  const geminiCliMgr = new GeminiCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
    binOverride: opts.tooling?.bins?.gemini,
  });
  const kimiCliMgr = new KimiCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
    binOverride: opts.tooling?.bins?.kimi,
  });
  const qwenCliMgr = new QwenCliManager({
    maxSessions: opts.maxSessions,
    validateCwd: opts.validateCwd,
    send: (m) => broadcast(m as TermServerMsg),
    termLogMaxBytes: opts.termLogMaxBytes,
    binOverride: opts.tooling?.bins?.qwen,
  });

  const sweepIntervalMs = Math.max(15000, Math.min(Number(opts.sessionPolicy?.sweepIntervalMs ?? 60000) || 60000, 600000));
  const sweepTimer = setInterval(() => {
    const idleTtlMs = Number(opts.sessionPolicy?.idleTtlMs ?? 0);
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) return;
    const now = Date.now();
    for (const [sessionId] of sessionMeta.entries()) {
      const lastAt = sessionActiveAt.get(sessionId) ?? now;
      if (now - lastAt < idleTtlMs) continue;
      const owner = sessionOwners.get(sessionId);
      const subs = sessionSubs.get(sessionId);
      if (subs && subs.size > 0) {
        const ttlHours = Math.max(0.1, Math.round((idleTtlMs / 3600000) * 10) / 10);
        for (const sock of subs) {
          send(sock, { t: "term.data", sessionId, data: `\r\n[session] closed after ${ttlHours}h idle timeout\r\n` });
        }
      }
      try {
        owner?.manager?.close?.(sessionId);
      } catch {}
      cleanupSession(sessionId);
    }
  }, sweepIntervalMs);
  if (typeof (sweepTimer as any).unref === "function") {
    (sweepTimer as any).unref();
  }
  wss.on("close", () => {
    clearInterval(sweepTimer);
  });

  wss.on("connection", async (ws, req) => {
    if (opts.authorize) {
      try {
        const auth = await opts.authorize(req);
        if (!auth.ok) {
          ws.close(1008, "unauthorized");
          return;
        }
      } catch {
        ws.close(1011, "auth error");
        return;
      }
    }

    ws.on("message", async (data) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data as ArrayBuffer).toString("utf8");

      const msg = safeJsonParse(text) as TermClientMsg | null;
      if (!msg || typeof (msg as any).t !== "string" || typeof (msg as any).reqId !== "string") {
        return;
      }

      const reqId = (msg as any).reqId as string;
      const t = (msg as any).t as string;
      const fail = (base: string, error: string) =>
        send(ws, { t: `${base}.resp` as any, reqId, ok: false, error } as any);

      try {
        if (t === "term.open") {
          const cwd = (msg as any).cwd;
          const cols = Number((msg as any).cols ?? 120);
          const rows = Number((msg as any).rows ?? 30);
          const mode = String((msg as any).mode ?? "restricted") as
            | "restricted"
            | "native"
            | "codex"
            | "claude"
            | "opencode"
            | "gemini"
            | "kimi"
            | "qwen"
            | "cursor-cli-agent"
            | "cursor-cli-plan"
            | "cursor-cli-ask";
          if (typeof cwd !== "string" || cwd.length === 0) return fail("term.open", "Missing cwd");
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return fail("term.open", "Invalid cols/rows");
          const realCwd = await opts.validateCwd(cwd);
          const runAs = opts.resolveRunAs ? opts.resolveRunAs(realCwd) : null;
          if (mode === "restricted") {
            const s = term.open(realCwd, cols, rows, runAs);
            registerSession(s.id, s.cwd, "restricted-exec", term, ws);
            send(ws, {
              t: "term.open.resp",
              reqId,
              ok: true,
              sessionId: s.id,
              cwd: s.cwd,
              mode: "restricted-exec",
            });
            send(ws, { t: "term.data", sessionId: s.id, data: `$ cd ${s.cwd}\r\n$ ` });
          } else if (mode === "native") {
            const s = nativeMgr.open(realCwd, cols, rows, runAs);
            registerSession(s.id, s.cwd, "native", nativeMgr, ws);
            send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "native" });
            send(ws, { t: "term.data", sessionId: s.id, data: `$ cd ${s.cwd}\r\n` });
          } else if (mode === "codex") {
            try {
              const s = await codexPtyMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "codex", codexPtyMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "codex" });
            } catch (e: any) {
              const s = await codexMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "codex", codexMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "codex" });
              send(ws, {
                t: "term.data",
                sessionId: s.id,
                data: `\r\n[codex] PTY unavailable, using exec mode: ${e?.message ?? String(e)}\r\n`,
              });
            }
          } else if (mode === "cursor-cli-agent" || mode === "cursor-cli-plan" || mode === "cursor-cli-ask") {
            const cliMode = mode === "cursor-cli-agent" ? "agent" : mode === "cursor-cli-plan" ? "plan" : "ask";
            try {
              const s = await cursorCliMgr.open(realCwd, cols, rows, cliMode, runAs);
              registerSession(s.id, s.cwd, mode, cursorCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode });
            } catch (e: any) {
              return fail("term.open", `Cursor CLI (${cliMode}) failed: ${e?.message ?? String(e)}`);
            }
          } else if (mode === "claude") {
            try {
              const s = await claudeCliMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "claude", claudeCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "claude" });
            } catch (e: any) {
              return fail("term.open", `Claude Code failed: ${e?.message ?? String(e)}`);
            }
          } else if (mode === "opencode") {
            try {
              const s = await opencodeCliMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "opencode", opencodeCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "opencode" });
            } catch (e: any) {
              return fail("term.open", `OpenCode failed: ${e?.message ?? String(e)}`);
            }
          } else if (mode === "gemini") {
            try {
              const s = await geminiCliMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "gemini", geminiCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "gemini" });
            } catch (e: any) {
              return fail("term.open", `Gemini CLI failed: ${e?.message ?? String(e)}`);
            }
          } else if (mode === "kimi") {
            try {
              const s = await kimiCliMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "kimi", kimiCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "kimi" });
            } catch (e: any) {
              return fail("term.open", `Kimi CLI failed: ${e?.message ?? String(e)}`);
            }
          } else if (mode === "qwen") {
            try {
              const s = await qwenCliMgr.open(realCwd, cols, rows, runAs);
              registerSession(s.id, s.cwd, "qwen", qwenCliMgr, ws);
              send(ws, { t: "term.open.resp", reqId, ok: true, sessionId: s.id, cwd: s.cwd, mode: "qwen" });
            } catch (e: any) {
              return fail("term.open", `Qwen Code CLI failed: ${e?.message ?? String(e)}`);
            }
          } else {
            return fail("term.open", `Unknown mode: ${mode}`);
          }
          return;
        }

        if (t === "term.attach") {
          const sessionId = String((msg as any).sessionId ?? "");
          if (!sessionId) return fail("term.attach", "Missing sessionId");
          const meta = sessionMeta.get(sessionId);
          if (!meta) return fail("term.attach", "Session not found");
          if (meta.mode === "native" || meta.mode === "restricted-pty") {
            const owner = sessionOwners.get(sessionId);
            if (owner) {
              try {
                owner.manager.close(sessionId);
              } catch {}
            }
            cleanupSession(sessionId);
            return fail("term.attach", "Legacy restricted session is no longer supported. Please create a new session.");
          }
          attachSession(ws, sessionId);
          touchSession(sessionId);
          send(ws, { t: "term.attach.resp", reqId, ok: true, sessionId, cwd: meta.cwd, mode: meta.mode });
          return;
        }

        if (t === "term.close") {
          const sessionId = String((msg as any).sessionId ?? "");
          if (!sessionId) return fail("term.close", "Missing sessionId");
          const owner = sessionOwners.get(sessionId);
          if (owner) {
            try {
              owner.manager.close(sessionId);
            } catch {}
          }
          send(ws, { t: "term.close.resp", reqId, ok: true });
          broadcast({ t: "term.exit", sessionId, code: 0 } as TermServerMsg);
          cleanupSession(sessionId);
          return;
        }

        if (t === "term.resize") {
          const sessionId = String((msg as any).sessionId ?? "");
          const cols = Number((msg as any).cols);
          const rows = Number((msg as any).rows);
          if (!sessionId) return fail("term.resize", "Missing sessionId");
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return fail("term.resize", "Invalid cols/rows");
          const owner = sessionOwners.get(sessionId);
          if (!owner) return fail("term.resize", "Unknown session");
          touchSession(sessionId);
          owner.manager.resize(sessionId, cols, rows);
          send(ws, { t: "term.resize.resp", reqId, ok: true });
          return;
        }

        if (t === "term.stdin") {
          const sessionId = String((msg as any).sessionId ?? "");
          const dataStr = (msg as any).data;
          if (!sessionId) return fail("term.stdin", "Missing sessionId");
          if (typeof dataStr !== "string") return fail("term.stdin", "Missing data");
          send(ws, { t: "term.stdin.resp", reqId, ok: true });
          const owner = sessionOwners.get(sessionId);
          if (!owner) return;
          touchSession(sessionId);
          const mgr = owner.manager;
          Promise.resolve()
            .then(() => mgr.stdin(sessionId, dataStr))
            .catch((e: any) => {
              broadcast({ t: "term.data", sessionId, data: `\r\n[error] ${e?.message ?? String(e)}\r\n` } as TermServerMsg);
            });
          return;
        }

        return;
      } catch (e: any) {
        fail(t, e?.message ?? String(e));
      }
    });

    ws.on("close", () => {
      detachWs(ws);
    });
  });

  return wss;
}

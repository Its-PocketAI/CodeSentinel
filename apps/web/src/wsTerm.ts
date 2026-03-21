import { getAuthToken } from "./api";
export type TermServerMsg =
  | { t: "term.open.resp"; reqId: string; ok: true; sessionId: string; cwd: string; mode?: string; threadId?: string }
  | { t: "term.open.resp"; reqId: string; ok: false; error: string }
  | { t: "term.attach.resp"; reqId: string; ok: true; sessionId: string; cwd?: string; mode?: string }
  | { t: "term.attach.resp"; reqId: string; ok: false; error: string }
  | { t: "term.stdin.resp"; reqId: string; ok: true }
  | { t: "term.stdin.resp"; reqId: string; ok: false; error: string }
  | { t: "term.resize.resp"; reqId: string; ok: true }
  | { t: "term.resize.resp"; reqId: string; ok: false; error: string }
  | { t: "term.close.resp"; reqId: string; ok: true }
  | { t: "term.close.resp"; reqId: string; ok: false; error: string }
  | { t: "term.data"; sessionId: string; data: string }
  | { t: "term.exit"; sessionId: string; code?: number };

function resolveWsUrl(): string {
  const loc = window.location;
  const wsProto = loc.protocol === "https:" ? "wss" : "ws";
  const envBase =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.VITE_WS_BASE as string | undefined)
      : undefined;

  if (envBase && envBase.trim()) {
    return `${envBase.trim().replace(/\/$/, "")}/ws/term`;
  }

  const isDev = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
  if (!isDev) {
    return `${wsProto}://${loc.host}/ws/term`;
  }

  if (loc.port === "3990") {
    return `${loc.origin.replace(/^http/, "ws")}/ws/term`;
  }

  return `${wsProto}://${loc.hostname}:3990/ws/term`;
}
function withWsToken(url: string): string {
  const token = getAuthToken();
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}token=${encodeURIComponent(token)}`;
  }
}


export class TermClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (msg: any) => void;
      reject: (err: Error) => void;
      timer: number;
    }
  >();
  private outbox: string[] = [];
  onMsg?: (msg: TermServerMsg) => void;
  debug = false;

  private log(..._args: any[]) {
    if (!this.debug) return;
  }

  private rejectAllPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const url = withWsToken(resolveWsUrl());
    this.log("connect()", { url });
    this.ws = new WebSocket(url);
    const ws = this.ws;
    const p = new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        if (ok) resolve();
        else reject(err ?? new Error("ws error"));
      };
      ws.onopen = () => {
        this.log("ws.onopen");
        const queued = this.outbox;
        this.outbox = [];
        for (const m of queued) ws.send(m);
        done(true);
      };
      ws.onerror = (ev) => {
        this.log("ws.onerror", ev);
        done(false, new Error("ws error"));
      };
      ws.onclose = (ev) => {
        this.log("ws.onclose", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        if (this.ws === ws) this.ws = null;
        done(false, new Error(`ws closed (${ev.code})`));
        this.rejectAllPending(`ws closed (${ev.code})`);
      };
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
    });
    this.connectPromise = p.finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  close() {
    this.log("close()");
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.outbox = [];
    this.rejectAllPending("ws closed");
  }

  private request<T extends { t: string; reqId: string }>(msg: any): Promise<T> {
    return (async () => {
      await this.connect();
      const reqId = `r_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
      msg.reqId = reqId;
      const payload = JSON.stringify(msg);
      this.log("send", { t: msg?.t, reqId, sessionId: msg?.sessionId, bytes: payload.length });
      const ws = this.ws;
      if (!ws) throw new Error("ws not connected");
      const p = new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(reqId);
          this.log("request timeout", { t: msg?.t, reqId });
          reject(new Error("request timeout"));
        }, 45000);
        this.pending.set(reqId, {
          resolve: (m) => {
            clearTimeout(timeout);
            resolve(m as T);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
          timer: timeout,
        });
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        this.outbox.push(payload);
      } else {
        this.pending.delete(reqId);
        throw new Error("ws not connected");
      }
      return p;
    })();
  }

  async open(
    cwd: string,
    cols: number,
    rows: number,
    mode?: "restricted" | "native" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "agent" | "plan" | "ask" | "cursor-cli-agent" | "cursor-cli-plan" | "cursor-cli-ask",
    options?: {
      prompt?: string;
      resume?: string;
    }
  ) {
    return await this.request<{
      t: "term.open.resp";
      reqId: string;
      ok: boolean;
      sessionId?: string;
      cwd?: string;
      mode?: string;
      threadId?: string;
      error?: string;
    }>({ t: "term.open", cwd, cols, rows, mode, options });
  }

  async attach(sessionId: string) {
    return await this.request<{
      t: "term.attach.resp";
      reqId: string;
      ok: boolean;
      sessionId?: string;
      cwd?: string;
      mode?: string;
      error?: string;
    }>({ t: "term.attach", sessionId });
  }

  async stdin(sessionId: string, data: string) {
    return await this.request<{ t: "term.stdin.resp"; reqId: string; ok: boolean; error?: string }>({
      t: "term.stdin",
      sessionId,
      data,
    });
  }

  async resize(sessionId: string, cols: number, rows: number) {
    return await this.request<{ t: "term.resize.resp"; reqId: string; ok: boolean; error?: string }>({
      t: "term.resize",
      sessionId,
      cols,
      rows,
    });
  }

  async closeSession(sessionId: string) {
    return await this.request<{ t: "term.close.resp"; reqId: string; ok: boolean; error?: string }>({
      t: "term.close",
      sessionId,
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.t === "term.data") {
      this.log("recv term.data", { sessionId: msg.sessionId, bytes: msg.data?.length ?? 0 });
    } else if (msg?.t === "term.exit") {
      this.log("recv term.exit", { sessionId: msg.sessionId, code: msg.code });
    } else if (typeof msg?.t === "string" && String(msg.t).endsWith(".resp")) {
      this.log("recv resp", { t: msg.t, reqId: msg.reqId, ok: msg.ok, error: msg.error });
    } else {
      this.log("recv", { t: msg?.t });
    }
    this.onMsg?.(msg as TermServerMsg);
    if (msg?.reqId && typeof msg.t === "string" && String(msg.t).endsWith(".resp")) {
      const p = this.pending.get(msg.reqId);
      if (p) {
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }
}

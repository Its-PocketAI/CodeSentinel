export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type OkResp<T extends string, Extra extends object = object> = { t: `${T}.resp`; reqId: string; ok: true } & Extra;
export type ErrResp<T extends string> = { t: `${T}.resp`; reqId: string; ok: false; error: string };

export type FsEntry = {
  name: string;
  type: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
};

export type TermOpenReq = { 
  t: "term.open"; 
  reqId: string; 
  cwd: string; 
  cols?: number; 
  rows?: number;
  mode?: "restricted" | "native" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "agent" | "plan" | "ask" | "cursor-cli-agent" | "cursor-cli-plan" | "cursor-cli-ask";
  options?: {
    prompt?: string;
    resume?: string;
  };
};
export type TermOpenResp = OkResp<"term.open", { 
  sessionId: string; 
  cwd: string;
  mode?: string;
  threadId?: string;
}> | ErrResp<"term.open">;

export type TermAttachReq = { t: "term.attach"; reqId: string; sessionId: string };
export type TermAttachResp = OkResp<"term.attach", { sessionId: string; cwd?: string; mode?: string }> | ErrResp<"term.attach">;

export type TermStdinReq = { t: "term.stdin"; reqId: string; sessionId: string; data: string };
export type TermStdinResp = OkResp<"term.stdin"> | ErrResp<"term.stdin">;

export type TermResizeReq = { t: "term.resize"; reqId: string; sessionId: string; cols: number; rows: number };
export type TermResizeResp = OkResp<"term.resize"> | ErrResp<"term.resize">;

export type TermCloseReq = { t: "term.close"; reqId: string; sessionId: string };
export type TermCloseResp = OkResp<"term.close"> | ErrResp<"term.close">;

export type TermDataEvt = { t: "term.data"; sessionId: string; data: string };
export type TermExitEvt = { t: "term.exit"; sessionId: string; code?: number };
export type SessionEventLevel = "info" | "success" | "warning" | "error";
export type SessionEventConfidence = "high" | "medium" | "low";
export type SessionEventKind =
  | "session.opened"
  | "session.attached"
  | "session.activity"
  | "session.completed"
  | "session.exited"
  | "session.closed"
  | "session.idle-timeout"
  | "attention.approval"
  | "attention.error"
  | "artifact.diff";
export type SessionEventEvt = {
  t: "session.event";
  eventId: string;
  seq: number;
  sessionId: string;
  ts: number;
  kind: SessionEventKind;
  source: "server" | "parser";
  level?: SessionEventLevel;
  confidence?: SessionEventConfidence;
  mode?: string;
  cwd?: string;
  title?: string;
  detail?: string;
  action?: "open-session" | "resume-session" | "view-replay" | "view-artifacts";
  data?: { [k: string]: JsonValue };
};

export type TermClientMsg = TermOpenReq | TermAttachReq | TermStdinReq | TermResizeReq | TermCloseReq;
export type TermServerMsg =
  | TermOpenResp
  | TermAttachResp
  | TermStdinResp
  | TermResizeResp
  | TermCloseResp
  | TermDataEvt
  | TermExitEvt
  | SessionEventEvt;

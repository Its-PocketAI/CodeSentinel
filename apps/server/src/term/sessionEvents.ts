import type { SessionEventConfidence, SessionEventEvt, SessionEventKind, SessionEventLevel } from "@codesentinel/protocol";

type SessionContext = {
  sessionId: string;
  cwd?: string;
  mode?: string;
};

type ParserState = {
  seq: number;
  lineBuf: string;
  lastActivityAt: number;
  seenMarkers: string[];
  diffDetected: boolean;
};

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function compactText(input: string, maxLen = 180): string {
  const clean = stripAnsi(input).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function markerKey(kind: SessionEventKind, detail: string): string {
  return `${kind}:${detail.toLowerCase()}`;
}

function rememberMarker(state: ParserState, marker: string): boolean {
  if (state.seenMarkers.includes(marker)) return false;
  state.seenMarkers.push(marker);
  if (state.seenMarkers.length > 24) {
    state.seenMarkers.splice(0, state.seenMarkers.length - 24);
  }
  return true;
}

function approvalSignal(line: string): { title: string; confidence: SessionEventConfidence } | null {
  if (line.length > 220) return null;
  if (/\[(?:y|Y)\/(?:n|N)\]/.test(line) || /\b(?:yes\/no|y\/n)\b/i.test(line)) {
    return { title: "需要人工确认", confidence: "high" };
  }
  if (/\b(?:approve|approval|allow|confirm|grant access|continue\?|proceed\?|press enter to continue)\b/i.test(line)) {
    return { title: "可能需要人工确认", confidence: "medium" };
  }
  return null;
}

function reviewSignal(line: string): { title: string; detail: string } | null {
  if (/^diff --git\b/i.test(line) || /^@@ .* @@$/.test(line) || /^(?:\+\+\+|---) /.test(line)) {
    return { title: "检测到 diff 输出", detail: "可直接从控制平面进入回放审阅" };
  }
  if (/\b(?:modified files?|changes ready|review changes|patch applied)\b/i.test(line) && line.length <= 220) {
    return { title: "检测到变更输出", detail: line };
  }
  return null;
}

function errorSignal(line: string): { title: string; detail: string } | null {
  if (line.length > 240) return null;
  if (/^\[error\]/i.test(line) || /\b(?:fatal|permission denied|failed|timed out|exception|traceback)\b/i.test(line)) {
    return { title: "会话输出包含错误", detail: line };
  }
  return null;
}

export function createSessionEventController(emit: (event: SessionEventEvt) => void) {
  const parserState = new Map<string, ParserState>();

  const ensureState = (sessionId: string) => {
    let state = parserState.get(sessionId);
    if (!state) {
      state = {
        seq: 0,
        lineBuf: "",
        lastActivityAt: 0,
        seenMarkers: [],
        diffDetected: false,
      };
      parserState.set(sessionId, state);
    }
    return state;
  };

  const emitEvent = (
    ctx: SessionContext,
    kind: SessionEventKind,
    options?: {
      level?: SessionEventLevel;
      confidence?: SessionEventConfidence;
      title?: string;
      detail?: string;
      action?: SessionEventEvt["action"];
      data?: SessionEventEvt["data"];
      source?: SessionEventEvt["source"];
    },
  ) => {
    const state = ensureState(ctx.sessionId);
    state.seq += 1;
    const ts = Date.now();
    emit({
      t: "session.event",
      eventId: `${ctx.sessionId}:${state.seq}`,
      seq: state.seq,
      sessionId: ctx.sessionId,
      ts,
      kind,
      source: options?.source ?? "server",
      level: options?.level,
      confidence: options?.confidence,
      mode: ctx.mode,
      cwd: ctx.cwd,
      title: options?.title,
      detail: options?.detail,
      action: options?.action,
      data: options?.data,
    });
  };

  const maybeEmitActivity = (ctx: SessionContext, preview: string) => {
    const state = ensureState(ctx.sessionId);
    const now = Date.now();
    if (!preview) return;
    if (now - state.lastActivityAt < 1500) return;
    state.lastActivityAt = now;
    emitEvent(ctx, "session.activity", {
      level: "info",
      title: "会话有新输出",
      detail: preview,
      action: "open-session",
    });
  };

  const maybeEmitLineSignal = (ctx: SessionContext, rawLine: string) => {
    const state = ensureState(ctx.sessionId);
    const line = compactText(rawLine, 220);
    if (!line) return;

    const approval = approvalSignal(line);
    if (approval) {
      const marker = markerKey("attention.approval", line);
      if (rememberMarker(state, marker)) {
        emitEvent(ctx, "attention.approval", {
          source: "parser",
          level: "warning",
          confidence: approval.confidence,
          title: approval.title,
          detail: line,
          action: "open-session",
        });
      }
    }

    const review = reviewSignal(line);
    if (review) {
      if (!state.diffDetected) {
        state.diffDetected = true;
        emitEvent(ctx, "artifact.diff", {
          source: "parser",
          level: "info",
          confidence: "medium",
          title: review.title,
          detail: review.detail,
          action: "view-replay",
        });
      }
    }

    const error = errorSignal(line);
    if (error) {
      const marker = markerKey("attention.error", line);
      if (rememberMarker(state, marker)) {
        emitEvent(ctx, "attention.error", {
          source: "parser",
          level: "error",
          confidence: "medium",
          title: error.title,
          detail: error.detail,
          action: "open-session",
        });
      }
    }
  };

  return {
    opened(ctx: SessionContext) {
      emitEvent(ctx, "session.opened", {
        level: "success",
        title: "会话已创建",
        detail: ctx.cwd || ctx.mode || ctx.sessionId,
        action: "open-session",
        data: { replayAvailable: true, snapshotAvailable: true },
      });
    },
    attached(ctx: SessionContext) {
      emitEvent(ctx, "session.attached", {
        level: "info",
        title: "会话已接入",
        detail: ctx.cwd || ctx.sessionId,
        action: "open-session",
      });
    },
    closed(ctx: SessionContext) {
      emitEvent(ctx, "session.closed", {
        level: "warning",
        title: "会话已关闭",
        detail: ctx.cwd || ctx.sessionId,
        action: "view-replay",
      });
      parserState.delete(ctx.sessionId);
    },
    idleTimeout(ctx: SessionContext, ttlHours: number) {
      emitEvent(ctx, "session.idle-timeout", {
        level: "warning",
        title: "会话因空闲超时关闭",
        detail: `${ttlHours}h 内无活动`,
        action: "view-replay",
      });
      parserState.delete(ctx.sessionId);
    },
    completed(ctx: SessionContext, code?: number) {
      emitEvent(ctx, "session.completed", {
        level: code && code !== 0 ? "warning" : "success",
        title: code && code !== 0 ? "命令执行完成（有退出码）" : "命令执行完成",
        detail: code === undefined ? "可继续输入下一条命令" : `退出码 ${code}`,
        action: "open-session",
      });
      if (code && code !== 0) {
        emitEvent(ctx, "attention.error", {
          source: "server",
          level: "warning",
          confidence: "high",
          title: "命令返回非零退出码",
          detail: `退出码 ${code}`,
          action: "open-session",
        });
      }
    },
    exited(ctx: SessionContext, code?: number) {
      emitEvent(ctx, "session.exited", {
        level: code && code !== 0 ? "error" : "warning",
        title: "会话已退出",
        detail: code === undefined ? "会话结束" : `退出码 ${code}`,
        action: "view-replay",
      });
      if (code && code !== 0) {
        emitEvent(ctx, "attention.error", {
          source: "server",
          level: "error",
          confidence: "high",
          title: "会话异常退出",
          detail: `退出码 ${code}`,
          action: "view-replay",
        });
      }
      parserState.delete(ctx.sessionId);
    },
    parseData(ctx: SessionContext, data: string) {
      if (!data) return;
      const state = ensureState(ctx.sessionId);
      const preview = compactText(data, 120);
      maybeEmitActivity(ctx, preview);
      const normalized = stripAnsi(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      state.lineBuf += normalized;
      const lines = state.lineBuf.split("\n");
      state.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        maybeEmitLineSignal(ctx, line);
      }
    },
  };
}

import { useSyncExternalStore } from "react";
import type { TermServerMsg } from "../wsTerm";

export type ControlPlaneSessionRow = {
  sessionId: string;
  updatedAt: number;
  sizeBytes: number;
  cwd?: string;
  mode?: string;
  active?: boolean;
};

type SessionStatus = "running" | "completed" | "exited" | "closed" | "idle" | "queued";

export type ControlPlaneSessionCard = {
  sessionId: string;
  cwd: string;
  mode: string;
  updatedAt: number;
  active: boolean;
  current: boolean;
  stale: boolean;
  status: SessionStatus;
  detail: string;
  replayAvailable: boolean;
  snapshotAvailable: boolean;
  diffAvailable: boolean;
  diffDetail: string;
  attentionCount: number;
};

export type ControlPlaneAttentionItem = {
  id: string;
  sessionId: string;
  kind: "approval" | "error";
  title: string;
  detail: string;
  level: "info" | "success" | "warning" | "error";
  confidence: "high" | "medium" | "low";
  createdAt: number;
  updatedAt: number;
  action: "open-session" | "resume-session" | "view-replay" | "view-artifacts";
};

export type ControlPlaneArtifactItem = {
  id: string;
  sessionId: string;
  kind: "replay" | "snapshot" | "diff";
  title: string;
  detail: string;
  updatedAt: number;
  available: boolean;
};

type SessionRecord = {
  sessionId: string;
  cwd: string;
  mode: string;
  updatedAt: number;
  active: boolean;
  stale: boolean;
  status: SessionStatus;
  detail: string;
  replayAvailable: boolean;
  snapshotAvailable: boolean;
  diffAvailable: boolean;
  diffDetail: string;
};

type Snapshot = {
  connected: boolean;
  stale: boolean;
  currentSessionId: string;
  sessions: ControlPlaneSessionCard[];
  attention: ControlPlaneAttentionItem[];
  artifacts: ControlPlaneArtifactItem[];
};

type SessionEventMessage = Extract<TermServerMsg, { t: "session.event" }>;

function emptySnapshot(): Snapshot {
  return {
    connected: false,
    stale: true,
    currentSessionId: "",
    sessions: [],
    attention: [],
    artifacts: [],
  };
}

function emptySession(sessionId: string): SessionRecord {
  return {
    sessionId,
    cwd: "",
    mode: "",
    updatedAt: Date.now(),
    active: false,
    stale: false,
    status: "queued",
    detail: "",
    replayAvailable: false,
    snapshotAvailable: false,
    diffAvailable: false,
    diffDetail: "",
  };
}

function artifactFromSession(session: SessionRecord): ControlPlaneArtifactItem[] {
  const items: ControlPlaneArtifactItem[] = [];
  if (session.replayAvailable) {
    items.push({
      id: `replay:${session.sessionId}`,
      sessionId: session.sessionId,
      kind: "replay",
      title: "终端回放",
      detail: session.cwd || session.mode || session.sessionId,
      updatedAt: session.updatedAt,
      available: true,
    });
  }
  if (session.snapshotAvailable) {
    items.push({
      id: `snapshot:${session.sessionId}`,
      sessionId: session.sessionId,
      kind: "snapshot",
      title: "实时快照",
      detail: "会话在线时可回看当前输出",
      updatedAt: session.updatedAt,
      available: true,
    });
  }
  if (session.diffAvailable) {
    items.push({
      id: `diff:${session.sessionId}`,
      sessionId: session.sessionId,
      kind: "diff",
      title: "Diff 线索",
      detail: session.diffDetail || "检测到变更输出，可进入回放审阅",
      updatedAt: session.updatedAt,
      available: true,
    });
  }
  return items;
}

export class ControlPlaneStore {
  private listeners = new Set<() => void>();
  private sessions = new Map<string, SessionRecord>();
  private attention = new Map<string, ControlPlaneAttentionItem>();
  private currentSessionId = "";
  private connected = false;
  private snapshot: Snapshot = emptySnapshot();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private attentionCount(sessionId: string) {
    let count = 0;
    for (const item of this.attention.values()) {
      if (item.sessionId === sessionId) count += 1;
    }
    return count;
  }

  private upsertSession(sessionId: string, update: Partial<SessionRecord>) {
    const prev = this.sessions.get(sessionId) ?? emptySession(sessionId);
    this.sessions.set(sessionId, { ...prev, ...update, sessionId });
  }

  private removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    for (const [id, item] of this.attention.entries()) {
      if (item.sessionId === sessionId) this.attention.delete(id);
    }
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = "";
    }
  }

  bootstrapSessions(rows: ControlPlaneSessionRow[]) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row?.sessionId) continue;
      seen.add(row.sessionId);
      const prev = this.sessions.get(row.sessionId) ?? emptySession(row.sessionId);
      const nextStatus: SessionStatus =
        row.active
          ? "running"
          : prev.status === "completed" || prev.status === "closed" || prev.status === "exited" || prev.status === "idle"
            ? prev.status
            : "exited";
      this.sessions.set(row.sessionId, {
        ...prev,
        sessionId: row.sessionId,
        cwd: row.cwd ?? prev.cwd,
        mode: row.mode ?? prev.mode,
        updatedAt: row.updatedAt || prev.updatedAt,
        active: Boolean(row.active),
        stale: false,
        status: nextStatus,
        detail: prev.detail || (row.active ? "会话在线" : "会话已结束"),
        replayAvailable: prev.replayAvailable || row.sizeBytes > 0,
        snapshotAvailable: Boolean(row.active),
      });
    }
    for (const [sessionId, session] of this.sessions.entries()) {
      if (seen.has(sessionId)) continue;
      if (session.active) {
        this.sessions.set(sessionId, { ...session, active: false, stale: true, snapshotAvailable: false });
        continue;
      }
      this.removeSession(sessionId);
    }
    this.emit();
  }

  applyServerMessage(msg: TermServerMsg) {
    if (msg.t !== "session.event") return;
    this.connected = true;
    this.applyEvent(msg);
    this.emit();
  }

  private applyEvent(event: SessionEventMessage) {
    const prev = this.sessions.get(event.sessionId) ?? emptySession(event.sessionId);
    const baseUpdate: Partial<SessionRecord> = {
      cwd: event.cwd ?? prev.cwd,
      mode: event.mode ?? prev.mode,
      updatedAt: event.ts || Date.now(),
      stale: false,
      replayAvailable: true,
      snapshotAvailable: prev.snapshotAvailable,
      detail: event.detail || prev.detail,
    };
    switch (event.kind) {
      case "session.opened":
      case "session.attached":
      case "session.activity":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          active: true,
          status: "running",
          snapshotAvailable: true,
        });
        break;
      case "session.completed":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          active: true,
          status: "completed",
          snapshotAvailable: true,
        });
        break;
      case "session.exited":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          active: false,
          status: "exited",
          snapshotAvailable: false,
        });
        break;
      case "session.closed":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          active: false,
          status: "closed",
          snapshotAvailable: false,
        });
        break;
      case "session.idle-timeout":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          active: false,
          status: "idle",
          snapshotAvailable: false,
        });
        break;
      case "artifact.diff":
        this.upsertSession(event.sessionId, {
          ...baseUpdate,
          diffAvailable: true,
          diffDetail: event.detail || prev.diffDetail,
        });
        break;
      default:
        this.upsertSession(event.sessionId, baseUpdate);
        break;
    }

    if (event.kind === "attention.approval" || event.kind === "attention.error") {
      const kind = event.kind === "attention.approval" ? "approval" : "error";
      const id = `${event.kind}:${event.sessionId}`;
      const prevAttention = this.attention.get(id);
      this.attention.set(id, {
        id,
        sessionId: event.sessionId,
        kind,
        title: event.title || (kind === "approval" ? "需要人工确认" : "会话异常"),
        detail: event.detail || "",
        level: event.level || (kind === "error" ? "error" : "warning"),
        confidence: event.confidence || (kind === "error" ? "high" : "medium"),
        createdAt: prevAttention?.createdAt ?? event.ts,
        updatedAt: event.ts,
        action: event.action || "open-session",
      });
    }
  }

  setCurrentSession(sessionId: string, meta?: { cwd?: string; mode?: string }) {
    this.currentSessionId = sessionId;
    if (sessionId) {
      this.upsertSession(sessionId, {
        cwd: meta?.cwd,
        mode: meta?.mode,
        active: true,
        stale: false,
      });
      this.ackSession(sessionId);
    }
    this.emit();
  }

  clearCurrentSession(sessionId?: string) {
    if (!sessionId || sessionId === this.currentSessionId) {
      this.currentSessionId = "";
      this.emit();
    }
  }

  ackSession(sessionId: string) {
    let changed = false;
    for (const [id, item] of this.attention.entries()) {
      if (item.sessionId !== sessionId) continue;
      this.attention.delete(id);
      changed = true;
    }
    if (changed) this.emit();
  }

  setConnection(connected: boolean) {
    this.connected = connected;
    if (!connected) {
      for (const [sessionId, session] of this.sessions.entries()) {
        if (!session.active) continue;
        this.sessions.set(sessionId, { ...session, stale: true, snapshotAvailable: false });
      }
    }
    this.emit();
  }

  private buildSnapshot(): Snapshot {
    const sessions = Array.from(this.sessions.values())
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        mode: session.mode,
        updatedAt: session.updatedAt,
        active: session.active,
        current: session.sessionId === this.currentSessionId,
        stale: session.stale,
        status: session.status,
        detail: session.detail,
        replayAvailable: session.replayAvailable,
        snapshotAvailable: session.snapshotAvailable,
        diffAvailable: session.diffAvailable,
        diffDetail: session.diffDetail,
        attentionCount: this.attentionCount(session.sessionId),
      }))
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });

    const attention = Array.from(this.attention.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const artifacts = sessions.flatMap((session) =>
      artifactFromSession({
        sessionId: session.sessionId,
        cwd: session.cwd,
        mode: session.mode,
        updatedAt: session.updatedAt,
        active: session.active,
        stale: session.stale,
        status: session.status,
        detail: session.detail,
        replayAvailable: session.replayAvailable,
        snapshotAvailable: session.snapshotAvailable,
        diffAvailable: session.diffAvailable,
        diffDetail: session.diffDetail,
      }),
    ).sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      connected: this.connected,
      stale: !this.connected,
      currentSessionId: this.currentSessionId,
      sessions,
      attention,
      artifacts,
    };
  }

  getSnapshot = (): Snapshot => {
    return this.snapshot;
  };
}

const controlPlaneStore = new ControlPlaneStore();

export function useControlPlaneSnapshot() {
  return useSyncExternalStore(controlPlaneStore.subscribe, controlPlaneStore.getSnapshot, controlPlaneStore.getSnapshot);
}

export { controlPlaneStore };

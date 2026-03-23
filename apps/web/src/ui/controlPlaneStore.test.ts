import { describe, expect, it } from "vitest";
import { ControlPlaneStore } from "./controlPlaneStore";
import type { TermServerMsg } from "../wsTerm";

function sessionEvent(event: Omit<Extract<TermServerMsg, { t: "session.event" }>, "t">): Extract<TermServerMsg, { t: "session.event" }> {
  return { t: "session.event", ...event };
}

describe("ControlPlaneStore", () => {
  it("bootstraps session cards and derives replay/snapshot artifacts", () => {
    const store = new ControlPlaneStore();
    store.bootstrapSessions([
      { sessionId: "s_1", updatedAt: 100, sizeBytes: 128, cwd: "/repo", mode: "codex", active: true },
      { sessionId: "s_2", updatedAt: 50, sizeBytes: 0, cwd: "/repo", mode: "claude", active: false },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0]?.sessionId).toBe("s_1");
    expect(snapshot.artifacts.some((item) => item.id === "replay:s_1")).toBe(true);
    expect(snapshot.artifacts.some((item) => item.id === "snapshot:s_1")).toBe(true);
  });

  it("turns attention events into inbox items and clears them when the session becomes current", () => {
    const store = new ControlPlaneStore();
    store.applyServerMessage(
      sessionEvent({
        eventId: "s_1:1",
        seq: 1,
        sessionId: "s_1",
        ts: 100,
        kind: "attention.approval",
        source: "parser",
        level: "warning",
        confidence: "high",
        title: "需要确认",
        detail: "Approve execution? [y/N]",
        action: "open-session",
      }),
    );

    expect(store.getSnapshot().attention).toHaveLength(1);
    store.setCurrentSession("s_1", { cwd: "/repo", mode: "codex" });
    expect(store.getSnapshot().attention).toHaveLength(0);
    expect(store.getSnapshot().currentSessionId).toBe("s_1");
  });

  it("marks diff availability and stale state from connection changes", () => {
    const store = new ControlPlaneStore();
    store.bootstrapSessions([{ sessionId: "s_1", updatedAt: 100, sizeBytes: 64, cwd: "/repo", mode: "codex", active: true }]);
    store.applyServerMessage(
      sessionEvent({
        eventId: "s_1:2",
        seq: 2,
        sessionId: "s_1",
        ts: 120,
        kind: "artifact.diff",
        source: "parser",
        level: "info",
        confidence: "medium",
        title: "检测到 diff 输出",
        detail: "diff --git a/app.ts b/app.ts",
        action: "view-replay",
      }),
    );

    expect(store.getSnapshot().artifacts.some((item) => item.id === "diff:s_1")).toBe(true);
    expect(store.getSnapshot().attention).toHaveLength(0);
    store.setConnection(false);
    expect(store.getSnapshot().sessions[0]?.stale).toBe(true);
  });

  it("prunes missing inactive sessions on bootstrap refresh", () => {
    const store = new ControlPlaneStore();
    store.bootstrapSessions([
      { sessionId: "s_keep", updatedAt: 100, sizeBytes: 64, cwd: "/repo", mode: "codex", active: true },
      { sessionId: "s_drop", updatedAt: 90, sizeBytes: 32, cwd: "/repo", mode: "claude", active: false },
    ]);

    store.bootstrapSessions([
      { sessionId: "s_keep", updatedAt: 110, sizeBytes: 96, cwd: "/repo", mode: "codex", active: true },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["s_keep"]);
    expect(snapshot.artifacts.some((item) => item.sessionId === "s_drop")).toBe(false);
  });

  it("reuses the same snapshot reference until store state changes", () => {
    const store = new ControlPlaneStore();
    const first = store.getSnapshot();
    const second = store.getSnapshot();

    expect(second).toBe(first);

    store.bootstrapSessions([{ sessionId: "s_1", updatedAt: 100, sizeBytes: 1, cwd: "/repo", mode: "codex", active: true }]);
    const third = store.getSnapshot();

    expect(third).not.toBe(first);
    expect(store.getSnapshot()).toBe(third);
  });
});

import { describe, expect, it } from "vitest";
import { createSessionEventController } from "./sessionEvents.js";

describe("createSessionEventController", () => {
  it("emits lifecycle events with monotonic sequence numbers", () => {
    const events: Array<{ kind: string; seq: number }> = [];
    const controller = createSessionEventController((event) => {
      events.push({ kind: event.kind, seq: event.seq });
    });

    controller.opened({ sessionId: "s_1", cwd: "/repo", mode: "codex" });
    controller.attached({ sessionId: "s_1", cwd: "/repo", mode: "codex" });
    controller.exited({ sessionId: "s_1", cwd: "/repo", mode: "codex" }, 0);

    expect(events.map((event) => event.kind)).toEqual(["session.opened", "session.attached", "session.exited"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("parses approval, diff, and error signals without duplicating the same marker", () => {
    const events: Array<{ kind: string; detail: string }> = [];
    const controller = createSessionEventController((event) => {
      events.push({ kind: event.kind, detail: event.detail || "" });
    });

    controller.parseData(
      { sessionId: "s_2", cwd: "/repo", mode: "codex" },
      "Approve execution? [y/N]\nApprove execution? [y/N]\ndiff --git a/app.ts b/app.ts\n[error] permission denied\n",
    );

    expect(events.some((event) => event.kind === "attention.approval" && event.detail.includes("[y/N]"))).toBe(true);
    expect(events.filter((event) => event.kind === "attention.approval")).toHaveLength(1);
    expect(events.some((event) => event.kind === "artifact.diff")).toBe(true);
    expect(events.some((event) => event.kind === "attention.review")).toBe(false);
    expect(events.some((event) => event.kind === "attention.error" && /permission denied/i.test(event.detail))).toBe(true);
  });

  it("emits an error attention item when a command completes with a non-zero exit code", () => {
    const events: string[] = [];
    const controller = createSessionEventController((event) => {
      events.push(event.kind);
    });

    controller.completed({ sessionId: "s_3", cwd: "/repo", mode: "restricted-exec" }, 2);

    expect(events).toEqual(["session.completed", "attention.error"]);
  });
});

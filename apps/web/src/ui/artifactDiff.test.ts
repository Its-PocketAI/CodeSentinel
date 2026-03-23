import { describe, expect, it } from "vitest";
import { extractDiffBlocks, summarizeDiffBlocks } from "./artifactDiff";

describe("artifactDiff", () => {
  it("extracts a standard git diff block", () => {
    const blocks = extractDiffBlocks(
      "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("diff --git a/app.ts b/app.ts");
    expect(summarizeDiffBlocks(blocks)).toEqual({ files: 1, added: 1, removed: 1 });
  });

  it("handles PTY replay chunks that leave a bare carriage return before diff headers", () => {
    const replay =
      "printf 'diff --git a/live.txt b/live.txt\\n--- a/live.txt\\n+++ b/live.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n'\r\n"
      + "\u001b[?2004l\rdiff --git a/live.txt b/live.txt\r\n--- a/live.txt\r\n+++ b/live.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n\u001b[?2004h.../repo $ ";

    const blocks = extractDiffBlocks(replay);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("diff --git a/live.txt b/live.txt");
    expect(blocks[0]?.body).toContain("@@ -1 +1 @@");
  });
});

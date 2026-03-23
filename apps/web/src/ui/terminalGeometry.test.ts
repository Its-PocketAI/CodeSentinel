import { describe, expect, it } from "vitest";
import {
  MIN_TERM_OPEN_COLS,
  MIN_TERM_OPEN_ROWS,
  SAFE_TERM_OPEN_COLS,
  SAFE_TERM_OPEN_ROWS,
  resolveSafeTerminalOpenSize,
} from "./terminalGeometry";

describe("resolveSafeTerminalOpenSize", () => {
  it("preserves fitted terminal sizes", () => {
    expect(resolveSafeTerminalOpenSize(120, 30)).toEqual({ cols: 120, rows: 30 });
    expect(resolveSafeTerminalOpenSize(MIN_TERM_OPEN_COLS, MIN_TERM_OPEN_ROWS)).toEqual({
      cols: MIN_TERM_OPEN_COLS,
      rows: MIN_TERM_OPEN_ROWS,
    });
  });

  it("falls back when the terminal has not completed its first fit", () => {
    expect(resolveSafeTerminalOpenSize(1, 30)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
    expect(resolveSafeTerminalOpenSize(0, 0)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
    expect(resolveSafeTerminalOpenSize(30, 1)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
  });
});

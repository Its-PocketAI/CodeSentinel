import { describe, expect, it } from "vitest";
import {
  MIN_TERM_OPEN_COLS,
  MIN_TERM_OPEN_ROWS,
  SAFE_TERM_OPEN_COLS,
  SAFE_TERM_OPEN_ROWS,
  sanitizeTermOpenSize,
  sanitizeTermResizeSize,
} from "./terminalGeometry.js";

describe("terminalGeometry", () => {
  it("preserves normal open sizes", () => {
    expect(sanitizeTermOpenSize(120, 30)).toEqual({ cols: 120, rows: 30 });
    expect(sanitizeTermOpenSize(MIN_TERM_OPEN_COLS, MIN_TERM_OPEN_ROWS)).toEqual({
      cols: MIN_TERM_OPEN_COLS,
      rows: MIN_TERM_OPEN_ROWS,
    });
  });

  it("falls back to a safe default when open size is degenerate", () => {
    expect(sanitizeTermOpenSize(1, 30)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
    expect(sanitizeTermOpenSize(0, 0)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
    expect(sanitizeTermOpenSize(20, 1)).toEqual({ cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS });
  });

  it("clamps resize dimensions to at least one cell", () => {
    expect(sanitizeTermResizeSize(0, 30)).toEqual({ cols: 1, rows: 30 });
    expect(sanitizeTermResizeSize(-5, 0)).toEqual({ cols: 1, rows: 1 });
    expect(sanitizeTermResizeSize(88, 22)).toEqual({ cols: 88, rows: 22 });
  });
});

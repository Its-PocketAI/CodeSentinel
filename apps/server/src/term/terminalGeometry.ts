export const SAFE_TERM_OPEN_COLS = 120;
export const SAFE_TERM_OPEN_ROWS = 30;
export const MIN_TERM_OPEN_COLS = 10;
export const MIN_TERM_OPEN_ROWS = 5;

function toPositiveInt(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

export function sanitizeTermOpenSize(cols: number, rows: number) {
  const nextCols = toPositiveInt(cols, SAFE_TERM_OPEN_COLS);
  const nextRows = toPositiveInt(rows, SAFE_TERM_OPEN_ROWS);

  // Interactive CLIs can crash if the PTY opens before xterm finishes its
  // first fit and reports a degenerate size like 0x0 or 1x30.
  if (nextCols < MIN_TERM_OPEN_COLS || nextRows < MIN_TERM_OPEN_ROWS) {
    return { cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS };
  }

  return { cols: nextCols, rows: nextRows };
}

export function sanitizeTermResizeSize(cols: number, rows: number) {
  return {
    cols: Math.max(1, toPositiveInt(cols, 1)),
    rows: Math.max(1, toPositiveInt(rows, 1)),
  };
}

export const SAFE_TERM_OPEN_COLS = 120;
export const SAFE_TERM_OPEN_ROWS = 30;
export const MIN_TERM_OPEN_COLS = 10;
export const MIN_TERM_OPEN_ROWS = 5;

function toPositiveInt(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

export function resolveSafeTerminalOpenSize(cols: number, rows: number) {
  const nextCols = toPositiveInt(cols, SAFE_TERM_OPEN_COLS);
  const nextRows = toPositiveInt(rows, SAFE_TERM_OPEN_ROWS);

  if (nextCols < MIN_TERM_OPEN_COLS || nextRows < MIN_TERM_OPEN_ROWS) {
    return { cols: SAFE_TERM_OPEN_COLS, rows: SAFE_TERM_OPEN_ROWS };
  }

  return { cols: nextCols, rows: nextRows };
}

import fs from "node:fs/promises";
import path from "node:path";

export const ROOTS_ALL_SENTINEL = "__ALL__";

export function isAllRootsToken(input: unknown) {
  return typeof input === "string" && input.trim().toLowerCase() === "all";
}

export function hasAllRootsAccess(roots: readonly string[]) {
  return roots.some((r) => r === ROOTS_ALL_SENTINEL || isAllRootsToken(r));
}

export function normalizeRoot(p: string) {
  const abs = path.resolve(p);
  // Strip trailing slash for consistent prefix checks.
  return abs.replace(/[\\/]+$/, "") || "/";
}

export async function normalizeRoots(roots: string[]) {
  const out: string[] = [];
  for (const r of roots) {
    const abs = normalizeRoot(r);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) out.push(abs);
    } catch {
      // ignore invalid roots
    }
  }
  if (out.length === 0) throw new Error("No valid roots");
  // prefer longer roots first (more specific)
  out.sort((a, b) => b.length - a.length);
  return out;
}

export async function realpathSafe(p: string) {
  // If the target (or its direct parent) doesn't exist yet, walk upward until an
  // existing ancestor is found, then reconstruct the unresolved tail.
  const abs = path.resolve(p);
  const tail: string[] = [];
  let probe = abs;
  while (true) {
    try {
      const realBase = await fs.realpath(probe);
      return tail.length ? path.join(realBase, ...tail.reverse()) : realBase;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new Error(`Path does not exist: ${p}`);
      }
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

export async function validatePathInRoots(inputPath: string, roots: string[]) {
  if (typeof inputPath !== "string" || inputPath.length === 0) throw new Error("Missing path");
  const abs = path.resolve(inputPath);
  const real = await realpathSafe(abs);
  if (hasAllRootsAccess(roots)) return real;
  for (const r of roots) {
    if (real === r) return real;
    if (real.startsWith(r + path.sep)) return real;
  }
  throw new Error("Path is outside configured roots");
}

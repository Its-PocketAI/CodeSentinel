import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FsEntry } from "@codesentinel/protocol";
import { validatePathInRoots } from "./pathGuard.js";

export type FileSearchMode = "name" | "content";

export type FileSearchHit = {
  path: string;
  relativePath: string;
  name: string;
  line?: number;
  column?: number;
  preview?: string;
};

const SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SEARCH_WALK_LIMIT = 20000;
const SEARCH_BUFFER_BYTES = 20 * 1024 * 1024;

function fileExists(p: string) {
  try {
    if (process.platform === "win32") return fsSync.existsSync(p);
    fsSync.accessSync(p, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBin(binName: string, envPATH?: string): Promise<string | null> {
  try {
    const env = envPATH != null ? { ...process.env, PATH: envPATH } : process.env;
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const r = await execa(cmd, [binName], { timeout: 3000, env });
    const p = r.stdout.trim().split("\n")[0]?.trim();
    if (p && fileExists(p)) return p;
  } catch {}
  return null;
}

function getRgCandidatePathsWin(): string[] {
  const dirs: string[] = [];
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const user = process.env.USERPROFILE || process.env.HOME || "";
  dirs.push(path.join(pf, "ripgrep"));
  dirs.push(path.join(pf86, "ripgrep"));
  if (local) dirs.push(path.join(local, "Programs", "ripgrep"));
  if (user) {
    dirs.push(path.join(user, "scoop", "apps", "ripgrep", "current"));
    dirs.push(path.join(user, ".cargo", "bin"));
  }
  return dirs.filter(Boolean);
}

async function resolveRgBinary() {
  let p = await whichBin("rg");
  let pathEnv = process.env.PATH || "";
  if (!p && process.platform === "win32") {
    const extraDirs = getRgCandidatePathsWin();
    if (extraDirs.length > 0) {
      pathEnv = [...extraDirs, pathEnv].join(path.delimiter);
      p = await whichBin("rg", pathEnv);
      if (!p) {
        for (const dir of extraDirs) {
          const candidate = path.join(dir, "rg.exe");
          if (fileExists(candidate)) {
            p = candidate;
            break;
          }
        }
      }
    }
  }
  if (!p) return null;
  return { bin: p, env: { ...process.env, PATH: pathEnv } };
}

function matchWithSmartCase(haystack: string, needle: string) {
  if (!needle) return false;
  const caseSensitive = /[A-Z]/.test(needle);
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function scoreNameMatch(relativePath: string, query: string) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const name = path.basename(relativePath);
  const caseSensitive = /[A-Z]/.test(query);
  const q = caseSensitive ? query : query.toLocaleLowerCase();
  const pathText = caseSensitive ? normalizedPath : normalizedPath.toLocaleLowerCase();
  const fileName = caseSensitive ? name : name.toLocaleLowerCase();
  if (fileName === q) return 0;
  if (fileName.startsWith(q)) return 1;
  if (fileName.includes(q)) return 2;
  if (pathText.startsWith(q)) return 3;
  if (pathText.includes(q)) return 4;
  return Number.POSITIVE_INFINITY;
}

function trimPreview(line: string) {
  return line.replace(/\r?\n$/, "");
}

async function searchWithRipgrep(baseDir: string, query: string, mode: FileSearchMode, limit: number) {
  const rg = await resolveRgBinary();
  if (!rg) return null;

  if (mode === "name") {
    const result = await execa(
      rg.bin,
      ["--files", "--hidden", "--glob", "!.git"],
      {
        cwd: baseDir,
        env: rg.env,
        reject: false,
        maxBuffer: SEARCH_BUFFER_BYTES,
      },
    );
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error((result.stderr || result.stdout || "rg failed").trim() || "rg failed");
    }
    const matches = result.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relativePath) => ({
        relativePath,
        score: scoreNameMatch(relativePath, query),
      }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => (a.score - b.score) || (a.relativePath.length - b.relativePath.length) || a.relativePath.localeCompare(b.relativePath));

    const truncated = matches.length > limit;
    const hits = matches.slice(0, limit).map((item) => ({
      path: path.resolve(baseDir, item.relativePath),
      relativePath: item.relativePath,
      name: path.basename(item.relativePath),
    }));
    return { hits, truncated, engine: "rg" as const };
  }

  const result = await execa(
    rg.bin,
    [
      "--json",
      "--line-number",
      "--column",
      "--fixed-strings",
      "--smart-case",
      "--max-count",
      "1",
      "--max-filesize",
      "10M",
      "--hidden",
      "--glob",
      "!.git",
      "--no-messages",
      query,
      ".",
    ],
    {
      cwd: baseDir,
      env: rg.env,
      reject: false,
      maxBuffer: SEARCH_BUFFER_BYTES,
    },
  );
  const exitCode = result.exitCode ?? 0;
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error((result.stderr || result.stdout || "rg failed").trim() || "rg failed");
  }

  const hits: FileSearchHit[] = [];
  let truncated = false;
  for (const line of result.stdout.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== "match") continue;
    const relativePath = String(parsed?.data?.path?.text || "").replace(/^\.\//, "");
    if (!relativePath) continue;
    const sub = Array.isArray(parsed?.data?.submatches) ? parsed.data.submatches[0] : null;
    hits.push({
      path: path.resolve(baseDir, relativePath),
      relativePath,
      name: path.basename(relativePath),
      line: typeof parsed?.data?.line_number === "number" ? parsed.data.line_number : undefined,
      column: typeof sub?.start === "number" ? sub.start + 1 : undefined,
      preview: trimPreview(String(parsed?.data?.lines?.text || "")),
    });
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
  }
  return { hits, truncated, engine: "rg" as const };
}

async function walkFiles(
  baseDir: string,
  onFile: (absPath: string, relativePath: string) => Promise<boolean> | boolean,
) {
  const stack = [baseDir];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absPath = path.join(current, entry.name);
      const relativePath = path.relative(baseDir, absPath) || entry.name;
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (visited > SEARCH_WALK_LIMIT) return true;
      const shouldStop = await onFile(absPath, relativePath);
      if (shouldStop) return true;
    }
  }
  return false;
}

function findTextPosition(text: string, query: string) {
  const caseSensitive = /[A-Z]/.test(query);
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const idx = source.indexOf(needle);
  if (idx < 0) return null;
  const lines = text.slice(0, idx).split(/\r?\n/g);
  const line = lines.length;
  const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
  const lineEndRaw = text.indexOf("\n", idx);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  return {
    line,
    column: idx - lineStart + 1,
    preview: text.slice(lineStart, lineEnd),
  };
}

async function searchWithNodeFallback(baseDir: string, query: string, mode: FileSearchMode, limit: number) {
  const hits: FileSearchHit[] = [];
  let truncated = false;
  const stoppedEarly = await walkFiles(baseDir, async (absPath, relativePath) => {
    if (mode === "name") {
      if (!matchWithSmartCase(relativePath.replace(/\\/g, "/"), query) && !matchWithSmartCase(path.basename(relativePath), query)) {
        return false;
      }
      hits.push({ path: absPath, relativePath, name: path.basename(relativePath) });
      if (hits.length >= limit) {
        truncated = true;
        return true;
      }
      return false;
    }

    try {
      const st = await fs.stat(absPath);
      if (st.size > SEARCH_MAX_FILE_BYTES) return false;
      const text = await fs.readFile(absPath, "utf8");
      if (text.includes("\u0000")) return false;
      const pos = findTextPosition(text, query);
      if (!pos) return false;
      hits.push({
        path: absPath,
        relativePath,
        name: path.basename(relativePath),
        line: pos.line,
        column: pos.column,
        preview: pos.preview,
      });
      if (hits.length >= limit) {
        truncated = true;
        return true;
      }
    } catch {}
    return false;
  });

  if (mode === "name") {
    hits.sort((a, b) => {
      const sa = scoreNameMatch(a.relativePath, query);
      const sb = scoreNameMatch(b.relativePath, query);
      return (sa - sb) || (a.relativePath.length - b.relativePath.length) || a.relativePath.localeCompare(b.relativePath);
    });
  }
  if (stoppedEarly) truncated = true;
  return { hits: hits.slice(0, limit), truncated, engine: "fs" as const };
}

export async function searchFiles(
  roots: string[],
  basePath: string,
  query: string,
  mode: FileSearchMode,
  limit = 100,
): Promise<{ path: string; query: string; mode: FileSearchMode; results: FileSearchHit[]; truncated: boolean; engine: "rg" | "fs" }> {
  const realBase = await validatePathInRoots(basePath, roots);
  const st = await fs.stat(realBase);
  if (!st.isDirectory()) throw new Error("Not a directory");
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { path: realBase, query: "", mode, results: [], truncated: false, engine: "fs" };
  }
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 200));
  const rgResults = await searchWithRipgrep(realBase, trimmedQuery, mode, safeLimit);
  if (rgResults) {
    return {
      path: realBase,
      query: trimmedQuery,
      mode,
      results: rgResults.hits,
      truncated: rgResults.truncated,
      engine: rgResults.engine,
    };
  }
  const fallback = await searchWithNodeFallback(realBase, trimmedQuery, mode, safeLimit);
  return {
    path: realBase,
    query: trimmedQuery,
    mode,
    results: fallback.hits,
    truncated: fallback.truncated,
    engine: fallback.engine,
  };
}

export async function listDir(roots: string[], dirPath: string): Promise<{ path: string; entries: FsEntry[] }> {
  const realDir = await validatePathInRoots(dirPath, roots);
  const st = await fs.stat(realDir);
  if (!st.isDirectory()) throw new Error("Not a directory");

  const names = await fs.readdir(realDir);
  const entries: FsEntry[] = [];
  for (const name of names) {
    const full = path.join(realDir, name);
    try {
      const s = await fs.lstat(full);
      const type = s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
      entries.push({ name, type, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // ignore broken entries
    }
  }
  // dirs first, then files
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: realDir, entries };
}

export async function statPath(
  roots: string[],
  filePath: string,
): Promise<{ path: string; type: FsEntry["type"]; size: number; mtimeMs: number }> {
  const real = await validatePathInRoots(filePath, roots);
  const st = await fs.stat(real);
  const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  return { path: real, type, size: st.size, mtimeMs: st.mtimeMs };
}

export async function readTextFile(
  roots: string[],
  filePath: string,
  maxBytes: number,
): Promise<{ path: string; text: string; size: number; mtimeMs: number }> {
  const real = await validatePathInRoots(filePath, roots);
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size > maxBytes) throw new Error(`File too large (${st.size} bytes > ${maxBytes})`);
  const text = await fs.readFile(real, "utf8");
  return { path: real, text, size: st.size, mtimeMs: st.mtimeMs };
}

export async function writeTextFile(
  roots: string[],
  filePath: string,
  text: string,
): Promise<{ path: string; size: number; mtimeMs: number }> {
  const real = await validatePathInRoots(filePath, roots);
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, text, "utf8");
  const st = await fs.stat(real);
  return { path: real, size: st.size, mtimeMs: st.mtimeMs };
}

export async function createDir(
  roots: string[],
  dirPath: string,
): Promise<{ path: string; mtimeMs: number }> {
  const real = await validatePathInRoots(dirPath, roots);
  await fs.mkdir(real, { recursive: true });
  const st = await fs.stat(real);
  return { path: real, mtimeMs: st.mtimeMs };
}

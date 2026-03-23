import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";

type ResolveBinResult = {
  binPath: string;
  pathEnv: string;
};

export type CliRuntime = {
  binPath: string;
  pathEnv: string;
  runAs: RunAsUser | null;
  notice?: string;
};

function fileExists(targetPath: string) {
  try {
    if (process.platform === "win32") {
      return fs.existsSync(targetPath);
    }
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(binName: string, envPATH?: string): Promise<string | null> {
  try {
    const env = envPATH != null ? { ...process.env, PATH: envPATH } : process.env;
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const res = await execa(cmd, [binName], { env, timeout: 3000 });
    const lines = res.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    const match = lines[0] ?? "";
    return match && fileExists(match) ? match : null;
  } catch {
    return null;
  }
}

function uniqueStrings(items: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildHomeCandidates(home: string | undefined | null) {
  if (!home) return [];
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "AppData", "Roaming", "npm"),
  ];
}

function findInDirs(dirs: string[], exeNames: string[]) {
  for (const dir of dirs) {
    for (const exeName of exeNames) {
      const full = path.join(dir, exeName);
      if (fileExists(full)) return full;
    }
  }
  return null;
}

function findInNvm(home: string | undefined | null, exeNames: string[]) {
  if (!home) return null;
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      for (const exeName of exeNames) {
        const full = path.join(base, entry, "bin", exeName);
        if (fileExists(full)) return full;
      }
    }
  } catch {}
  return null;
}

function firstMeaningfulLine(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

async function resolveCommandFromShell(binName: string, runAs: RunAsUser | null): Promise<ResolveBinResult | null> {
  if (!runAs || process.platform === "win32") return null;
  if (typeof process.getuid !== "function") return null;

  const currentUid = process.getuid();
  const sameUser = currentUid === runAs.uid;
  if (!sameUser && currentUid !== 0) return null;

  const shellPath = runAs.shell && fileExists(runAs.shell) ? runAs.shell : "/bin/bash";
  const runuserBin = fileExists("/usr/sbin/runuser") ? "/usr/sbin/runuser" : "runuser";
  const marker = "__CODESENTINEL_PATH__=";
  const script = `command -v ${binName} || true\nprintf '${marker}%s' "$PATH"`;

  try {
    const result = sameUser
      ? await execa(shellPath, ["-lc", script], {
          timeout: 3000,
          env: buildRunAsEnv({ ...process.env }, runAs),
        })
      : await execa(runuserBin, ["-u", runAs.username, "--", shellPath, "-lc", script], {
          timeout: 3000,
          env: buildRunAsEnv({ ...process.env }, runAs),
        });
    const raw = result.stdout ?? "";
    const markerIndex = raw.lastIndexOf(marker);
    const shellEnvPath =
      markerIndex >= 0
        ? raw.slice(markerIndex + marker.length).trim()
        : (process.env.PATH ?? "");
    const commandText = markerIndex >= 0 ? raw.slice(0, markerIndex) : raw;
    const binPath = firstMeaningfulLine(commandText);
    if (!binPath || !fileExists(binPath)) return null;
    return { binPath, pathEnv: shellEnvPath };
  } catch {
    return null;
  }
}

export async function resolveCliBinary(args: {
  binName: string;
  runAs?: RunAsUser | null;
  overrideBin?: string;
  exeNames?: string[];
}): Promise<ResolveBinResult | null> {
  const explicit = String(args.overrideBin ?? "").trim();
  if (explicit && fileExists(explicit)) {
    return { binPath: explicit, pathEnv: process.env.PATH ?? "" };
  }

  const shellResolved = await resolveCommandFromShell(args.binName, args.runAs ?? null);
  if (shellResolved) return shellResolved;

  const exeNames =
    args.exeNames ??
    (process.platform === "win32"
      ? [`${args.binName}.exe`, `${args.binName}.cmd`, `${args.binName}.bat`, args.binName]
      : [args.binName]);

  const homeDirs = uniqueStrings([args.runAs?.home, process.env.HOME, process.env.USERPROFILE]);
  const extraDirs = uniqueStrings(homeDirs.flatMap(buildHomeCandidates));
  const searchPath = uniqueStrings([...extraDirs, process.env.PATH ?? ""]).join(path.delimiter);

  const resolved = await which(args.binName, searchPath);
  if (resolved) return { binPath: resolved, pathEnv: searchPath };

  const direct = findInDirs(extraDirs, exeNames);
  if (direct) return { binPath: direct, pathEnv: searchPath };

  for (const home of homeDirs) {
    const nvm = findInNvm(home, exeNames);
    if (nvm) return { binPath: nvm, pathEnv: searchPath };
  }

  return null;
}

function filteredPathEntries(pathEnv: string, runAs: RunAsUser | null) {
  const entries = pathEnv
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!runAs) return entries;
  return entries.filter((entry) => !entry.startsWith("/root/"));
}

export function buildCliPath(binPath: string, runAs: RunAsUser | null, pathEnv?: string) {
  const nvmDirs = runAs?.home
    ? (() => {
        const dirs: string[] = [];
        const base = path.join(runAs.home, ".nvm", "versions", "node");
        try {
          const entries = fs.readdirSync(base);
          for (const entry of entries) {
            dirs.push(path.join(base, entry, "bin"));
          }
        } catch {}
        return dirs;
      })()
    : [];

  return uniqueStrings([
    path.dirname(binPath),
    ...buildHomeCandidates(runAs?.home),
    ...nvmDirs,
    ...filteredPathEntries(pathEnv && pathEnv.trim() ? pathEnv : process.env.PATH ?? "", runAs),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ]).join(path.delimiter);
}

export function resolveCliSpawnCommand(binPath: string) {
  if (process.platform !== "win32") {
    return { cmd: binPath, args: [] as string[] };
  }
  const realPath = (() => {
    try {
      return fs.realpathSync(binPath);
    } catch {
      return binPath;
    }
  })();
  if (realPath.endsWith(".js") || realPath.endsWith(".cjs") || realPath.endsWith(".mjs")) {
    return { cmd: process.execPath, args: [realPath] };
  }
  return { cmd: binPath, args: [] as string[] };
}

async function probeCliRuntime(binPath: string, smokeArgs: string[], runAs: RunAsUser | null, pathEnv: string) {
  const spawn = resolveCliSpawnCommand(binPath);
  try {
    const result = await execa(spawn.cmd, [...spawn.args, ...smokeArgs], {
      stdin: "ignore",
      reject: false,
      timeout: 5000,
      env: buildRunAsEnv(
        {
          ...process.env,
          FORCE_COLOR: "0",
          CI: "1",
          PATH: buildCliPath(binPath, runAs, pathEnv),
          TERM: process.env.TERM ?? "xterm-256color",
        },
        runAs,
      ),
      uid: runAs?.uid,
      gid: runAs?.gid,
    });
    if ((result.exitCode ?? 0) === 0) return "";
    return firstMeaningfulLine(`${result.stderr ?? ""}\n${result.stdout ?? ""}`) || `exit code ${result.exitCode ?? 1}`;
  } catch (error: any) {
    return firstMeaningfulLine(error?.stderr ?? error?.stdout ?? error?.shortMessage ?? error?.message ?? String(error));
  }
}

export async function selectCliRuntime(args: {
  displayName: string;
  resolveBin: (runAs: RunAsUser | null) => Promise<ResolveBinResult | null>;
  runAs?: RunAsUser | null;
  smokeArgs?: string[];
}): Promise<CliRuntime> {
  const smokeArgs = args.smokeArgs && args.smokeArgs.length > 0 ? args.smokeArgs : ["--version"];
  const candidates: Array<RunAsUser | null> = [];
  if (args.runAs) candidates.push(args.runAs);
  candidates.push(null);

  const seen = new Set<string>();
  const failures: string[] = [];

  for (const candidate of candidates) {
    const key = candidate?.username ?? "__service__";
    if (seen.has(key)) continue;
    seen.add(key);

    const resolved = await args.resolveBin(candidate);
    if (!resolved) {
      failures.push(candidate ? `项目用户 ${candidate.username} 未找到 ${args.displayName}` : `服务进程用户未找到 ${args.displayName}`);
      continue;
    }

    const probeError = await probeCliRuntime(resolved.binPath, smokeArgs, candidate, resolved.pathEnv);
    if (!probeError) {
      return {
        ...resolved,
        runAs: candidate,
        notice:
          args.runAs && !candidate
            ? `${args.displayName} 已切换到服务进程用户运行；项目用户 ${args.runAs.username} 的安装不可用：${failures[0] ?? "启动探测失败"}`
            : undefined,
      };
    }

    failures.push(candidate ? `项目用户 ${candidate.username}: ${probeError}` : `服务进程用户: ${probeError}`);
  }

  throw new Error(`${args.displayName} 无法启动。${failures.join("；")}`);
}

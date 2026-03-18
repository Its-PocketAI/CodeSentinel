import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProjectUserRule = {
  root: string;
  username: string;
  enabled?: boolean;
};

export type RunAsUser = {
  username: string;
  uid: number;
  gid: number;
  home?: string;
  shell?: string;
};

let passwdLoaded = false;
const passwdCache = new Map<string, RunAsUser>();
const loggedOnce = new Set<string>();

function logOnce(key: string, msg: string, level: "info" | "warn" = "info") {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  if (level === "warn") {
    console.warn(msg);
  } else {
    console.log(msg);
  }
}

function loadPasswd() {
  if (passwdLoaded) return;
  passwdLoaded = true;
  if (process.platform === "win32") return;
  try {
    const raw = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const name = parts[0];
      const uid = Number(parts[2]);
      const gid = Number(parts[3]);
      const home = parts[5] || "";
      const shell = parts[6] || "";
      if (!name || !Number.isFinite(uid) || !Number.isFinite(gid)) continue;
      passwdCache.set(name, { username: name, uid, gid, home, shell });
    }
  } catch (e: any) {
    logOnce("passwd.read", `[runas] failed to read /etc/passwd: ${e?.message ?? String(e)}`, "warn");
  }
}

export function resolveRunAsUser(username: string): RunAsUser | null {
  if (!username || typeof username !== "string") return null;
  if (process.platform === "win32") return null;
  loadPasswd();
  return passwdCache.get(username) ?? null;
}

export function resolveUserHome(username: string): string | null {
  if (!username || typeof username !== "string") return null;
  if (process.platform === "win32") return null;
  try {
    const info = os.userInfo();
    if (info && info.username === username && info.homedir) return info.homedir;
  } catch {}
  const user = resolveRunAsUser(username);
  return user?.home ?? null;
}

export function canUseRunAs(user: RunAsUser): boolean {
  if (process.platform === "win32") return false;
  if (typeof process.getuid !== "function") return false;
  const uid = process.getuid();
  return uid === 0 || uid === user.uid;
}

export function buildRunAsEnv(baseEnv: Record<string, string | undefined>, user: RunAsUser | null) {
  if (!user) return { ...baseEnv };
  const env = { ...baseEnv };
  if (user.home) env.HOME = user.home;
  env.USER = user.username;
  env.LOGNAME = user.username;
  if (user.shell) env.SHELL = user.shell;
  return env;
}

function normalizePath(p: string) {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

function isUnder(root: string, target: string) {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

function isRuleAllowed(ruleRoot: string, allowedRoots: string[]) {
  for (const r of allowedRoots) {
    if (ruleRoot === r) return true;
    const prefix = r.endsWith(path.sep) ? r : r + path.sep;
    if (ruleRoot.startsWith(prefix)) return true;
  }
  return false;
}

export function resolveProjectRunAs(
  cwd: string,
  rules: ProjectUserRule[] | null | undefined,
  allowedRoots: string[],
  defaultUser?: string | null,
): RunAsUser | null {
  if (process.platform === "win32") return null;
  const normCwd = normalizePath(cwd);
  const normRoots = allowedRoots.map((r) => normalizePath(r));
  let best: ProjectUserRule | null = null;
  let bestLen = -1;
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      if (!rule.root || !rule.username) continue;
      const ruleRoot = normalizePath(rule.root);
      if (!isRuleAllowed(ruleRoot, normRoots)) continue;
      if (!isUnder(ruleRoot, normCwd)) continue;
      if (ruleRoot.length > bestLen) {
        best = rule;
        bestLen = ruleRoot.length;
      }
    }
  }
  const pickUser = (username: string, reason: string) => {
    const user = resolveRunAsUser(username);
    if (!user) {
      logOnce(`runas.missing.${username}`, `[runas] user not found: ${username} (cwd=${normCwd})`, "warn");
      return null;
    }
    if (user.username === "root") {
      logOnce("runas.root", "[runas] WARNING: running terminals as root is dangerous. Use only if you fully trust the project.", "warn");
    }
    if (!canUseRunAs(user)) {
      logOnce(`runas.denied.${username}`, `[runas] insufficient privileges to run as ${username} (cwd=${normCwd})`, "warn");
      return null;
    }
    logOnce(`runas.ok.${username}.${reason}`, `[runas] using ${username} for ${normCwd} (${reason})`);
    return user;
  };
  if (best?.username) {
    const user = pickUser(best.username, "rule");
    if (user) return user;
  }
  if (!defaultUser) return null;
  const home = resolveUserHome(defaultUser);
  if (!home) return null;
  const normHome = normalizePath(home);
  if (!isUnder(normHome, normCwd)) return null;
  return pickUser(defaultUser, "default");
}

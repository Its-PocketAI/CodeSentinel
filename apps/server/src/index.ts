import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import express from "express";
import type { Request } from "express";
import type { Response } from "express";
import cors from "cors";
import { execa } from "execa";
import Busboy from "busboy";

import { loadConfig, rootsOverridePath, readRootsOverride } from "./config.js";
import { normalizeRoots, validatePathInRoots } from "./pathGuard.js";
import { listDir, readTextFile, writeTextFile, createDir, statPath } from "./fsApi.js";
import { attachTermWs, listActiveTermSessions } from "./term/wsTerm.js";
import { getDataDir } from "./paths.js";
import { snapshotManager } from "./term/snapshotManager.js";
import { readSessionMeta } from "./term/recording.js";
import { executeCursorAgent, spawnCursorAgentStream, listCursorModels } from "./cursorAgent.js";
import { resolveProjectRunAs, resolveUserHome } from "./userRunAs.js";
import type { ChatSession, Message, Workspace } from "./db.js";

/** 延迟加载 db，避免 better-sqlite3 加载失败时整个进程在启动前崩溃，至少 /ping、/api/roots、/api/setup/check 可用 */
type DbModule = typeof import("./db.js");
let _dbModule: DbModule | null = null;
let _dbLoadError: Error | null = null;
async function getDbModule(): Promise<DbModule> {
  if (_dbModule) return _dbModule;
  if (_dbLoadError) throw _dbLoadError;
  try {
    _dbModule = await import("./db.js");
    return _dbModule;
  } catch (e) {
    _dbLoadError = e instanceof Error ? e : new Error(String(e));
    console.error("[server] db module load failed:", _dbLoadError.message);
    throw _dbLoadError;
  }
}

const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function getRepoRoot() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // apps/server/src or apps/server/dist -> repo root
  return path.resolve(__dirname, "..", "..", "..");
}

function isLoopbackReq(req: Request) {
  const ra = req.socket.remoteAddress || "";
  return (
    ra === "127.0.0.1" ||
    ra === "::1" ||
    ra === "::ffff:127.0.0.1" ||
    ra.toLowerCase() === "::ffff:7f00:1"
  );
}

/** 是否为本机请求（含 loopback 或本机 LAN IP），用于选择根目录等需在本机弹窗的接口 */
function isLocalReq(req: Request): boolean {
  if (isLoopbackReq(req)) return true;
  const ra = (req.socket.remoteAddress || "").replace(/^::ffff:/i, "");
  if (!ra) return false;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const nets = ifaces[name];
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === "IPv4" && net.address === ra) return true;
      if (net.family === "IPv6" && net.address === req.socket.remoteAddress) return true;
    }
  }
  return false;
}

function fileExists(p: string) {
  try {
    if (process.platform === "win32") return fs.existsSync(p);
    fs.accessSync(p, fs.constants.X_OK);
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

/** Windows 上 Cursor agent 常见安装目录，用于检测时扩展 PATH */
function getAgentCandidatePathsWin(): string[] {
  const dirs: string[] = [];
  const user = process.env.USERPROFILE || process.env.HOME || "";
  const local = process.env.LOCALAPPDATA || "";
  if (user) {
    dirs.push(path.join(user, ".cursor", "bin"));
    dirs.push(path.join(user, "AppData", "Local", "cursor", "bin"));
    dirs.push(path.join(user, "AppData", "Local", "Programs", "cursor", "bin"));
  }
  if (local) {
    dirs.push(path.join(local, "cursor", "bin"));
    dirs.push(path.join(local, "Programs", "cursor", "bin"));
  }
  return dirs.filter((d) => d.length > 0);
}

/** Windows 上 ripgrep (rg) 常见安装目录，winget/scoop 等安装后可能不在当前进程 PATH 中 */
function getRgCandidatePathsWin(): string[] {
  const dirs: string[] = [];
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const user = process.env.USERPROFILE || process.env.HOME || "";
  dirs.push(path.join(pf, "ripgrep"));
  dirs.push(path.join(pf86, "ripgrep"));
  if (local) {
    dirs.push(path.join(local, "Programs", "ripgrep"));
  }
  if (user) {
    dirs.push(path.join(user, "scoop", "apps", "ripgrep", "current"));
    dirs.push(path.join(user, ".cargo", "bin"));
  }
  return dirs.filter((d) => d.length > 0);
}

async function checkAgentCli() {
  try {
    const pathEnv =
      process.platform === "win32"
        ? [...getAgentCandidatePathsWin(), process.env.PATH || ""].join(path.delimiter)
        : `${process.env.HOME || ""}/.local/bin:${process.env.PATH || ""}`;
    await execa("agent", ["--version"], {
      env: { ...process.env, PATH: pathEnv },
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function checkCmdVersion(bin: string, args: string[] = ["--version"], overrideBin?: string) {
  const override = typeof overrideBin === "string" && overrideBin.trim() ? overrideBin.trim() : "";
  let p: string | null = null;
  if (override) {
    if (fileExists(override)) {
      p = override;
    } else {
      return { ok: false as const, path: override, version: null as string | null, error: "not found" };
    }
  }
  if (!p) p = await whichBin(bin);
  // Windows: 若 PATH 中未找到，尝试常见安装目录（用户安装后可能未重启服务，PATH 未更新）
  if (!p && process.platform === "win32") {
    const extraDirs = bin === "agent" ? getAgentCandidatePathsWin() : bin === "rg" ? getRgCandidatePathsWin() : [];
    const exeName = process.platform === "win32" && (bin === "agent" || bin === "rg") ? `${bin}.exe` : bin;
    if (extraDirs.length > 0) {
      const basePath = process.env.PATH || "";
      const extendedPath = [...extraDirs, basePath].join(path.delimiter);
      p = await whichBin(bin, extendedPath);
      if (!p) {
        for (const dir of extraDirs) {
          const full = path.join(dir, exeName);
          if (fileExists(full)) {
            p = full;
            break;
          }
        }
      }
    }
  }
  if (!p) return { ok: false as const, path: null as string | null, version: null as string | null, error: "not found" };
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const extraBins =
      homeDir.length > 0
        ? [
            path.join(homeDir, ".local", "bin"),
            path.join(homeDir, ".npm-global", "bin"),
            path.join(homeDir, ".local", "share", "pnpm"),
          ]
        : [];
    const unixPath = [...extraBins, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
    const pathEnv =
      process.platform === "win32" && bin === "agent"
        ? [...getAgentCandidatePathsWin(), process.env.PATH || ""].join(path.delimiter)
      : process.platform === "win32" && bin === "rg"
          ? [...getRgCandidatePathsWin(), process.env.PATH || ""].join(path.delimiter)
          : unixPath;
    const r = await execa(p, args, {
      timeout: 5000,
      env: { ...process.env, PATH: pathEnv },
    });
    const v = (r.stdout || r.stderr || "").trim();
    return { ok: true as const, path: p, version: v || null, error: null as string | null };
  } catch (e: any) {
    return { ok: false as const, path: p, version: null as string | null, error: e?.shortMessage ?? e?.message ?? String(e) };
  }
}

type SetupInstallTool = "agent" | "rg" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen";

function getInstallHint(tool: SetupInstallTool) {
  const hints = getInstallHintsByPlatform(tool);
  return process.platform === "win32" ? hints.win32 : process.platform === "darwin" ? hints.darwin : hints.linux;
}

/** 按平台返回安装说明，供前端区分 macOS / Windows / Linux 展示 */
function getInstallHintsByPlatform(tool: SetupInstallTool): { darwin: string; win32: string; linux: string } {
  if (tool === "agent") {
    return {
      darwin: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
      linux: "curl https://cursor.com/install -fsS | bash",
    };
  }
  if (tool === "rg") {
    return {
      darwin: "brew install ripgrep",
      win32: "winget install --id BurntSushi.ripgrep.MSVC -e --accept-source-agreements --accept-package-agreements",
      linux: "Install ripgrep (rg) via your package manager, e.g. apt/dnf/pacman",
    };
  }
  if (tool === "claude") {
    return {
      darwin: "curl -fsSL https://claude.ai/install.sh | bash (or: brew install --cask claude-code)",
      win32: "irm https://claude.ai/install.ps1 | iex (or: winget install Anthropic.ClaudeCode)",
      linux: "curl -fsSL https://claude.ai/install.sh | bash",
    };
  }
  if (tool === "opencode") {
    return {
      darwin: "curl -fsSL https://opencode.ai/install | bash (or: npm install -g opencode-ai)",
      win32: "npm install -g opencode-ai",
      linux: "curl -fsSL https://opencode.ai/install | bash (or: npm install -g opencode-ai)",
    };
  }
  if (tool === "gemini") {
    const cmd = "npm install -g @google/gemini-cli";
    return { darwin: cmd, win32: cmd, linux: cmd };
  }
  if (tool === "kimi") {
    return {
      darwin: "curl -LsSf https://code.kimi.com/install.sh | bash",
      win32: "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression",
      linux: "curl -LsSf https://code.kimi.com/install.sh | bash",
    };
  }
  if (tool === "qwen") {
    return {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh | bash",
      win32: "curl -fsSL -o %TEMP%\\install-qwen.bat https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat && %TEMP%\\install-qwen.bat",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh | bash",
    };
  }
  // codex (same on all platforms)
  const codexCmd = "npm i -g @openai/codex";
  return { darwin: codexCmd, win32: codexCmd, linux: codexCmd };
}

async function canAutoInstall(tool: SetupInstallTool): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (tool === "agent") {
    const hasCurl = process.platform === "win32" ? true : Boolean(await whichBin("curl"));
    const hasBash = process.platform === "win32" ? true : Boolean(await whichBin("bash"));
    if (process.platform !== "win32" && (!hasCurl || !hasBash)) {
      return { ok: false, reason: `Missing required tools for auto install: ${!hasCurl ? "curl " : ""}${!hasBash ? "bash" : ""}`.trim() };
    }
    if (process.platform === "win32") {
      const hasPs = Boolean(await whichBin("powershell"));
      if (!hasPs) return { ok: false, reason: "Missing PowerShell (powershell.exe) in PATH" };
    }
    return { ok: true };
  }

  if (tool === "rg") {
    if (process.platform === "darwin") {
      const hasBrew = Boolean(await whichBin("brew"));
      if (!hasBrew) return { ok: false, reason: "Homebrew not found (brew). Install it first or install rg manually." };
      return { ok: true };
    }
    if (process.platform === "win32") {
      const hasWinget = Boolean(await whichBin("winget"));
      if (!hasWinget) return { ok: false, reason: "winget not found. Install ripgrep manually or add winget." };
      return { ok: true };
    }
    return { ok: false, reason: "Auto install for rg is not supported on this platform in setup (distro-specific)." };
  }

  if (tool === "claude") {
    if (process.platform === "darwin") {
      const hasBrew = Boolean(await whichBin("brew"));
      if (!hasBrew) return { ok: false, reason: "Homebrew not found (brew). Install Claude Code manually." };
      return { ok: true };
    }
    if (process.platform === "win32") {
      const hasWinget = Boolean(await whichBin("winget"));
      if (!hasWinget) return { ok: false, reason: "winget not found. Install Claude Code manually." };
      return { ok: true };
    }
    const hasCurl = Boolean(await whichBin("curl"));
    const hasBash = Boolean(await whichBin("bash"));
    if (!hasCurl || !hasBash) return { ok: false, reason: "Missing curl/bash. Install Claude Code manually." };
    return { ok: true };
  }

  if (tool === "opencode") {
    const hasNpm = Boolean(await whichBin(process.platform === "win32" ? "npm.cmd" : "npm")) || Boolean(await whichBin("npm"));
    if (!hasNpm) return { ok: false, reason: "npm not found. Install Node.js (includes npm) first." };
    return { ok: true };
  }
  if (tool === "gemini") {
    const hasNpm = Boolean(await whichBin(process.platform === "win32" ? "npm.cmd" : "npm")) || Boolean(await whichBin("npm"));
    if (!hasNpm) return { ok: false, reason: "npm not found. Install Node.js (includes npm) first." };
    return { ok: true };
  }
  if (tool === "kimi") {
    if (process.platform === "win32") {
      const hasPs = Boolean(await whichBin("powershell"));
      if (!hasPs) return { ok: false, reason: "Missing PowerShell (powershell.exe) in PATH" };
      return { ok: true };
    }
    const hasCurl = Boolean(await whichBin("curl"));
    const hasBash = Boolean(await whichBin("bash"));
    if (!hasCurl || !hasBash) return { ok: false, reason: "Missing curl/bash. Install Kimi CLI manually." };
    return { ok: true };
  }
  if (tool === "qwen") {
    if (process.platform === "win32") {
      const hasCurl = Boolean(await whichBin("curl"));
      if (!hasCurl) return { ok: false, reason: "Missing curl. Install Qwen Code CLI manually." };
      return { ok: true };
    }
    const hasCurl = Boolean(await whichBin("curl"));
    const hasBash = Boolean(await whichBin("bash"));
    if (!hasCurl || !hasBash) return { ok: false, reason: "Missing curl/bash. Install Qwen Code CLI manually." };
    return { ok: true };
  }

  // codex
  const hasNpm = Boolean(await whichBin(process.platform === "win32" ? "npm.cmd" : "npm")) || Boolean(await whichBin("npm"));
  if (!hasNpm) return { ok: false, reason: "npm not found. Install Node.js (includes npm) first." };
  return { ok: true };
}

async function runAutoInstall(tool: SetupInstallTool) {
  const timeout = 10 * 60 * 1000;
  const env = {
    ...process.env,
    PATH: [path.join(process.env.HOME ?? "", ".local", "bin"), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };

  if (tool === "agent") {
    if (process.platform === "win32") {
      // Use PowerShell installer recommended by Cursor.
      const cmd = "irm 'https://cursor.com/install?win32=true' | iex";
      return await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env,
      });
    }
    const cmd = "curl https://cursor.com/install -fsS | bash";
    return await execa("bash", ["-lc", cmd], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
  }

  if (tool === "rg") {
    if (process.platform === "darwin") {
      return await execa("brew", ["install", "ripgrep"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
    }
    if (process.platform === "win32") {
      return await execa(
        "winget",
        ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e", "--accept-source-agreements", "--accept-package-agreements"],
        { timeout, maxBuffer: 10 * 1024 * 1024, env },
      );
    }
    throw new Error("Auto install for rg is not supported on this platform.");
  }

  if (tool === "claude") {
    if (process.platform === "darwin") {
      return await execa("brew", ["install", "--cask", "claude-code"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
    }
    if (process.platform === "win32") {
      return await execa("winget", ["install", "Anthropic.ClaudeCode"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
    }
    const cmd = "curl -fsSL https://claude.ai/install.sh | bash";
    return await execa("bash", ["-lc", cmd], { timeout, maxBuffer: 10 * 1024 * 1024, env });
  }

  if (tool === "opencode") {
    return await execa("npm", ["install", "-g", "opencode-ai"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
  }
  if (tool === "gemini") {
    return await execa("npm", ["install", "-g", "@google/gemini-cli"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
  }
  if (tool === "kimi") {
    if (process.platform === "win32") {
      const cmd = "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression";
      return await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env,
      });
    }
    const cmd = "curl -LsSf https://code.kimi.com/install.sh | bash";
    return await execa("bash", ["-lc", cmd], { timeout, maxBuffer: 10 * 1024 * 1024, env });
  }
  if (tool === "qwen") {
    if (process.platform === "win32") {
      const cmd = "curl -fsSL -o %TEMP%\\install-qwen.bat https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat && %TEMP%\\install-qwen.bat";
      return await execa("cmd", ["/c", cmd], { timeout, maxBuffer: 10 * 1024 * 1024, env });
    }
    const cmd = "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh | bash";
    return await execa("bash", ["-lc", cmd], { timeout, maxBuffer: 10 * 1024 * 1024, env });
  }

  // codex
  return await execa("npm", ["i", "-g", "@openai/codex"], { timeout, maxBuffer: 10 * 1024 * 1024, env });
}

async function chooseDirectoryNative(promptText: string) {
  if (process.platform === "darwin") {
    // Returns POSIX path with trailing slash. Exit code 1 on cancel.
    const script = `POSIX path of (choose folder with prompt "${promptText.replace(/"/g, '\\"')}")`;
    const r = await execa("osascript", ["-e", script], { timeout: 300000 });
    const out = String(r.stdout || "").trim();
    return out;
  }
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
      `$d.Description = "${promptText.replace(/"/g, '""')}";`,
      "$r = $d.ShowDialog();",
      "if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }",
      "Write-Output $d.SelectedPath;",
    ].join(" ");
    // -Sta: Single Thread Apartment required for System.Windows.Forms dialog to show
    const r = await execa("powershell", ["-Sta", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      timeout: 300000,
      windowsHide: false,
    });
    return String(r.stdout || "").trim();
  }
  // linux: best-effort (requires zenity)
  const r = await execa("zenity", ["--file-selection", "--directory", "--title", promptText], { timeout: 300000 });
  return String(r.stdout || "").trim();
}

async function main() {
  console.log("[server] main() started");
  const repoRoot = getRepoRoot();
  const configPath = process.env.CONFIG_PATH ?? path.join(repoRoot, "config", "config.json");
  const rootsPath = rootsOverridePath(configPath);
  const setupDonePath = path.join(path.dirname(configPath), ".setup-done");
  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try {
    cfg = await loadConfig(configPath);
  } catch (e) {
    console.error("[server] loadConfig failed:", (e as Error)?.message);
    throw e;
  }
  const authEnabled = Boolean(cfg.auth?.enabled);
  const authUsername = String(cfg.auth?.username ?? process.env.CODESENTINEL_AUTH_USERNAME ?? "admin");
  const authPassword = String(cfg.auth?.password ?? process.env.CODESENTINEL_AUTH_PASSWORD ?? "");
  const tokenTtlDays = Number(cfg.auth?.tokenTtlDays ?? 3);
  const tokenTtlMs = Math.max(1, tokenTtlDays) * 24 * 60 * 60 * 1000;
  const loginMaxAttempts = Math.max(1, Math.floor(Number(cfg.auth?.loginMaxAttempts ?? 5)));
  const loginLockMinutes = Math.max(1, Number(cfg.auth?.loginLockMinutes ?? 10));
  const loginLockMs = loginLockMinutes * 60 * 1000;
  type LoginLimiterEntry = { failures: number; lockedUntil: number; lastFailAt: number };
  const loginLimiter = new Map<string, LoginLimiterEntry>();
  const captchaEnabled = authEnabled && Boolean(cfg.auth?.captcha?.enabled ?? true);
  const captchaTtlSec = Math.max(30, Number(cfg.auth?.captcha?.ttlSec ?? 120));
  const captchaTtlMs = captchaTtlSec * 1000;
  type CaptchaEntry = { answer: string; createdAt: number; expiresAt: number };
  const captchaStore = new Map<string, CaptchaEntry>();
  let authEncEnabled = authEnabled && Boolean(cfg.auth?.encryption?.enabled ?? true);
  let authKeyPair: { publicKey: string; privateKey: string } | null = null;
  if (authEncEnabled) {
    try {
      authKeyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    } catch (e: any) {
      console.error("[auth] Failed to generate keypair:", e?.message ?? String(e));
      authEncEnabled = false;
      authKeyPair = null;
    }
  }
  const toolingBins = cfg.tooling?.bins ?? {};
  const toolingCheckArgs = cfg.tooling?.checkArgs ?? {};
  const resolveCheckArgs = (name: string, fallback: string[] = ["--version"]) => {
    const raw = toolingCheckArgs?.[name];
    return Array.isArray(raw) && raw.length > 0 ? raw : fallback;
  };
  const resolveCheckBin = (name: string) => {
    const raw = toolingBins?.[name];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const uiToolIds = new Set(["cursor", "codex", "claude", "opencode", "gemini", "kimi", "qwen", "cursor-cli", "command"]);
  const defaultUiTools = [
    { id: "cursor", enabled: true },
    { id: "codex", enabled: true },
    { id: "claude", enabled: true },
    { id: "opencode", enabled: true },
    { id: "gemini", enabled: true },
    { id: "kimi", enabled: true },
    { id: "qwen", enabled: true },
    { id: "cursor-cli", enabled: true },
    { id: "command", enabled: true },
  ];
  const normalizeUiTools = (input: unknown) => {
    if (!Array.isArray(input)) return defaultUiTools;
    const seen = new Set<string>();
    const out: { id: string; enabled: boolean }[] = [];
    for (const item of input) {
      const id = typeof (item as any)?.id === "string" ? String((item as any).id).trim() : "";
      if (!id || !uiToolIds.has(id) || seen.has(id)) continue;
      out.push({ id, enabled: Boolean((item as any)?.enabled) });
      seen.add(id);
    }
    for (const t of defaultUiTools) {
      if (!seen.has(t.id)) out.push({ ...t });
    }
    if (!out.some((t) => t.enabled)) out[0].enabled = true;
    return out;
  };

  const defaultUiState = {
    mobileTab: "terminal",
    leftPanelTab: "files",
    termMode: "cursor",
    cursorMode: "agent",
    cursorCliMode: "agent",
    editorMode: "edit",
    panelExplorerCollapsed: false,
    panelEditorCollapsed: false,
    panelTerminalCollapsed: false,
    leftWidth: 320,
    topHeight: 49,
    mobileKeysVisible: false,
    fontSize: 12,
  };

  const normalizeUiState = (input: unknown) => {
    const raw = input && typeof input === "object" ? (input as any) : {};
    const pick = <T extends string>(val: unknown, allowed: T[], fallback: T): T =>
      typeof val === "string" && (allowed as string[]).includes(val) ? (val as T) : fallback;
    const pickBool = (val: unknown, fallback: boolean) => (typeof val === "boolean" ? val : fallback);
    const pickNum = (val: unknown, fallback: number, min: number, max: number) => {
      const n = Number(val);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    return {
      mobileTab: pick(raw.mobileTab, ["explorer", "editor", "terminal", "settings"], defaultUiState.mobileTab),
      leftPanelTab: pick(raw.leftPanelTab, ["files", "settings", "windows"], defaultUiState.leftPanelTab),
      termMode: pick(raw.termMode, ["cursor", "codex", "claude", "opencode", "gemini", "kimi", "qwen", "cursor-cli", "restricted"], defaultUiState.termMode),
      cursorMode: pick(raw.cursorMode, ["agent", "plan", "ask"], defaultUiState.cursorMode),
      cursorCliMode: pick(raw.cursorCliMode, ["agent", "plan", "ask"], defaultUiState.cursorCliMode),
      editorMode: pick(raw.editorMode, ["edit", "preview"], defaultUiState.editorMode),
      panelExplorerCollapsed: pickBool(raw.panelExplorerCollapsed, defaultUiState.panelExplorerCollapsed),
      panelEditorCollapsed: pickBool(raw.panelEditorCollapsed, defaultUiState.panelEditorCollapsed),
      panelTerminalCollapsed: pickBool(raw.panelTerminalCollapsed, defaultUiState.panelTerminalCollapsed),
      leftWidth: pickNum(raw.leftWidth, defaultUiState.leftWidth, 200, 900),
      topHeight: pickNum(raw.topHeight, defaultUiState.topHeight, 20, 80),
      mobileKeysVisible: pickBool(raw.mobileKeysVisible, defaultUiState.mobileKeysVisible),
      fontSize: pickNum(raw.fontSize, defaultUiState.fontSize, 10, 18),
    };
  };

  const isRootUser = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  let defaultProjectUser = "";
  if (!isRootUser) {
    try {
      defaultProjectUser = os.userInfo().username;
    } catch {
      defaultProjectUser = process.env.USER ?? "";
    }
  } else {
    defaultProjectUser = String(process.env.CODESENTINEL_DEFAULT_USER ?? cfg.defaultProjectUser ?? "codesentinel");
  }
  if (!defaultProjectUser) {
    try {
      defaultProjectUser = os.userInfo().username;
    } catch {
      defaultProjectUser = process.env.USER ?? "";
    }
  }

  let defaultRoot = resolveUserHome(defaultProjectUser) ?? os.homedir();
  try {
    const normalizedDefault = await normalizeRoots([defaultRoot]);
    defaultRoot = normalizedDefault[0] || "";
  } catch {
    defaultRoot = "";
  }

  let roots: string[];
  try {
    roots = await normalizeRoots(cfg.roots);
  } catch (e) {
    if (!cfg.roots || cfg.roots.length === 0) {
      roots = [];
    } else {
      console.warn("[config] No valid roots from config, using process.cwd() as fallback:", (e as Error)?.message);
      const fallback = process.cwd();
      try {
        const st = await fs.promises.stat(fallback);
        roots = st.isDirectory() ? [fallback] : [path.join(fallback, "..")];
      } catch {
        roots = [path.resolve(fallback, "..")];
      }
    }
  }

  if (roots.length === 0 && defaultRoot) {
    roots = [defaultRoot];
    console.log(`[config] No roots configured; using default root: ${defaultRoot}`);
  }

  // 不阻塞启动：在后台检测 Cursor Agent CLI，避免 checkAgentCli 卡住导致服务迟迟无法监听端口
  void checkAgentCli();

  const port = Number(cfg.server?.port ?? process.env.PORT ?? 3990);
  const timeoutSec = cfg.limits?.timeoutSec ?? 900;
  const maxOutputKB = cfg.limits?.maxOutputKB ?? 1024;
  const maxSessions = cfg.limits?.maxSessions ?? 4;
  const rawTermLogMaxMB = Number(cfg.limits?.termLogMaxMB);
  const termLogMaxMB = Number.isFinite(rawTermLogMaxMB) ? Math.min(512, Math.max(0, Math.round(rawTermLogMaxMB))) : 8;
  const termLogMaxBytes = termLogMaxMB > 0 ? termLogMaxMB * 1024 * 1024 : 0;
  const rawTermScrollback = Number(cfg.limits?.termScrollback);
  const termScrollback = Number.isFinite(rawTermScrollback) ? Math.min(10000, Math.max(200, Math.round(rawTermScrollback))) : 2000;
  snapshotManager.setScrollback(termScrollback);
  const bufferDir = cfg.bufferDir ?? path.join(repoRoot, "data", "agent-buffers");
  try {
    fs.mkdirSync(bufferDir, { recursive: true });
  } catch {}

  const baseDenylist = Array.isArray(cfg.dangerousCommandDenylist) ? cfg.dangerousCommandDenylist : [];
  const baseWhitelist = cfg.commandWhitelist && typeof cfg.commandWhitelist === "object" ? cfg.commandWhitelist : {};
  const baseWhitelistKeys = Object.keys(baseWhitelist ?? {});
  const projectUserRules = Array.isArray(cfg.projectUsers)
    ? cfg.projectUsers.filter((r) => r && typeof r.root === "string" && typeof r.username === "string")
    : [];
  const resolveRunAs = (cwd: string) => resolveProjectRunAs(cwd, projectUserRules, roots, defaultProjectUser);

  const defaultCommandSettings = {
    mode: baseWhitelistKeys.length > 0 ? "allowlist" : "denylist",
    whitelist: baseWhitelistKeys,
    denylist: [],
    timeoutSec,
    maxOutputKB,
  } as const;

  const sanitizeCmdList = (input: unknown) => {
    if (!Array.isArray(input)) return [] as string[];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of input) {
      if (typeof v !== "string") continue;
      const cmd = v.trim();
      if (!cmd) continue;
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(cmd)) continue;
      const key = cmd.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cmd);
    }
    return out;
  };

  const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const normalizeCommandSettings = (input: unknown) => {
    const raw = input && typeof input === "object" ? (input as any) : {};
    const mode = raw.mode === "allowlist" ? "allowlist" : "denylist";
    const whitelist = sanitizeCmdList(raw.whitelist);
    const denylist = sanitizeCmdList(raw.denylist);
    const timeout = clampInt(raw.timeoutSec, 1, 3600, defaultCommandSettings.timeoutSec);
    const maxOut = clampInt(raw.maxOutputKB, 1, 8192, defaultCommandSettings.maxOutputKB);
    return {
      mode,
      whitelist,
      denylist,
      timeoutSec: timeout,
      maxOutputKB: maxOut,
    };
  };

  const commandRuntime = {
    whitelist: {} as Record<string, { title?: string }>,
    denylist: [] as string[],
    limits: { timeoutSec, maxOutputBytes: maxOutputKB * 1024 },
  };

  const applyCommandSettings = (settings: ReturnType<typeof normalizeCommandSettings>) => {
    commandRuntime.limits.timeoutSec = settings.timeoutSec;
    commandRuntime.limits.maxOutputBytes = settings.maxOutputKB * 1024;

    const allow = new Set(settings.mode === "allowlist" ? settings.whitelist : []);
    for (const key of Object.keys(commandRuntime.whitelist)) {
      if (!allow.has(key)) delete commandRuntime.whitelist[key];
    }
    for (const key of allow) {
      commandRuntime.whitelist[key] = {};
    }

    const deny = Array.from(new Set([...baseDenylist, ...settings.denylist]));
    commandRuntime.denylist.splice(0, commandRuntime.denylist.length, ...deny);
  };

  let commandSettings = defaultCommandSettings;
  try {
    const db = await getDbModule();
    const raw = db.getAppState("ui.command");
    if (raw) {
      try {
        commandSettings = normalizeCommandSettings(JSON.parse(raw));
      } catch {}
    }
  } catch {}
  applyCommandSettings(commandSettings);

  const app = express();
  const localHosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      const nets = ifaces[name];
      if (!nets) continue;
      for (const net of nets) {
        if (net.address) localHosts.add(net.address);
      }
    }
  } catch {}
  const allowedOrigin = (origin: string | undefined) => {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      if (localHosts.has(url.hostname)) return true;
      return false;
    } catch {
      return false;
    }
  };
  app.use(
    cors({
      origin: (origin, cb) => cb(null, allowedOrigin(origin ?? undefined)),
      credentials: false,
      exposedHeaders: ["X-Run-Id"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "10mb" }));

  const logsDir = path.join(repoRoot, "logs");
  const serverLogPath = path.join(logsDir, "server.log");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {}
  const writeServerLog = (line: string) => {
    try {
      fs.appendFileSync(serverLogPath, line + "\n");
    } catch {}
  };
  const scrubUrlToken = (rawUrl: string) => {
    try {
      const u = new URL(rawUrl, "http://localhost");
      if (u.searchParams.has("token")) u.searchParams.set("token", "***");
      return u.pathname + (u.search || "");
    } catch {
      return rawUrl;
    }
  };
  const getClientIp = (req: Request | http.IncomingMessage) => {
    const header = String((req as any).headers?.["x-forwarded-for"] ?? "");
    const ip = header ? header.split(",")[0].trim() : (req as any).socket?.remoteAddress ?? "";
    return ip || "unknown";
  };
  const pruneLoginLimiter = (now: number) => {
    if (loginLimiter.size <= 1000) return;
    for (const [ip, entry] of loginLimiter.entries()) {
      if (entry.lockedUntil <= now && now - entry.lastFailAt > loginLockMs) {
        loginLimiter.delete(ip);
      }
    }
  };
  const getLoginEntry = (ip: string) => {
    const now = Date.now();
    const existing = loginLimiter.get(ip);
    if (existing && now - existing.lastFailAt > loginLockMs && existing.lockedUntil <= now) {
      loginLimiter.delete(ip);
      return { entry: null as LoginLimiterEntry | null, now };
    }
    return { entry: existing ?? null, now };
  };
  const checkLoginLock = (ip: string) => {
    const { entry, now } = getLoginEntry(ip);
    if (!entry) return { locked: false, retryAfterSec: 0 };
    if (entry.lockedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
      return { locked: true, retryAfterSec };
    }
    return { locked: false, retryAfterSec: 0 };
  };
  const recordLoginFailure = (ip: string) => {
    const { entry, now } = getLoginEntry(ip);
    const next: LoginLimiterEntry = entry ?? { failures: 0, lockedUntil: 0, lastFailAt: now };
    next.failures += 1;
    next.lastFailAt = now;
    if (next.failures >= loginMaxAttempts) {
      next.lockedUntil = now + loginLockMs;
    }
    loginLimiter.set(ip, next);
    pruneLoginLimiter(now);
    if (next.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.max(1, Math.ceil((next.lockedUntil - now) / 1000)) };
    }
    return { locked: false, retryAfterSec: 0 };
  };
  const clearLoginLimiter = (ip: string) => {
    loginLimiter.delete(ip);
  };
  const pruneCaptchaStore = (now: number) => {
    if (captchaStore.size <= 500) return;
    for (const [id, entry] of captchaStore.entries()) {
      if (entry.expiresAt <= now) captchaStore.delete(id);
    }
  };
  const createCaptcha = () => {
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const answer = String(a + b);
    const id = crypto.randomBytes(12).toString("hex");
    const now = Date.now();
    captchaStore.set(id, { answer, createdAt: now, expiresAt: now + captchaTtlMs });
    pruneCaptchaStore(now);
    return { id, question: `${a} + ${b} = ?`, ttlSec: captchaTtlSec };
  };
  const normalizeCaptchaAnswer = (raw: unknown) => {
    const s = String(raw ?? "").trim();
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
    return s;
  };
  const verifyCaptcha = (id: string, answer: unknown) => {
    const entry = captchaStore.get(id);
    const now = Date.now();
    if (!entry) return { ok: false, error: "captcha_invalid" } as const;
    if (entry.expiresAt <= now) {
      captchaStore.delete(id);
      return { ok: false, error: "captcha_expired" } as const;
    }
    const normalized = normalizeCaptchaAnswer(answer);
    if (!normalized || normalized !== entry.answer) {
      captchaStore.delete(id);
      return { ok: false, error: "captcha_invalid" } as const;
    }
    captchaStore.delete(id);
    return { ok: true } as const;
  };
  const decodeLoginPayload = (req: Request) => {
    if (!authEncEnabled || !authKeyPair) {
      return { ok: true, data: (req.body ?? {}) as any } as const;
    }
    const payload = String(req.body?.payload ?? "");
    if (!payload) return { ok: false, error: "auth_payload_required" } as const;
    try {
      const buf = Buffer.from(payload, "base64");
      const decrypted = crypto.privateDecrypt(
        {
          key: authKeyPair.privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        buf,
      );
      const parsed = JSON.parse(decrypted.toString("utf8"));
      if (!parsed || typeof parsed !== "object") return { ok: false, error: "auth_payload_invalid" } as const;
      return { ok: true, data: parsed } as const;
    } catch {
      return { ok: false, error: "auth_payload_invalid" } as const;
    }
  };
  app.use((req, res, next) => {
    const start = Date.now();
    const startedAt = new Date().toISOString();
    const ip = getClientIp(req);
    const method = req.method;
    const url = scrubUrlToken(req.originalUrl || req.url || "");
    const ua = String(req.headers["user-agent"] ?? "").replace(/\s+/g, " ").slice(0, 200);
    res.on("finish", () => {
      const ms = Date.now() - start;
      const status = res.statusCode;
      writeServerLog(`${startedAt} ${status} ${method} ${url} ${ms}ms ip=${ip} ua=${JSON.stringify(ua)}`);
    });
    next();
  });

  const publicPaths = new Set([
    "/ping",
    "/healthz",
    "/api/auth/login",
    "/api/auth/status",
    "/api/auth/captcha",
    "/api/auth/public-key",
  ]);
  const getBearerToken = (req: Request) => {
    const header = String(req.headers.authorization ?? "");
    if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
    return "";
  };

  const verifyToken = async (token: string) => {
    if (!authEnabled) return { ok: true, expiresAt: Date.now() + tokenTtlMs } as const;
    const db = await getDbModule();
    const now = Date.now();
    try {
      db.purgeExpiredTokens(now);
    } catch {}
    const row = db.getAuthToken(token);
    if (!row) return { ok: false, error: "auth_invalid" } as const;
    if (row.expiresAt <= now) {
      db.deleteAuthToken(token);
      return { ok: false, error: "auth_expired" } as const;
    }
    const nextExpires = now + tokenTtlMs;
    db.touchAuthToken(token, now, nextExpires);
    return { ok: true, expiresAt: nextExpires } as const;
  };

  const getWsToken = (req: http.IncomingMessage) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "", `http://${host}`);
    return url.searchParams.get("token") ?? "";
  };

  app.use(async (req, res, next) => {
    if (!authEnabled) return next();
    if (req.method === "OPTIONS") return next();
    if (publicPaths.has(req.path)) return next();
    if (!req.path.startsWith("/api/")) return next();
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "auth_required" });
    try {
      const result = await verifyToken(token);
      if (!result.ok) return res.status(401).json({ ok: false, error: result.error });
      (req as any).authToken = token;
      return next();
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });


  // 方案 A：runId + 缓冲 + 重连。Map<runId, AgentRun>
  type AgentRun = {
    buffer: string[];
    listeners: Set<Response>;
    ended: boolean;
    endFrame: string | null;
    stop: () => void;
  };
  const agentRuns = new Map<string, AgentRun>();

  // 向单个 res 写一行 NDJSON（带换行）
  const writeNdjsonLine = (res: Response, line: string) => {
    try {
      res.write(line.endsWith("\n") ? line : line + "\n");
    } catch {}
  };

  // 无依赖，用于确认后端已启动（代理/前端可先请求 /ping）
  app.get("/ping", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, roots, uptimeSec: Math.floor(process.uptime()) });
  });

  app.get("/api/auth/status", async (req, res) => {
    try {
      if (!authEnabled) {
        return res.json({ ok: true, enabled: false, authenticated: true });
      }
      const token = getBearerToken(req);
      if (!token) {
        return res.json({ ok: true, enabled: true, authenticated: false });
      }
      const result = await verifyToken(token);
      if (!result.ok) {
        return res.json({ ok: true, enabled: true, authenticated: false, error: result.error });
      }
      return res.json({ ok: true, enabled: true, authenticated: true, expiresAt: result.expiresAt });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/auth/captcha", (_req, res) => {
    try {
      if (!authEnabled || !captchaEnabled) {
        return res.json({ ok: true, enabled: false });
      }
      const cap = createCaptcha();
      return res.json({ ok: true, enabled: true, id: cap.id, question: cap.question, ttlSec: cap.ttlSec });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/auth/public-key", (_req, res) => {
    try {
      if (!authEnabled || !authEncEnabled || !authKeyPair) {
        return res.json({ ok: true, enabled: false });
      }
      return res.json({ ok: true, enabled: true, publicKey: authKeyPair.publicKey, algorithm: "RSA-OAEP-256" });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      if (!authEnabled) {
        return res.json({ ok: true, enabled: false });
      }
      if (!authPassword) {
        return res.status(500).json({ ok: false, error: "auth_not_configured" });
      }
      const ip = getClientIp(req);
      const lock = checkLoginLock(ip);
      if (lock.locked) {
        return res.status(429).json({ ok: false, error: "auth_locked", retryAfterSec: lock.retryAfterSec });
      }
      const payload = decodeLoginPayload(req);
      if (!payload.ok) {
        return res.status(400).json({ ok: false, error: payload.error });
      }
      const body = payload.data ?? {};
      if (captchaEnabled) {
        const captchaId = String(body?.captchaId ?? "");
        const captchaAnswer = body?.captchaAnswer ?? "";
        if (!captchaId || captchaAnswer === "") {
          return res.status(400).json({ ok: false, error: "captcha_required" });
        }
        const result = verifyCaptcha(captchaId, captchaAnswer);
        if (!result.ok) {
          return res.status(401).json({ ok: false, error: result.error });
        }
      }
      const username = String(body?.username ?? "");
      const password = String(body?.password ?? "");
      if (!username || !password) {
        return res.status(401).json({ ok: false, error: "invalid_credentials" });
      }
      if (username !== authUsername || password !== authPassword) {
        const next = recordLoginFailure(ip);
        if (next.locked) {
          return res.status(429).json({ ok: false, error: "auth_locked", retryAfterSec: next.retryAfterSec });
        }
        return res.status(401).json({ ok: false, error: "invalid_credentials" });
      }
      clearLoginLimiter(ip);
      const token = crypto.randomBytes(24).toString("hex");
      const now = Date.now();
      const expiresAt = now + tokenTtlMs;
      const db = await getDbModule();
      db.createAuthToken(token, now, expiresAt);
      return res.json({ ok: true, enabled: true, token, expiresAt, ttlDays: tokenTtlDays });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      if (!authEnabled) return res.json({ ok: true });
      const token = (req as any).authToken ?? getBearerToken(req);
      if (token) {
        const db = await getDbModule();
        db.deleteAuthToken(token);
      }
      return res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/roots", (_req, res) => {
    try {
      res.json({ ok: true, roots: Array.isArray(roots) ? roots : [] });
    } catch (e: any) {
      console.error("[api/roots]", e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/setup/check", async (_req, res) => {
    try {
      const checkOne = async (cmd: string, args?: string[]) => {
        try {
          const resolvedArgs = args ?? resolveCheckArgs(cmd);
          const overrideBin = resolveCheckBin(cmd);
          return await checkCmdVersion(cmd, resolvedArgs, overrideBin);
        } catch (e) {
          return { ok: false as const, path: null as string | null, version: null as string | null, error: (e as Error)?.message ?? String(e) };
        }
      };
      // 避免 checkCmdVersion 内部未捕获的异常导致整次请求 500
      const tools = {
        opencode: await checkOne("opencode"),
        claude: await checkOne("claude"),
        codex: await checkOne("codex"),
        gemini: await checkOne("gemini"),
        kimi: await checkOne("kimi"),
        qwen: await checkOne("qwen"),
        cursor: await checkOne("cursor"),
        agent: await checkOne("agent"),
        rg: await checkOne("rg"),
      };

      let cursorAppPaths: string[] = [];
      try {
        if (process.platform === "darwin") {
          const home = os.homedir();
          cursorAppPaths = ["/Applications/Cursor.app", path.join(home, "Applications", "Cursor.app")].filter((p) => fs.existsSync(p));
        }
      } catch {}

      let setupDone = false;
      try {
        setupDone = fs.existsSync(setupDonePath);
      } catch {}
      if (!setupDone && Array.isArray(roots) && roots.length > 0) {
        setupDone = true;
      }

      let dbReady = false;
      let dbError: string | null = null;
      try {
        const dataDir = getDataDir();
        const dbPath = path.join(dataDir, "chat_history.db");
        const stat = fs.statSync(dbPath);
        if (stat.isFile()) {
          try {
            const db = await getDbModule();
            db.getDb();
            dbReady = true;
          } catch (e) {
            dbReady = false;
            dbError = (e as Error)?.message ?? String(e);
          }
        }
      } catch {}

      res.json({
        ok: true,
        platform: process.platform,
        configPath,
        roots,
        defaultRoot,
        setupDone,
        dbReady,
        dbError,
        tools,
        cursorAppPaths,
        installHints: {
          opencode: getInstallHintsByPlatform("opencode"),
          claude: getInstallHintsByPlatform("claude"),
          agent: getInstallHintsByPlatform("agent"),
          rg: getInstallHintsByPlatform("rg"),
          codex: getInstallHintsByPlatform("codex"),
          gemini: getInstallHintsByPlatform("gemini"),
          kimi: getInstallHintsByPlatform("kimi"),
          qwen: getInstallHintsByPlatform("qwen"),
        },
      });
    } catch (e: any) {
      console.error("[api/setup/check]", e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // 确保数据库已创建并应用 schema（安装第三步）
  app.get("/api/setup/ensure-db", async (_req, res) => {
    try {
      const db = await getDbModule();
      db.getDb();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // 完成安装：写入 .setup-done，之后可进入正式功能
  app.post("/api/setup/complete", (req, res) => {
    try {
      fs.writeFileSync(
        setupDonePath,
        JSON.stringify({ doneAt: Date.now() }) + "\n",
        "utf8",
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/setup/install", async (req, res) => {
    if (!isLocalReq(req)) return res.status(403).json({ ok: false, error: "仅允许本机访问" });
    try {
      const tool = String((req.body as any)?.tool ?? "") as SetupInstallTool;
      if (tool !== "agent" && tool !== "rg" && tool !== "codex" && tool !== "claude" && tool !== "opencode" && tool !== "gemini" && tool !== "kimi" && tool !== "qwen") {
        return res.status(400).json({ ok: false, error: "Invalid tool" });
      }

      const support = await canAutoInstall(tool);
      if (!support.ok) {
        return res.status(400).json({ ok: false, error: support.reason, hint: getInstallHint(tool) });
      }

      const r = await runAutoInstall(tool);

      const after =
        tool === "agent"
          ? await checkCmdVersion("agent", resolveCheckArgs("agent"), resolveCheckBin("agent"))
          : tool === "rg"
            ? await checkCmdVersion("rg", resolveCheckArgs("rg"), resolveCheckBin("rg"))
            : tool === "claude"
              ? await checkCmdVersion("claude", resolveCheckArgs("claude"), resolveCheckBin("claude"))
              : tool === "opencode"
                ? await checkCmdVersion("opencode", resolveCheckArgs("opencode"), resolveCheckBin("opencode"))
                : tool === "gemini"
                  ? await checkCmdVersion("gemini", resolveCheckArgs("gemini"), resolveCheckBin("gemini"))
                  : tool === "kimi"
                    ? await checkCmdVersion("kimi", resolveCheckArgs("kimi"), resolveCheckBin("kimi"))
                    : tool === "qwen"
                      ? await checkCmdVersion("qwen", resolveCheckArgs("qwen"), resolveCheckBin("qwen"))
                      : await checkCmdVersion("codex", resolveCheckArgs("codex"), resolveCheckBin("codex"));

      res.json({
        ok: true,
        tool,
        hint: getInstallHint(tool),
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: typeof r.exitCode === "number" ? r.exitCode : 0,
        after,
      });
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // 可选文件夹列表（用户主目录及其直接子目录），供前端 HTML select 选择
  app.get("/api/setup/folder-options", async (_req, res) => {
    try {
      const home = defaultRoot || os.homedir();
      const paths: string[] = [home];
      try {
        const names = await fs.promises.readdir(home, { withFileTypes: true });
        for (const e of names) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const full = path.join(home, e.name);
          try {
            const st = await fs.promises.stat(full);
            if (st.isDirectory()) paths.push(full);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* only home */
      }
      paths.sort((a, b) => a.localeCompare(b));
      res.json({ ok: true, paths });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/setup/add-root", async (req, res) => {
    if (!isLocalReq(req)) return res.status(403).json({ ok: false, error: "仅允许本机访问" });
    try {
      const rootRaw = String((req.body as any)?.root ?? "");
      const setActive = Boolean((req.body as any)?.setActive ?? true);
      if (!rootRaw) return res.status(400).json({ ok: false, error: "Missing root" });

      // Validate it's a directory and normalize.
      const norm = (await normalizeRoots([rootRaw]))[0];

      // Prefer roots override file; fall back to config.json roots if present.
      let existing = (await readRootsOverride(rootsPath)) ?? [];
      if (existing.length === 0) {
        try {
          const raw = await fs.promises.readFile(configPath, "utf8");
          const parsed = JSON.parse(raw) as any;
          if (Array.isArray(parsed?.roots)) existing = parsed.roots.map(String);
        } catch {
          /* ignore */
        }
      }
      const merged = Array.from(new Set([...existing, norm]));
      await fs.promises.mkdir(path.dirname(rootsPath), { recursive: true });
      await fs.promises.writeFile(rootsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

      // Mark setup as done (local flag file, git-ignored)
      try {
        await fs.promises.writeFile(
          setupDonePath,
          JSON.stringify({ doneAt: Date.now() }) + "\n",
          "utf8",
        );
      } catch {}

      // Refresh in-memory roots for this running server.
      roots = await normalizeRoots(merged);

      if (setActive) {
        try {
          const db = await getDbModule();
          db.setActiveRoot(norm);
        } catch {}
      }

      let activeRoot: string = norm;
      try {
        const db = await getDbModule();
        activeRoot = setActive ? norm : (db.getActiveRoot() ?? norm);
      } catch {}
      res.json({ ok: true, roots, activeRoot, configPath, rootsPath });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/app/active-root", async (_req, res) => {
    try {
      const db = await getDbModule();
      const root = db.getActiveRoot();
      res.json({ ok: true, root });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/app/active-root", async (req, res) => {
    try {
      const root = String((req.body as any)?.root ?? "");
      if (!root) return res.status(400).json({ ok: false, error: "Missing root" });
      const db = await getDbModule();
      db.setActiveRoot(root);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/ui/tools", async (_req, res) => {
    try {
      const db = await getDbModule();
      const raw = db.getAppState("ui.tools");
      if (!raw) {
        return res.json({ ok: true, tools: defaultUiTools });
      }
      try {
        const parsed = JSON.parse(raw);
        const tools = normalizeUiTools(parsed);
        return res.json({ ok: true, tools });
      } catch {
        return res.json({ ok: true, tools: defaultUiTools });
      }
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/ui/tools", async (req, res) => {
    try {
      const tools = normalizeUiTools((req.body as any)?.tools);
      const db = await getDbModule();
      db.setAppState("ui.tools", JSON.stringify(tools));
      res.json({ ok: true, tools });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/ui/command", async (_req, res) => {
    try {
      res.json({ ok: true, settings: commandSettings });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/ui/command", async (req, res) => {
    try {
      const payload = (req.body as any)?.settings ?? req.body;
      const next = normalizeCommandSettings(payload);
      const db = await getDbModule();
      db.setAppState("ui.command", JSON.stringify(next));
      commandSettings = next;
      applyCommandSettings(next);
      res.json({ ok: true, settings: next });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/ui/state", async (_req, res) => {
    try {
      const db = await getDbModule();
      const raw = db.getAppState("ui.state");
      if (!raw) {
        return res.json({ ok: true, state: defaultUiState });
      }
      try {
        const parsed = JSON.parse(raw);
        const state = normalizeUiState(parsed);
        return res.json({ ok: true, state });
      } catch {
        return res.json({ ok: true, state: defaultUiState });
      }
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/ui/state", async (req, res) => {
    try {
      const payload = (req.body as any)?.state ?? req.body;
      const state = normalizeUiState(payload);
      const db = await getDbModule();
      db.setAppState("ui.state", JSON.stringify(state));
      res.json({ ok: true, state });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/term/replay/:sessionId", (req, res) => {
    const sessionId = String(req.params.sessionId || "");
    if (!SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const tailBytes = Math.max(1024, Math.min(Number(req.query.tailBytes ?? 20000), 200000));
    const baseDir = path.join(getDataDir(), "term", sessionId);
    const stdoutPath = path.join(baseDir, "stdout");
    try {
      if (!fs.existsSync(stdoutPath)) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const stats = fs.statSync(stdoutPath);
      const size = stats.size;
      const start = Math.max(0, size - tailBytes);
      const fd = fs.openSync(stdoutPath, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(buf.toString("utf8"));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.get("/api/term/sessions", (_req, res) => {
    try {
      const limitRaw = Number(_req.query.limit ?? 50);
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200));
      const base = path.join(getDataDir(), "term");
      if (!fs.existsSync(base)) return res.json({ ok: true, sessions: [] });

      const active = listActiveTermSessions();
      const activeMap = new Map(active.map((s) => [s.sessionId, s]));
      const rows: Array<{ sessionId: string; updatedAt: number; sizeBytes: number; cwd?: string; mode?: string; active?: boolean }> = [];
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const sessionId = ent.name;
        if (!SESSION_ID_REGEX.test(sessionId)) continue;
        const stdoutPath = path.join(base, sessionId, "stdout");
        if (!fs.existsSync(stdoutPath)) continue;
        try {
          const st = fs.statSync(stdoutPath);
          const live = activeMap.get(sessionId);
          const meta = live ?? readSessionMeta(sessionId);
          rows.push({ sessionId, updatedAt: st.mtimeMs, sizeBytes: st.size, cwd: meta?.cwd, mode: meta?.mode, active: Boolean(live) });
        } catch {}
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ ok: true, sessions: rows.slice(0, limit) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.delete("/api/term/sessions/:sessionId", (req, res) => {
    const sessionId = String(req.params.sessionId || "");
    if (!SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({ ok: false, error: "invalid session id" });
      return;
    }
    try {
      const baseDir = path.join(getDataDir(), "term", sessionId);
      if (!fs.existsSync(baseDir)) {
        return res.status(404).json({ ok: false, error: "not found" });
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
      return res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/term/snapshot/:sessionId", (req, res) => {
    const sessionId = String(req.params.sessionId || "");
    if (!SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const tailBytes = Math.max(1024, Math.min(Number(req.query.tailBytes ?? 20000), 200000));
    void (async () => {
      try {
        const snap = await snapshotManager.snapshotText(sessionId);
        if (snap) {
          res.json({ ok: true, cols: snap.cols, rows: snap.rows, data: snap.text });
          return;
        }
      } catch {}

      const baseDir = path.join(getDataDir(), "term", sessionId);
      const stdoutPath = path.join(baseDir, "stdout");
      try {
        if (!fs.existsSync(stdoutPath)) {
          res.status(404).json({ error: "not found" });
          return;
        }
        const stats = fs.statSync(stdoutPath);
        const size = stats.size;
        const start = Math.max(0, size - tailBytes);
        const fd = fs.openSync(stdoutPath, "r");
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        res.json({ ok: true, data: buf.toString("utf8") });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message ?? String(e) });
      }
    })();
  });

  app.get("/api/list", async (req, res) => {
    try {
      const p = String(req.query.path ?? "");
      const r = await listDir(roots, p);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/stat", async (req, res) => {
    try {
      const p = String(req.query.path ?? "");
      const r = await statPath(roots, p);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/read", async (req, res) => {
    try {
      const p = String(req.query.path ?? "");
      const maxRaw = String(req.query.maxBytes ?? "");
      const maxReq = Number(maxRaw);
      const hardLimit = 50 * 1024 * 1024;
      const defaultLimit = 10 * 1024 * 1024;
      const maxBytes = Number.isFinite(maxReq) && maxReq > 0 ? Math.min(maxReq, hardLimit) : defaultLimit;
      const r = await readTextFile(roots, p, maxBytes);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/download", async (req, res) => {
    try {
      const p = String(req.query.path ?? "");
      const real = await validatePathInRoots(p, roots);
      const st = await fs.promises.stat(real);
      if (!st.isFile()) {
        return res.status(400).json({ ok: false, error: "Not a file" });
      }
      res.setHeader("Content-Length", String(st.size));
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(real)}"`);
      res.sendFile(real);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.delete("/api/delete", async (req, res) => {
    try {
      const p = String(req.query.path ?? "");
      const real = await validatePathInRoots(p, roots);
      if (roots.some((r) => real === r)) {
        return res.status(400).json({ ok: false, error: "Cannot delete root" });
      }
      const st = await fs.promises.stat(real);
      if (st.isDirectory()) {
        await fs.promises.rm(real, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(real);
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/write", async (req, res) => {
    try {
      const p = String(req.body?.path ?? "");
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      const r = await writeTextFile(roots, p, text);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/mkdir", async (req, res) => {
    try {
      const p = String(req.body?.path ?? "");
      const r = await createDir(roots, p);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/upload", (req, res) => {
    const queryPath = String(req.query.path ?? "");
    const bb = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 50 * 1024 * 1024 },
    });
    let targetDir = queryPath;
    let clientFileName = "";
    let hadFile = false;
    let writePromise: Promise<{ path: string; size: number; mtimeMs: number }> | null = null;
    let error: Error | null = null;

    bb.on("field", (name, value) => {
      if (name === "path" && !targetDir) targetDir = value;
      if (name === "filename") clientFileName = value;
    });

    bb.on("file", (_name, file, info) => {
      hadFile = true;
      writePromise = (async () => {
        if (!targetDir) throw new Error("Missing path");
        const realDir = await validatePathInRoots(targetDir, roots);
        const st = await fs.promises.stat(realDir);
        if (!st.isDirectory()) throw new Error("Target is not a directory");

        const safeName = path.basename(clientFileName || info.filename || "upload");
        const destPath = path.join(realDir, safeName);
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(destPath);
          file.on("limit", () => reject(new Error("File too large")));
          file.on("error", reject);
          out.on("error", reject);
          out.on("finish", resolve);
          file.pipe(out);
        });

        const saved = await fs.promises.stat(destPath);
        return { path: destPath, size: saved.size, mtimeMs: saved.mtimeMs };
      })();

      writePromise.catch((err) => {
        error = err;
        file.resume();
      });
    });

    bb.on("error", (err) => {
      error = err;
    });

    bb.on("finish", async () => {
      try {
        if (error) throw error;
        if (!hadFile || !writePromise) throw new Error("No file uploaded");
        const result = await writePromise;
        res.json({ ok: true, ...result });
      } catch (e: any) {
        res.status(400).json({ ok: false, error: e?.message ?? String(e) });
      }
    });

    req.pipe(bb);
  });

  app.get("/api/cursor-agent/models", async (_req, res) => {
    try {
      const models = await listCursorModels();
      res.json({ ok: true, models });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/cursor-agent", async (req, res) => {
    try {
      const prompt = String(req.body?.prompt ?? "");
      const mode = String(req.body?.mode ?? "agent") as "agent" | "plan" | "ask";
      const cwd = String(req.body?.cwd ?? roots[0] ?? "");
      const model = typeof req.body?.model === "string" ? String(req.body.model).trim() || undefined : undefined;

      if (!prompt.trim()) {
        return res.status(400).json({ ok: false, error: "Missing prompt" });
      }

      // Validate cwd is in roots
      const realCwd = await validatePathInRoots(cwd, roots);

      const result = await executeCursorAgent(prompt, mode, realCwd, model);
      res.json({ ok: true, result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/cursor-agent/stream", async (req, res) => {
    let runIdToClean: string | undefined;
    let runToClean: AgentRun | undefined;
    try {
      const prompt = String(req.body?.prompt ?? "");
      const mode = String(req.body?.mode ?? "agent") as "agent" | "plan" | "ask";
      const cwd = String(req.body?.cwd ?? roots[0] ?? "");
      const force = typeof req.body?.force === "boolean" ? Boolean(req.body.force) : true;
      const resume = typeof req.body?.resume === "string" ? String(req.body.resume) : "";
      const model = typeof req.body?.model === "string" ? String(req.body.model).trim() || undefined : undefined;

      if (!prompt.trim()) {
        return res.status(400).json({ ok: false, error: "Missing prompt" });
      }

      const realCwd = await validatePathInRoots(cwd, roots);

      const runId = crypto.randomUUID();
      const run: AgentRun = {
        buffer: [],
        listeners: new Set(),
        ended: false,
        endFrame: null,
        stop: () => {},
      };
      runIdToClean = runId;
      runToClean = run;
      agentRuns.set(runId, run);
      run.listeners.add(res);

      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Run-Id", runId);
      res.setHeader("X-Accel-Buffering", "no");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).flushHeaders?.();

      const broadcast = (line: string) => {
        run.buffer.push(line);
        for (const r of run.listeners) {
          writeNdjsonLine(r, line);
        }
      };

      const { stop } = await spawnCursorAgentStream({
        prompt,
        mode,
        cwd: realCwd,
        force,
        model,
        resume: resume.trim() ? resume.trim() : undefined,
        timeoutMs: timeoutSec * 1000,
        onStdoutLine: (line) => broadcast(line),
        onStderrLine: (line) => broadcast(JSON.stringify({ type: "stderr", message: line })),
        onExit: ({ code, signal, timedOut }) => {
          const endLine = JSON.stringify({ type: "result", exitCode: code, signal, timedOut });
          run.buffer.push(endLine);
          run.ended = true;
          run.endFrame = endLine;
          for (const r of run.listeners) {
            try {
              writeNdjsonLine(r, endLine);
              r.end();
            } catch {}
          }
          run.listeners.clear();
          // 保留已结束的 run 一段时间，供重连拉取全量 buffer
          setTimeout(() => agentRuns.delete(runId), 60_000);
        },
      });
      run.stop = stop;

      // 方案 A：客户端断开时只移除该连接的 listener，不杀进程
      req.on("close", () => {
        run.listeners.delete(res);
        try {
          res.end();
        } catch {}
      });
    } catch (e: any) {
      if (runIdToClean != null && runToClean != null && agentRuns.has(runIdToClean)) {
        runToClean.listeners.delete(res);
        agentRuns.delete(runIdToClean);
      }
      try {
        if (!res.headersSent) {
          return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
        }
        res.write(JSON.stringify({ type: "error", message: e?.message ?? String(e) }) + "\n");
        res.end();
      } catch {
        // ignore
      }
    }
  });

  // 方案 A：按 runId 停止（用户点击停止时调用）
  app.post("/api/cursor-agent/stream/:runId/stop", (req, res) => {
    const runId = req.params.runId;
    const run = agentRuns.get(runId);
    if (!run) {
      return res.status(404).json({ ok: false, error: "Run not found or already finished" });
    }
    try {
      run.stop();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // 方案 A：按 runId 重连，先返回已缓冲输出，再接入后续实时输出
  app.get("/api/cursor-agent/stream/:runId", async (req, res) => {
    const runId = req.params.runId;
    const run = agentRuns.get(runId);
    if (!run) {
      return res.status(404).json({ ok: false, error: "Run not found or already finished" });
    }

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Run-Id", runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).flushHeaders?.();

    if (run.ended) {
      for (const line of run.buffer) {
        writeNdjsonLine(res, line);
      }
      try {
        res.end();
      } catch {}
      return;
    }

    for (const line of run.buffer) {
      writeNdjsonLine(res, line);
    }
    run.listeners.add(res);
    req.on("close", () => {
      run.listeners.delete(res);
      try {
        res.end();
      } catch {}
    });
  });

  // ==================== 文件缓冲方案：任务独立运行，输出写文件，前端轮询读取 ====================

  type TaskRunEntry = { stop: () => void; ended: boolean };
  const taskRunStore = new Map<string, TaskRunEntry>();

  const UUID_REG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isSafeRunId(runId: string): boolean {
    return UUID_REG.test(runId) && !runId.includes("..");
  }

  app.post("/api/cursor-agent/start", async (req, res) => {
    try {
      const prompt = String(req.body?.prompt ?? "");
      const mode = String(req.body?.mode ?? "agent") as "agent" | "plan" | "ask";
      const cwd = String(req.body?.cwd ?? roots[0] ?? "");
      const force = typeof req.body?.force === "boolean" ? Boolean(req.body.force) : true;
      const resume = typeof req.body?.resume === "string" ? String(req.body.resume).trim() : "";
      const model = typeof req.body?.model === "string" ? String(req.body.model).trim() || undefined : undefined;

      if (!prompt.trim()) {
        return res.status(400).json({ ok: false, error: "Missing prompt" });
      }

      const realCwd = await validatePathInRoots(cwd, roots);

      const runId = crypto.randomUUID();
      const filePath = path.join(bufferDir, `${runId}.ndjson`);
      const writeStream = fs.createWriteStream(filePath, { flags: "a" });

      const runEntry: TaskRunEntry = { stop: () => {}, ended: false };
      taskRunStore.set(runId, runEntry);

      const writeLine = (line: string) => {
        try {
          writeStream.write(line.endsWith("\n") ? line : line + "\n");
        } catch {}
      };

      const spawnPromise = spawnCursorAgentStream({
        prompt,
        mode,
        cwd: realCwd,
        force,
        model,
        resume: resume || undefined,
        timeoutMs: timeoutSec * 1000,
        onStdoutLine: (line) => writeLine(line),
        onStderrLine: (line) => writeLine(JSON.stringify({ type: "stderr", message: line })),
        onExit: ({ code, signal, timedOut }) => {
          try {
            writeLine(JSON.stringify({ type: "result", exitCode: code, signal, timedOut }));
          } catch {}
          try {
            writeStream.end();
          } catch {}
          runEntry.ended = true;
        },
      });

      await spawnPromise.then(
        ({ stop }) => {
          runEntry.stop = stop;
        },
        (err: Error) => {
          try {
            writeLine(JSON.stringify({ type: "error", message: err?.message ?? String(err) }));
          } catch {}
          try {
            writeStream.end();
          } catch {}
          runEntry.ended = true;
          throw err;
        },
      );
      res.status(200).json({ ok: true, runId });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/cursor-agent/task/:runId/output", async (req, res) => {
    const runId = req.params.runId;
    if (!isSafeRunId(runId)) {
      return res.status(400).json({ ok: false, error: "Invalid runId" });
    }

    const filePath = path.join(bufferDir, `${runId}.ndjson`);
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

    try {
      const stat = fs.statSync(filePath);
      const size = stat.size;
      const runEntry = taskRunStore.get(runId);
      let ended = runEntry?.ended ?? false;
      if (!ended && size > 0) {
        const tailBytes = Math.min(2048, size);
        const fd = fs.openSync(filePath, "r");
        const tailBuf = Buffer.alloc(tailBytes);
        fs.readSync(fd, tailBuf, 0, tailBytes, size - tailBytes);
        fs.closeSync(fd);
        const str = tailBuf.toString("utf8");
        const lines = str.split("\n").map((s) => s.trim()).filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          try {
            const o = JSON.parse(lastLine) as { type?: string };
            if (o?.type === "result") ended = true;
          } catch {
            /* ignore */
          }
        }
        if (!ended && !runEntry && offset >= size) {
          ended = true;
        }
      }

      if (offset >= size) {
        return res.json({ ok: true, output: "", nextOffset: size, ended });
      }

      const buf: Buffer[] = [];
      const readStream = fs.createReadStream(filePath, { start: offset });
      for await (const chunk of readStream) {
        buf.push(chunk as Buffer);
      }
      const output = Buffer.concat(buf).toString("utf8");
      const nextOffset = offset + Buffer.byteLength(output, "utf8");

      res.json({ ok: true, output, nextOffset, ended });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return res.status(404).json({ ok: false, error: "Run not found or no output yet" });
      }
      res.status(500).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  app.post("/api/cursor-agent/task/:runId/stop", (req, res) => {
    const runId = req.params.runId;
    if (!isSafeRunId(runId)) {
      return res.status(400).json({ ok: false, error: "Invalid runId" });
    }

    const runEntry = taskRunStore.get(runId);
    if (!runEntry) {
      return res.status(404).json({ ok: false, error: "Run not found or already finished" });
    }

    try {
      runEntry.stop();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ==================== Chat Session APIs ====================

  // Get all sessions for a given cwd
  app.get("/api/chat/sessions", async (req, res) => {
    try {
      const db = await getDbModule();
      const cwd = String(req.query.cwd ?? "");
      if (!cwd) {
        return res.status(400).json({ ok: false, error: "Missing cwd parameter" });
      }
      const sessions = db.getAllSessions(cwd);
      res.json({ ok: true, sessions });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Get a single session by ID
  app.get("/api/chat/sessions/:id", async (req, res) => {
    try {
      const db = await getDbModule();
      const session = db.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }
      res.json({ ok: true, session });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Create a new session
  app.post("/api/chat/sessions", async (req, res) => {
    try {
      const db = await getDbModule();
      const { id, cwd, title, messages, createdAt, updatedAt } = req.body;
      if (!id || !cwd) {
        return res.status(400).json({ ok: false, error: "Missing required fields" });
      }
      const session: ChatSession = {
        id,
        cwd,
        title: title || "New Chat",
        messages: messages || [],
        createdAt: createdAt || Date.now(),
        updatedAt: updatedAt || Date.now(),
      };
      const created = db.createSession(session);
      res.json({ ok: true, session: created });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Update a session
  app.put("/api/chat/sessions/:id", async (req, res) => {
    try {
      const db = await getDbModule();
      const existing = db.getSession(req.params.id);
      if (!existing) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }
      const { title, messages, updatedAt } = req.body;
      const updated = db.updateSession({
        ...existing,
        title: title ?? existing.title,
        messages: messages ?? existing.messages,
        updatedAt: updatedAt ?? Date.now(),
      });
      res.json({ ok: true, session: updated });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Delete a session
  app.delete("/api/chat/sessions/:id", async (req, res) => {
    try {
      const db = await getDbModule();
      const deleted = db.deleteSession(req.params.id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Add a message to a session
  app.post("/api/chat/sessions/:id/messages", async (req, res) => {
    try {
      const db = await getDbModule();
      const session = db.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }
      const { id, role, content, timestamp } = req.body;
      if (!id || !role || content === undefined) {
        return res.status(400).json({ ok: false, error: "Missing required message fields" });
      }
      const message: Message = {
        id,
        role,
        content,
        timestamp: timestamp || Date.now(),
      };
      db.addMessage(req.params.id, message);
      res.json({ ok: true, message });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Update a message content
  app.patch("/api/chat/messages/:id", async (req, res) => {
    try {
      const db = await getDbModule();
      const { content } = req.body;
      if (content === undefined) {
        return res.status(400).json({ ok: false, error: "Missing content" });
      }
      db.updateMessage(req.params.id, content);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ==================== End Chat Session APIs ====================

  // ==================== Workspace APIs ====================

  // Get all workspaces
  app.get("/api/workspaces", async (_req, res) => {
    try {
      const db = await getDbModule();
      const workspaces = db.getAllWorkspaces();
      const active = db.getActiveWorkspace();
      res.json({ ok: true, workspaces, activeId: active?.id ?? null });
    } catch (e: any) {
      console.error("[api/workspaces]", e);
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Create a new workspace
  app.post("/api/workspaces", async (req, res) => {
    try {
      const db = await getDbModule();
      const { id, cwd, name, isActive } = req.body;
      if (!id || !cwd || !name) {
        return res.status(400).json({ ok: false, error: "Missing required fields" });
      }
      
      const existing = db.getWorkspaceByCwd(cwd);
      if (existing) {
        if (isActive) {
          db.setActiveWorkspace(existing.id);
        }
        return res.json({ ok: true, workspace: { ...existing, isActive: isActive ?? existing.isActive } });
      }
      
      const workspace = db.createWorkspace({
        id,
        cwd,
        name,
        isActive: isActive ?? false,
        createdAt: Date.now(),
      });
      
      if (isActive) {
        db.setActiveWorkspace(workspace.id);
      }
      
      res.json({ ok: true, workspace });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Set active workspace
  app.put("/api/workspaces/:id/active", async (req, res) => {
    try {
      const db = await getDbModule();
      db.setActiveWorkspace(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Delete a workspace
  app.delete("/api/workspaces/:id", async (req, res) => {
    try {
      const db = await getDbModule();
      const deleted = db.deleteWorkspace(req.params.id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: "Workspace not found" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ==================== End Workspace APIs ====================

  // ==================== Editor state APIs (last opened file per root) ====================

  app.get("/api/editor/last", async (req, res) => {
    try {
      const db = await getDbModule();
      const root = String(req.query.root ?? "");
      if (!root) {
        return res.status(400).json({ ok: false, error: "Missing root parameter" });
      }
      const filePath = db.getLastOpenedFile(root);
      res.json({ ok: true, filePath });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/editor/last", async (req, res) => {
    try {
      const db = await getDbModule();
      const { root, filePath } = req.body;
      if (!root || !filePath) {
        return res.status(400).json({ ok: false, error: "Missing root or filePath" });
      }
      validatePathInRoots(filePath, roots);
      db.setLastOpenedFile(root, filePath);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ==================== End Editor state APIs ====================

  // In production, optionally serve the built web app from apps/web/dist.
  const serveWeb =
    process.env.CODESENTINEL_SERVE_WEB === "1" ||
    process.env.NODE_ENV === "production";
  if (serveWeb) {
    const webDist = path.join(repoRoot, "apps", "web", "dist");
    if (fs.existsSync(webDist)) {
      app.use(express.static(webDist));
      app.get("/", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
      app.get(/.*/, (req, res, next) => {
        if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) return next();
        res.sendFile(path.join(webDist, "index.html"));
      });
      console.log(`[server] serving web from ${webDist}`);
    } else {
      console.warn(`[server] web dist not found: ${webDist}`);
    }
  }

  const server = http.createServer(app);

  attachTermWs({
    server,
    path: "/ws/term",
    whitelist: commandRuntime.whitelist,
    denylist: commandRuntime.denylist,
    maxSessions,
    limits: commandRuntime.limits,
    termLogMaxBytes,
    resolveRunAs,
    tooling: {
      bins: {
        opencode: resolveCheckBin("opencode"),
        gemini: resolveCheckBin("gemini"),
        kimi: resolveCheckBin("kimi"),
        qwen: resolveCheckBin("qwen"),
      },
    },
    authorize: authEnabled
      ? async (req) => {
          const token = getWsToken(req);
          if (!token) return { ok: false, error: "auth_required" };
          const result = await verifyToken(token);
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true };
        }
      : undefined,
    validateCwd: (cwd) => validatePathInRoots(cwd, roots),
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ 端口 ${port} 已被占用，后端启动失败。`);
      console.error(`   请运行: pnpm dev:fresh  （会先释放 3989/3990 再启动）`);
      console.error(`   或手动: netstat -ano | findstr :${port}  然后 taskkill /PID <PID> /F`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  console.log("[server] binding to port", port);
  server.listen(port, "0.0.0.0", () => {
    const networkInterfaces = os.networkInterfaces();
    const localIPs: string[] = [];
    
    for (const name of Object.keys(networkInterfaces)) {
      const nets = networkInterfaces[name];
      if (nets) {
        for (const net of nets) {
          // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
          if (net.family === "IPv4" && !net.internal) {
            localIPs.push(net.address);
          }
        }
      }
    }
    
    console.log(`✅ Server running on 0.0.0.0:${port}`);
    console.log(`   Local:   http://localhost:${port}/`);
    if (localIPs.length > 0) {
      console.log(`   Network: http://${localIPs[0]}:${port}/`);
      if (localIPs.length > 1) {
        localIPs.slice(1).forEach(ip => {
          console.log(`            http://${ip}:${port}/`);
        });
      }
    }
    console.log(`   API:     http://localhost:${port}/api/*`);
    console.log(`   WebSocket: ws://localhost:${port}/ws/term`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
    // Force close after 10 seconds
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
    // Don't exit immediately, let the server try to recover
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    // Don't exit immediately
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

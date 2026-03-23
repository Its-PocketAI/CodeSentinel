import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { appendRecording, initSessionRecording, writeSessionMeta } from "./recording.js";
import { snapshotManager } from "./snapshotManager.js";
import { buildRunAsEnv, type RunAsUser } from "../userRunAs.js";
import { loadPty, type Pty } from "./ptyLoader.js";
import { resolveTermSessionControlDir } from "./sessionPaths.js";

export type TermSend = (msg: any) => void;

type CommandPolicyMode = "allowlist" | "denylist";

type RestrictedPtySession = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: ReturnType<Pty["spawn"]>;
  stdoutPath: string;
  bytesSinceInput: number;
  outputClamped: boolean;
};

const SAFE_BASH_BUILTINS = [
  ":",
  "bg",
  "bind",
  "cd",
  "clear",
  "dirs",
  "exit",
  "fg",
  "history",
  "jobs",
  "logout",
  "popd",
  "pushd",
  "pwd",
  "set",
  "wait",
] as const;

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fileExists(p: string) {
  try {
    if (process.platform === "win32") {
      return fs.existsSync(p);
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function shellArray(items: string[]) {
  return items.map((item) => shellQuote(item)).join(" ");
}

function writeTextFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function resolveWindowsCommand(binName: string, envPATH?: string): Promise<string | null> {
  try {
    const env = envPATH != null ? { ...process.env, PATH: envPATH } : process.env;
    const res = await execa("where.exe", [binName], { env, timeout: 3000 });
    const lines = res.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

function buildBashRc(args: {
  historyPath: string;
  policyMode: CommandPolicyMode;
  whitelist: string[];
  denylist: string[];
}) {
  const allow = shellArray(args.whitelist.map((item) => item.toLowerCase()));
  const deny = shellArray(args.denylist.map((item) => item.toLowerCase()));
  const builtins = shellArray([...SAFE_BASH_BUILTINS]);
  const historyPath = shellQuote(args.historyPath);
  return `# CodeSentinel interactive PTY shell bootstrap
set +o histexpand
shopt -s checkwinsize cmdhist extdebug histappend
export HISTFILE=${historyPath}
export HISTSIZE=5000
export HISTFILESIZE=10000
export PROMPT_DIRTRIM=3

__codesentinel_mode=${shellQuote(args.policyMode)}
__codesentinel_guard=0
__codesentinel_allow=(${allow})
__codesentinel_deny=(${deny})
__codesentinel_safe_builtins=(${builtins})

__codesentinel_contains() {
  local needle="$1"
  shift || true
  local item=""
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

__codesentinel_trim_left() {
  local text="$1"
  text="\${text#"\${text%%[![:space:]]*}"}"
  printf '%s' "$text"
}

__codesentinel_shift_token() {
  local text="$1"
  local token="$2"
  text="\${text#"$token"}"
  __codesentinel_trim_left "$text"
}

__codesentinel_effective_command() {
  local raw="$1"
  local rest="$(__codesentinel_trim_left "$raw")"
  local token=""

  while [[ "$rest" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
    token="\${rest%%[[:space:];|&()<>]*}"
    rest="$(__codesentinel_shift_token "$rest" "$token")"
    [[ -n "$rest" ]] || break
  done

  token="\${rest%%[[:space:];|&()<>]*}"
  case "$token" in
    command|builtin|exec|env|nohup|sudo)
      rest="$(__codesentinel_shift_token "$rest" "$token")"
      while [[ "$rest" == -* ]]; do
        token="\${rest%%[[:space:];|&()<>]*}"
        rest="$(__codesentinel_shift_token "$rest" "$token")"
      done
      while [[ "$rest" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
        token="\${rest%%[[:space:];|&()<>]*}"
        rest="$(__codesentinel_shift_token "$rest" "$token")"
        [[ -n "$rest" ]] || break
      done
      token="\${rest%%[[:space:];|&()<>]*}"
      ;;
  esac

  token="\${token##*/}"
  printf '%s' "$token"
}

__codesentinel_ignore_token() {
  local token="$1"
  case "$token" in
    ""|"#"*|"$"|"\$"|if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function|"{"|"}"|"(("|"[[")
      return 0
      ;;
  esac
  [[ "$token" == *=* ]]
}

__codesentinel_is_allowed() {
  local cmd="$1"
  [[ -z "$cmd" ]] && return 0
  __codesentinel_contains "$cmd" "\${__codesentinel_safe_builtins[@]}" && return 0
  __codesentinel_contains "$cmd" "\${__codesentinel_allow[@]}"
}

__codesentinel_is_denied() {
  local cmd="$1"
  [[ -z "$cmd" ]] && return 1
  __codesentinel_contains "$cmd" "\${__codesentinel_deny[@]}"
}

__codesentinel_preexec() {
  if [[ \${__codesentinel_guard:-0} -eq 1 ]]; then
    return 0
  fi
  __codesentinel_guard=1
  local raw="$BASH_COMMAND"
  local cmd="$(__codesentinel_effective_command "$raw")"
  cmd="\${cmd,,}"

  if __codesentinel_ignore_token "$cmd"; then
    __codesentinel_guard=0
    return 0
  fi

  if [[ "$__codesentinel_mode" == "allowlist" ]]; then
    if ! __codesentinel_is_allowed "$cmd"; then
      printf '\\r\\n[blocked] Command not allowed: %s\\r\\n' "$cmd" >&2
      __codesentinel_guard=0
      return 1
    fi
  else
    if __codesentinel_is_denied "$cmd"; then
      printf '\\r\\n[blocked] Dangerous command: %s\\r\\n' "$cmd" >&2
      __codesentinel_guard=0
      return 1
    fi
  fi

  __codesentinel_guard=0
  return 0
}

PS1='\\w \\\$ '
printf '[session] interactive shell ready in %s\\r\\n' "$PWD"
trap '__codesentinel_preexec' DEBUG
`;
}

async function buildWindowsWrapperPath(controlDir: string, args: {
  policyMode: CommandPolicyMode;
  whitelist: string[];
  denylist: string[];
  basePath: string;
}) {
  const wrapperDir = path.join(controlDir, "bin");
  fs.mkdirSync(wrapperDir, { recursive: true });

  if (args.policyMode === "allowlist") {
    for (const cmd of args.whitelist) {
      const resolved = await resolveWindowsCommand(cmd, args.basePath);
      if (!resolved) continue;
      const wrapperPath = path.join(wrapperDir, `${cmd}.cmd`);
      writeTextFile(
        wrapperPath,
        `@echo off\r\n"${resolved.replace(/"/g, '""')}" %*\r\n`,
      );
    }
    return wrapperDir;
  }

  for (const cmd of args.denylist) {
    const wrapperPath = path.join(wrapperDir, `${cmd}.cmd`);
    writeTextFile(
      wrapperPath,
      `@echo off\r\necho [blocked] Dangerous command: ${cmd}\r\nexit /b 127\r\n`,
    );
  }
  return `${wrapperDir}${path.delimiter}${args.basePath}`;
}

async function resolveShellLaunch(args: {
  controlDir: string;
  cwd: string;
  runAs?: RunAsUser | null;
  policyMode: CommandPolicyMode;
  whitelist: string[];
  denylist: string[];
}) {
  const env = buildRunAsEnv({
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: process.env.COLORTERM ?? "truecolor",
  }, args.runAs ?? null);

  if (process.platform === "win32") {
    env.PATH = await buildWindowsWrapperPath(args.controlDir, {
      policyMode: args.policyMode,
      whitelist: args.whitelist,
      denylist: args.denylist,
      basePath: env.PATH ?? process.env.PATH ?? "",
    });
    return {
      bin: process.env.ComSpec || "cmd.exe",
      launchArgs: [] as string[],
      env,
    };
  }

  const candidates = [
    args.runAs?.shell,
    process.env.SHELL,
    "/bin/bash",
    "/usr/bin/bash",
  ].filter((item): item is string => Boolean(item));

  let bashPath = "";
  for (const candidate of candidates) {
    if (fileExists(candidate) && path.basename(candidate).toLowerCase().includes("bash")) {
      bashPath = candidate;
      break;
    }
  }
  if (!bashPath) {
    for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
      if (fileExists(candidate)) {
        bashPath = candidate;
        break;
      }
    }
  }

  if (bashPath) {
    const rcPath = path.join(args.controlDir, "bashrc");
    const historyPath = path.join(args.controlDir, "history");
    writeTextFile(
      rcPath,
      buildBashRc({
        historyPath,
        policyMode: args.policyMode,
        whitelist: args.whitelist,
        denylist: args.denylist,
      }),
    );
    return {
      bin: bashPath,
      launchArgs: ["--noprofile", "--rcfile", rcPath, "-i"],
      env,
    };
  }

  const shell = (args.runAs?.shell && fileExists(args.runAs.shell) && args.runAs.shell) ||
    (process.env.SHELL && fileExists(process.env.SHELL) && process.env.SHELL) ||
    "/bin/sh";
  return {
    bin: shell,
    launchArgs: ["-i"],
    env,
  };
}

export class PtyRestrictedManager {
  private sessions = new Map<string, RestrictedPtySession>();

  constructor(
    private opts: {
      maxSessions: number;
      validateCwd: (cwd: string) => Promise<string>;
      send: TermSend;
      termLogMaxBytes?: number;
      maxOutputBytes?: () => number;
      policyMode: () => CommandPolicyMode;
      whitelist: () => string[];
      denylist: () => string[];
    },
  ) {}

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  async open(cwd: string, cols = 120, rows = 30, runAs?: RunAsUser | null) {
    if (this.sessions.size >= this.opts.maxSessions) throw new Error("Too many sessions");
    const realCwd = await this.opts.validateCwd(cwd);
    const sessionId = `r_${randomId()}`;
    const controlDir = resolveTermSessionControlDir(sessionId, runAs ?? null);
    const shellLaunch = await resolveShellLaunch({
      controlDir,
      cwd: realCwd,
      runAs: runAs ?? null,
      policyMode: this.opts.policyMode(),
      whitelist: this.opts.whitelist(),
      denylist: this.opts.denylist(),
    });

    const { pty, spawnOptions } = await loadPty();
    const term = pty.spawn(shellLaunch.bin, shellLaunch.launchArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: realCwd,
      ...spawnOptions,
      env: shellLaunch.env,
      uid: runAs?.uid,
      gid: runAs?.gid,
    });

    const stdoutPath = initSessionRecording(sessionId);
    writeSessionMeta(sessionId, { cwd: realCwd, mode: "restricted-pty", controlDir });
    await snapshotManager.create(sessionId, cols, rows);

    const s: RestrictedPtySession = {
      id: sessionId,
      cwd: realCwd,
      cols,
      rows,
      pty: term,
      stdoutPath,
      bytesSinceInput: 0,
      outputClamped: false,
    };
    this.sessions.set(sessionId, s);

    term.onData((chunk: string) => {
      const limit = Math.max(0, this.opts.maxOutputBytes?.() ?? 0);
      let text = chunk;
      let justClamped = false;

      if (limit > 0 && !s.outputClamped) {
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        const nextBytes = s.bytesSinceInput + chunkBytes;
        if (nextBytes > limit) {
          const allowed = Math.max(0, limit - s.bytesSinceInput);
          text = allowed > 0 ? Buffer.from(chunk, "utf8").subarray(0, allowed).toString("utf8") : "";
          s.bytesSinceInput = limit;
          s.outputClamped = true;
          justClamped = true;
        } else {
          s.bytesSinceInput = nextBytes;
        }
      }

      if (text) {
        appendRecording(stdoutPath, text, this.opts.termLogMaxBytes);
        snapshotManager.write(sessionId, text);
        this.opts.send({ t: "term.data", sessionId, data: text });
      }

      if (justClamped) {
        const msg = "\r\n[truncated] output exceeded limit; sent Ctrl+C to interrupt\r\n";
        appendRecording(stdoutPath, msg, this.opts.termLogMaxBytes);
        snapshotManager.write(sessionId, msg);
        this.opts.send({ t: "term.data", sessionId, data: msg });
        try {
          s.pty.write("\u0003");
        } catch {}
      }
    });
    term.onExit((e: any) => {
      this.sessions.delete(sessionId);
      snapshotManager.dispose(sessionId);
      this.opts.send({ t: "term.exit", sessionId, code: e?.exitCode ?? 0, signal: e?.signal });
    });

    return s;
  }

  close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    snapshotManager.dispose(sessionId);
    try {
      s.pty.kill();
    } catch {}
  }

  resize(sessionId: string, cols: number, rows: number) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    try {
      s.pty.resize(cols, rows);
    } catch {}
    snapshotManager.resize(sessionId, cols, rows);
  }

  stdin(sessionId: string, data: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session");
    s.bytesSinceInput = 0;
    s.outputClamped = false;
    s.pty.write(data);
  }
}

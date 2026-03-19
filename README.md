# CodeSentinel (DingMaXia)

<p align="center">
  <strong>Mobile-first, self-hosted AI coding cockpit for secure terminal workflows.</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文</a> ·
  <a href="#install-recommended">Install</a> ·
  <a href="#linux-manual-install">Linux Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#developer-mode-from-source">Developer Mode</a> ·
  <a href="#one-click-deploy-installsh--bash">One-Click Deploy</a> ·
  <a href="#terminal-run-user-linux">Run-As User</a>
</p>

<p align="center">
  <img alt="Node 18+" src="https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img alt="pnpm 10+" src="https://img.shields.io/badge/pnpm-10%2B-F69220?style=for-the-badge&logo=pnpm&logoColor=white" />
  <img alt="Platform Linux/macOS/WSL" src="https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20WSL-111827?style=for-the-badge" />
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-2563EB?style=for-the-badge" />
</p>

CodeSentinel is a local-first Web IDE for secure project operations: file explorer, editor, and terminal sessions with multiple AI agents (Cursor CLI, Codex, Claude, OpenCode, Gemini, Kimi, Qwen).  
It is optimized for mobile + desktop, and designed for persistent terminal workflows with strict safety controls.

## Install (Recommended)

### One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash
```

What it does:
- Checks Node.js and pnpm.
- Clones/updates the repository to `~/CodeSentinel` by default.
- Installs dependencies.
- Bootstraps `config/config.json` from `config/config.example.json` (if missing).
- Starts production service (`./run/prod-start.sh`) by default.

### Custom install directory / no auto-start

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  CODESENTINEL_DIR=/opt/data/CodeSentinal CODESENTINEL_START=0 bash
```

Available env vars:
- `CODESENTINEL_REPO` (default: `https://github.com/Its-PocketAI/CodeSentinel.git`)
- `CODESENTINEL_BRANCH` (default: `main`)
- `CODESENTINEL_DIR` (default: `~/CodeSentinel`)
- `CODESENTINEL_START` (`1` auto-start, `0` skip start)

<a id="linux-manual-install"></a>
## Linux Install (Manual)

### 1) Prerequisites

- Git, curl, build tools
- Node.js `>= 18`
- pnpm `>= 10` (via Corepack recommended)

Example (Ubuntu/Debian):

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential
corepack enable
corepack prepare pnpm@10.4.0 --activate
```

### 2) Install and Start

```bash
git clone https://github.com/Its-PocketAI/CodeSentinel.git /opt/data/CodeSentinal
cd /opt/data/CodeSentinal
pnpm install
cp config/config.example.json config/config.json
./run/prod-start.sh
```

### 3) Stop / Restart

```bash
cd /opt/data/CodeSentinal
./run/prod-stop.sh
./run/prod-start.sh
```

## Quick Start

After install:

```bash
cd ~/CodeSentinel
./run/prod-start.sh
```

Open:
- Web: `http://localhost:3990/`
- First setup: `http://localhost:3990/#/setup`
- Health: `http://localhost:3990/healthz`

Stop service:

```bash
./run/prod-stop.sh
```

## Developer Mode (From Source)

```bash
git clone https://github.com/Its-PocketAI/CodeSentinel.git
cd CodeSentinel
pnpm install
pnpm dev
```

Dev endpoints:
- Web: `http://localhost:3989/`
- API: `http://localhost:3990/`

Useful scripts:
- `pnpm dev` full stack
- `pnpm dev:server` server only
- `pnpm dev:web` web + protocol
- `pnpm dev:fresh` free occupied ports and restart dev
- `./run/dev-start.sh` / `./run/dev-stop.sh` background dev mode

## One-Click Deploy (`install.sh | bash`)

For a clean Linux server bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  CODESENTINEL_DIR=/opt/data/CodeSentinal bash
```

Then use:

```bash
cd /opt/data/CodeSentinal
./run/prod-start.sh
./run/prod-stop.sh
```

## Architecture (Short)

```text
Browser (Web UI)
   |  HTTP / WS
   v
CodeSentinel Server (3990)
   |-- File API / Auth / Setup
   |-- Terminal sessions (PTY + restricted exec)
   |-- SQLite (chat / UI state / settings)
```

## Core Capabilities

- Local file explorer + editor with large-file open guard.
- Multi-agent terminal modes: Restricted / Codex / Claude / OpenCode / Gemini / Kimi / Qwen / Cursor CLI.
- Persistent terminal sessions across refresh/reconnect.
- Session idle TTL auto cleanup (default 12h).
- Mobile terminal controls (direction keys, Enter, Ask Image, Ctrl+C/Z, Tab, Shift+Enter, Alt+Enter).
- Agent-specific quick keys auto-switch while base keys stay available.
- Built-in auth: password + token, login rate limit, captcha, encrypted login payload.
- Optional per-project Linux run-as user for terminal execution.

## Security Defaults

- Restricted mode executes commands with server-side allowlist/denylist policy (no PTY bypass).
- Auth supports:
  - `auth.tokenTtlDays`
  - `auth.loginMaxAttempts`
  - `auth.loginLockMinutes`
  - captcha and encrypted login payload
- Do not expose directly to public internet without firewall/reverse proxy.

## Configuration

Bootstrap:

```bash
cp config/config.example.json config/config.json
```

Config precedence:
1. `config/config.json`
2. `config/config.local.json`
3. `config/roots.local.json` (or `CODESENTINEL_ROOTS_FILE`)
4. `CODESENTINEL_ROOTS`

Important fields:
- `server.port` (default `3990`)
- `limits.termSessionIdleHours` (`1..168`, default `12`)
- `tooling.bins.*` and `tooling.checkArgs.*`
- `defaultProjectUser`, `projectUsers[]` (Linux run-as model)

<a id="terminal-run-user-linux"></a>
## Terminal Run User (Linux)

Actual behavior of `./run/prod-start.sh` and `./run/dev-start.sh`:

| Startup identity | Terminal default user | Auto-create user | `projectUsers[]` behavior |
| --- | --- | --- | --- |
| Start as `root` | `CODESENTINEL_DEFAULT_USER` -> `config.defaultProjectUser` -> `codesentinel` | Yes (except when target is `root`) | Effective when target user exists and has permission |
| Start as non-root | Current OS login user (`$USER`) | No | Cannot elevate; rules requiring other users are ignored |

Notes:
- Root mode supports dedicated per-project users and can create the default user automatically.
- Non-root mode stays in the current user context (recommended for local development).
- If `roots` is empty, CodeSentinel defaults to that runtime user's home directory as initial project root.

## Mobile UX Notes

- D-pad keys do not auto-open system keyboard.
- Use `⌨️` button when manual typing is needed.
- `🖼️ Ask Image` uploads to `./.codesentinel/uploaded_pictures` and inserts:
  `@./.codesentinel/uploaded_pictures/<filename>`.
- Long-press key buttons to show key-hint bubbles.
- Header `Keymap` button shows official key references by selected agent.

## Windows / WSL

WSL is recommended for best compatibility (PTY, terminal behavior, path handling).

PowerShell scripts are included:

```powershell
.\run\dev-start.ps1
.\run\dev-stop.ps1
.\run\prod-start.ps1
.\run\prod-stop.ps1
```

For Linux scripts, use:

```bash
./run/dev-start.sh
./run/dev-stop.sh
./run/prod-start.sh
./run/prod-stop.sh
```

## Reverse Proxy (Optional)

Nginx example:
- `nginx/codesentinel.conf`

It proxies `/api` and `/ws/term` and serves frontend assets.

## Troubleshooting

- `3990` refused: run `./run/prod-start.sh` or `pnpm dev:server`
- `500` with server running: check `logs/server.log` / `logs/prod.log`
- ports occupied: `pnpm dev:fresh`
- CLI not found in service: configure `tooling.bins.<tool>` or service PATH
- OpenCode path issue: set `OPENCODE_BIN=/absolute/path/to/opencode`

## Acknowledgements

CodeSentinel is inspired by and references:
- https://github.com/ls2046/vibe-go

## License

MIT License. See [LICENSE](./LICENSE).

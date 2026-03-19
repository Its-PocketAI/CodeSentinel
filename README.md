# CodeSentinel

**Language**: English | [中文](./README.zh-CN.md)

CodeSentinel is a local-first Web IDE for secure project operations: file tree + editor + restricted terminal, with Cursor CLI (`agent`), Codex CLI, Claude Code CLI (`claude`), OpenCode CLI (`opencode`), Gemini CLI (`gemini`), Kimi CLI (`kimi`), and Qwen Code CLI (`qwen`) integration.

---

## Highlights

- Local file tree and editor, safe by default.
- Restricted terminal modes (Restricted / Codex / Claude / OpenCode / Gemini / Kimi / Qwen / Cursor).
- Restricted mode is strict server-side command execution (allowlist/denylist enforced, no PTY bypass).
- Terminal sessions persist across page refresh/reconnect and auto-expire by idle TTL (default 12h).
- Frontend/Backend separated, clear dev ports.
- Built-in auth (password + token), rate limit, captcha, encrypted login payload.
- Optional per-project Linux run-as user.
- One-click production start/stop scripts.

---

## Design Principles

- Local-first: no external service required for core workflows.
- Least-privilege: terminals run in restricted mode by default.
- Deterministic ops: explicit roots, explicit ports, explicit startup.
- Observability: structured logs, reproducible setup.

---

## Architecture

```
Browser (Web UI)
   |
   |  HTTP / WS
   v
CodeSentinel Server (3990)
   |-- File ops / API / Auth
   |-- PTY + CLI integration
   |-- SQLite (chat / UI state)
```

---

## Quick Start (Dev)

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:3989/`
- First-time setup: `http://localhost:3989/#/setup`

Windows note: WSL is recommended for best compatibility (PTY, CLI tools, and filesystem paths).

---

## Windows (PowerShell)

Prereqs: Node.js 18+ and pnpm in PATH.

Dev (background):
```powershell
.\run\dev-start.ps1
.\run\dev-stop.ps1
```

Prod:
```powershell
.\run\prod-start.ps1
.\run\prod-stop.ps1
```

Notes:
- Root paths accept `C:\\Users\\...` or `C:/Users/...`.
- Terminal sessions run under the current Windows user.

Run in background (optional):
```bash
./run/dev-start.sh
./run/dev-stop.sh
```

Logs:
- `logs/dev.log`
- `logs/server.log`

---

## Mobile Usage

- The on-screen terminal keys (Up/Down/Left/Right/Enter) do not auto-open the OS keyboard.
- Tap the ⌨️ button to open the keyboard when you need to type.
- The 🖼️ Ask Image button (second row) uploads to `./.codesentinel/uploaded_pictures` under the current project root
  and inserts `@./.codesentinel/uploaded_pictures/<filename>` into the terminal input.

---

## Preferences

- Settings → Preferences: adjust global font size (+ / -) and reset to default.

---

## Production (Recommended)

One-click:
```bash
./run/prod-start.sh
./run/prod-stop.sh
```

Access:
- Web: `http://<host>:3990/`
- Health: `http://<host>:3990/healthz`

Logs:
- `logs/prod.log`
- `logs/server.log`

Notes:
- `prod-start` runs `pnpm build`, then starts the server in production mode.
- Production serves the built frontend when `CODESENTINEL_SERVE_WEB=1` and `NODE_ENV=production` are set.

---

## Configuration

Bootstrap:
```bash
cp config/config.example.json config/config.json
```

Config precedence:
1. `config/config.json`
2. `config/config.local.json` (optional override)
3. `config/roots.local.json` (roots override, or `CODESENTINEL_ROOTS_FILE`)
4. `CODESENTINEL_ROOTS` (highest priority)

Roots:
```json
["/path/to/workspace"]
```

Notes:
- Format can be either `["/path/a", "/path/b"]` or `{ "roots": ["/path/a"] }`.
- Override file path via `CODESENTINEL_ROOTS_FILE=/abs/path/to/roots.json`.
- Or via env:
  ```bash
  CODESENTINEL_ROOTS='["/path/a","/path/b"]' pnpm dev
  ```
- If no roots are configured, CodeSentinel uses the default user’s home directory as a root.
- Local config files are git-ignored: `config/config.json`, `config/config.local.json`, `config/roots.local.json`, `config/.setup-done`.

Ports:
- Backend: `config.server.port` or `PORT` (default 3990)
- Frontend dev port: `VITE_PORT` (default 3989)
- Frontend API base: `VITE_API_BASE` (LAN/proxy)

Tooling detection:
- `tooling.bins.<tool>`: override CLI binary path (e.g. `tooling.bins.opencode`).
- `tooling.checkArgs.<tool>`: override version check args (e.g. `["--version"]`).

Terminal policy:
- `limits.termSessionIdleHours`: idle session auto-close TTL in hours (default `12`, range `1..168`).
- UI path: `Settings -> Terminal Safety Policy -> Session idle expiry (hours)`.
- Restricted mode commands are always validated server-side using allowlist/denylist policy.

---

## Auth & Security

Configure in `config/config.json`:
- `auth.enabled`, `auth.username`, `auth.password`
- `auth.tokenTtlDays` (default 3 days)
- `auth.loginMaxAttempts` (default 5)
- `auth.loginLockMinutes` (default 10)
- `auth.captcha.enabled` + `auth.captcha.ttlSec`
- `auth.encryption.enabled`

Notes:
- Token auto-refreshes on active use, expires after inactivity.
- Do not expose this service to the public internet without auth + firewall.

---

## Project Run-As User (Linux)

Run terminals under a specific Linux user per project (root required):
```json
{
  "defaultProjectUser": "codesentinel",
  "projectUsers": [
    { "root": "/path/to/project", "username": "codesentinel", "enabled": true }
  ]
}
```

Behavior:
- Longest matching `root` wins.
- Rule only applies when `root` is under an allowed root.
- If the service is not root, it falls back to the current user.
- You can override with `CODESENTINEL_DEFAULT_USER`.
- `run/dev-start.sh` and `run/prod-start.sh` auto-create `defaultProjectUser` when running as root.

---

## CLI Tools (Optional)

Recommended tools:
- Cursor CLI (`agent`)
- Ripgrep (`rg`)
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)
- OpenCode CLI (`opencode`)
- Gemini CLI (`gemini`)
- Kimi CLI (`kimi`)
- Qwen Code CLI (`qwen`)

Examples:
```bash
curl https://cursor.com/install -fsS | bash
agent --version

npm i -g @openai/codex
codex --version

curl -fsSL https://claude.ai/install.sh | bash
claude --version

curl -fsSL https://opencode.ai/install | bash
opencode --version

npm install -g @google/gemini-cli
gemini --version

curl -LsSf https://code.kimi.com/install.sh | bash
kimi --version

curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh | bash
qwen --version
```

---

## Reverse Proxy (Optional)

An Nginx example is provided at [nginx/codesentinel.conf](./nginx/codesentinel.conf).  
It proxies `/api` and `/ws/term` to the backend and serves the built frontend.

---

## Troubleshooting

- 3990 connection refused: backend not running, try `pnpm dev:server` or `./run/prod-start.sh`
- 500 with backend up: check `logs/server.log` or `logs/prod.log`
- Ports 3989/3990 in use: run `pnpm dev:fresh`
- CLI not found: check PATH, use `where.exe` on Windows
- OpenCode found locally but not in server: set `OPENCODE_BIN=/absolute/path/to/opencode` or ensure the service user’s PATH includes the bin dir

---

## Acknowledgements

This project is inspired by and references the open-source project:  
https://github.com/ls2046/vibe-go

---

## License

MIT License. See [LICENSE](./LICENSE).

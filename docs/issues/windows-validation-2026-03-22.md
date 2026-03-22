# Windows Validation Report

Date: 2026-03-22
Branch: `fix/windows-powershell-runner`
Repo: `E:\program_code\auto-controller`

## Scope

Validated on native Windows PowerShell only.

- Install dependencies
- Configure local auth and service port
- Verify `run/dev-start.ps1`
- Verify `run/dev-stop.ps1`
- Verify `run/prod-start.ps1`
- Verify `run/prod-stop.ps1`
- Verify `run/update.ps1`
- Verify login, HTTP API, WebSocket terminal, native shell command sending, and CodeSentinel `codex` mode command sending

## Fixed

### 1. PowerShell start scripts failed immediately on Windows

Symptom:

- `run/dev-start.ps1` and `run/prod-start.ps1` used `Start-Process` with `RedirectStandardOutput` and `RedirectStandardError` pointed at the same file.
- Windows PowerShell rejects that combination and the scripts exited before the app started.

Fix:

- Replaced direct `pnpm` launch with a background PowerShell runner using `-EncodedCommand`.
- Combined output through PowerShell redirection instead of `Start-Process` dual-file redirection.

Files:

- `run/dev-start.ps1`
- `run/prod-start.ps1`

### 2. PID handling was broken by PowerShell's built-in `$PID`

Symptom:

- The scripts used `$pid` as a normal variable.
- PowerShell treats `$PID` case-insensitively and it is read-only.
- This caused stale PID behavior and false "Already running" messages.

Fix:

- Renamed script-local PID variables to `$procId`.

Files:

- `run/dev-start.ps1`
- `run/prod-start.ps1`
- `run/dev-stop.ps1`
- `run/prod-stop.ps1`

### 3. Stop scripts could leave child processes behind

Symptom:

- Killing only the parent process is not reliable on Windows when `pnpm` spawns child `node` processes.

Fix:

- Switched Windows stop behavior to `taskkill /T /F` so the whole process tree is terminated.

Files:

- `run/dev-stop.ps1`
- `run/prod-stop.ps1`

### 4. Dev mode assumed backend port `3990`

Symptom:

- `scripts/start-server-first.js` hardcoded port `3990`.
- On this machine, WSL already had another validated instance on `3990`.
- Windows dev mode collided with the Linux/WSL instance.

Fix:

- `run/dev-start.ps1` now reads `config/config.json` and exports the configured backend port into the dev environment.
- It also sets `VITE_API_BASE` and `VITE_WS_BASE` so the dev frontend points at the configured Windows backend.
- `scripts/start-server-first.js` now reads `PORT` / `CODESENTINEL_PORT` instead of hardcoding `3990`.

Files:

- `run/dev-start.ps1`
- `scripts/start-server-first.js`

### 5. `better-sqlite3` native binding was missing on Windows

Symptom:

- Server boot looked healthy, but login failed with `Database init failed`.
- Root cause was missing `better_sqlite3.node`.

Fix:

- Added `run/windows-ensure-native.ps1`.
- Startup scripts now verify `better-sqlite3` before launching the service.
- If missing, the script rebuilds it in place with `npm run install --verbose`.

Files:

- `run/windows-ensure-native.ps1`
- `run/dev-start.ps1`
- `run/prod-start.ps1`

## Current Limitation

### `node-pty` interactive Windows PTY is not fully available on this machine

Symptom:

- CodeSentinel can load `@homebridge/node-pty-prebuilt-multiarch`, but `conpty.node` is missing.
- `codex` PTY therefore cannot start in full interactive mode.
- The app falls back to non-PTY exec mode and still works for command sending.

Observed blockers:

- Official prebuilt download for `node-pty-prebuilt-multiarch` timed out from GitHub.
- Source build requires additional Visual Studio Spectre-mitigated libraries that are not installed on this Windows machine.

Current handling:

- `run/windows-ensure-native.ps1` warns clearly about the missing PTY binary.
- CodeSentinel still works because server-side codex terminal fallback (`codex exec`) is already implemented and was validated successfully.

## Validation Result

Windows validation passed with one documented limitation:

- Native shell command sending: passed
- Auth login flow: passed
- WebSocket terminal open/send/close: passed
- CodeSentinel `codex` mode send instruction and receive answer: passed
- Full Windows PTY-backed codex session: not available on this machine; fallback exec mode used instead


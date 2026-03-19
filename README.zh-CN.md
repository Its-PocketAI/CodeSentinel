# CodeSentinel（盯码侠）

**语言**：中文 | [English](./README.md)

CodeSentinel 是一款本机优先的 Web IDE：目录树 + 编辑器 + 受限终端，并集成 Cursor CLI（`agent`）、Codex CLI、Claude Code CLI（`claude`）、OpenCode CLI（`opencode`）、Gemini CLI（`gemini`）、Kimi CLI（`kimi`）与 Qwen Code CLI（`qwen`）。

---

## 主要特性

- 本地文件树与编辑器，默认安全访问。
- 受限终端模式（受限 / Codex / Claude / OpenCode / Gemini / Kimi / Qwen / Cursor）。
- 受限模式为后端严格执行（allowlist/denylist 生效，不走 PTY 绕过）。
- 终端会话支持刷新/重连后恢复，空闲超时自动关闭（默认 12 小时）。
- 前后端分离，开发端口清晰。
- 内置登录（密码 + Token）、失败锁定、验证码与加密传输。
- Linux 可按项目指定终端运行用户。
- 一键生产启动脚本。

---

## 设计原则

- 本机优先：核心流程无需外部服务。
- 最小权限：终端默认受限模式运行。
- 可控可复现：明确 roots、端口与启动流程。
- 可观测：日志与安装路径清晰可追踪。

---

## 架构

```
浏览器（Web UI）
   |
   |  HTTP / WS
   v
CodeSentinel Server (3990)
   |-- 文件操作 / API / 登录
   |-- PTY + CLI 集成
   |-- SQLite（聊天 / UI 状态）
```

---

## 快速开始（开发）

```bash
pnpm install
pnpm dev
```

- Web：`http://localhost:3989/`
- 首次安装：`http://localhost:3989/#/setup`

Windows 建议：推荐使用 WSL 运行以获得更好的兼容性（PTY、CLI 工具与路径处理）。

---

## Windows（PowerShell）

前置：Node.js 18+ 与 pnpm 已加入 PATH。

开发（后台）：
```powershell
.\run\dev-start.ps1
.\run\dev-stop.ps1
```

生产：
```powershell
.\run\prod-start.ps1
.\run\prod-stop.ps1
```

说明：
- 根目录路径可使用 `C:\\Users\\...` 或 `C:/Users/...`。
- 终端会话以当前 Windows 用户运行。

后台启动（可选）：
```bash
./run/dev-start.sh
./run/dev-stop.sh
```

日志：
- `logs/dev.log`
- `logs/server.log`

---

## 移动端使用

- 终端上的方向键（Up/Down/Left/Right/Enter）不会自动唤起系统键盘。
- 需要输入时请点击 ⌨️ 按钮唤起键盘。
- 第二排提供“ask image 提问图片”按钮，会将图片上传到当前项目根目录下的 `./.codesentinel/uplaod_pictures`，
  并在终端输入位置插入 `@./.codesentinel/uplaod_pictures/<filename>`。

---

## 偏好设置

- 设置 → 偏好设置：调整全局字体大小（+ / -），并可一键恢复默认值。

---

## 生产部署（推荐）

一键启动：
```bash
./run/prod-start.sh
./run/prod-stop.sh
```

访问：
- Web：`http://<host>:3990/`
- 健康检查：`http://<host>:3990/healthz`

日志：
- `logs/prod.log`
- `logs/server.log`

说明：
- `prod-start` 会先执行 `pnpm build`，然后以生产模式启动服务。
- 生产模式通过 `CODESENTINEL_SERVE_WEB=1` 与 `NODE_ENV=production` 启用。

---

## 配置

初始化：
```bash
cp config/config.example.json config/config.json
```

配置文件优先级：
1. `config/config.json`
2. `config/config.local.json`（本地覆盖，可选）
3. `config/roots.local.json`（根目录覆盖，或 `CODESENTINEL_ROOTS_FILE` 指定）
4. `CODESENTINEL_ROOTS`（最高优先级）

根目录：
```json
["/path/to/workspace"]
```

说明：
- 支持两种格式：`["/path/a", "/path/b"]` 或 `{ "roots": ["/path/a"] }`。
- 可通过 `CODESENTINEL_ROOTS_FILE=/abs/path/to/roots.json` 指定文件路径。
- 或使用环境变量：
  ```bash
  CODESENTINEL_ROOTS='["/path/a","/path/b"]' pnpm dev
  ```
- 未配置 roots 时，默认使用默认用户的 home 作为根目录。
- 本地配置文件默认不会提交：`config/config.json`、`config/config.local.json`、`config/roots.local.json`、`config/.setup-done`。

端口：
- 后端：`config.server.port` 或 `PORT`（默认 3990）
- 前端开发：`VITE_PORT`（默认 3989）
- 前端 API 基址：`VITE_API_BASE`（LAN/代理）

工具检测：
- `tooling.bins.<tool>`：指定 CLI 可执行文件路径（如 `tooling.bins.opencode`）。
- `tooling.checkArgs.<tool>`：指定检测参数（如 `["--version"]`）。

终端策略：
- `limits.termSessionIdleHours`：空闲会话自动关闭小时数（默认 `12`，范围 `1..168`）。
- 界面入口：`设置 -> 命令行安全策略 -> 会话空闲过期（小时）`。
- 受限模式命令始终由后端基于 allowlist/denylist 做校验。

---

## 登录与安全

在 `config/config.json` 中设置：
- `auth.enabled`, `auth.username`, `auth.password`
- `auth.tokenTtlDays`（默认 3 天）
- `auth.loginMaxAttempts`（默认 5）
- `auth.loginLockMinutes`（默认 10）
- `auth.captcha.enabled` + `auth.captcha.ttlSec`
- `auth.encryption.enabled`

说明：
- Token 在活跃访问时自动续期，长时间不访问会过期。
- 不要直接暴露公网，建议开启登录并配合防火墙/反代。

---

## 终端运行用户（Linux）

按项目指定终端运行用户（需 root 权限）：
```json
{
  "defaultProjectUser": "codesentinel",
  "projectUsers": [
    { "root": "/path/to/project", "username": "codesentinel", "enabled": true }
  ]
}
```

规则：
- `root` 最长匹配优先。
- 规则仅在 `root` 位于允许根目录下时生效。
- 服务非 root 启动时会回退为当前用户。
- 可用 `CODESENTINEL_DEFAULT_USER` 覆盖默认用户。
- `run/dev-start.sh` 与 `run/prod-start.sh` 在 root 启动时会自动创建 `defaultProjectUser`。

---

## CLI 工具（可选）

推荐安装：
- Cursor CLI (`agent`)
- Ripgrep (`rg`)
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)
- OpenCode CLI (`opencode`)
- Gemini CLI (`gemini`)
- Kimi CLI (`kimi`)
- Qwen Code CLI (`qwen`)

示例：
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

## 反向代理（可选）

Nginx 示例配置见 [nginx/codesentinel.conf](./nginx/codesentinel.conf)。  
示例会代理 `/api` 与 `/ws/term`，并托管构建后的前端。

---

## 常见问题

- 3990 连接失败：后端未启动，先运行 `pnpm dev:server` 或 `./run/prod-start.sh`
- 500 但后端已启动：查看 `logs/server.log` 或 `logs/prod.log`
- 3989/3990 被占用：运行 `pnpm dev:fresh`
- CLI 找不到：检查 PATH，Windows 使用 `where.exe`
- 本地能用但服务端找不到 OpenCode：设置 `OPENCODE_BIN=/absolute/path/to/opencode`，或把该路径加入服务运行用户的 PATH

---

## 致谢

本项目参考并致谢开源项目：  
https://github.com/ls2046/vibe-go

---

## License

MIT License. See [LICENSE](./LICENSE).

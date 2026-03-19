# CodeSentinel（盯码侠）

<p align="center">
  <strong>面向手机优先的自托管 AI 编码控制台，专注安全终端工作流。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="#安装推荐">安装</a> ·
  <a href="#快速使用">快速使用</a> ·
  <a href="#开发者模式源码启动">开发者模式</a> ·
  <a href="#一键部署installsh--bash">一键部署</a>
</p>

<p align="center">
  <img alt="Node 18+" src="https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img alt="pnpm 10+" src="https://img.shields.io/badge/pnpm-10%2B-F69220?style=for-the-badge&logo=pnpm&logoColor=white" />
  <img alt="Platform Linux/macOS/WSL" src="https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20WSL-111827?style=for-the-badge" />
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-2563EB?style=for-the-badge" />
</p>

CodeSentinel 是一款本机优先的 Web IDE：文件树、编辑器、终端与多 AI Agent CLI（Cursor/Codex/Claude/OpenCode/Gemini/Kimi/Qwen）融合在一个控制台中。  
重点是手机与桌面统一体验、终端会话持久化，以及后端安全策略可控。

## 安装（推荐）

### 一行安装

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash
```

脚本会自动：
- 检查 Node.js / pnpm
- 克隆或更新仓库到默认目录 `~/CodeSentinel`
- 安装依赖
- 自动生成 `config/config.json`（若不存在）
- 默认启动生产服务（`./run/prod-start.sh`）

### 指定目录 / 不自动启动

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  CODESENTINEL_DIR=/opt/data/CodeSentinal CODESENTINEL_START=0 bash
```

可用环境变量：
- `CODESENTINEL_REPO`（默认：`https://github.com/Its-PocketAI/CodeSentinel.git`）
- `CODESENTINEL_BRANCH`（默认：`main`）
- `CODESENTINEL_DIR`（默认：`~/CodeSentinel`）
- `CODESENTINEL_START`（`1` 自动启动，`0` 跳过）

## 快速使用

安装后：

```bash
cd ~/CodeSentinel
./run/prod-start.sh
```

访问：
- 主页面：`http://localhost:3990/`
- 首次配置：`http://localhost:3990/#/setup`
- 健康检查：`http://localhost:3990/healthz`

停止服务：

```bash
./run/prod-stop.sh
```

## 开发者模式（源码启动）

```bash
git clone https://github.com/Its-PocketAI/CodeSentinel.git
cd CodeSentinel
pnpm install
pnpm dev
```

开发端口：
- 前端：`http://localhost:3989/`
- 后端：`http://localhost:3990/`

常用命令：
- `pnpm dev` 全栈开发
- `pnpm dev:server` 仅后端
- `pnpm dev:web` 前端 + protocol
- `pnpm dev:fresh` 释放占用端口后重启
- `./run/dev-start.sh` / `./run/dev-stop.sh` 后台开发模式

## 一键部署（`install.sh | bash`）

适合新 Linux 服务器快速落地：

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  CODESENTINEL_DIR=/opt/data/CodeSentinal bash
```

后续运维：

```bash
cd /opt/data/CodeSentinal
./run/prod-start.sh
./run/prod-stop.sh
```

## 架构（简版）

```text
Browser (Web UI)
   |  HTTP / WS
   v
CodeSentinel Server (3990)
   |-- 文件 API / 登录 / 初始化
   |-- 终端会话（PTY + 受限执行）
   |-- SQLite（聊天 / UI 状态 / 设置）
```

## 核心能力

- 本地文件树 + 编辑器（含大文件打开保护）
- 多终端模式：Restricted / Codex / Claude / OpenCode / Gemini / Kimi / Qwen / Cursor CLI
- 终端会话刷新恢复、重连恢复、空闲 TTL 自动清理（默认 12h）
- 移动端终端按键体系（方向键、Enter、ask image、Ctrl+C/Z、Tab、Shift+Enter、Alt+Enter）
- Agent 扩展键位会随模式切换，默认键位始终保留
- 内置安全登录：密码 + Token、失败次数限制、验证码、加密传输
- Linux 可按项目配置专属运行用户（run-as user）

## 安全默认策略

- Restricted 模式命令由后端基于 allowlist/denylist 严格校验
- 登录支持：
  - `auth.tokenTtlDays`
  - `auth.loginMaxAttempts`
  - `auth.loginLockMinutes`
  - captcha 与加密登录载荷
- 公网部署建议配合防火墙与反向代理，不建议裸露服务

## 配置

初始化：

```bash
cp config/config.example.json config/config.json
```

配置优先级：
1. `config/config.json`
2. `config/config.local.json`
3. `config/roots.local.json`（或 `CODESENTINEL_ROOTS_FILE`）
4. `CODESENTINEL_ROOTS`

关键字段：
- `server.port`（默认 `3990`）
- `limits.termSessionIdleHours`（`1..168`，默认 `12`）
- `tooling.bins.*`、`tooling.checkArgs.*`
- `defaultProjectUser`、`projectUsers[]`（Linux 专属用户模型）

## 移动端体验说明

- 方向键不会自动唤起系统键盘，需要手动点 `⌨️`
- `🖼️ 提问图片` 会上传到 `./.codesentinel/uploaded_pictures`
- 自动插入引用：`@./.codesentinel/uploaded_pictures/<filename>`
- 长按键位可显示键位提示冒泡
- 终端头部 `键位表` 可查看当前 Agent 的官方键位参考

## Windows / WSL

推荐使用 WSL，终端行为与路径兼容性更稳定。

PowerShell 脚本：

```powershell
.\run\dev-start.ps1
.\run\dev-stop.ps1
.\run\prod-start.ps1
.\run\prod-stop.ps1
```

## 反向代理（可选）

Nginx 示例配置：
- `nginx/codesentinel.conf`

示例已包含 `/api` 和 `/ws/term` 代理，以及前端静态资源托管。

## 常见问题

- `3990` 连不上：先执行 `./run/prod-start.sh` 或 `pnpm dev:server`
- 后端在跑但 `500`：看 `logs/server.log` / `logs/prod.log`
- 端口冲突：`pnpm dev:fresh`
- 服务端找不到某 CLI：配置 `tooling.bins.<tool>` 或修正服务用户 PATH
- OpenCode 路径问题：设置 `OPENCODE_BIN=/absolute/path/to/opencode`

## 致谢

CodeSentinel 参考并致谢：
- https://github.com/ls2046/vibe-go

## License

MIT License，详见 [LICENSE](./LICENSE)。

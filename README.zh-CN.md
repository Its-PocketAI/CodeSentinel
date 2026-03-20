# CodeSentinel（盯码侠）

<p align="center">
  <strong>面向手机优先的自托管 AI 编码控制台，专注安全终端工作流。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="#安装推荐">安装</a> ·
  <a href="#linux-manual-install">Linux 安装</a> ·
  <a href="#快速使用">快速使用</a> ·
  <a href="#开发者模式源码启动">开发者模式</a> ·
  <a href="#一键部署installsh--bash">一键部署</a> ·
  <a href="#terminal-run-user-linux">运行用户</a>
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

### 国内用户加速模式（`--for-user zh`）

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  bash -s -- --for-user=zh
```

该模式会在安装阶段临时启用 npm/pnpm 国内镜像，不会改写你全局的 npm 配置。

脚本会自动：
- 检查 Node.js / pnpm
- 克隆或更新仓库到默认目录 `~/CodeSentinel`
- 安装依赖
- 检查 `better-sqlite3` 原生绑定，缺失时自动重建修复
- 自动生成 `config/config.json`（若不存在）
- 在终端环境下交互确认登录 `username`、`password` 与服务 `port`（通过 `/dev/tty`，`curl | bash` 也可交互）
- 校验端口占用：交互模式遇到占用会要求重填，非交互模式会快速报错退出
- 终端打印并提醒你自行保存，同时写入 `config/config.json`
- 默认启动生产服务（`./run/prod-start.sh`）
- 安装脚本退出前会等待 `http://localhost:<port>/healthz` 返回 200（默认超时 60 秒）

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
- `CODESENTINEL_INTERACTIVE`（`auto`/`1`/`0`，默认 `auto`）
- `CODESENTINEL_PORT`、`CODESENTINEL_AUTH_USER`、`CODESENTINEL_AUTH_PASS`（非交互/CI 覆盖）
- `CODESENTINEL_HEALTH_TIMEOUT_SEC`（启动后健康检查等待秒数，默认 `60`）
- `CODESENTINEL_FOR_USER`（`global` 或 `zh`，默认 `global`）
- `CODESENTINEL_ZH_NPM_REGISTRY`（默认 `https://registry.npmmirror.com`，仅 `--for-user zh` 生效）

说明：
- `CODESENTINEL_INTERACTIVE=auto`：有 TTY 时自动交互，无 TTY（如 CI）自动走非交互。
- `CODESENTINEL_INTERACTIVE=1`：强制交互，要求存在 `/dev/tty`；否则安装脚本会报错退出。

<a id="linux-manual-install"></a>
## Linux 手动安装

### 1）依赖准备

- Git、curl、编译工具
- Node.js `>= 18`
- pnpm `>= 10`（推荐通过 Corepack）

Ubuntu / Debian 示例：

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential
corepack enable
corepack prepare pnpm@10.4.0 --activate
```

### 2）安装并启动

```bash
git clone https://github.com/Its-PocketAI/CodeSentinel.git /opt/data/CodeSentinal
cd /opt/data/CodeSentinal
pnpm install
cp config/config.example.json config/config.json
./run/prod-start.sh
```

### 3）停止 / 重启

```bash
cd /opt/data/CodeSentinal
./run/prod-stop.sh
./run/prod-start.sh
```

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

国内网络优化的一键部署：

```bash
curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | \
  CODESENTINEL_DIR=/opt/data/CodeSentinal bash -s -- --for-user=zh
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
- `roots`（位于 `config/config.json` 或 `config/roots.local.json`）：默认是目录列表模式；可写入 `"all"` 表示允许访问当前运行用户权限范围内的任意路径。

目录列表示例：

```json
{
  "roots": ["/home/codesentinel", "/opt/data/projects"]
}
```

`roots=all` 示例：

```json
{
  "roots": ["all"]
}
```

```bash
export CODESENTINEL_ROOTS='["all"]'
```

安全提示：
- 当服务进程以 `root` 运行时，`roots=all` 等价于通过 API 拥有完整文件系统访问能力。生产环境建议使用非 root 运行。

<a id="terminal-run-user-linux"></a>
## 终端运行用户（Linux）

`./run/prod-start.sh` 与 `./run/dev-start.sh` 的实际行为如下：

| 启动身份 | 终端默认用户 | 自动创建用户 | `projectUsers[]` 行为 |
| --- | --- | --- | --- |
| 以 `root` 启动 | `CODESENTINEL_DEFAULT_USER` -> `config.defaultProjectUser` -> `codesentinel` | 会（目标是 `root` 时除外） | 可生效（目标用户存在且权限允许） |
| 以非 root 启动 | 当前系统登录用户（`$USER`） | 不会 | 不会提权，涉及其他用户的规则会被忽略 |

说明：
- root 模式支持专属运行用户，并可自动创建默认用户。
- 非 root 模式固定使用当前用户上下文（本地开发推荐）。
- 当 `roots` 为空时，CodeSentinel 会默认使用当前运行用户的 Home 目录作为初始项目根目录。

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

Linux 脚本入口：

```bash
./run/dev-start.sh
./run/dev-stop.sh
./run/prod-start.sh
./run/prod-stop.sh
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

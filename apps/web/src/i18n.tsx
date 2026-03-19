import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "codesentinel:lang";

const EN: Record<string, string> = {
  "语言": "Language",
  "中文": "Chinese",
  "英文": "English",
  "展开": "Expand",
  "折叠": "Collapse",

  "正在连接服务…": "Connecting to service…",
  "等待后端就绪": "Waiting for backend readiness",
  "后端未就绪或出错": "Backend not ready or failed",
  "请确认已运行：pnpm dev 或 pnpm dev:server": "Please confirm it is running: pnpm dev or pnpm dev:server",
  "错误信息：{msg}": "Error: {msg}",
  "重试": "Retry",
  "需要登录": "Login required",
  "请输入用户名与密码": "Enter username and password",
  "用户名": "Username",
  "密码": "Password",
  "验证码": "Captcha",
  "加载中…": "Loading…",
  "刷新": "Refresh",
  "请输入验证码答案": "Enter captcha answer",
  "登录中…": "Signing in…",
  "登录": "Sign in",
  "重新检测": "Recheck",
  "退出登录": "Sign out",
  "请输入用户名": "Please enter a username",
  "请输入密码": "Please enter a password",
  "请完成验证码": "Please complete the captcha",
  "登录失败": "Login failed",
  "登录失败次数过多，请在 {sec}s 后再试": "Too many failed logins. Try again in {sec}s",
  "登录失败次数过多，请稍后再试": "Too many failed logins. Please try again later",
  "用户名或密码错误": "Invalid username or password",
  "加密不可用，请刷新页面或联系管理员": "Encryption unavailable. Refresh or contact admin",
  "验证码错误，请重试": "Captcha incorrect. Try again",
  "验证码已过期，请重试": "Captcha expired. Try again",
  "无效的 JSON": "Invalid JSON",
  "打开键盘": "Open keyboard",
  "Gemini CLI": "Gemini CLI",
  "Kimi CLI": "Kimi CLI",
  "Qwen Code CLI": "Qwen Code CLI",

  "配置与安装": "Setup & Install",
  "选择根目录": "Select root folders",
  "安装 Cursor / Codex / Claude / OpenCode / Gemini / Kimi / Qwen（手动）": "Install Cursor / Codex / Claude / OpenCode / Gemini / Kimi / Qwen (Manual)",
  "初始化数据库": "Initialize database",
  "正在检测环境…": "Detecting environment…",
  "无法连接后端：{msg}": "Unable to connect backend: {msg}",
  "无法连接后端，请确认服务已启动（如 pnpm dev）": "Unable to connect backend. Ensure the service is running (e.g. pnpm dev)",
  "第一步：选择根目录": "Step 1: Select root folders",
  "添加允许在 CodeSentinel（盯码侠）中访问的根目录（至少一个）。每行一个路径，可一次添加多个。":
    "Add root folders that CodeSentinel can access (at least one). One path per line; multiple lines supported.",
  "每行一个绝对路径，如 /Users/你的用户名/项目 或 /Users/你的用户名/Desktop":
    "One absolute path per line, e.g. /Users/yourname/project or /Users/yourname/Desktop",
  "每行一个绝对路径，如 C:\\Users\\你的用户名\\项目 或 D:\\workspace（反斜杠写一条或两条均可）":
    "One absolute path per line, e.g. C:\\Users\\yourname\\project or D:\\workspace (single or double backslashes both work)",
  "每行一个绝对路径，如 /home/你的用户名/project":
    "One absolute path per line, e.g. /home/yourname/project",
  "/Users/你的用户名/project\n/Users/你的用户名/Desktop":
    "/Users/yourname/project\n/Users/yourname/Desktop",
  "C:\\Users\\你的用户名\\project\nD:\\workspace":
    "C:\\Users\\yourname\\project\nD:\\workspace",
  "/home/你的用户名/project":
    "/home/yourname/project",
  "添加中…": "Adding…",
  "添加": "Add",
  "已添加 {count} 个根目录": "Added {count} root folder(s)",
  "已添加 {added} 个，失败 {failed} 个：{detail}": "Added {added}, failed {failed}: {detail}",
  "添加失败": "Add failed",
  "请求失败": "Request failed",
  "第二步：安装 Cursor / Codex / Claude / OpenCode / Gemini / Kimi / Qwen（手动安装）": "Step 2: Install Cursor / Codex / Claude / OpenCode / Gemini / Kimi / Qwen (Manual)",
  "以下工具用于 Cursor Chat、Codex/Claude/OpenCode/Gemini/Kimi/Qwen 终端等功能。请根据当前检测状态，在终端中按下方说明手动安装。未安装也可跳过，但相关功能将无法使用。":
    "These tools enable Cursor Chat and Codex/Claude/OpenCode/Gemini/Kimi/Qwen terminals. Install them manually in a terminal as instructed. You may skip, but related features will be unavailable.",
  "安装方法": "Install",
  "✓ 已安装 {version}": "✓ Installed {version}",
  "✓ 已安装": "✓ Installed",
  "✗ 未安装": "✗ Not installed",
  "第三步：初始化数据库": "Step 3: Initialize database",
  "初始化完成": "Initialization complete",
  "初始化中…": "Initializing…",
  "初始化": "Initialize",
  "完成安装，进入 CodeSentinel": "Finish and enter CodeSentinel",
  "处理中…": "Processing…",
  "完成": "Finish",
  "上一步": "Back",
  "下一步": "Next",
  "跳过此步": "Skip this step",
  "已跳过": "Skipped",
  "初始化失败": "Initialization failed",
  "完成失败": "Finalize failed",
  "请先添加至少一个根目录": "Please add at least one root folder",
  "跳过则无法正常使用 Cursor Chat、Codex/Claude/OpenCode/Gemini/Kimi/Qwen 终端等功能。":
    "Skipping disables Cursor Chat and Codex/Claude/OpenCode/Gemini/Kimi/Qwen terminals.",
  "初始化本地数据库，用于保存聊天记录、工作区等。":
    "Initialize the local database to store chat history and workspaces.",
  "数据库已初始化": "Database initialized",
  "已安装": "Installed",
  "未安装": "Not installed",

  "对话式助手（非终端）": "Chat assistant (non-terminal)",
  "交互式 CLI": "Interactive CLI",
  "Claude Code CLI": "Claude Code CLI",
  "OpenCode CLI": "OpenCode CLI",
  "Cursor 命令行模式": "Cursor CLI mode",
  "命令行": "Terminal",
  "安全受限命令行": "Restricted terminal",

  "[提示] 当前模式暂无会话，请点击“新建”": "[Hint] No session for this mode. Click “New”",
  "[提示] {tool} 暂无会话，点击“新建”创建。": "[Hint] {tool} has no session. Click “New” to create.",
  "[提示] 请先选择工作目录": "[Hint] Please select a working directory first",
  "[错误] 工具设置: {msg}": "[Error] Tool settings: {msg}",
  "[错误] 命令行设置: {msg}": "[Error] Terminal settings: {msg}",
  "[错误] 界面状态: {msg}": "[Error] UI state: {msg}",
  "[错误] 保存工具: {msg}": "[Error] Save tools: {msg}",
  "[错误] 至少保留一个工具": "[Error] Keep at least one tool",
  "[成功] 命令行设置已保存": "[Success] Terminal settings saved",
  "[错误] 会话恢复失败: {msg}": "[Error] Session restore failed: {msg}",
  "[已恢复] {msg}": "[Restored] {msg}",
  "[错误] 根目录: {msg}": "[Error] Roots: {msg}",
  "[错误] 列表: {msg}": "[Error] List: {msg}",
  "[错误] 读取: {msg}": "[Error] Read: {msg}",
  "[错误] 文件过大：{name} {size} > {limit}": "[Error] File too large: {name} {size} > {limit}",
  "文件“{name}”大小为 {size}，超过 {threshold}。是否继续打开？":
    "File “{name}” is {size}, exceeding {threshold}. Open anyway?",
  "[提示] 已取消打开 {name}": "[Hint] Open cancelled: {name}",
  "[成功] 已ask image提问图片 {name}": "[Success] ask image prepared: {name}",
  "[成功] 已保存 {name}": "[Success] Saved {name}",
  "[错误] 写入: {msg}": "[Error] Write: {msg}",
  "[错误] 刷新: {msg}": "[Error] Refresh: {msg}",
  "[错误] 请先选择目录": "[Error] Please select a directory first",
  "[成功] 已上传 {count} 个文件": "[Success] Uploaded {count} file(s)",
  "[错误] 上传失败: {msg}": "[Error] Upload failed: {msg}",
  "[成功] 已删除 {name}": "[Success] Deleted {name}",
  "[错误] 删除: {msg}": "[Error] Delete: {msg}",
  "[成功] 已下载 {name}": "[Success] Downloaded {name}",
  "[错误] 下载: {msg}": "[Error] Download: {msg}",
  "[错误] 名称不能为空": "[Error] Name cannot be empty",
  "[成功] 已创建文件夹 {name}": "[Success] Folder created: {name}",
  "[成功] 已创建文件 {name}": "[Success] File created: {name}",
  "[错误] 创建{type}: {msg}": "[Error] Create {type}: {msg}",
  "[错误] 终端: {msg}": "[Error] Terminal: {msg}",
  "[提示] 当前会话无法直接删除，请先切换或关闭终端": "[Hint] Active session cannot be deleted directly. Switch or close the terminal first",
  "[错误] 删除会话: {msg}": "[Error] Delete session: {msg}",
  "终端回放 {id}": "Terminal Replay {id}",
  "(空)": "(Empty)",
  "[启动 codex…]": "[Starting codex…]",
  "[WebSocket 错误] {msg}": "[WebSocket Error] {msg}",
  "[codex 已退出 {code}]": "[codex exited {code}]",
  "[claude 已退出 {code}]": "[claude exited {code}]",
  "[opencode 已退出 {code}]": "[opencode exited {code}]",
  "[gemini 已退出 {code}]": "[gemini exited {code}]",
  "[kimi 已退出 {code}]": "[kimi exited {code}]",
  "[qwen 已退出 {code}]": "[qwen exited {code}]",
  "[cursor-cli 已退出 {code}]": "[cursor-cli exited {code}]",
  "[restricted PTY 已退出 {code}]": "[restricted PTY exited {code}]",
  "会话不存在或已结束": "Session not found or ended",
  "[会话] 正在打开 {path}": "[Session] Opening {path}",
  "已上传 {uploaded}/{total}，": "Uploaded {uploaded}/{total}, ",

  "工具设置": "Tool Settings",
  "启用或隐藏工具（设置会写入后端）": "Enable or hide tools (settings are stored on server)",
  "偏好设置": "Preferences",
  "全局字体大小": "Global font size",
  "减小字体": "Decrease font size",
  "增大字体": "Increase font size",
  "恢复默认": "Reset",
  "AI 工具": "AI Tools",
  "命令行工具": "Terminal Tools",
  "命令行安全策略": "Terminal Safety Policy",
  "命令行窗口默认启用受限模式，仅允许安全命令。": "Terminal defaults to restricted mode and allows only safe commands.",
  "模式": "Mode",
  "禁止列表（默认）": "Denylist (default)",
  "允许列表": "Allowlist",
  "超时（秒）": "Timeout (sec)",
  "最大输出（KB）": "Max output (KB)",
  "会话空闲过期（小时）": "Session idle expiry (hours)",
  "允许列表（每行一个命令）": "Allowlist (one command per line)",
  "例如：ls\npwd\ngit\nnode": "e.g. ls\npwd\ngit\nnode",
  "禁止列表（每行一个命令）": "Denylist (one command per line)",
  "例如：rm\nsudo\nshutdown": "e.g. rm\nsudo\nshutdown",
  "至少保留一个工具。": "Keep at least one tool.",
  "工具保存中…": "Saving tools…",
  "保存中…": "Saving…",
  "保存命令行设置": "Save terminal settings",
  "窗口列表": "Window List",
  "窗口": "Windows",
  "刷新中…": "Refreshing…",
  "文件": "File",
  "文件夹": "Folder",
  "暂无打开的文件": "No open files",
  "终端": "Terminal",
  "暂无会话": "No session",
  "已打开文件": "Open Files",
  "关闭 {name}": "Close {name}",
  "编辑器": "Editor",
  "(无文件)": "(No file)",
  "编辑器模式": "Editor Mode",
  "编辑": "Edit",
  "预览": "Preview",
  "请先打开文件": "Open a file first",
  "使用 highlight.js 预览": "Preview with highlight.js",
  "保存": "Save",
  "拖拽调整大小": "Drag to resize",
  "终端模式": "Terminal Mode",
  "受限命令行": "Restricted Terminal",
  "新建会话": "New session",
  "新建": "New",
  "粘贴到终端": "Paste to terminal",
  "粘贴命令": "Paste command",
  "工作目录: {path}": "Working dir: {path}",
  "折叠侧边栏": "Collapse sidebar",
  "展开侧边栏": "Expand sidebar",
  "设置": "Settings",
  "根目录": "Root Folders",
  "根目录与操作": "Roots & Actions",
  "切换项目": "Switch Project",
  "退出": "Logout",
  "切换到浅色模式": "Switch to light mode",
  "切换到深色模式": "Switch to dark mode",
  "复制文件名或路径": "Copy name or path",
  "复制": "Copy",
  "复制文件名": "Copy name",
  "复制路径": "Copy path",
  "下载文件": "Download file",
  "在此文件夹打开终端": "Open terminal here",
  "打开": "Open",
  "当前": "Current",
  "在线": "Online",
  "已结束": "Ended",
  "终端会话": "Terminal Sessions",
  "恢复": "Restore",
  "查看": "View",
  "加载失败：{msg}": "Load failed: {msg}",
  "上传到当前目录": "Upload to current folder",
  "ask image 提问图片": "ask image",
  "上传": "Upload",
  "上传中…": "Uploading…",
  "新建文件夹": "New folder",
  "新建文件": "New file",
  "无根目录": "No root folder",
  "在此输入或粘贴内容，点击确定发送到终端": "Type or paste here, then click Confirm to send to terminal",
  "取消": "Cancel",
  "确定": "Confirm",
  "“{name}” 有未保存的更改。仍要关闭吗？": "“{name}” has unsaved changes. Close anyway?",
  "新建{type}": "New {type}",
  "在当前目录下新建。": "Create in current directory.",
  "当前目录: {path}": "Current directory: {path}",
  "(未选择目录)": "(No directory selected)",
  "例如：src 或 docs": "e.g. src or docs",
  "例如：index.ts 或 README.md": "e.g. index.ts or README.md",
  "二次确认删除": "Confirm deletion",
  "即将删除{type}：": "You are about to delete this {type}:",
  "路径：{path}": "Path: {path}",
  "请输入 DELETE 以确认删除": "Type DELETE to confirm",
  "删除": "Delete",
  "终端回放": "Terminal Replay",
  "关闭": "Close",

  "提示": "Hint",
  "错误": "Error",
  "成功": "Success",
  "命令行设置": "Terminal Settings",

  "Agent": "Agent",
  "Plan": "Plan",
  "Ask": "Ask",
  "Auto（当前）": "Auto (Current)",
  "Claude 4.5 Opus (Thinking)（默认）": "Claude 4.5 Opus (Thinking) (Default)",
  "新对话": "New chat",
  "[工具 #{n}] {path}": "[Tool #{n}] {path}",
  "[工具 #{n}] 已启动": "[Tool #{n}] Started",
  "[标准错误] {msg}": "[stderr] {msg}",
  "[错误] {msg}": "[Error] {msg}",
  "[完成] 退出码={code}{sig}{timeout}": "[Done] exit={code}{sig}{timeout}",
  "切换模型": "Switch model",
  "为此文件夹开始新对话": "Start a new chat for this folder",
  "查看聊天历史": "View chat history",
  "历史 ({count})": "History ({count})",
  "停止": "Stop",
  "聊天历史": "Chat history",
  "暂无聊天历史": "No chat history",
  "{count} 条消息": "{count} messages",
  "删除此对话": "Delete this chat",
  "与 Cursor {mode} 开始对话。": "Start a chat with Cursor {mode}.",
  "在下方输入您的问题或任务。（Ctrl/Cmd + Enter 发送）": "Type your question or task below. (Ctrl/Cmd + Enter to send)",
  "取消待发送": "Cancel pending send",
  "向 {mode} 提问...（Ctrl/Cmd+Enter 发送）": "Ask {mode}… (Ctrl/Cmd+Enter to send)",
  "发送": "Send",
  "请求失败 ({status})": "Request failed ({status})",
  "服务端未返回 X-Run-Id": "Server did not return X-Run-Id",
  "无响应体": "No response body",
  "[连接断开，回到前台将自动重连]": "[Disconnected. Will auto-reconnect when back to foreground]",
  "错误: {msg}": "Error: {msg}",
  "停止当前请求": "Stop current request",
  " 信号={sig}": " signal={sig}",
  " 超时=true": " timeout=true",
};

function detectLang(): Lang {
  if (typeof window === "undefined") return "zh";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  const nav = window.navigator?.language?.toLowerCase() || "";
  return nav.startsWith("en") ? "en" : "zh";
}

function applyVars(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    return match;
  });
}

type I18nContextValue = {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue>({
  lang: "zh",
  setLang: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", lang);
    }
  }, [lang]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const base = lang === "en" ? (EN[key] ?? key) : key;
      return applyVars(base, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

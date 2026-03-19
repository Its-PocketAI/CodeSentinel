import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";

// Load monaco from node_modules (served at /vs by Vite)
loader.config({
  paths: {
    vs: "/vs",
  },
});
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import hljs from "highlight.js";
import { 
  apiList, 
  apiRead, 
  apiRoots, 
  apiWrite, 
  apiMkdir,
  apiDelete,
  apiDownload,
  apiUploadFile,
  apiGetLastOpenedFile,
  apiSetLastOpenedFile,
  apiGetActiveRoot,
  apiSetActiveRoot,
  apiGetUiTools,
  apiSetUiTools,
  apiGetCommandSettings,
  apiSetCommandSettings,
  apiGetUiState,
  apiSetUiState,
  apiFetch,
  apiStat,
  apiAuthLogout,
  clearAuthToken,
  getAuthToken,
  type FsEntry,
  type CommandSettings,
  type UiState,
  type UiToolSetting,
} from "../api";
import { TermClient, type TermServerMsg } from "../wsTerm";
import { CursorChatPanel } from "./CursorChatPanel";
import { useI18n } from "../i18n";

type TreeNode = {
  path: string;
  name: string;
  type: "dir" | "file" | "other";
  size?: number;
  mtimeMs?: number;
  expanded?: boolean;
  loading?: boolean;
  loaded?: boolean;
  children?: TreeNode[];
};

type ToolId = "cursor" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "cursor-cli" | "command";
type TermMode = "restricted" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "cursor" | "cursor-cli";

const TOOL_DEFS: { id: ToolId; label: string; desc: string }[] = [
  { id: "cursor", label: "Cursor Chat", desc: "对话式助手（非终端）" },
  { id: "codex", label: "Codex", desc: "交互式 CLI" },
  { id: "claude", label: "Claude", desc: "Claude Code CLI" },
  { id: "opencode", label: "OpenCode", desc: "OpenCode CLI" },
  { id: "gemini", label: "Gemini", desc: "Gemini CLI" },
  { id: "kimi", label: "Kimi", desc: "Kimi CLI" },
  { id: "qwen", label: "Qwen", desc: "Qwen Code CLI" },
  { id: "cursor-cli", label: "Cursor CLI", desc: "Cursor 命令行模式" },
  { id: "command", label: "命令行", desc: "安全受限命令行" },
];

const DEFAULT_TOOL_SETTINGS: UiToolSetting[] = TOOL_DEFS.map((t) => ({ id: t.id, enabled: true }));
const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024;
const LARGE_FILE_HARD_LIMIT_BYTES = 50 * 1024 * 1024;

function isToolId(id: string): id is ToolId {
  return TOOL_DEFS.some((t) => t.id === id);
}

function mergeToolSettings(input: UiToolSetting[] | null | undefined): UiToolSetting[] {
  const seen = new Set<string>();
  const out: UiToolSetting[] = [];
  if (Array.isArray(input)) {
    for (const t of input) {
      if (!t || typeof t.id !== "string") continue;
      if (!isToolId(t.id) || seen.has(t.id)) continue;
      out.push({ id: t.id, enabled: Boolean(t.enabled) });
      seen.add(t.id);
    }
  }
  for (const def of DEFAULT_TOOL_SETTINGS) {
    if (!seen.has(def.id)) out.push({ ...def });
  }
  if (!out.some((t) => t.enabled)) out[0].enabled = true;
  return out;
}

function toolIdToMode(id: ToolId): TermMode {
  return id === "command" ? "restricted" : (id as TermMode);
}

function modeToToolId(mode: TermMode): ToolId {
  return mode === "restricted" ? "command" : (mode as ToolId);
}

function getToolDef(id: ToolId) {
  return TOOL_DEFS.find((t) => t.id === id) ?? { id, label: id, desc: "" };
}

const DEFAULT_UI_STATE: UiState = {
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

const UI_FONT_MIN = 10;
const UI_FONT_MAX = 18;

const STORAGE_PREFIX = "codesentinel";
const storageKey = (key: string) => `${STORAGE_PREFIX}:${key}`;

const LAST_TERM_SESSION_KEY = storageKey("lastTermSession");
const TERM_SESSIONS_BY_MODE_KEY = storageKey("termSessionsByMode");

function getStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(storageKey(key));
}

function setStored(key: string, value: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(storageKey(key), value);
}

function removeStored(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storageKey(key));
}

type TermSessionRecord = { sessionId: string; cwd?: string; mode?: string };
type TermSessionsByMode = Partial<Record<TermMode, TermSessionRecord>>;

function readSessionsByMode(): TermSessionsByMode {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(TERM_SESSIONS_BY_MODE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as TermSessionsByMode;
  } catch {
    return {};
  }
}

function writeSessionsByMode(map: TermSessionsByMode) {
  if (typeof window === "undefined") return;
  try {
    const clean: TermSessionsByMode = {};
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v.sessionId !== "string" || !v.sessionId) continue;
      (clean as any)[k] = { sessionId: v.sessionId, cwd: v.cwd, mode: v.mode };
    }
    localStorage.setItem(TERM_SESSIONS_BY_MODE_KEY, JSON.stringify(clean));
  } catch {}
}

function parseCommandList(text: string): string[] {
  const parts = text.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function listToText(list: string[]): string {
  return list.join("\n");
}

function normalizeUiState(input: UiState | null | undefined): UiState {
  const raw = input ?? ({} as UiState);
  const pick = <T extends string>(val: unknown, allowed: T[], fallback: T): T =>
    typeof val === "string" && (allowed as string[]).includes(val) ? (val as T) : fallback;
  const pickBool = (val: unknown, fallback: boolean) => (typeof val === "boolean" ? val : fallback);
  const pickNum = (val: unknown, fallback: number, min: number, max: number) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    mobileTab: pick(raw.mobileTab, ["explorer", "editor", "terminal", "settings"], DEFAULT_UI_STATE.mobileTab),
    leftPanelTab: pick(raw.leftPanelTab, ["files", "settings", "windows"], DEFAULT_UI_STATE.leftPanelTab),
    termMode: pick(raw.termMode, ["cursor", "codex", "claude", "opencode", "gemini", "kimi", "qwen", "cursor-cli", "restricted"], DEFAULT_UI_STATE.termMode),
    cursorMode: pick(raw.cursorMode, ["agent", "plan", "ask"], DEFAULT_UI_STATE.cursorMode),
    cursorCliMode: pick(raw.cursorCliMode, ["agent", "plan", "ask"], DEFAULT_UI_STATE.cursorCliMode),
    editorMode: pick(raw.editorMode, ["edit", "preview"], DEFAULT_UI_STATE.editorMode),
    panelExplorerCollapsed: pickBool(raw.panelExplorerCollapsed, DEFAULT_UI_STATE.panelExplorerCollapsed),
    panelEditorCollapsed: pickBool(raw.panelEditorCollapsed, DEFAULT_UI_STATE.panelEditorCollapsed),
    panelTerminalCollapsed: pickBool(raw.panelTerminalCollapsed, DEFAULT_UI_STATE.panelTerminalCollapsed),
    leftWidth: pickNum(raw.leftWidth, DEFAULT_UI_STATE.leftWidth, 200, 900),
    topHeight: pickNum(raw.topHeight, DEFAULT_UI_STATE.topHeight, 20, 80),
    mobileKeysVisible: pickBool(raw.mobileKeysVisible, DEFAULT_UI_STATE.mobileKeysVisible),
    fontSize: pickNum(raw.fontSize, DEFAULT_UI_STATE.fontSize, 10, 18),
  };
}

function baseName(p: string) {
  const clean = p.replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

function dirName(p: string) {
  const clean = p.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return clean.startsWith("/") ? "/" : "";
  return clean.slice(0, idx);
}

function joinPath(parent: string, name: string) {
  if (parent.endsWith("/")) return parent + name;
  return parent + "/" + name;
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function stripAnsi(text: string) {
  const oscRegex = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
  const ansiRegex = /(?:\u001b|\u009b)[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  return text
    .replace(oscRegex, "")
    .replace(ansiRegex, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function languageFromPath(p: string): string | null {
  const lower = p.toLowerCase();
  const name = baseName(lower);
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === ".env" || name.endsWith(".env")) return "dotenv";
  const parts = lower.split(".");
  if (parts.length < 2) return null;
  const ext = parts[parts.length - 1] ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "jsonc":
      return "json";
    case "cjs":
    case "mjs":
      return "javascript";
    case "css":
      return "css";
    case "scss":
    case "sass":
    case "less":
      return "scss";
    case "html":
      return "xml";
    case "xml":
    case "svg":
      return "xml";
    case "md":
      return "markdown";
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "ps1":
      return "powershell";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    case "ini":
    case "cfg":
      return "ini";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "swift":
      return "swift";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "sql":
      return "sql";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return "cpp";
    default:
      return null;
  }
}

function readCssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function parseCssColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim().toLowerCase();
  if (!c) return null;
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r, g, b };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b };
    }
    return null;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return { r, g, b };
      }
    }
  }
  return null;
}

function toOscRgb(color: string, fallback: string) {
  const rgb = parseCssColorToRgb(color) ?? parseCssColorToRgb(fallback);
  const to16 = (n: number) => {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return ((v << 8) | v).toString(16).padStart(4, "0");
  };
  if (!rgb) return "rgb:0000/0000/0000";
  return `rgb:${to16(rgb.r)}/${to16(rgb.g)}/${to16(rgb.b)}`;
}

function getTermTheme(isDark: boolean) {
  return {
    background: readCssVar("--term-bg", isDark ? "#1e293b" : "#f1f5f9"),
    foreground: readCssVar("--term-fg", isDark ? "#f1f5f9" : "#0f172a"),
    cursor: readCssVar("--term-cursor", isDark ? "#3b82f6" : "#2563eb"),
    selectionBackground: readCssVar("--term-selection", isDark ? "rgba(59,130,246,0.3)" : "rgba(37,99,235,0.18)"),
  };
}

function getMonoFontFamily() {
  const fallback =
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace";
  if (typeof window === "undefined") return fallback;
  const css = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
  return css || fallback;
}

function CodePreview(props: { path: string; code: string }) {
  const lang = useMemo(() => languageFromPath(props.path), [props.path]);

  const highlighted = useMemo(() => {
    try {
      if (lang) {
        return hljs.highlight(props.code, { language: lang, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(props.code).value;
    } catch {
      // Fallback: escape is handled by React when we render as text, but
      // here we use HTML, so return plain text wrapped safely.
      return props.code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }
  }, [props.code, lang]);

  const className = ["hljs", lang ? `language-${lang}` : ""].filter(Boolean).join(" ");
  return (
    <div className="codePreview">
      <pre>
        <code className={className} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function updateNode(tree: TreeNode, targetPath: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (tree.path === targetPath) return fn(tree);
  if (!tree.children) return tree;
  const nextChildren = tree.children.map((c) => updateNode(c, targetPath, fn));
  // Only allocate a new object if children changed references.
  const changed = nextChildren.some((c, i) => c !== tree.children![i]);
  return changed ? { ...tree, children: nextChildren } : tree;
}

function findNode(tree: TreeNode, targetPath: string): TreeNode | null {
  if (tree.path === targetPath) return tree;
  if (!tree.children) return null;
  for (const child of tree.children) {
    const found = findNode(child, targetPath);
    if (found) return found;
  }
  return null;
}

function TreeView(props: {
  node: TreeNode;
  depth: number;
  activeFile: string;
  selectedPath: string;
  rootPath: string;
  onSelectNode: (node: TreeNode) => void;
  onToggleDir: (node: TreeNode) => void;
  onOpenFile: (node: TreeNode) => void;
  onOpenTerminalDir: (node: TreeNode) => void;
  onDeleteNode: (node: TreeNode) => void;
  onDownloadFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const { node, depth, activeFile, selectedPath } = props;
  const indent = depth * 12;
  const isActive = node.type === "file" && node.path === activeFile;
  const isSelected = node.path === selectedPath;
  const isRoot = props.rootPath && node.path === props.rootPath;
  const [copyOpen, setCopyOpen] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);

  const copyToClipboard = useCallback((text: string) => {
    const done = () => setCopyOpen(false);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
      return;
    }
    // Fallback for non-secure context or when clipboard API is unavailable
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } finally {
      done();
    }
  }, [t]);

  useEffect(() => {
    if (!copyOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target as Node)) setCopyOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [copyOpen]);

  return (
    <div className="fileTreeNode" data-depth={depth} style={{ ["--tree-indent" as any]: `${indent}px` }}>
      <div
        className={
          "fileRow" +
          (isActive ? " fileRowActive" : "") +
          (isSelected ? " fileRowSelected" : "")
        }
        data-path={node.path}
        data-type={node.type}
        data-expanded={node.type === "dir" ? (node.expanded ? "true" : "false") : undefined}
        onClick={() => {
          props.onSelectNode(node);
          if (node.type === "dir") props.onToggleDir(node);
          else if (node.type === "file") props.onOpenFile(node);
        }}
        title={node.path}
      >
        <div className="fileRowLeft">
          <span className="fileCaret" style={{ color: node.type === "dir" ? "var(--accent)" : "var(--text)" }}>
            {node.type === "dir" ? (node.expanded ? "▾" : "▸") : " "}
          </span>
          <span className="fileIcon" aria-hidden />
          <span className="fileName">{node.name}</span>
          {node.loading ? <span className="fileMeta">{t("加载中…")}</span> : null}
        </div>

        <div className="dirActions" onClick={(e) => e.stopPropagation()}>
          <div className="copyPathWrap" ref={copyMenuRef}>
            <button
              type="button"
              className="copyPathBtn"
              onClick={() => setCopyOpen((o) => !o)}
              title={t("复制文件名或路径")}
              aria-label={t("复制")}
            >
              ⎘
            </button>
            {copyOpen ? (
              <div className="copyPathMenu">
                <button type="button" onClick={() => copyToClipboard(node.name)}>{t("复制文件名")}</button>
                <button type="button" onClick={() => copyToClipboard(node.path)}>{t("复制路径")}</button>
              </div>
            ) : null}
          </div>
          {node.type === "file" ? (
            <button
              type="button"
              className="dirActionBtn"
              onClick={() => props.onDownloadFile(node.path)}
              title={t("下载文件")}
              aria-label={t("下载文件")}
            >
              ↓
            </button>
          ) : null}
          {!isRoot ? (
            <button
              type="button"
              className="dirActionBtn dirActionDanger"
              onClick={() => props.onDeleteNode(node)}
              title={t("删除")}
              aria-label={t("删除")}
            >
              Del
            </button>
          ) : null}
          {node.type === "dir" ? (
            <button className="dirTermBtn" onClick={() => props.onOpenTerminalDir(node)} title={t("在此文件夹打开终端")}>
              {t("终端")}
            </button>
          ) : null}
        </div>
      </div>

      {node.type === "dir" && node.expanded ? (
        <div className={"fileChildren" + (depth > 0 ? " fileChildrenNested" : "")}>
          {node.children?.map((c) => (
            <TreeView
              key={c.path}
              node={c}
              depth={depth + 1}
              activeFile={activeFile}
              selectedPath={selectedPath}
              rootPath={props.rootPath}
              onSelectNode={props.onSelectNode}
              onToggleDir={props.onToggleDir}
              onOpenFile={props.onOpenFile}
              onOpenTerminalDir={props.onOpenTerminalDir}
              onDeleteNode={props.onDeleteNode}
              onDownloadFile={props.onDownloadFile}
            />
          ))}
          {node.loading ? (
            <div className="fileMeta" style={{ paddingLeft: 8 + indent + 24, paddingTop: 4, paddingBottom: 6 }}>
              {t("加载中…")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const { t, lang, setLang } = useI18n();
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState<"explorer" | "editor" | "terminal" | "settings">(DEFAULT_UI_STATE.mobileTab);
  const [mobileWorkspaceDrawerOpen, setMobileWorkspaceDrawerOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"edit" | "preview">(DEFAULT_UI_STATE.editorMode);
  const [leftWidth, setLeftWidth] = useState(DEFAULT_UI_STATE.leftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [topHeight, setTopHeight] = useState(DEFAULT_UI_STATE.topHeight); // 终端区域宽度百分比（桌面端左右分栏）
  const [isDraggingVertical, setIsDraggingVertical] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"files" | "settings" | "windows">(DEFAULT_UI_STATE.leftPanelTab);
  const [toolSettings, setToolSettings] = useState<UiToolSetting[]>(DEFAULT_TOOL_SETTINGS);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [commandSaving, setCommandSaving] = useState(false);
  const [commandSettings, setCommandSettings] = useState<CommandSettings | null>(null);
  const [commandMode, setCommandMode] = useState<"denylist" | "allowlist">("denylist");
  const [commandWhitelistText, setCommandWhitelistText] = useState("");
  const [commandDenylistText, setCommandDenylistText] = useState("");
  const [commandTimeoutSec, setCommandTimeoutSec] = useState("900");
  const [commandMaxOutputKB, setCommandMaxOutputKB] = useState("1024");
  const [uiFontSize, setUiFontSize] = useState(DEFAULT_UI_STATE.fontSize);
  type SettingsSectionKey = "tools" | "preference" | "language" | "security";
  const [settingsOpen, setSettingsOpen] = useState<Record<SettingsSectionKey, boolean>>({
    tools: true,
    preference: true,
    language: true,
    security: true,
  });
  const [termSessions, setTermSessions] = useState<
    Array<{ sessionId: string; updatedAt: number; sizeBytes: number; cwd?: string; mode?: string; active?: boolean }>
  >([]);
  const [termSessionsLoading, setTermSessionsLoading] = useState(false);
  const [termSessionsError, setTermSessionsError] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayText, setReplayText] = useState("");
  const [replayTitle, setReplayTitle] = useState("");
  const [replayLoading, setReplayLoading] = useState(false);
  const uiStateLoadedRef = useRef(false);
  const uiStateSaveTimerRef = useRef<number | null>(null);
  const settingsTouchedRef = useRef(false);
  
  // Dark mode state
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = getStored("darkMode");
    if (saved !== null) return saved === "true";
    return true;
  });

  const [authToken, setAuthTokenState] = useState(() => getAuthToken());

  useEffect(() => {
    const onAuth = () => setAuthTokenState(getAuthToken());
    window.addEventListener("codesentinel:auth-changed", onAuth);
    return () => {
      window.removeEventListener("codesentinel:auth-changed", onAuth);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGetUiTools()
      .then((res) => {
        if (cancelled) return;
        setToolSettings(mergeToolSettings(res.tools));
      })
      .catch((e: any) => {
        if (cancelled) return;
        setStatus(t("[错误] 工具设置: {msg}", { msg: e?.message ?? String(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    apiGetCommandSettings()
      .then((res) => {
        if (cancelled) return;
        const s = res.settings;
        setCommandSettings(s);
        setCommandMode(s.mode);
        setCommandWhitelistText(listToText(s.whitelist));
        setCommandDenylistText(listToText(s.denylist));
        setCommandTimeoutSec(String(s.timeoutSec));
        setCommandMaxOutputKB(String(s.maxOutputKB));
      })
      .catch((e: any) => {
        if (cancelled) return;
        setStatus(t("[错误] 命令行设置: {msg}", { msg: e?.message ?? String(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    apiGetUiState()
      .then((res) => {
        if (cancelled) return;
        const next = normalizeUiState(res.state);
        setMobileTab(next.mobileTab);
        setLeftPanelTab(next.leftPanelTab);
        setTermMode(next.termMode);
        setCursorMode(next.cursorMode);
        setCursorCliMode(next.cursorCliMode);
        setEditorMode(next.editorMode);
        setPanelExplorerCollapsed(isMobile ? next.panelExplorerCollapsed : false);
        setPanelEditorCollapsed(false);
        setPanelTerminalCollapsed(isMobile ? next.panelTerminalCollapsed : false);
        setLeftWidth(next.leftWidth);
        setTopHeight(next.topHeight);
        setMobileKeysVisible(next.mobileKeysVisible);
        setUiFontSize(next.fontSize);
        uiStateLoadedRef.current = true;
      })
      .catch((e: any) => {
        if (cancelled) return;
        setStatus(t("[错误] 界面状态: {msg}", { msg: e?.message ?? String(e) }));
        uiStateLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [isMobile, t]);

  const handleLogout = useCallback(async () => {
    try {
      await apiAuthLogout();
    } catch {}
    clearAuthToken();
  }, []);

  const handleSwitchProject = useCallback(() => {
    removeStored("activeRoot");
    setActiveRoot("");
    setTree(null);
    setOpenTabs([]);
    setActiveFile("");
    setFileStateByPath({});
    setTerminalCwd("");
    setSelectedExplorerPath("");
    setExplorerUserPath("");
    setMobileWorkspaceDrawerOpen(false);
    window.location.hash = "#/setup";
  }, []);

  const saveUiTools = useCallback(async (tools: UiToolSetting[]) => {
    setToolsSaving(true);
    try {
      await apiSetUiTools(tools);
    } catch (e: any) {
      setStatus(t("[错误] 保存工具: {msg}", { msg: e?.message ?? String(e) }));
    } finally {
      setToolsSaving(false);
    }
  }, [t]);

  const toggleToolEnabled = useCallback((id: ToolId, enabled: boolean) => {
    setToolSettings((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, enabled } : t));
      const enabledCount = next.filter((t) => t.enabled).length;
      if (enabledCount === 0) {
        setStatus(t("[错误] 至少保留一个工具"));
        return prev;
      }
      void saveUiTools(next);
      return next;
    });
  }, [saveUiTools, t]);

  const handleSaveCommandSettings = useCallback(async () => {
    setCommandSaving(true);
    try {
      const settings: CommandSettings = {
        mode: commandMode,
        whitelist: parseCommandList(commandWhitelistText),
        denylist: parseCommandList(commandDenylistText),
        timeoutSec: Math.max(1, Number(commandTimeoutSec) || 1),
        maxOutputKB: Math.max(1, Number(commandMaxOutputKB) || 1),
      };
      const res = await apiSetCommandSettings(settings);
      setCommandSettings(res.settings);
      setCommandMode(res.settings.mode);
      setCommandWhitelistText(listToText(res.settings.whitelist));
      setCommandDenylistText(listToText(res.settings.denylist));
      setCommandTimeoutSec(String(res.settings.timeoutSec));
      setCommandMaxOutputKB(String(res.settings.maxOutputKB));
      setStatus(t("[成功] 命令行设置已保存"));
    } catch (e: any) {
      setStatus(t("[错误] 命令行设置: {msg}", { msg: e?.message ?? String(e) }));
    } finally {
      setCommandSaving(false);
    }
  }, [
    commandMode,
    commandWhitelistText,
    commandDenylistText,
    commandTimeoutSec,
    commandMaxOutputKB,
    t,
  ]);

  const refreshTermSessions = useCallback(async () => {
    setTermSessionsLoading(true);
    setTermSessionsError(null);
    try {
      const res = await apiFetch("/api/term/sessions?limit=80");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load sessions");
      setTermSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (e: any) {
      setTermSessionsError(e?.message ?? String(e));
    } finally {
      setTermSessionsLoading(false);
    }
  }, []);

  const handleViewSession = useCallback(async (sessionId: string) => {
    setReplayOpen(true);
    setReplayTitle(t("终端回放 {id}", { id: sessionId }));
    setReplayText("");
    setReplayLoading(true);
    try {
      const res = await apiFetch(`/api/term/replay/${sessionId}?tailBytes=20000`);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      const text = await res.text();
      setReplayText(stripAnsi(text) || t("(空)"));
    } catch (e: any) {
      setReplayText(t("[错误] {msg}", { msg: e?.message ?? String(e) }));
    } finally {
      setReplayLoading(false);
    }
  }, [t]);

  const saveSessionForMode = useCallback((mode: TermMode, session: TermSessionRecord) => {
    if (mode === "cursor") return;
    const map = readSessionsByMode();
    map[mode] = { sessionId: session.sessionId, cwd: session.cwd, mode: session.mode };
    writeSessionsByMode(map);
  }, []);

  const getSessionForMode = useCallback((mode: TermMode): TermSessionRecord | null => {
    if (mode === "cursor") return null;
    const map = readSessionsByMode();
    const entry = map[mode];
    return entry?.sessionId ? entry : null;
  }, []);

  const clearSessionById = useCallback((sessionId: string) => {
    if (!sessionId) return;
    const map = readSessionsByMode();
    let changed = false;
    for (const key of Object.keys(map)) {
      const entry = (map as any)[key] as TermSessionRecord | undefined;
      if (entry?.sessionId === sessionId) {
        delete (map as any)[key];
        changed = true;
      }
    }
    if (changed) writeSessionsByMode(map);
  }, []);

  const clearSavedSession = useCallback((sessionId: string) => {
    try {
      const raw = localStorage.getItem(LAST_TERM_SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { sessionId?: string };
      if (saved?.sessionId === sessionId) {
        localStorage.removeItem(LAST_TERM_SESSION_KEY);
      }
    } catch {}
    clearSessionById(sessionId);
  }, [clearSessionById]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (sessionId === termSessionIdRef.current) {
      setStatus(t("[提示] 当前会话无法直接删除，请先切换或关闭终端"));
      return;
    }
    try {
      const res = await apiFetch(`/api/term/sessions/${sessionId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Delete failed");
      setTermSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      clearSavedSession(sessionId);
    } catch (e: any) {
      setStatus(t("[错误] 删除会话: {msg}", { msg: e?.message ?? String(e) }));
    }
  }, [clearSavedSession, t]);

  // PC 端三块区域折叠状态（仅桌面端生效）
  const [panelExplorerCollapsed, setPanelExplorerCollapsed] = useState(false);
  const [panelEditorCollapsed, setPanelEditorCollapsed] = useState(false); // 编辑器不再折叠，保留状态占位
  const [panelTerminalCollapsed, setPanelTerminalCollapsed] = useState(false);
  const explorerCollapsed = isMobile ? panelExplorerCollapsed : false;
  const terminalCollapsed = isMobile ? panelTerminalCollapsed : false;

  const [roots, setRoots] = useState<string[]>([]);
  const [activeRoot, setActiveRoot] = useState("");
  const [tree, setTree] = useState<TreeNode | null>(null);
  const treeRef = useRef<TreeNode | null>(null);
  const expandingTreeRef = useRef(false);
  const lastSyncedExplorerRootRef = useRef<string>("");
  const lastSyncedExplorerPathRef = useRef<string>("");
  const manualRootOverrideRef = useRef(false);
  const autoExpandSeqRef = useRef(0);
  const autoExpandRequestRef = useRef<{ id: number; root: string; path: string } | null>(null);
  const userCollapsedByRootRef = useRef<Map<string, Set<string>>>(new Map());
  const markUserCollapsed = useCallback((root: string, path: string) => {
    if (!root) return;
    const map = userCollapsedByRootRef.current;
    const existing = map.get(root);
    const set = existing ? new Set(existing) : new Set<string>();
    set.add(path);
    map.set(root, set);
  }, []);

  const clearUserCollapsed = useCallback((root: string, path: string) => {
    if (!root) return;
    const map = userCollapsedByRootRef.current;
    const set = map.get(root);
    if (!set) return;
    set.delete(path);
    if (set.size === 0) map.delete(root);
  }, []);

  const isPathBlockedByCollapse = useCallback((root: string, path: string) => {
    if (!root) return false;
    const set = userCollapsedByRootRef.current.get(root);
    if (!set || set.size === 0) return false;
    for (const collapsed of set) {
      if (path === collapsed || path.startsWith(`${collapsed}/`)) return true;
    }
    return false;
  }, []);

  const fileListRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<string>("");
  const [terminalCwd, setTerminalCwd] = useState<string>("");

  // Dark mode effect
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", isDarkMode ? "dark" : "light");
    setStored("darkMode", String(isDarkMode));
  }, [isDarkMode]);

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((prev) => !prev);
  }, []);

  // Auto-hide status toast after 3 seconds
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => {
      setStatus("");
    }, 3000);
    return () => clearTimeout(timer);
  }, [status]);

  // Escape closes mobile workspace drawer
  useEffect(() => {
    if (!mobileWorkspaceDrawerOpen || !isMobile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileWorkspaceDrawerOpen(false);
        mobileSidebarToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileWorkspaceDrawerOpen, isMobile]);

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [fileStateByPath, setFileStateByPath] = useState<
    Record<string, { text: string; dirty: boolean; info: { size: number; mtimeMs: number } | null }>
  >({});
  const restoredRootRef = useRef<string>("");
  const [explorerUserPath, setExplorerUserPath] = useState<string>("");
  const [selectedExplorerPath, setSelectedExplorerPath] = useState<string>("");

  const activeState = activeFile ? fileStateByPath[activeFile] : undefined;
  const fileText = activeState?.text ?? "";
  const dirty = activeState?.dirty ?? false;
  const fileInfo = activeState?.info ?? null;

  const termAreaWrapRef = useRef<HTMLDivElement | null>(null);
  const termDivRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termClientRef = useRef<TermClient | null>(null);
  const termSessionIdRef = useRef<string>("");
  const termSessionModeRef = useRef<"restricted" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "cursor-cli-agent" | "cursor-cli-plan" | "cursor-cli-ask" | "native" | "">("");
  const termSessionIsPtyRef = useRef(false);
  const termPendingStdinRef = useRef<string>(""); // buffer keystrokes before a session is ready
  // Buffer term.data that arrives before term.open.resp (sessionId not set yet) so we don't drop initial output
  const termPendingDataBufferRef = useRef<Map<string, string[]>>(new Map());
  const [termMode, setTermMode] = useState<TermMode>("cursor");
  const termModeRef = useRef<TermMode>("cursor");
  const [restrictedNonce, setRestrictedNonce] = useState(0);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [openNonce, setOpenNonce] = useState(0);
  const pendingOpenRef = useRef<{ mode: TermMode; cwd?: string } | null>(null);
  const pendingAttachRef = useRef<{ sessionId: string; cwd?: string; mode?: string; noFallback?: boolean } | null>(null);
  const autoAttachPreparedRef = useRef(false);
  const [cursorMode, setCursorMode] = useState<"agent" | "plan" | "ask">("agent");
  const cursorModeRef = useRef<"agent" | "plan" | "ask">("agent");
  const [cursorCliMode, setCursorCliMode] = useState<"agent" | "plan" | "ask">("agent");
  const cursorCliModeRef = useRef<"agent" | "plan" | "ask">("agent");
  const termCwdRef = useRef<string>("");
  const lastOpenKeyRef = useRef<string>("");
  const cursorPromptNudgedRef = useRef(false);
  const termInitedRef = useRef(false);

  const logTerm = (..._args: any[]) => {};
  const termResizeObsRef = useRef<ResizeObserver | null>(null);
  const termInputBufRef = useRef<string>("");

  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteModalText, setPasteModalText] = useState("");
  const pasteModalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalType, setCreateModalType] = useState<"file" | "folder">("file");
  const [createModalName, setCreateModalName] = useState("");
  const [createModalParent, setCreateModalParent] = useState("");
  const createModalInputRef = useRef<HTMLInputElement | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const deleteConfirmInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const imageUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [mobileKeysVisible, setMobileKeysVisible] = useState(false);
  const mobileKeysTouchedRef = useRef(false);
  const termMobileControlsRef = useRef<HTMLDivElement | null>(null);
  const lastMobileControlsHRef = useRef<number>(-1);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const chatHeaderContainerRef = useRef<HTMLDivElement | null>(null);
  const collapsedPanelWidth = 48;
  const splitGapPercent = 2;

  const buildOpenKey = useCallback(
    (cwd: string, uiMode: TermMode, cliMode: "agent" | "plan" | "ask") =>
      `${cwd}::${uiMode}` +
      (uiMode === "cursor-cli" ? `::${cliMode}` : "") +
      (uiMode === "restricted" ? `::r${restrictedNonce}` : "") +
      `::restore${restoreNonce}`,
    [restrictedNonce, restoreNonce],
  );

  const mapSessionMode = useCallback((mode?: string) => {
    const fallbackCli = cursorCliModeRef.current;
    if (!mode) {
      return {
        uiMode: termModeRef.current,
        cliMode: fallbackCli,
        sessionMode: termModeRef.current === "cursor-cli" ? `cursor-cli-${fallbackCli}` : termModeRef.current,
        isPty: termModeRef.current !== "restricted",
      };
    }
    if (mode.startsWith("cursor-cli-")) {
      const sub = mode.replace("cursor-cli-", "");
      const cliMode = sub === "plan" || sub === "ask" ? (sub as "plan" | "ask") : "agent";
      return { uiMode: "cursor-cli" as TermMode, cliMode, sessionMode: mode, isPty: true };
    }
    if (mode === "codex" || mode === "claude" || mode === "opencode" || mode === "gemini" || mode === "kimi" || mode === "qwen") {
      return { uiMode: mode as TermMode, cliMode: fallbackCli, sessionMode: mode, isPty: true };
    }
    if (mode === "restricted-pty") {
      return { uiMode: "restricted" as TermMode, cliMode: fallbackCli, sessionMode: "restricted", isPty: true };
    }
    if (mode === "restricted-exec" || mode === "native") {
      return { uiMode: "restricted" as TermMode, cliMode: fallbackCli, sessionMode: "restricted", isPty: false };
    }
    return { uiMode: "restricted" as TermMode, cliMode: fallbackCli, sessionMode: "restricted", isPty: false };
  }, []);

  const showNoSessionHint = useCallback((mode: TermMode) => {
    const term = termRef.current;
    if (!term || mode === "cursor") return;
    term.reset();
    term.write(`${t("[提示] {tool} 暂无会话，点击“新建”创建。", { tool: t(getToolDef(modeToToolId(mode)).label) })}\r\n`);
  }, [t]);

  const detachActiveSession = useCallback((nextMode?: TermMode) => {
    const sid = termSessionIdRef.current;
    if (sid) {
      const currentMode = termModeRef.current;
      const sessionMode = termSessionModeRef.current || currentMode;
      saveSessionForMode(currentMode, { sessionId: sid, cwd: termCwdRef.current || terminalCwd, mode: sessionMode });
    }
    termSessionIdRef.current = "";
    termSessionModeRef.current = "";
    termSessionIsPtyRef.current = false;
    termPendingStdinRef.current = "";
    termPendingDataBufferRef.current.clear();
    if (nextMode && nextMode !== "cursor") {
      showNoSessionHint(nextMode);
    }
  }, [saveSessionForMode, showNoSessionHint, terminalCwd]);

  const handleSelectTool = useCallback((id: ToolId) => {
    const nextMode = toolIdToMode(id);
    if (nextMode === termModeRef.current) return;
    if (nextMode === "restricted") {
      setRestrictedNonce((n) => n + 1);
    }
    detachActiveSession(nextMode);
    setTermMode(nextMode);
    if (nextMode !== "cursor") {
      const saved = getSessionForMode(nextMode);
      if (saved?.sessionId) {
        pendingAttachRef.current = { sessionId: saved.sessionId, cwd: saved.cwd, mode: saved.mode, noFallback: true };
        setRestoreNonce((n) => n + 1);
      } else {
        setStatus(t("[提示] 当前模式暂无会话，请点击“新建”"));
      }
      termRef.current?.focus();
      setTimeout(() => termRef.current?.focus(), 50);
    }
  }, [detachActiveSession, getSessionForMode]);

  const handleNewSession = useCallback(() => {
    if (termModeRef.current === "cursor") return;
    if (!terminalCwd) {
      setStatus(t("[提示] 请先选择工作目录"));
      return;
    }
    detachActiveSession();
    pendingAttachRef.current = null;
    pendingOpenRef.current = { mode: termModeRef.current, cwd: terminalCwd };
    setOpenNonce((n) => n + 1);
  }, [detachActiveSession, terminalCwd]);

  useEffect(() => {
    if (autoAttachPreparedRef.current) return;
    if (termSessionIdRef.current) {
      autoAttachPreparedRef.current = true;
      return;
    }
    const raw =
      localStorage.getItem(LAST_TERM_SESSION_KEY);
    if (!raw) {
      autoAttachPreparedRef.current = true;
      return;
    }
    try {
      const saved = JSON.parse(raw) as { sessionId?: string; cwd?: string; mode?: string };
      if (!saved?.sessionId) {
        autoAttachPreparedRef.current = true;
        return;
      }
      pendingAttachRef.current = { sessionId: saved.sessionId, cwd: saved.cwd, mode: saved.mode, noFallback: true };
      const mapped = mapSessionMode(saved.mode);
      if (mapped.uiMode !== termModeRef.current) setTermMode(mapped.uiMode);
      if (mapped.cliMode !== cursorCliModeRef.current) setCursorCliMode(mapped.cliMode);
      if (saved.cwd && saved.cwd !== terminalCwd) setTerminalCwd(saved.cwd);
      if (isMobile) setMobileTab("terminal");
      autoAttachPreparedRef.current = true;
    } catch {
      autoAttachPreparedRef.current = true;
    }
  }, [isMobile, mapSessionMode, terminalCwd]);

  const handleRestoreSession = useCallback((s: { sessionId: string; cwd?: string; mode?: string }) => {
    pendingAttachRef.current = { sessionId: s.sessionId, cwd: s.cwd, mode: s.mode, noFallback: true };
    const mapped = mapSessionMode(s.mode);
    if (mapped.uiMode !== termModeRef.current) setTermMode(mapped.uiMode);
    if (mapped.cliMode !== cursorCliModeRef.current) setCursorCliMode(mapped.cliMode);
    if (s.cwd) setTerminalCwd(s.cwd);
    setRestoreNonce((n) => n + 1);
    if (isMobile) setMobileTab("terminal");
  }, [isMobile, mapSessionMode]);

  const terminalVisible = !isMobile || mobileTab === "terminal";
  const enabledToolIds = useMemo(
    () => toolSettings.filter((t): t is UiToolSetting & { id: ToolId } => t.enabled && isToolId(t.id)).map((t) => t.id),
    [toolSettings],
  );
  const activeToolId = modeToToolId(termMode);
  const commandDirty = useMemo(() => {
    if (!commandSettings) return false;
    const toNum = (v: string, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const whitelist = parseCommandList(commandWhitelistText);
    const denylist = parseCommandList(commandDenylistText);
    return (
      commandMode !== commandSettings.mode ||
      JSON.stringify(whitelist) !== JSON.stringify(commandSettings.whitelist) ||
      JSON.stringify(denylist) !== JSON.stringify(commandSettings.denylist) ||
      toNum(commandTimeoutSec, commandSettings.timeoutSec) !== commandSettings.timeoutSec ||
      toNum(commandMaxOutputKB, commandSettings.maxOutputKB) !== commandSettings.maxOutputKB
    );
  }, [
    commandSettings,
    commandMode,
    commandWhitelistText,
    commandDenylistText,
    commandTimeoutSec,
    commandMaxOutputKB,
  ]);

  useEffect(() => {
    if (enabledToolIds.length === 0) return;
    if (!enabledToolIds.includes(activeToolId)) {
      const next = enabledToolIds[0]!;
      const nextMode = toolIdToMode(next);
      if (nextMode === "restricted") setRestrictedNonce((n) => n + 1);
      setTermMode(nextMode);
    }
  }, [enabledToolIds, activeToolId]);

  useEffect(() => {
    if (leftPanelTab === "windows") {
      void refreshTermSessions();
    }
  }, [leftPanelTab, refreshTermSessions]);

  useEffect(() => {
    if (!uiStateLoadedRef.current) return;
    const next: UiState = {
      mobileTab,
      leftPanelTab,
      termMode,
      cursorMode,
      cursorCliMode,
      editorMode,
      panelExplorerCollapsed: isMobile ? panelExplorerCollapsed : false,
      panelEditorCollapsed,
      panelTerminalCollapsed: isMobile ? panelTerminalCollapsed : false,
      leftWidth,
      topHeight,
      mobileKeysVisible,
      fontSize: uiFontSize,
    };
    if (uiStateSaveTimerRef.current) window.clearTimeout(uiStateSaveTimerRef.current);
    uiStateSaveTimerRef.current = window.setTimeout(() => {
      apiSetUiState(next).catch(() => {});
    }, 600);
    return () => {
      if (uiStateSaveTimerRef.current) window.clearTimeout(uiStateSaveTimerRef.current);
    };
  }, [
    mobileTab,
    leftPanelTab,
    termMode,
    cursorMode,
    cursorCliMode,
    editorMode,
    panelExplorerCollapsed,
    panelEditorCollapsed,
    panelTerminalCollapsed,
    leftWidth,
    topHeight,
    mobileKeysVisible,
    uiFontSize,
    isMobile,
  ]);

  const sendTermInput = useCallback((data: string) => {
    const term = termRef.current;
    const client = termClientRef.current;
    const sid = termSessionIdRef.current;
    if (!term || !client) return;
    if (!sid) {
      if (pendingOpenRef.current || pendingAttachRef.current) {
        termPendingStdinRef.current += data;
      } else {
        setStatus(t("[提示] 当前模式暂无会话，请点击“新建”"));
      }
      return;
    }

    const isPty = termSessionIsPtyRef.current;
    if (!isPty) {
      const isEnter = data === "\r" || data === "\n" || data === "\r\n";
      if (termModeRef.current === "restricted") {
        if (data === "\u007f" || data === "\b") {
          termInputBufRef.current = termInputBufRef.current.slice(0, -1);
          term.write("\b \b");
        } else if (isEnter) {
          const line = termInputBufRef.current.trim();
          termInputBufRef.current = "";
          term.write("\r\n");
          if (line === "codex") {
            term.write(`${t("[启动 codex…]")}\r\n`);
            setTermMode("codex");
            return;
          }
        } else {
          termInputBufRef.current += data;
          term.write(data);
        }
      } else {
        if (data === "\u007f" || data === "\b") term.write("\b \b");
        else term.write(data);
      }
    }

    void client.stdin(sid, data).catch((e) => {
      if (termModeRef.current === "codex" || termModeRef.current === "claude" || termModeRef.current === "opencode" || termModeRef.current === "gemini" || termModeRef.current === "kimi" || termModeRef.current === "qwen" || termModeRef.current === "cursor-cli") {
        term.write(`\r\n${t("[错误] {msg}", { msg: e?.message ?? String(e) })}\r\n`);
      } else {
        term.write(`\r\n${t("[错误] {msg}", { msg: e?.message ?? String(e) })}\r\n$ `);
      }
    });
  }, [t]);

  const handleTermKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (termModeRef.current !== "cursor-cli") return;
      if (!termSessionIsPtyRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      let data: string | null = null;
      switch (e.key) {
        case "ArrowUp":
          data = "\x1b[A";
          break;
        case "ArrowDown":
          data = "\x1b[B";
          break;
        case "ArrowLeft":
          data = "\x1b[D";
          break;
        case "ArrowRight":
          data = "\x1b[C";
          break;
        case "Enter":
          data = "\r";
          break;
        case "Backspace":
          data = "\x7f";
          break;
        default:
          if (e.key.length === 1) data = e.key;
      }

      if (data) {
        e.preventDefault();
        sendTermInput(data);
      }
    },
    [sendTermInput],
  );

  useEffect(() => {
    termModeRef.current = termMode;
  }, [termMode]);

  useEffect(() => {
    cursorModeRef.current = cursorMode;
  }, [cursorMode]);

  useEffect(() => {
    cursorCliModeRef.current = cursorCliMode;
  }, [cursorCliMode]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    // Safari legacy fallback
    // eslint-disable-next-line deprecation/deprecation
    mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply);
    return () => {
      // eslint-disable-next-line deprecation/deprecation
      mq.removeEventListener ? mq.removeEventListener("change", apply) : mq.removeListener(apply);
    };
  }, []);

  useEffect(() => {
    if (settingsTouchedRef.current) return;
    if (isMobile) {
      setSettingsOpen({ tools: true, language: false, security: false });
    } else {
      setSettingsOpen({ tools: true, language: true, security: true });
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (termMode === "cursor") return;
    if (mobileKeysTouchedRef.current) return;
    setMobileKeysVisible(true);
  }, [isMobile, termMode]);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const newWidth = e.clientX - 10;
      if (newWidth >= 200 && newWidth <= 600) {
        setLeftWidth(newWidth);
      }
    };
    const onMouseUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  const rightPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDraggingVertical) return;
    const onMouseMove = (e: MouseEvent) => {
      const rightPanel = rightPanelRef.current;
      if (!rightPanel) return;
      const rect = rightPanel.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const newWidthPercent = (offsetX / rect.width) * 100;
      // newWidthPercent is the divider position from left (i.e. Editor width %)
      // We store Terminal width %, so invert it.
      if (newWidthPercent >= 30 && newWidthPercent <= 80) {
        setTopHeight(100 - newWidthPercent);
      }
    };
    const onMouseUp = () => setIsDraggingVertical(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDraggingVertical]);

  const ready = useMemo(() => roots.length > 0 && activeRoot.length > 0, [roots, activeRoot]);

  const safeFitTerm = useCallback(() => {
    const el = termDivRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!el || !fit || !term) return;
    // Force reflow so hidden→visible container has up-to-date dimensions (e.g. after Cursor→Codex)
    void el.offsetHeight;
    if (el.clientWidth <= 0 || el.clientHeight <= 0) {
      try {
        fit.fit();
      } catch {
        // ignore; will retry on next delayed fit
      }
      return;
    }
    const core = (term as any)?._core;
    const dims = core?._renderService?._renderer?.dimensions;
    if (!dims) {
      try {
        fit.fit();
      } catch {
        // ignore
      }
      return;
    }
    try {
      fit.fit();
    } catch {
      // ignore
    }
  }, []);

  const fitAndResize = useCallback(() => {
    safeFitTerm();
    const sid = termSessionIdRef.current;
    const client = termClientRef.current;
    const term = termRef.current;
    if (!sid || !client || !term) return;
    void client.resize(sid, term.cols, term.rows).catch(() => {});
  }, [safeFitTerm]);

  // Mobile: when the on-screen keyboard overlays the bottom area (iOS Safari), push the terminal panes up
  // by the measured keyboard height. This keeps the last rows visible and lets xterm refit cleanly.
  useEffect(() => {
    const wrap = termAreaWrapRef.current;
    if (!wrap) return;

    if (!isMobile || !terminalVisible || termMode === "cursor") {
      wrap.style.setProperty("--term-kb-bottom", "0px");
      return;
    }

    let raf = 0;
    let lastApplied = -1;
    const vv = window.visualViewport ?? null;

    const computeKeyboardBottom = () => {
      if (!vv) return 0;
      // When the keyboard is open on iOS Safari, innerHeight often stays stable while visualViewport shrinks.
      const px = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
      // Avoid reacting to minor chrome/address-bar changes; keyboard is usually much larger.
      return px >= 80 ? px : 0;
    };

    const applyNow = () => {
      const kb = computeKeyboardBottom();
      if (kb === lastApplied) return;
      lastApplied = kb;
      wrap.style.setProperty("--term-kb-bottom", `${kb}px`);
      // Let layout settle, then refit xterm so rows/cols match the new height.
      requestAnimationFrame(() => {
        fitAndResize();
        setTimeout(fitAndResize, 50);
      });
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyNow();
      });
    };

    applyNow();
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      wrap.style.setProperty("--term-kb-bottom", "0px");
    };
  }, [isMobile, terminalVisible, termMode, fitAndResize]);

  // Mobile: measure the height of the "dpad + input" controls so panes can be lifted precisely
  // (instead of hardcoding a padding/bottom value).
  useEffect(() => {
    const wrap = termAreaWrapRef.current;
    if (!wrap) return;

    if (!isMobile || !terminalVisible || termMode === "cursor" || !mobileKeysVisible) {
      wrap.style.setProperty("--term-mobile-controls-h", "0px");
      lastMobileControlsHRef.current = -1;
      return;
    }

    const controls = termMobileControlsRef.current;
    if (!controls) {
      wrap.style.setProperty("--term-mobile-controls-h", "0px");
      lastMobileControlsHRef.current = -1;
      return;
    }

    let raf = 0;
    const applyNow = () => {
      const h = Math.max(0, Math.ceil(controls.getBoundingClientRect().height));
      if (h === lastMobileControlsHRef.current) return;
      lastMobileControlsHRef.current = h;
      wrap.style.setProperty("--term-mobile-controls-h", `${h}px`);
      requestAnimationFrame(() => {
        fitAndResize();
        setTimeout(fitAndResize, 50);
      });
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyNow();
      });
    };

    applyNow();
    const ro = new ResizeObserver(schedule);
    ro.observe(controls);
    window.addEventListener("resize", schedule);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      wrap.style.setProperty("--term-mobile-controls-h", "0px");
      lastMobileControlsHRef.current = -1;
    };
  }, [isMobile, terminalVisible, termMode, mobileKeysVisible, fitAndResize]);

  // Refit after refresh/font-load to avoid row/column glitches.
  useEffect(() => {
    if (!terminalVisible || termMode === "cursor") return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      fitAndResize();
    };
    const t1 = setTimeout(run, 120);
    const t2 = setTimeout(run, 420);
    const t3 = setTimeout(run, 900);
    const fonts = (document as any).fonts as FontFaceSet | undefined;
    if (fonts?.ready) {
      fonts.ready.then(run).catch(() => {});
    }
    window.addEventListener("resize", run);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      window.removeEventListener("resize", run);
    };
  }, [terminalVisible, termMode, fitAndResize]);

  // Sometimes after switching Cursor <-> Codex/Restricted, the terminal container DOM may be re-created
  // (or third-party children removed), leaving the term div empty:
  // <div class="term termPane termPaneActive"></div>
  // In that case, re-attach xterm to the current container and refit.
  const ensureTermAttached = useCallback(() => {
    const el = termDivRef.current;
    const term = termRef.current;
    if (!el || !term) return;

    const existingXterm = el.querySelector(".xterm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const termElement = (term as any)?.element as HTMLElement | undefined | null;
    const attachedHere = termElement ? el.contains(termElement) : false;
    if (existingXterm && attachedHere) return;

    // Best-effort detach from any previous parent and clear the container before re-opening.
    try {
      if (termElement?.parentElement && termElement.parentElement !== el) {
        termElement.parentElement.removeChild(termElement);
      }
    } catch {}
    try {
      // Clear any stale nodes to avoid duplicates when re-opening.
      el.innerHTML = "";
    } catch {}
    try {
      term.open(el);
    } catch {}
  }, []);

  useEffect(() => {
    apiRoots()
      .then(async (r) => {
        setRoots(r.roots);
        let dbRoot: string | null = null;
        try {
          const res = await apiGetActiveRoot();
          dbRoot = res.root;
        } catch {}
        // Try to restore last active root from SQLite, then localStorage
        const saved = getStored("activeRoot");
        const defaultRoot =
          ((dbRoot && r.roots.includes(dbRoot) ? dbRoot : null) ??
            (saved && r.roots.includes(saved) ? saved : null) ??
            r.roots[0]) ||
          "";
        setActiveRoot((prev) => prev || defaultRoot);
      })
      .catch((e) => setStatus(t("[错误] 根目录: {msg}", { msg: e?.message ?? String(e) })));
  }, []);

  // Persist activeRoot to localStorage
  useEffect(() => {
    if (activeRoot) {
      setStored("activeRoot", activeRoot);
      apiSetActiveRoot(activeRoot).catch(() => {});
    }
  }, [activeRoot]);

  useEffect(() => {
    if (activeRoot) {
      setStored("lastExplorerRoot", activeRoot);
    }
  }, [activeRoot]);

  const resolveRootForCwd = useCallback(
    (cwd: string) => {
      if (roots.length === 0) return "";
      let best = "";
      for (const r of roots) {
        if (cwd === r || cwd.startsWith(r + "/")) {
          if (r.length > best.length) best = r;
        }
      }
      return best || activeRoot;
    },
    [roots, activeRoot],
  );

  const syncExplorerRootForCwd = useCallback(
    (cwd: string, opts?: { force?: boolean }) => {
      if (manualRootOverrideRef.current && !opts?.force) return;
      const root = resolveRootForCwd(cwd);
      if (!root) return;
      if (root && root !== activeRoot) {
        setActiveRoot(root);
      }
    },
    [resolveRootForCwd, activeRoot],
  );

  const openTerminalDir = useCallback(
    (node: TreeNode) => {
      if (!node?.path) return;
      setTerminalCwd(node.path);
      setSelectedExplorerPath(node.path);
      if (isMobile) setMobileTab("terminal");
    },
    [isMobile],
  );

  const ensureLargeFileAllowed = useCallback(
    async (path: string, size?: number) => {
      let actualSize = typeof size === "number" && Number.isFinite(size) ? size : null;
      if (actualSize === null) {
        try {
          const st = await apiStat(path);
          if (typeof st.size === "number" && Number.isFinite(st.size)) {
            actualSize = st.size;
          }
        } catch {}
      }

      if (actualSize !== null && actualSize > LARGE_FILE_HARD_LIMIT_BYTES) {
        setStatus(
          t("[错误] 文件过大：{name} {size} > {limit}", {
            name: baseName(path),
            size: bytes(actualSize),
            limit: bytes(LARGE_FILE_HARD_LIMIT_BYTES),
          }),
        );
        return { ok: false, force: false };
      }

      if (actualSize !== null && actualSize > LARGE_FILE_THRESHOLD_BYTES) {
        const ok = window.confirm(
          t("文件“{name}”大小为 {size}，超过 {threshold}。是否继续打开？", {
            name: baseName(path),
            size: bytes(actualSize),
            threshold: bytes(LARGE_FILE_THRESHOLD_BYTES),
          }),
        );
        if (!ok) {
          setStatus(t("[提示] 已取消打开 {name}", { name: baseName(path) }));
          return { ok: false, force: false };
        }
        return { ok: true, force: true };
      }

      return { ok: true, force: false };
    },
    [t],
  );

  const initializedCwdRef = useRef(false);

  useEffect(() => {
    if (!activeRoot) return;
    if (!initializedCwdRef.current) {
      initializedCwdRef.current = true;
      const savedCwd = getStored("terminalCwd");
      // Only use saved cwd if it starts with the active root (valid path)
      if (savedCwd && savedCwd.startsWith(activeRoot)) {
        setTerminalCwd(savedCwd);
        return;
      }
    }
    if (!terminalCwd || !terminalCwd.startsWith(activeRoot)) {
      setTerminalCwd(activeRoot);
    }
  }, [activeRoot, terminalCwd]);

  // Persist terminalCwd to localStorage
  useEffect(() => {
    if (terminalCwd) {
      setStored("terminalCwd", terminalCwd);
    }
  }, [terminalCwd]);

  useEffect(() => {
    if (roots.length === 0 || !terminalCwd) return;
    syncExplorerRootForCwd(terminalCwd);
  }, [roots.length, terminalCwd, syncExplorerRootForCwd]);

  useEffect(() => {
    if (!activeRoot || !terminalCwd) return;
    if (!terminalCwd.startsWith(activeRoot)) return;
    setStored(`lastExplorerPath:${activeRoot}`, terminalCwd);
  }, [activeRoot, terminalCwd]);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const explorerTargetPath = useMemo(() => {
    if (!activeRoot) return "";
    if (explorerUserPath && explorerUserPath.startsWith(activeRoot)) return explorerUserPath;
    if (terminalCwd && terminalCwd.startsWith(activeRoot)) return terminalCwd;
    const saved = getStored(`lastExplorerPath:${activeRoot}`) || "";
    if (saved && saved.startsWith(activeRoot)) return saved;
    return activeRoot;
  }, [activeRoot, terminalCwd, explorerUserPath]);

  useEffect(() => {
    if (!explorerTargetPath) return;
    setSelectedExplorerPath((prev) => {
      if (prev && activeRoot && prev.startsWith(activeRoot)) return prev;
      return explorerTargetPath;
    });
  }, [explorerTargetPath, activeRoot]);

  useEffect(() => {
    lastSyncedExplorerRootRef.current = "";
    lastSyncedExplorerPathRef.current = "";
  }, [terminalCwd, activeRoot]);

  const scrollToTerminalCwd = useCallback((): boolean => {
    if (!explorerTargetPath) return false;
    if (!fileListRef.current) return false;
    if (!isMobile && explorerCollapsed) return false;
    if (isMobile && mobileTab !== "explorer") return false;
    const escape = (globalThis as any).CSS?.escape ?? ((v: string) => v.replace(/["\\]/g, "\\$&"));
    const selector = `[data-path="${escape(explorerTargetPath)}"]`;
    const target = fileListRef.current.querySelector(selector) as HTMLElement | null;
    if (!target) return false;
    target.scrollIntoView({ block: "start" });
    return true;
  }, [explorerTargetPath, isMobile, mobileTab, explorerCollapsed]);

  useEffect(() => {
    if (!activeRoot) return;
    const rootNode: TreeNode = { path: activeRoot, name: baseName(activeRoot), type: "dir", expanded: true };
    setTree(rootNode);
    // Load root children
    (async () => {
      try {
        setTree((t) => (t ? { ...t, loading: true } : t));
        const r = await apiList(activeRoot);
        const children: TreeNode[] = r.entries.map((e) => ({
          path: joinPath(r.path, e.name),
          name: e.name,
          type: e.type,
          size: e.size,
          mtimeMs: e.mtimeMs,
        }));
        setTree((t) => (t ? { ...t, loading: false, loaded: true, children } : t));
      } catch (e: any) {
        setStatus(t("[错误] 列表: {msg}", { msg: e?.message ?? String(e) }));
        setTree((t) => (t ? { ...t, loading: false } : t));
      }
    })();
  }, [activeRoot]);

  useEffect(() => {
    if (!activeRoot || !explorerTargetPath) return;
    if (!explorerTargetPath.startsWith(activeRoot)) return;
    if (!treeRef.current) return;
    if (expandingTreeRef.current) return;

    // Only skip re-expand when we already synced this path and tree changed due to user collapse.
    // Set lastSynced only after expandToPath completes so initial load and tree-with-children updates still run.
    if (
      lastSyncedExplorerRootRef.current === activeRoot &&
      lastSyncedExplorerPathRef.current === explorerTargetPath
    ) {
      return;
    }

    const rootToSync = activeRoot;
    const pathToSync = explorerTargetPath;
    if (isPathBlockedByCollapse(rootToSync, pathToSync)) {
      lastSyncedExplorerRootRef.current = rootToSync;
      lastSyncedExplorerPathRef.current = pathToSync;
      return;
    }
    const waitForNode = async (path: string, attempts = 20): Promise<TreeNode | null> => {
      for (let i = 0; i < attempts; i += 1) {
        const currentTree = treeRef.current;
        const node = currentTree ? findNode(currentTree, path) : null;
        if (node) return node;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };

    const expandToPath = async () => {
      expandingTreeRef.current = true;
      try {
        const rel = pathToSync.slice(rootToSync.length).replace(/^\/+/, "");
        const parts = rel ? rel.split("/") : [];
        let currentPath = rootToSync;

        for (const part of parts) {
          currentPath = joinPath(currentPath, part);
          const node = await waitForNode(currentPath);
          if (!node || node.type !== "dir") return;

          if (!node.expanded) {
            setTree((prev) =>
              prev
                ? updateNode(prev, node.path, (n) => ({
                    ...n,
                    expanded: true,
                    loading: n.loaded ? false : true,
                  }))
                : prev,
            );
          }

          if (!node.loaded) {
            try {
              const r = await apiList(node.path);
              const children: TreeNode[] = r.entries.map((e: FsEntry) => ({
                path: joinPath(r.path, e.name),
                name: e.name,
                type: e.type,
                size: e.size,
                mtimeMs: e.mtimeMs,
              }));
              setTree((prev) =>
                prev
                  ? updateNode(prev, node.path, (n) => ({
                      ...n,
                      expanded: true,
                      loading: false,
                      loaded: true,
                      children,
                    }))
                  : prev,
              );
              await new Promise((r) => setTimeout(r, 0));
            } catch (e: any) {
              setStatus(t("[错误] 列表: {msg}", { msg: e?.message ?? String(e) }));
              setTree((prev) =>
                prev ? updateNode(prev, node.path, (n) => ({ ...n, loading: false })) : prev,
              );
              return;
            }
          }
        }
      } finally {
        expandingTreeRef.current = false;
        lastSyncedExplorerRootRef.current = rootToSync;
        lastSyncedExplorerPathRef.current = pathToSync;
        setTimeout(() => {
          scrollToTerminalCwd();
        }, 50);
      }
    };

    void expandToPath();
  }, [activeRoot, explorerTargetPath, scrollToTerminalCwd, tree]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const ok = scrollToTerminalCwd();
      if (!ok) {
        setTimeout(() => {
          scrollToTerminalCwd();
        }, 80);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [scrollToTerminalCwd, tree]);

  // Restore last opened file from SQLite when activeRoot changes
  useEffect(() => {
    if (!activeRoot) return;
    if (restoredRootRef.current === activeRoot) return;
    let cancelled = false;
    const restoreFromPath = async (path: string) => {
      if (!path.startsWith(activeRoot)) return;
      const guard = await ensureLargeFileAllowed(path);
      if (!guard.ok) return;
      const r = await apiRead(path, guard.force ? { maxBytes: LARGE_FILE_HARD_LIMIT_BYTES } : undefined);
      if (cancelled) return;
      setOpenTabs((prev) => (prev.includes(r.path) ? prev : [r.path]));
      setActiveFile(r.path);
      setFileStateByPath((prev) => ({
        ...prev,
        [r.path]: { text: r.text, dirty: false, info: { size: r.size, mtimeMs: r.mtimeMs } },
      }));
      setEditorMode("edit");
    };

    apiGetLastOpenedFile(activeRoot)
      .then((res) => {
        if (cancelled) return;
        restoredRootRef.current = activeRoot;
        if (res.filePath) return restoreFromPath(res.filePath);
        const fallback = getStored(`lastOpenedFile:${activeRoot}`);
        if (fallback) return restoreFromPath(fallback);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeRoot, activeFile, openTabs.length]);

  const toggleDir = async (node: TreeNode) => {
    setSelectedExplorerPath(node.path);
    setExplorerUserPath(node.path);
    // Collapse
    if (node.expanded) {
      if (activeRoot) markUserCollapsed(activeRoot, node.path);
      setTree((prev) => (prev ? updateNode(prev, node.path, (n) => ({ ...n, expanded: false })) : prev));
      return;
    }

    // Expand (and show loading placeholder immediately)
    if (activeRoot) clearUserCollapsed(activeRoot, node.path);
    setTree((prev) =>
      prev
        ? updateNode(prev, node.path, (n) => ({
            ...n,
            expanded: true,
            loading: n.loaded ? false : true,
          }))
        : prev,
    );
    if (node.loaded) return;
    try {
      const r = await apiList(node.path);
      const children: TreeNode[] = r.entries.map((e: FsEntry) => ({
        path: joinPath(r.path, e.name),
        name: e.name,
        type: e.type,
        size: e.size,
        mtimeMs: e.mtimeMs,
      }));
      setTree((prev) =>
        prev
          ? updateNode(prev, node.path, (n) => ({ ...n, expanded: true, loading: false, loaded: true, children }))
          : prev,
      );
    } catch (e: any) {
      setStatus(t("[错误] 列表: {msg}", { msg: e?.message ?? String(e) }));
      setTree((prev) => (prev ? updateNode(prev, node.path, (n) => ({ ...n, loading: false })) : prev));
    }
  };

  const openFile = async (node: TreeNode) => {
    setSelectedExplorerPath(node.path);
    const parentDir = dirName(node.path);
    if (parentDir) setExplorerUserPath(parentDir);
    try {
      setStatus("");
      const guard = await ensureLargeFileAllowed(node.path, node.size);
      if (!guard.ok) return;
      const r = await apiRead(node.path, guard.force ? { maxBytes: LARGE_FILE_HARD_LIMIT_BYTES } : undefined);
      setActiveFile(r.path);
      setEditorMode("edit");
      if (!isMobile) setPanelEditorCollapsed(false); // 点击文件时若编辑器折叠则展开
      if (isMobile) setMobileTab("editor"); // 移动端点击文件名自动跳转到编辑器
      setOpenTabs((prev) => (prev.includes(r.path) ? prev : [...prev, r.path]));
      setFileStateByPath((prev) => ({
        ...prev,
        [r.path]: { text: r.text, dirty: false, info: { size: r.size, mtimeMs: r.mtimeMs } },
      }));
      if (activeRoot) apiSetLastOpenedFile(activeRoot, r.path).catch(() => {});
      if (activeRoot) {
        setStored(`lastOpenedFile:${activeRoot}`, r.path);
      }
    } catch (e: any) {
      setStatus(t("[错误] 读取: {msg}", { msg: e?.message ?? String(e) }));
    }
  };

  const save = async () => {
    if (!activeFile) return;
    try {
      const r = await apiWrite(activeFile, fileText);
      setFileStateByPath((prev) => ({
        ...prev,
        [activeFile]: { text: fileText, dirty: false, info: { size: r.size, mtimeMs: r.mtimeMs } },
      }));
      setStatus(t("[成功] 已保存 {name}", { name: baseName(activeFile) }));
    } catch (e: any) {
      setStatus(t("[错误] 写入: {msg}", { msg: e?.message ?? String(e) }));
    }
  };

  const closeTab = (path: string) => {
    const st = fileStateByPath[path];
    if (st?.dirty) {
      const ok = window.confirm(t("“{name}” 有未保存的更改。仍要关闭吗？", { name: baseName(path) }));
      if (!ok) return;
    }

    setFileStateByPath((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });

    setOpenTabs((prev) => {
      const nextTabs = prev.filter((p) => p !== path);
      if (activeFile === path) {
        const nextActive = nextTabs[nextTabs.length - 1] ?? "";
        setActiveFile(nextActive);
      }
      return nextTabs;
    });
  };

  const activateTab = useCallback((path: string) => {
    setActiveFile(path);
    if (activeRoot) apiSetLastOpenedFile(activeRoot, path).catch(() => {});
    if (isMobile) setMobileTab("editor");
  }, [activeRoot, isMobile]);

  const refreshDirectoryInTree = useCallback(
    async (dirPath: string) => {
      try {
        const r = await apiList(dirPath);
        const children: TreeNode[] = r.entries.map((e: FsEntry) => ({
          path: joinPath(r.path, e.name),
          name: e.name,
          type: e.type,
          size: e.size,
          mtimeMs: e.mtimeMs,
        }));
        if (dirPath === activeRoot) {
          setTree((prev) =>
            prev ? { ...prev, children, loaded: true, loading: false } : prev,
          );
        } else {
          setTree((prev) =>
            prev
              ? updateNode(prev, dirPath, (n) => ({
                  ...n,
                  children,
                  loaded: true,
                  loading: false,
                }))
              : prev,
          );
        }
      } catch (e: any) {
        setStatus(t("[错误] 刷新: {msg}", { msg: e?.message ?? String(e) }));
      }
    },
    [activeRoot, t],
  );

  const resolveExplorerDir = useCallback(() => {
    const selected = selectedExplorerPath;
    if (selected && treeRef.current) {
      const node = findNode(treeRef.current, selected);
      if (node) {
        if (node.type === "dir") return node.path;
        if (node.type === "file") return dirName(node.path);
      }
    }
    if (explorerTargetPath) return explorerTargetPath;
    return activeRoot;
  }, [selectedExplorerPath, explorerTargetPath, activeRoot]);

  const handleUploadClick = useCallback(() => {
    if (!activeRoot || isUploading) return;
    const input = uploadInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }, [activeRoot, isUploading]);

  const handleUploadChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length === 0) return;
      const targetDir = resolveExplorerDir();
      if (!targetDir) {
        setStatus(t("[错误] 请先选择目录"));
        return;
      }
      let uploaded = 0;
      setIsUploading(true);
      try {
        for (const file of files) {
          await apiUploadFile(targetDir, file);
          uploaded += 1;
        }
        setExplorerUserPath(targetDir);
        setSelectedExplorerPath(targetDir);
        await refreshDirectoryInTree(targetDir);
        setStatus(t("[成功] 已上传 {count} 个文件", { count: uploaded }));
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const prefix = uploaded > 0 ? t("已上传 {uploaded}/{total}，", { uploaded, total: files.length }) : "";
        setStatus(t("[错误] 上传失败: {msg}", { msg: `${prefix}${msg}` }));
      } finally {
        setIsUploading(false);
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    },
    [resolveExplorerDir, refreshDirectoryInTree, t],
  );

  const buildImageUploadDir = useCallback((cwd: string) => {
    const base = cwd.replace(/\/+$/, "");
    return joinPath(joinPath(base, "codesentinel"), "uploaded_pictures");
  }, []);

  const buildImageFileName = useCallback((file: File) => {
    const raw = (file.name || "image").trim();
    const clean = raw.replace(/[^\w.-]+/g, "_");
    const dot = clean.lastIndexOf(".");
    const base = (dot > 0 ? clean.slice(0, dot) : clean) || "image";
    const ext = dot > 0 ? clean.slice(dot + 1) : "";
    const fallbackExt = file.type && file.type.startsWith("image/") ? file.type.split("/")[1] : "png";
    const finalExt = (ext || fallbackExt).toLowerCase();
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    return `${base}_${stamp}.${finalExt}`;
  }, []);

  const handleImageUploadClick = useCallback(() => {
    if (!terminalCwd) {
      setStatus(t("[错误] 请先选择目录"));
      return;
    }
    if (isImageUploading) return;
    const input = imageUploadInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }, [terminalCwd, isImageUploading, t]);

  const handleImageUploadChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files ? e.target.files[0] : null;
      if (!file) return;
      if (!terminalCwd) {
        setStatus(t("[错误] 请先选择目录"));
        return;
      }
      setIsImageUploading(true);
      try {
        const uploadDir = buildImageUploadDir(terminalCwd);
        await apiMkdir(uploadDir);
        const fileName = buildImageFileName(file);
        await apiUploadFile(uploadDir, file, { fileName });
        await refreshDirectoryInTree(uploadDir);
        const rel = `./codesentinel/uploaded_pictures/${fileName}`;
        sendTermInput(`@${rel} `);
        setStatus(t("[成功] 已上传图片 {name}", { name: fileName }));
      } catch (e: any) {
        setStatus(t("[错误] 上传失败: {msg}", { msg: e?.message ?? String(e) }));
      } finally {
        setIsImageUploading(false);
        if (imageUploadInputRef.current) imageUploadInputRef.current.value = "";
      }
    },
    [terminalCwd, buildImageUploadDir, buildImageFileName, refreshDirectoryInTree, sendTermInput, t],
  );

  const dropTabsUnderPath = useCallback((targetPath: string) => {
    setFileStateByPath((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key === targetPath || key.startsWith(`${targetPath}/`)) {
          delete next[key];
        }
      }
      return next;
    });
    setOpenTabs((prev) => {
      const nextTabs = prev.filter((p) => !(p === targetPath || p.startsWith(`${targetPath}/`)));
      if (activeFile && !nextTabs.includes(activeFile)) {
        setActiveFile(nextTabs[nextTabs.length - 1] ?? "");
      }
      return nextTabs;
    });
  }, [activeFile]);

  const handleDeleteNode = useCallback((node: TreeNode) => {
    setDeleteTarget(node);
    setDeleteConfirmText("");
    setDeleteModalOpen(true);
    setTimeout(() => deleteConfirmInputRef.current?.focus(), 80);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const target = deleteTarget;
    if (!target) {
      setDeleteModalOpen(false);
      return;
    }
    try {
      await apiDelete(target.path);
      dropTabsUnderPath(target.path);
      const parentDir = dirName(target.path);
      const refreshTarget = parentDir || activeRoot;
      if (refreshTarget) {
        setExplorerUserPath(refreshTarget);
        setSelectedExplorerPath(refreshTarget);
        await refreshDirectoryInTree(refreshTarget);
      }
      setStatus(t("[成功] 已删除 {name}", { name: target.name || baseName(target.path) }));
    } catch (e: any) {
      setStatus(t("[错误] 删除: {msg}", { msg: e?.message ?? String(e) }));
    } finally {
      setDeleteModalOpen(false);
      setDeleteTarget(null);
      setDeleteConfirmText("");
    }
  }, [activeRoot, deleteTarget, dropTabsUnderPath, refreshDirectoryInTree, t]);

  const handleDownloadFile = useCallback(async (filePath: string) => {
    try {
      const blob = await apiDownload(filePath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = baseName(filePath) || "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setStatus(t("[成功] 已下载 {name}", { name: baseName(filePath) }));
    } catch (e: any) {
      setStatus(t("[错误] 下载: {msg}", { msg: e?.message ?? String(e) }));
    }
  }, [t]);

  const createFolder = useCallback(() => {
    const parentDir = resolveExplorerDir();
    if (!parentDir) return;
    setExplorerUserPath(parentDir);
    setCreateModalType("folder");
    setCreateModalParent(parentDir);
    setCreateModalName("");
    setCreateModalOpen(true);
    setTimeout(() => createModalInputRef.current?.focus(), 80);
  }, [resolveExplorerDir]);

  const createFile = useCallback(() => {
    const parentDir = resolveExplorerDir();
    if (!parentDir) return;
    setExplorerUserPath(parentDir);
    setCreateModalType("file");
    setCreateModalParent(parentDir);
    setCreateModalName("");
    setCreateModalOpen(true);
    setTimeout(() => createModalInputRef.current?.focus(), 80);
  }, [resolveExplorerDir]);

  const handleCreateConfirm = useCallback(async () => {
    const parentDir = createModalParent;
    const rawName = createModalName.trim();
    if (!parentDir) {
      setCreateModalOpen(false);
      return;
    }
    if (!rawName) {
      setStatus(t("[错误] 名称不能为空"));
      return;
    }
    const newPath = joinPath(parentDir, rawName);
    try {
      if (createModalType === "folder") {
        await apiMkdir(newPath);
        setStatus(t("[成功] 已创建文件夹 {name}", { name: rawName }));
        await refreshDirectoryInTree(parentDir);
        setSelectedExplorerPath(newPath);
      } else {
        const r = await apiWrite(newPath, "");
        setStatus(t("[成功] 已创建文件 {name}", { name: rawName }));
        await refreshDirectoryInTree(parentDir);
        setActiveFile(newPath);
        setSelectedExplorerPath(newPath);
        setEditorMode("edit");
        if (!isMobile) setPanelEditorCollapsed(false);
        setOpenTabs((prev) => (prev.includes(newPath) ? prev : [...prev, newPath]));
        setFileStateByPath((prev) => ({
          ...prev,
          [newPath]: { text: "", dirty: false, info: { size: r.size, mtimeMs: r.mtimeMs } },
        }));
      }
      setCreateModalOpen(false);
      setCreateModalName("");
    } catch (e: any) {
      setStatus(t("[错误] 创建{type}: {msg}", {
        type: createModalType === "folder" ? t("文件夹") : t("文件"),
        msg: e?.message ?? String(e),
      }));
    }
  }, [
    createModalParent,
    createModalName,
    createModalType,
    isMobile,
    refreshDirectoryInTree,
    t,
  ]);

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, fileText]);

  // Update terminal theme when dark mode changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = getTermTheme(isDarkMode);
    term.options.fontFamily = getMonoFontFamily();
    term.options.fontSize = uiFontSize;
    try {
      term.refresh(0, term.rows - 1);
    } catch {}
    safeFitTerm();
  }, [isDarkMode, uiFontSize, safeFitTerm]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
  }, [uiFontSize]);

  // Terminal init: only when a mode that shows the terminal (Codex/Claude/OpenCode/Restricted/cursor-cli).
  // In Cursor mode we don't create the terminal so xterm is never opened in a 0x0 hidden container.
  useEffect(() => {
    if (!terminalVisible) return;
    if (termMode === "cursor") return;
    if (termInitedRef.current) return;
    const el = termDivRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: getMonoFontFamily(),
      fontSize: uiFontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      theme: getTermTheme(isDarkMode),
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termInitedRef.current = true;
    // Container is visible (Codex/Claude/OpenCode/Restricted/cursor-cli); fit after layout.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        safeFitTerm();
        // Extra fit after a short delay so xterm renderer is ready
        setTimeout(safeFitTerm, 50);
      });
    });
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    const client = new TermClient();
    termClientRef.current = client;
    client.debug = true;
    logTerm("terminal init", { terminalVisible, w: el.clientWidth, h: el.clientHeight });

    // Ensure TUIs can query device/cursor status.
    // xterm.js may not always answer strict clients fast enough; respond explicitly.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (term as any).parser?.registerCsiHandler?.({ final: "n" }, (params: number[]) => {
        const sid = termSessionIdRef.current;
        if (!sid) return true;
        // CSI 5 n: "Status Report" -> "OK"
        if (params?.[0] === 5) {
          void client.stdin(sid, "\u001b[0n").catch(() => {});
          return true;
        }
        // CSI 6 n: "Cursor Position Report"
        if (params?.[0] === 6) {
          // xterm uses 0-based cursor position
          const row = term.buffer.active.cursorY + 1;
          const col = term.buffer.active.cursorX + 1;
          const resp = `\u001b[${row};${col}R`;
          void client.stdin(sid, resp).catch(() => {});
          return true;
        }
        return false;
      });

      // Primary Device Attributes (DA): CSI c
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (term as any).parser?.registerCsiHandler?.({ final: "c" }, (_params: number[]) => {
        const sid = termSessionIdRef.current;
        if (!sid) return true;
        // Identify as xterm-like with common capabilities.
        void client.stdin(sid, "\u001b[?62;1;2;6;7;8;9;15;18;21;22c").catch(() => {});
        return true;
      });

      // Secondary Device Attributes (DA2): CSI > c
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (term as any).parser?.registerCsiHandler?.({ prefix: ">", final: "c" }, (_params: number[]) => {
        const sid = termSessionIdRef.current;
        if (!sid) return true;
        // "xterm" style DA2 response: Pp; Pv; Pc
        void client.stdin(sid, "\u001b[>0;276;0c").catch(() => {});
        return true;
      });
    } catch {}

    // Handle OSC 10/11 (foreground/background color query) for agent CLI.
    // Agent may send ESC]10;?BEL / ESC]11;?BEL to query colors.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (term as any).parser?.registerOscHandler?.(10, (data: string) => {
        if (data !== "?") return false;
        const sid = termSessionIdRef.current;
        if (!sid) return true;
        const fg = toOscRgb(readCssVar("--term-fg", "#e2e8f0"), "#e2e8f0");
        // Send BOTH BEL and ST terminated variants (different TUIs accept different forms).
        void client
          .stdin(sid, `\x1b]10;${fg}\x07\x1b]10;${fg}\x1b\\`)
          .catch(() => {});
        return true;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (term as any).parser?.registerOscHandler?.(11, (data: string) => {
        if (data !== "?") return false;
        const sid = termSessionIdRef.current;
        if (!sid) return true;
        const bg = toOscRgb(readCssVar("--term-bg", "#0b1020"), "#0b1020");
        // Send BOTH BEL and ST terminated variants (different TUIs accept different forms).
        void client
          .stdin(sid, `\x1b]11;${bg}\x07\x1b]11;${bg}\x1b\\`)
          .catch(() => {});
        return true;
      });
    } catch {}

    client.onMsg = (m: TermServerMsg) => {
      if (m.t === "term.data") {
        const sid = m.sessionId;
        if (sid === termSessionIdRef.current) {
          term.write(m.data);
          logTerm("term.data", { sessionId: sid, bytes: m.data.length, head: m.data.slice(0, 24) });
          // Cursor Agent TUI sometimes only renders after resize. Nudge with resize only (Enter + resize
          // can cause full redraw and duplicate output in terminal).
          if ((termModeRef.current === "cursor" || termModeRef.current === "cursor-cli") && !cursorPromptNudgedRef.current) {
            if (m.data.includes("Cursor Agent")) {
              cursorPromptNudgedRef.current = true;
              const s = termSessionIdRef.current;
              if (s) {
                logTerm("nudge prompt: sending resize only", { sessionId: s, termMode: termModeRef.current });
                setTimeout(() => void client.resize(s, term.cols, term.rows).catch(() => {}), 200);
              }
            }
          }
        } else {
          // Buffer for Codex/Claude/OpenCode/Cursor CLI in case output arrives before open.resp.
          if (termModeRef.current === "codex" || termModeRef.current === "claude" || termModeRef.current === "opencode" || termModeRef.current === "gemini" || termModeRef.current === "kimi" || termModeRef.current === "qwen" || termModeRef.current === "cursor-cli") {
            if (!termPendingDataBufferRef.current.has(sid)) termPendingDataBufferRef.current.set(sid, []);
            termPendingDataBufferRef.current.get(sid)!.push(m.data);
          }
        }
      }
      if (m.t === "term.exit" && m.sessionId === termSessionIdRef.current) {
        const sessionMode = termSessionModeRef.current;
        logTerm("term.exit", { sessionId: m.sessionId, code: m.code, termMode: sessionMode || termModeRef.current });
        // For PTY-based modes (codex, cursor, cursor-cli), term.exit means the whole session ended.
        // For restricted mode, term.exit only means a single command finished — keep the session open.
        if (sessionMode === "codex") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[codex 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "claude") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[claude 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "opencode") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[opencode 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "gemini") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[gemini 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "kimi") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[kimi 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "qwen") {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[qwen 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (
          sessionMode === "cursor-cli-agent" ||
          sessionMode === "cursor-cli-plan" ||
          sessionMode === "cursor-cli-ask"
        ) {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          cursorPromptNudgedRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[cursor-cli 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else if (sessionMode === "restricted" && termSessionIsPtyRef.current) {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          clearSavedSession(m.sessionId);
          term.write(`\r\n${t("[restricted PTY 已退出 {code}]", { code: m.code ?? "?" })}\r\n`);
        } else {
          // restricted mode: command finished, but session stays open for more commands
          // Ensure cursor is visible in non-PTY restricted mode
          try {
            term.write("\x1b[?25h");
          } catch {}
          term.write(`$ `);
        }
      }
    };

    let disposed = false;
    client
      .connect()
      .then(() => {
        if (disposed) return;
        // Don't print a prompt here; prompts are managed per-session.
      })
      .catch((e) => {
        term.write(`\r\n${t("[WebSocket 错误] {msg}", { msg: e?.message ?? String(e) })}\r\n`);
      });

    term.onData((data) => {
      sendTermInput(data);
    });

    // Fit on container resize (more reliable than window resize in mobile browsers).
    const ro = new ResizeObserver(() => {
      safeFitTerm();
      const sid = termSessionIdRef.current;
      if (!sid) return;
      void client.resize(sid, term.cols, term.rows).catch(() => {});
    });
    ro.observe(el);
    termResizeObsRef.current = ro;

    return () => {
      // Intentionally do NOT dispose on tab switches; only mark disposed for connect() continuation.
      disposed = true;
    };
  }, [safeFitTerm, terminalVisible, termMode, sendTermInput]);

  // When switching to Codex/Restricted (including Cursor→Codex again), the xterm container may have been hidden.
  // Trigger fit + backend resize; multiple delayed fits so layout and renderer are ready.
  useEffect(() => {
    if (!terminalVisible) return;
    if (termMode === "cursor") return;
    const runFit = () => {
      ensureTermAttached();
      const el = termDivRef.current;
      if (el) void el.offsetHeight; // force reflow before fit
      safeFitTerm();
      const sid = termSessionIdRef.current;
      const term = termRef.current;
      const client = termClientRef.current;
      if (term && term.rows > 0) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {}
      }
      if (sid && term && client) {
        void client.resize(sid, term.cols, term.rows).catch(() => {});
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(runFit));
    const t1 = setTimeout(runFit, 150);
    const t2 = setTimeout(runFit, 400);
    const t3 = setTimeout(runFit, 700);
    const t4 = setTimeout(runFit, 1200);
    const t5 = setTimeout(runFit, 1800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
    };
  }, [terminalVisible, termMode, safeFitTerm, ensureTermAttached]);

  // Terminal cleanup (unmount only)
  useEffect(() => {
    return () => {
      try {
        termResizeObsRef.current?.disconnect();
      } catch {}
      termResizeObsRef.current = null;
      try {
        // Avoid closing WS during HMR to prevent dropping live PTY sessions.
        // In production/unload, the browser will close the socket anyway.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isHmr = (import.meta as any)?.hot;
        if (!isHmr) {
          termClientRef.current?.close();
        }
      } catch {}
      try {
        termRef.current?.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
      termClientRef.current = null;
      termSessionIdRef.current = "";
      termInitedRef.current = false;
      termSessionIsPtyRef.current = false;
    };
  }, []);

  // (Re)open terminal session on explicit attach/new requests.
  useEffect(() => {
    const client = termClientRef.current;
    const term = termRef.current;
    const pendingAttach = pendingAttachRef.current;
    const pendingOpen = pendingOpenRef.current;
    if (!terminalVisible || !client || !term) return;
    if (!pendingAttach?.sessionId && !pendingOpen) return;

    if (termMode === "cursor" && !pendingAttach?.sessionId) return;

    const tryAttach = async (): Promise<{ ok: true } | { ok: false; noFallback: boolean; error?: string }> => {
      const pending = pendingAttachRef.current;
      if (!pending?.sessionId) return { ok: false, noFallback: false };
      if (pending.sessionId === termSessionIdRef.current) {
        pendingAttachRef.current = null;
        return { ok: true };
      }
      try {
        const resp = await client.attach(pending.sessionId);
        if (!resp.ok || !resp.sessionId) {
          const errMsg = resp?.error ?? "Session not found";
          const isNotFound = /not found/i.test(errMsg);
          if (isNotFound) clearSavedSession(pending.sessionId);
          const uiMsg = isNotFound ? t("会话不存在或已结束") : errMsg;
          setStatus(t("[错误] 会话恢复失败: {msg}", { msg: uiMsg }));
          pendingAttachRef.current = null;
          return { ok: false, noFallback: Boolean(pending.noFallback), error: errMsg };
        }
        pendingAttachRef.current = null;
        const sessionMode = resp.mode || pending.mode || "";
        const sessionCwd = resp.cwd || pending.cwd || terminalCwd;
        const mapped = mapSessionMode(sessionMode);
        termSessionIdRef.current = resp.sessionId;
        termSessionModeRef.current = mapped.sessionMode;
        termSessionIsPtyRef.current = mapped.isPty;
        lastOpenKeyRef.current = buildOpenKey(sessionCwd, mapped.uiMode, mapped.cliMode);
        termCwdRef.current = sessionCwd;

        if (sessionCwd && sessionCwd !== terminalCwd) setTerminalCwd(sessionCwd);
        if (mapped.uiMode !== termModeRef.current) setTermMode(mapped.uiMode);
        if (mapped.cliMode !== cursorCliModeRef.current) setCursorCliMode(mapped.cliMode);

        try {
          localStorage.setItem(
            LAST_TERM_SESSION_KEY,
            JSON.stringify({ sessionId: resp.sessionId, cwd: sessionCwd, mode: sessionMode || mapped.sessionMode }),
          );
        } catch {}
        saveSessionForMode(mapped.uiMode, { sessionId: resp.sessionId, cwd: sessionCwd, mode: sessionMode || mapped.sessionMode });

        ensureTermAttached();
        term.reset();
        fitAndResize();
        try {
          const snap = await apiFetch(`/api/term/snapshot/${resp.sessionId}?tailBytes=20000`);
          if (snap.ok) {
            const payload = await snap.json();
            if (payload?.data) {
              term.write(payload.data);
            }
          }
        } catch {}
        fitAndResize();
        setTimeout(fitAndResize, 200);
        setStatus(t("[已恢复] {msg}", { msg: sessionCwd || resp.sessionId }));
        return { ok: true };
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        const isNotFound = /not found/i.test(errMsg);
        if (isNotFound) clearSavedSession(pending.sessionId);
        const uiMsg = isNotFound ? t("会话不存在或已结束") : errMsg;
        setStatus(t("[错误] 会话恢复失败: {msg}", { msg: uiMsg }));
        pendingAttachRef.current = null;
        return { ok: false, noFallback: Boolean(pending.noFallback), error: errMsg };
      }
    };

    (async () => {
      const attachResult = await tryAttach();
      if (attachResult.ok) return;
      if (attachResult.noFallback) return;
      const openReq = pendingOpenRef.current;
      if (!openReq) return;
      pendingOpenRef.current = null;
      try {
        const uiMode = openReq.mode ?? termModeRef.current;
        if (uiMode !== termModeRef.current) setTermMode(uiMode);
        const openCwd = openReq.cwd || terminalCwd;
        if (!openCwd) {
          setStatus(t("[提示] 请先选择工作目录"));
          return;
        }
        logTerm("open session begin", { terminalCwd: openCwd, termMode: uiMode, cursorMode, cursorCliMode });

        // Detach current session from UI but keep it running in background.
        if (termSessionIdRef.current) {
          termSessionIdRef.current = "";
          termSessionModeRef.current = "";
          termSessionIsPtyRef.current = false;
          lastOpenKeyRef.current = "";
        }

        // Determine actual mode for WebSocket
        // Map cursor-cli modes to the backend modes: cursor-cli-agent/plan/ask
        let actualMode:
          | "restricted"
          | "native"
          | "codex"
          | "claude"
          | "opencode"
          | "gemini"
          | "kimi"
          | "qwen"
          | "cursor-cli-agent"
          | "cursor-cli-plan"
          | "cursor-cli-ask";
        if (uiMode === "cursor-cli") {
          actualMode = `cursor-cli-${cursorCliMode}` as
            | "cursor-cli-agent"
            | "cursor-cli-plan"
            | "cursor-cli-ask";
        } else {
          actualMode = uiMode; // uiMode here is "restricted" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen"
        }
        logTerm("actualMode", { actualMode });
        
        // Reset terminal when switching into codex/claude/opencode/cursor-cli/restricted to avoid mixing outputs.
        if (uiMode === "codex" || uiMode === "claude" || uiMode === "opencode" || uiMode === "gemini" || uiMode === "kimi" || uiMode === "qwen" || uiMode === "cursor-cli" || uiMode === "restricted") {
          term.reset();
        } else {
          term.write(`\r\n${t("[会话] 正在打开 {path}", { path: openCwd })}\r\n`);
        }

        const resp = await client.open(openCwd, term.cols, term.rows, actualMode);
        if (!resp.ok || !resp.sessionId) throw new Error(resp.error ?? "term.open failed");
        termSessionIdRef.current = resp.sessionId;
        termSessionModeRef.current = actualMode;
        termCwdRef.current = resp.cwd || openCwd;
        const isPtySession =
          actualMode === "codex" ||
          actualMode === "claude" ||
          actualMode === "opencode" ||
          actualMode === "gemini" ||
          actualMode === "kimi" ||
          actualMode === "qwen" ||
          actualMode === "cursor-cli-agent" ||
          actualMode === "cursor-cli-plan" ||
          actualMode === "cursor-cli-ask" ||
          (actualMode === "restricted" && resp.mode === "restricted-pty");
        termSessionIsPtyRef.current = isPtySession;
        lastOpenKeyRef.current = buildOpenKey(openCwd, termModeRef.current, cursorCliModeRef.current);
        cursorPromptNudgedRef.current = false;
        if (uiMode === "restricted") {
          // Force cursor visible for restricted mode (especially non-PTY fallback)
          try {
            term.options.cursorStyle = "block";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (term.options as any).cursorInactiveStyle = "block";
            term.options.cursorBlink = true;
            term.write("\x1b[?25h");
          } catch {}
        }
        // Flush any term.data that arrived before term.open.resp (e.g. Codex welcome / PTY hint)
        const buf = termPendingDataBufferRef.current.get(resp.sessionId);
        if (buf?.length) {
          for (const d of buf) term.write(d);
          termPendingDataBufferRef.current.delete(resp.sessionId);
        }
        termPendingDataBufferRef.current.clear();
        logTerm("open session ok", { sessionId: resp.sessionId, cwd: resp.cwd, mode: resp.mode });
        try {
          localStorage.setItem(
            LAST_TERM_SESSION_KEY,
            JSON.stringify({ sessionId: resp.sessionId, cwd: resp.cwd, mode: resp.mode ?? actualMode }),
          );
        } catch {}
        saveSessionForMode(uiMode, { sessionId: resp.sessionId, cwd: resp.cwd, mode: resp.mode ?? actualMode });
        // After session opens, force focus back to xterm.
        // This helps when the mode button/dropdown stole focus.
        term.focus();
        requestAnimationFrame(() => term.focus());

        // Fit + resize after open (includes delayed retries for font/layout settling)
        logTerm("resize after open", { sessionId: resp.sessionId, cols: term.cols, rows: term.rows });
        fitAndResize();
        setTimeout(fitAndResize, 200);

        if (isPtySession) {
          try {
            const snap = await apiFetch(`/api/term/snapshot/${resp.sessionId}?tailBytes=20000`);
            if (snap.ok) {
              const payload = await snap.json();
              if (payload?.data && term.buffer.active.length === 0) {
                term.write(payload.data);
              } else if (!payload?.data) {
                const replay = await apiFetch(`/api/term/replay/${resp.sessionId}?tailBytes=20000`);
                if (replay.ok) {
                  const text = await replay.text();
                  if (text && term.buffer.active.length === 0) {
                    term.write(text);
                  }
                }
              }
            } else {
              const replay = await apiFetch(`/api/term/replay/${resp.sessionId}?tailBytes=20000`);
              if (replay.ok) {
                const text = await replay.text();
                if (text && term.buffer.active.length === 0) {
                  term.write(text);
                }
              }
            }
          } catch {}
        }

        // Flush any keystrokes typed while the session was opening.
        const pending = termPendingStdinRef.current;
        if (pending) {
          termPendingStdinRef.current = "";
          await client.stdin(resp.sessionId, pending).catch(() => {});
        }

        if (!isPtySession && uiMode !== "codex" && uiMode !== "claude" && uiMode !== "opencode" && uiMode !== "gemini" && uiMode !== "kimi" && uiMode !== "qwen" && uiMode !== "cursor-cli") term.write("$ ");
      } catch (e: any) {
        lastOpenKeyRef.current = "";
          setStatus(t("[错误] 终端: {msg}", { msg: e?.message ?? String(e) }));
      }
    })();
  }, [terminalCwd, terminalVisible, termMode, cursorMode, cursorCliMode, restoreNonce, openNonce, buildOpenKey, mapSessionMode, ensureTermAttached, saveSessionForMode, fitAndResize]);

  const settingsTools = toolSettings.filter((t): t is UiToolSetting & { id: ToolId } => isToolId(t.id));
  const aiTools = settingsTools.filter((t) => t.id !== "command");
  const commandTools = settingsTools.filter((t) => t.id === "command");
  const commandDisabled = !commandSettings;
  const canDecFont = uiFontSize > UI_FONT_MIN;
  const canIncFont = uiFontSize < UI_FONT_MAX;
  const toggleSettingsSection = useCallback((key: SettingsSectionKey) => {
    settingsTouchedRef.current = true;
    setSettingsOpen((prev) => {
      const next = !prev[key];
      if (!isMobile) return { ...prev, [key]: next };
      if (!next) return { ...prev, [key]: false };
      return { tools: false, preference: false, language: false, security: false, [key]: true };
    });
  }, [isMobile]);

  const SettingsSection = ({
    id,
    title,
    hint,
    children,
  }: {
    id: SettingsSectionKey;
    title: string;
    hint?: string;
    children: React.ReactNode;
  }) => {
    const open = settingsOpen[id];
    const bodyId = `settings-${id}`;
    return (
      <div className={"settingsFold" + (open ? " settingsFoldOpen" : "")}>
        <button
          type="button"
          className="settingsFoldHeader"
          onClick={() => toggleSettingsSection(id)}
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? t("折叠") : t("展开")}
        >
          <span className="settingsFoldIcon" aria-hidden>{open ? "▾" : "▸"}</span>
          <span className="settingsFoldTitle">{title}</span>
        </button>
        {open ? (
          <div className="settingsFoldBody" id={bodyId}>
            {hint ? <div className="settingsSectionHint">{hint}</div> : null}
            {children}
          </div>
        ) : null}
      </div>
    );
  };

  const SettingsPanel = (
    <div className="settingsPanel">
      <SettingsSection id="tools" title={t("工具设置")} hint={t("启用或隐藏工具（设置会写入后端）")}>
        <div className="settingsGroupTitle">{t("AI 工具")}</div>
        <div className="settingsList">
          {aiTools.map((tool) => {
            const def = getToolDef(tool.id);
            return (
              <label className="settingsItem" key={tool.id}>
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  onChange={(e) => toggleToolEnabled(tool.id, e.target.checked)}
                />
                <span className="settingsItemLabel">{t(def.label)}</span>
                <span className="settingsItemDesc">{t(def.desc)}</span>
              </label>
            );
          })}
        </div>
        <div className="settingsGroupTitle">{t("命令行工具")}</div>
        <div className="settingsList">
          {commandTools.map((tool) => {
            const def = getToolDef(tool.id);
            return (
              <label className="settingsItem" key={tool.id}>
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  onChange={(e) => toggleToolEnabled(tool.id, e.target.checked)}
                />
                <span className="settingsItemLabel">{t(def.label)}</span>
                <span className="settingsItemDesc">{t(def.desc)}</span>
              </label>
            );
          })}
        </div>
        <div className="settingsFooter">
          <span className="settingsHintText">{t("至少保留一个工具。")}</span>
          <div className="settingsFooterRight">
            {toolsSaving ? <span className="settingsHintText">{t("工具保存中…")}</span> : null}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="preference" title={t("偏好设置")}>
        <div className="settingsGrid">
          <div className="settingsField">
            <span className="settingsFieldLabel">{t("全局字体大小")}</span>
            <div className="settingsFontControls">
              <button
                className="btn btnSm"
                type="button"
                disabled={!canDecFont}
                onClick={() => setUiFontSize((v) => Math.max(UI_FONT_MIN, v - 1))}
                title={t("减小字体")}
                aria-label={t("减小字体")}
              >
                -
              </button>
              <span className="settingsFontValue">{uiFontSize}px</span>
              <button
                className="btn btnSm"
                type="button"
                disabled={!canIncFont}
                onClick={() => setUiFontSize((v) => Math.min(UI_FONT_MAX, v + 1))}
                title={t("增大字体")}
                aria-label={t("增大字体")}
              >
                +
              </button>
              <button
                className="btn btnSm"
                type="button"
                onClick={() => setUiFontSize(DEFAULT_UI_STATE.fontSize)}
                title={t("恢复默认")}
              >
                {t("恢复默认")}
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="language" title={t("语言")}>
        <div className="settingsGrid">
          <label className="settingsField">
            <span className="settingsFieldLabel">{t("语言")}</span>
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en")}>
              <option value="zh">{t("中文")}</option>
              <option value="en">{t("英文")}</option>
            </select>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection id="security" title={t("命令行安全策略")} hint={t("命令行窗口默认启用受限模式，仅允许安全命令。")}>
        <div className="settingsGrid">
          <label className="settingsField">
            <span className="settingsFieldLabel">{t("模式")}</span>
            <select
              className="select"
              value={commandMode}
              disabled={commandDisabled}
              onChange={(e) => setCommandMode(e.target.value as "denylist" | "allowlist")}
            >
              <option value="denylist">{t("禁止列表（默认）")}</option>
              <option value="allowlist">{t("允许列表")}</option>
            </select>
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{t("超时（秒）")}</span>
            <input
              className="input"
              type="number"
              min={1}
              value={commandTimeoutSec}
              disabled={commandDisabled}
              onChange={(e) => setCommandTimeoutSec(e.target.value)}
            />
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{t("最大输出（KB）")}</span>
            <input
              className="input"
              type="number"
              min={1}
              value={commandMaxOutputKB}
              disabled={commandDisabled}
              onChange={(e) => setCommandMaxOutputKB(e.target.value)}
            />
          </label>
        </div>
        <div className="settingsField">
          <span className="settingsFieldLabel">{t("允许列表（每行一个命令）")}</span>
          <textarea
            className="settingsTextarea"
            rows={5}
            placeholder={t("例如：ls\npwd\ngit\nnode")}
            value={commandWhitelistText}
            disabled={commandDisabled}
            onChange={(e) => setCommandWhitelistText(e.target.value)}
          />
        </div>
        <div className="settingsField">
          <span className="settingsFieldLabel">{t("禁止列表（每行一个命令）")}</span>
          <textarea
            className="settingsTextarea"
            rows={4}
            placeholder={t("例如：rm\nsudo\nshutdown")}
            value={commandDenylistText}
            disabled={commandDisabled}
            onChange={(e) => setCommandDenylistText(e.target.value)}
          />
        </div>
        <div className="settingsFooter">
          <span className="settingsHintText">{t("至少保留一个工具。")}</span>
          <div className="settingsFooterRight">
            <button className="btn" onClick={handleSaveCommandSettings} disabled={!commandDirty || commandSaving}>
              {commandSaving ? t("保存中…") : t("保存命令行设置")}
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );

  const WindowsPanel = (
    <div className="windowsPanel">
      <div className="windowsHeader">
        <div className="windowsTitle">{t("窗口列表")}</div>
        <button className="btn btnSm" onClick={refreshTermSessions} disabled={termSessionsLoading}>
          {termSessionsLoading ? t("刷新中…") : t("刷新")}
        </button>
      </div>
      <div className="windowsSection">
        <div className="windowsSectionTitle">{t("文件")}</div>
        {openTabs.length === 0 ? (
          <div className="fileMeta">{t("暂无打开的文件")}</div>
        ) : (
          <div className="windowsList">
            {openTabs.map((p) => {
              const isCurrent = p === activeFile;
              const isDirty = fileStateByPath[p]?.dirty;
              return (
                <div className="windowsRow" key={p}>
                  <div className="windowsRowMain">
                    <div className="windowsRowTitle">{baseName(p)}{isDirty ? " *" : ""}</div>
                    <div className="windowsRowMeta">{p}</div>
                  </div>
                  <div className="windowsRowActions">
                    {isCurrent ? <span className="windowsTag">{t("当前")}</span> : null}
                    <button className="btn btnSm" onClick={() => activateTab(p)}>
                      {t("打开")}
                    </button>
                    <button className="btn btnSm" onClick={() => closeTab(p)}>
                      {t("关闭")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="windowsSection">
        <div className="windowsSectionTitle">{t("终端会话")}</div>
        {termSessionsError ? <div className="fileMeta">{t("加载失败：{msg}", { msg: termSessionsError })}</div> : null}
        {!termSessionsLoading && termSessions.length === 0 ? (
          <div className="fileMeta">{t("暂无会话")}</div>
        ) : null}
        <div className="windowsList">
          {termSessions.map((s) => {
            const isCurrent = s.sessionId === termSessionIdRef.current;
            const isActive = Boolean(s.active);
            const modeLabel = s.mode
              ? s.mode.startsWith("cursor-cli-")
                ? `cursor-cli(${s.mode.replace("cursor-cli-", "")})`
                : s.mode
              : "";
            return (
              <div className="windowsRow" key={s.sessionId}>
                <div className="windowsRowMain">
                  <div className="windowsRowTitle">{s.sessionId}</div>
                  <div className="windowsRowMeta">
                    {formatTime(s.updatedAt)} · {bytes(s.sizeBytes)}
                    {s.cwd ? ` · ${s.cwd}` : ""}
                    {modeLabel ? ` · ${modeLabel}` : ""}
                  </div>
                </div>
                <div className="windowsRowActions">
                  {isCurrent ? <span className="windowsTag">{t("当前")}</span> : null}
                  {!isCurrent && isActive ? <span className="windowsTag windowsTagOk">{t("在线")}</span> : null}
                  {!isActive ? <span className="windowsTag windowsTagMuted">{t("已结束")}</span> : null}
                  <button
                    className="btn btnSm"
                    disabled={!isActive}
                    onClick={() => handleRestoreSession(s)}
                  >
                    {t("恢复")}
                  </button>
                  <button className="btn btnSm" onClick={() => handleViewSession(s.sessionId)}>
                    {t("查看")}
                  </button>
                  <button
                    className="btn btnSm"
                    disabled={isCurrent}
                    onClick={() => handleDeleteSession(s.sessionId)}
                  >
                    {t("关闭")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const ExplorerPanel = (
    <div className={"panel" + (isMobile && mobileTab !== "explorer" ? " hidden" : "")} style={{ flex: isMobile ? 1 : undefined }}>
      <div className="panelHeader" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div className="leftToggle">
          <button
            type="button"
            className={"leftToggleBtn" + (leftPanelTab === "files" ? " leftToggleBtnActive" : "")}
            onClick={() => setLeftPanelTab("files")}
          >
            {t("文件")}
          </button>
          <button
            type="button"
            className={"leftToggleBtn" + (leftPanelTab === "settings" ? " leftToggleBtnActive" : "")}
            onClick={() => setLeftPanelTab("settings")}
          >
            {t("设置")}
          </button>
          <button
            type="button"
            className={"leftToggleBtn" + (leftPanelTab === "windows" ? " leftToggleBtnActive" : "")}
            onClick={() => setLeftPanelTab("windows")}
          >
            {t("窗口")}
          </button>
        </div>

        {leftPanelTab === "files" ? (
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button
              type="button"
              className="segBtn segBtnUpload"
              onClick={handleUploadClick}
              disabled={!activeRoot || isUploading}
              title={t("上传到当前目录")}
            >
              {isUploading ? t("上传中…") : t("上传")}
            </button>
            <button
              type="button"
              className="segBtn"
              onClick={createFolder}
              disabled={!activeRoot}
              title={t("新建文件夹")}
            >
              📁+
            </button>
            <button
              type="button"
              className="segBtn"
              onClick={createFile}
              disabled={!activeRoot}
              title={t("新建文件")}
            >
              📄+
            </button>
          </div>
        ) : null}
      </div>
      <div className="panelBody">
        {leftPanelTab === "files" ? (
          <div className="fileList" ref={(el) => {
            if (el) fileListRef.current = el;
          }}>
                {tree ? (
                  <TreeView
                    node={tree}
                    depth={0}
                    activeFile={activeFile}
                    selectedPath={selectedExplorerPath}
                    rootPath={activeRoot}
                    onSelectNode={(n) => setSelectedExplorerPath(n.path)}
                    onToggleDir={toggleDir}
                    onOpenFile={openFile}
                    onOpenTerminalDir={openTerminalDir}
                    onDeleteNode={handleDeleteNode}
                    onDownloadFile={handleDownloadFile}
                  />
                ) : (
              <div className="fileMeta">{ready ? t("加载中…") : t("无根目录")}</div>
            )}
          </div>
        ) : leftPanelTab === "settings" ? (
          SettingsPanel
        ) : (
          WindowsPanel
        )}
      </div>
    </div>
  );

  // Editor panel and Terminal panel are inlined (not inner components) so that toggling
  // collapse does not change component identity and thus does not unmount/remount
  // CursorChatPanel or trigger session list refetch / terminal session reopen.

  return (
    <>
      <input
        ref={uploadInputRef}
        type="file"
        className="fileUploadInput"
        multiple
        onChange={handleUploadChange}
      />
      <input
        ref={imageUploadInputRef}
        type="file"
        accept="image/*"
        className="fileUploadInput"
        onChange={handleImageUploadChange}
      />
        {/* 桌面端 */}
      <div className="app">
        <div
          className={
            "panel" +
            (!isMobile && explorerCollapsed ? " panelCollapsed panelExplorerCollapsed" : "")
          }
          style={{
            width: isMobile ? "auto" : explorerCollapsed ? 48 : leftWidth,
            minWidth: isMobile ? "auto" : explorerCollapsed ? 48 : "200px",
          }}
        >
          <div className="panelHeader" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
              {/* <h2>Files</h2> */}
              {!isMobile && explorerCollapsed && (
                <span style={{ writingMode: "vertical-rl", fontSize: uiFontSize, color: "var(--muted)" }}>{t("文件")}</span>
              )}
              {!explorerCollapsed && (
                <div className="row" style={{ marginLeft: "auto", gap: 8, alignItems: "center" }}>
                {/* <a href="#/setup" className="setupLink" title="配置与安装指南" style={{ fontSize: 12, color: "var(--muted)" }}>
                  安装指南
                </a> */}
                <button
                  type="button"
                  className="toolbarBtn"
                  onClick={handleSwitchProject}
                  title={t("切换项目")}
                >
                  {t("切换项目")}
                </button>
                {authToken ? (
                  <button
                    type="button"
                    className="toolbarBtn"
                    onClick={handleLogout}
                    title={t("退出登录")}
                  >
                    {t("退出")}
                  </button>
                ) : null}

                <button
                  type="button"
                  className="themeToggleBtn"
                  onClick={toggleDarkMode}
                  title={isDarkMode ? t("切换到浅色模式") : t("切换到深色模式")}
                  aria-label={isDarkMode ? t("切换到浅色模式") : t("切换到深色模式")}
                >
                  {isDarkMode ? "☀️" : "🌙"}
                </button>
                <select
                    className="select"
                    value={activeRoot}
                    onChange={(e) => {
                      manualRootOverrideRef.current = true;
                      setActiveRoot(e.target.value);
                      setTerminalCwd(e.target.value);
                      setOpenTabs([]);
                      setActiveFile("");
                      setFileStateByPath({});
                      setEditorMode("edit");
                    setExplorerUserPath(e.target.value);
                    }}
                    disabled={roots.length === 0}
                    title={t("根目录")}
                  >
                    {roots.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {!explorerCollapsed ? (
              <>
                <div className="leftToggle">
                  <button
                    type="button"
                    className={"leftToggleBtn" + (leftPanelTab === "files" ? " leftToggleBtnActive" : "")}
                    onClick={() => setLeftPanelTab("files")}
                  >
                    {t("文件")}
                  </button>
                  <button
                    type="button"
                    className={"leftToggleBtn" + (leftPanelTab === "settings" ? " leftToggleBtnActive" : "")}
                    onClick={() => setLeftPanelTab("settings")}
                  >
                    {t("设置")}
                  </button>
                  <button
                    type="button"
                    className={"leftToggleBtn" + (leftPanelTab === "windows" ? " leftToggleBtnActive" : "")}
                    onClick={() => setLeftPanelTab("windows")}
                  >
                    {t("窗口")}
                  </button>
                </div>
                {leftPanelTab === "files" ? (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button
                      type="button"
                      className="segBtn segBtnUpload"
                      onClick={handleUploadClick}
                      disabled={!activeRoot || isUploading}
                      title={t("上传到当前目录")}
                    >
                      {isUploading ? t("上传中…") : t("上传")}
                    </button>
                    <button
                      type="button"
                      className="segBtn"
                      onClick={createFolder}
                      disabled={!activeRoot}
                      title={t("新建文件夹")}
                    >
                      📁+
                    </button>
                    <button
                      type="button"
                      className="segBtn"
                      onClick={createFile}
                      disabled={!activeRoot}
                      title={t("新建文件")}
                    >
                      📄+
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="panelBody">
            {leftPanelTab === "files" ? (
              <div className="fileList" ref={(el) => {
                if (el) fileListRef.current = el;
              }}>
                {tree ? (
                  <TreeView
                    node={tree}
                    depth={0}
                    activeFile={activeFile}
                    selectedPath={selectedExplorerPath}
                    rootPath={activeRoot}
                    onSelectNode={(n) => setSelectedExplorerPath(n.path)}
                    onToggleDir={toggleDir}
                    onOpenFile={openFile}
                    onOpenTerminalDir={openTerminalDir}
                    onDeleteNode={handleDeleteNode}
                    onDownloadFile={handleDownloadFile}
                  />
                ) : (
                  <div className="fileMeta">{ready ? t("加载中…") : t("无根目录")}</div>
                )}
              </div>
            ) : leftPanelTab === "settings" ? (
              SettingsPanel
            ) : (
              WindowsPanel
            )}
          </div>
        </div>

        {!isMobile && !explorerCollapsed && (
          <div className="resizer" onMouseDown={() => setIsDragging(true)} title={t("拖拽调整大小")} />
        )}

        <div className="right" style={{ flex: isMobile ? undefined : 1 }} ref={rightPanelRef}>
          {/* Editor panel (inlined) */}
          <div
            className={
              "panel" +
              (isMobile && mobileTab !== "editor" ? " hidden" : "")
            }
            style={{
              flex: isMobile
                ? 1
                : terminalCollapsed
                  ? 1
                  : `0 0 ${Math.max(0, 100 - topHeight - splitGapPercent)}%`,
              width: isMobile
                ? undefined
                : terminalCollapsed
                  ? undefined
                  : `${Math.max(0, 100 - topHeight - splitGapPercent)}%`,
              minWidth: isMobile ? undefined : 0,
            }}
          >
            <div className="tabStrip" role="tablist" aria-label={t("已打开文件")}>
              {openTabs.map((p) => {
                const isActive = p === activeFile;
                const isDirty = fileStateByPath[p]?.dirty;
                return (
                  <div
                    key={p}
                    className={"fileTab" + (isActive ? " fileTabActive" : "")}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    title={p}
                    onClick={() => {
                      setActiveFile(p);
                      if (activeRoot) apiSetLastOpenedFile(activeRoot, p).catch(() => {});
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setActiveFile(p);
                        if (activeRoot) apiSetLastOpenedFile(activeRoot, p).catch(() => {});
                      }
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {baseName(p)}
                      {isDirty ? " •" : ""}
                    </span>
                    <button
                      className="tabClose"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(p);
                      }}
                      aria-label={t("关闭 {name}", { name: baseName(p) })}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="panelHeader">
              <h2>{t("编辑器")}</h2>
              <span className="fileMeta" title={activeFile}>
                {activeFile ? baseName(activeFile) : t("(无文件)")}
                {dirty ? " *" : ""}
              </span>
              {fileInfo ? <span className="fileMeta">{bytes(fileInfo.size)}</span> : null}
              <div className="row" style={{ marginLeft: "auto" }}>
                <div className="segmented" aria-label={t("编辑器模式")}>
                  <button className={"segBtn" + (editorMode === "edit" ? " segBtnActive" : "")} onClick={() => setEditorMode("edit")}>
                    {t("编辑")}
                  </button>
                  <button
                    className={"segBtn" + (editorMode === "preview" ? " segBtnActive" : "")}
                    onClick={() => setEditorMode("preview")}
                    disabled={!activeFile}
                    title={!activeFile ? t("请先打开文件") : t("使用 highlight.js 预览")}
                  >
                    {t("预览")}
                  </button>
                </div>
                <button className="segBtn" onClick={save} disabled={!activeFile || !dirty}>
                  {t("保存")}
                </button>
              </div>
            </div>
            <div className="panelBody" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {editorMode === "preview" && activeFile ? (
                <CodePreview path={activeFile} code={fileText} />
              ) : (
                <div style={{ flex: 1, minHeight: 0 }}>
                  <Editor
                    value={fileText}
                    path={activeFile || "untitled.txt"}
                    defaultLanguage="plaintext"
                    language={activeFile ? languageFromPath(activeFile) ?? "plaintext" : "plaintext"}
                    onChange={(v) => {
                      const next = v ?? "";
                      if (!activeFile) return;
                      setFileStateByPath((prev) => ({
                        ...prev,
                        [activeFile]: { text: next, dirty: true, info: prev[activeFile]?.info ?? null },
                      }));
                    }}
                    theme={isDarkMode ? "vs-dark" : "vs"}
                    options={{
                      fontFamily: "var(--mono)",
                      fontSize: uiFontSize,
                      minimap: { enabled: false },
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                    }}
                  />
                </div>
              )}
            </div>
          </div>
          {!isMobile && !terminalCollapsed && (
            <div className="resizerVertical" onMouseDown={() => setIsDraggingVertical(true)} title={t("拖拽调整大小")} />
          )}
          {/* Terminal panel (inlined to avoid remount on collapse toggle) */}
          <div
            className={
              "panel" +
              (isMobile && mobileTab !== "terminal" ? " hidden" : "") +
              (!isMobile && terminalCollapsed ? " panelCollapsed panelVerticalCollapsed" : "")
            }
            style={{
              flex: isMobile
                ? 1
                : terminalCollapsed
                  ? `0 0 ${collapsedPanelWidth}px`
                  : `0 0 ${topHeight}%`,
              width: isMobile
                ? undefined
                : terminalCollapsed
                  ? `${collapsedPanelWidth}px`
                  : `${topHeight}%`,
              minWidth: isMobile
                ? undefined
                  : terminalCollapsed
                    ? collapsedPanelWidth
                  : termMode === "cursor-cli" || termMode === "claude" || termMode === "opencode" || termMode === "gemini" || termMode === "kimi" || termMode === "qwen"
                      ? 520
                      : 0,
              minHeight: isMobile ? "65dvh" : undefined,
            }}
          >
            <div className="panelHeader termPanelHeader">
              {!isMobile && terminalCollapsed ? (
                <span className="collapsedLabel">{t("终端")}</span>
              ) : null}
              {!terminalCollapsed ? (
                <div className="termPanelHeaderRow">
                <div className="segmented" aria-label={t("终端模式")}>
                  {enabledToolIds.map((id) => {
                    const def = getToolDef(id);
                    const isActive = activeToolId === id;
                    return (
                      <button
                        key={id}
                        className={"segBtn" + (isActive ? " segBtnActive" : "")}
                        onClick={() => handleSelectTool(id)}
                        title={t(def.desc)}
                      >
                        {t(def.label)}
                      </button>
                    );
                  })}
                </div>
                {activeToolId === "command" ? (
                  <span className="termBadge">{t("受限命令行")}</span>
                ) : null}
                <div className="row" style={{ marginLeft: "auto" }}>
                  {termMode !== "cursor" && (
                    <>
                      <button
                        type="button"
                        className="termNewBtn"
                        title={t("新建会话")}
                        disabled={!terminalCwd}
                        onClick={handleNewSession}
                      >
                        {t("新建")}
                      </button>
                      <button
                        type="button"
                        className="termPasteBtn"
                        title={t("粘贴到终端")}
                        onClick={() => {
                          const sid = termSessionIdRef.current;
                          const client = termClientRef.current;
                          if (!sid || !client) return;
                          setPasteModalText("");
                          setPasteModalOpen(true);
                          setTimeout(() => pasteModalTextareaRef.current?.focus(), 80);
                        }}
                      >
                        {t("粘贴命令")}
                      </button>
                    </>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="termPanelHeaderCwd" title={terminalCwd}>
                {terminalCwd ? t("工作目录: {path}", { path: terminalCwd }) : ""}
              </div>
            </div>
            <div
              className={
                "termAreaWrap" +
                (isMobile && terminalVisible && termMode !== "cursor" && mobileKeysVisible
                  ? " termAreaWrapWithKeys"
                  : "")
              }
              ref={termAreaWrapRef}
              tabIndex={0}
              onKeyDown={handleTermKeyDown}
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                className={
                  "termChatWrap termPane " +
                  (termMode === "cursor" ? "termPaneActive" : "termPaneHidden")
                }
                style={{
                  flex: 1,
                  minHeight: 0,
                  height: "100%",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <CursorChatPanel mode={cursorMode} onModeChange={setCursorMode} cwd={terminalCwd} />
              </div>
              <div
                className={
                  "term termPane " +
                  (termMode === "cursor" ? "termPaneHidden" : "termPaneActive")
                }
                ref={termDivRef}
                style={{
                  minHeight: termMode === "cursor" ? undefined : (isMobile ? 120 : 80),
                  flexDirection: "column",
                  overflow: "hidden",
                }}
                onMouseDown={() => termRef.current?.focus()}
                onTouchStart={() => termRef.current?.focus()}
              />
              {isMobile && terminalVisible && termMode !== "cursor" && mobileKeysVisible ? (
                <div className="termMobileControls" ref={termMobileControlsRef}>
                  <div className="termMobileKeysRow">
                    <button
                      type="button"
                      className="termMobileKeyBtn termMobileKeyBtnKeyboard"
                      title={t("打开键盘")}
                      aria-label={t("打开键盘")}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        termRef.current?.focus();
                      }}
                    >
                      ⌨️
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[A");
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[B");
                      }}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[D");
                      }}
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[C");
                      }}
                    >
                      Right
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn termMobileKeyEnter"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\r");
                      }}
                    >
                      Enter
                    </button>
                  </div>
                  <div className="termMobileKeysRow">
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      disabled={!terminalCwd || isImageUploading}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleImageUploadClick();
                      }}
                      title={t("上传图片")}
                      aria-label={t("上传图片")}
                    >
                      {isImageUploading ? t("上传中…") : t("上传图片")}
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      disabled={!terminalCwd || isImageUploading}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleImageUploadClick();
                      }}
                      title={t("上传图片")}
                      aria-label={t("上传图片")}
                    >
                      {isImageUploading ? t("上传中…") : t("上传图片")}
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u0003");
                      }}
                    >
                      Ctrl+C
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u001a");
                      }}
                    >
                      Ctrl+Z
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u001b");
                      }}
                    >
                      Esc
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\t");
                      }}
                    >
                      Tab
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\r");
                      }}
                    >
                      Shift+Enter
                    </button>
                  </div>
                </div>
              ) : null}
                </div>
              </div>
            </div>
      </div>

      {/* 移动端 */}
      {isMobile ? (
        <div className="appMobile">
          <div className="topbar">
            <button
              ref={mobileSidebarToggleRef}
              type="button"
              className="mobileSidebarToggle"
              onClick={() => setMobileWorkspaceDrawerOpen((prev) => !prev)}
              aria-label={mobileWorkspaceDrawerOpen ? t("折叠侧边栏") : t("展开侧边栏")}
              aria-expanded={mobileWorkspaceDrawerOpen}
              title={mobileWorkspaceDrawerOpen ? t("折叠侧边栏") : t("展开侧边栏")}
            >
              <span aria-hidden>{mobileWorkspaceDrawerOpen ? "✕" : "≡"}</span>
            </button>
            <span className="mobileTopbarProjectName" title={terminalCwd || activeRoot}>
              {terminalCwd ? baseName(terminalCwd) : activeRoot ? baseName(activeRoot) : ""}
            </span>
            <button
              type="button"
              className="themeToggleBtn"
              onClick={toggleDarkMode}
              title={isDarkMode ? t("切换到浅色模式") : t("切换到深色模式")}
              aria-label={isDarkMode ? t("切换到浅色模式") : t("切换到深色模式")}
            >
              {isDarkMode ? "☀️" : "🌙"}
            </button>
            <div className="tabs">
              <button className={"tabBtn" + (mobileTab === "explorer" ? " tabBtnActive" : "")} onClick={() => setMobileTab("explorer")}>
                {t("文件夹")}
              </button>
              <button className={"tabBtn" + (mobileTab === "editor" ? " tabBtnActive" : "")} onClick={() => setMobileTab("editor")}>
                {t("编辑器")}
              </button>
              <button className={"tabBtn" + (mobileTab === "terminal" ? " tabBtnActive" : "")} onClick={() => setMobileTab("terminal")}>
                {t("终端")}
              </button>
              <button className={"tabBtn" + (mobileTab === "settings" ? " tabBtnActive" : "")} onClick={() => setMobileTab("settings")}>
                {t("设置")}
              </button>
            </div>
          </div>

          {ExplorerPanel}
          <div className={"panel" + (isMobile && mobileTab !== "settings" ? " hidden" : "")} style={{ flex: 1, minHeight: "65dvh" }}>
            <div className="panelHeader">
              <h2>{t("设置")}</h2>
            </div>
            <div className="panelBody">
              {SettingsPanel}
            </div>
          </div>
          {/* Mobile editor panel (same structure as desktop, isMobile makes collapse btn hidden) */}
          <div
            className={"panel" + (isMobile && mobileTab !== "editor" ? " hidden" : "")}
            style={{ flex: 1 }}
          >
            <div className="tabStrip" role="tablist" aria-label={t("已打开文件")}>
              {openTabs.map((p) => {
                const isActive = p === activeFile;
                const isDirty = fileStateByPath[p]?.dirty;
                return (
                  <div
                    key={p}
                    className={"fileTab" + (isActive ? " fileTabActive" : "")}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    title={p}
                    onClick={() => {
                      setActiveFile(p);
                      if (activeRoot) apiSetLastOpenedFile(activeRoot, p).catch(() => {});
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setActiveFile(p);
                        if (activeRoot) apiSetLastOpenedFile(activeRoot, p).catch(() => {});
                      }
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {baseName(p)}
                      {isDirty ? " •" : ""}
                    </span>
                    <button
                      className="tabClose"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(p);
                      }}
                      aria-label={t("关闭 {name}", { name: baseName(p) })}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="panelHeader">
              <h2>{t("编辑器")}</h2>
              <div className="row" style={{ marginLeft: "auto" }}>
                <div className="segmented" aria-label={t("编辑器模式")}>
                  <button className={"segBtn" + (editorMode === "edit" ? " segBtnActive" : "")} onClick={() => setEditorMode("edit")}>
                    {t("编辑")}
                  </button>
                  <button
                    className={"segBtn" + (editorMode === "preview" ? " segBtnActive" : "")}
                    onClick={() => setEditorMode("preview")}
                    disabled={!activeFile}
                    title={!activeFile ? t("请先打开文件") : t("使用 highlight.js 预览")}
                  >
                    {t("预览")}
                  </button>
                </div>
                <span className="fileMeta" title={activeFile}>
                  {activeFile ? baseName(activeFile) : t("(无文件)")}
                  {dirty ? " *" : ""}
                </span>
                {fileInfo ? <span className="fileMeta">{bytes(fileInfo.size)}</span> : null}
                <button className="btn" onClick={save} disabled={!activeFile || !dirty}>
                  {t("保存")}
                </button>
              </div>
            </div>
            {editorMode === "preview" && activeFile ? (
              <CodePreview path={activeFile} code={fileText} />
            ) : (
              <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                  value={fileText}
                  path={activeFile || "untitled.txt"}
                  defaultLanguage="plaintext"
                  language={activeFile ? languageFromPath(activeFile) ?? "plaintext" : "plaintext"}
                  onChange={(v) => {
                    const next = v ?? "";
                    if (!activeFile) return;
                    setFileStateByPath((prev) => ({
                      ...prev,
                      [activeFile]: { text: next, dirty: true, info: prev[activeFile]?.info ?? null },
                    }));
                  }}
                  theme="vs"
                  options={{
                    fontFamily: "var(--mono)",
                    fontSize: uiFontSize,
                    minimap: { enabled: false },
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                  }}
                />
              </div>
            )}
          </div>
          {/* Mobile terminal panel */}
          <div
            className={"panel" + (isMobile && mobileTab !== "terminal" ? " hidden" : "")}
            style={{ flex: 1, minHeight: "65dvh" }}
          >
            <div className="panelHeader termPanelHeader">
              <div className="termPanelHeaderRow">
                <div className="segmented" aria-label={t("终端模式")}>
                  {enabledToolIds.map((id) => {
                    const def = getToolDef(id);
                    const isActive = activeToolId === id;
                    return (
                      <button
                        key={id}
                        className={"segBtn" + (isActive ? " segBtnActive" : "")}
                        onClick={() => handleSelectTool(id)}
                        title={t(def.desc)}
                      >
                        {t(def.label)}
                      </button>
                    );
                  })}
                </div>
                {activeToolId === "command" ? (
                  <span className="termBadge">{t("受限命令行")}</span>
                ) : null}
                {termMode !== "cursor" && (
                  <>
                    <button
                      type="button"
                      className="termNewBtn"
                      title={t("新建会话")}
                      disabled={!terminalCwd}
                      onClick={handleNewSession}
                    >
                      {t("新建")}
                    </button>
                    <button
                      type="button"
                      className="termPasteBtn"
                      title={t("粘贴到终端")}
                      onClick={() => {
                        const sid = termSessionIdRef.current;
                        const client = termClientRef.current;
                        if (!sid || !client) return;
                        setPasteModalText("");
                        setPasteModalOpen(true);
                        setTimeout(() => pasteModalTextareaRef.current?.focus(), 80);
                      }}
                    >
                      {t("粘贴命令")}
                    </button>
                  </>
                )}
              </div>
              {isMobile && termMode === "cursor" && (
                <div ref={chatHeaderContainerRef} className="mobileChatHeaderSlot" />
              )}
              {!isMobile && (
                <div className="termPanelHeaderCwd" title={terminalCwd}>
                  {terminalCwd ? t("工作目录: {path}", { path: terminalCwd }) : ""}
                </div>
              )}
            </div>
            <div
              className={
                "termAreaWrap" +
                (isMobile && terminalVisible && termMode !== "cursor" && mobileKeysVisible
                  ? " termAreaWrapWithKeys"
                  : "")
              }
              ref={termAreaWrapRef}
              tabIndex={0}
              onKeyDown={handleTermKeyDown}
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                className={
                  "termChatWrap termPane " +
                  (termMode === "cursor" ? "termPaneActive" : "termPaneHidden")
                }
                style={{
                  flex: 1,
                  minHeight: 0,
                  height: "100%",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <CursorChatPanel
                  mode={cursorMode}
                  onModeChange={setCursorMode}
                  cwd={terminalCwd}
                  headerContainerRef={isMobile && termMode === "cursor" ? chatHeaderContainerRef : undefined}
                />
              </div>
              <div
                className={
                  "term termPane " +
                  (termMode === "cursor" ? "termPaneHidden" : "termPaneActive")
                }
                ref={termDivRef}
                style={{
                  minHeight: termMode === "cursor" ? undefined : 120,
                  flexDirection: "column",
                  overflow: "hidden",
                }}
                onMouseDown={() => termRef.current?.focus()}
                onTouchStart={() => termRef.current?.focus()}
              />
              {isMobile && terminalVisible && termMode !== "cursor" && mobileKeysVisible ? (
                <div className="termMobileControls" ref={termMobileControlsRef}>
                  <div className="termMobileKeysRow">
                    <button
                      type="button"
                      className="termMobileKeyBtn termMobileKeyBtnKeyboard"
                      title={t("打开键盘")}
                      aria-label={t("打开键盘")}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        termRef.current?.focus();
                      }}
                    >
                      ⌨️
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[A");
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[B");
                      }}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[D");
                      }}
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\x1b[C");
                      }}
                    >
                      Right
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn termMobileKeyEnter"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\r");
                      }}
                    >
                      Enter
                    </button>
                  </div>
                  <div className="termMobileKeysRow">
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u0003");
                      }}
                    >
                      Ctrl+C
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u001a");
                      }}
                    >
                      Ctrl+Z
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\u001b");
                      }}
                    >
                      Esc
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\t");
                      }}
                    >
                      Tab
                    </button>
                    <button
                      type="button"
                      className="termMobileKeyBtn"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        sendTermInput("\r");
                      }}
                    >
                      Shift+Enter
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isMobile ? (
        <>
          <div
            className={"mobileWorkspaceDrawerOverlay" + (mobileWorkspaceDrawerOpen ? " mobileWorkspaceDrawerOpen" : "")}
            onClick={() => {
              setMobileWorkspaceDrawerOpen(false);
              mobileSidebarToggleRef.current?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMobileWorkspaceDrawerOpen(false);
                mobileSidebarToggleRef.current?.focus();
              }
            }}
            aria-hidden
          />
          <div
            className={"mobileWorkspaceDrawer" + (mobileWorkspaceDrawerOpen ? " mobileWorkspaceDrawerOpen" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={t("根目录与操作")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobileWorkspaceDrawerRootSection">
              <label className="mobileWorkspaceDrawerRootLabel" htmlFor="mobileRootSelect">
                {t("根目录")}
              </label>
              <select
                id="mobileRootSelect"
                className="select mobileWorkspaceDrawerRootSelect"
                value={activeRoot}
                onChange={(e) => {
                  manualRootOverrideRef.current = true;
                  setActiveRoot(e.target.value);
                  setTerminalCwd(e.target.value);
                  setOpenTabs([]);
                  setActiveFile("");
                  setFileStateByPath({});
                  setEditorMode("edit");
                  setExplorerUserPath(e.target.value);
                }}
                disabled={roots.length === 0}
                title={t("根目录")}
              >
                {roots.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="mobileWorkspaceDrawerActions">
              <button
                type="button"
                className="toolbarBtn"
                onClick={handleSwitchProject}
              >
                {t("切换项目")}
              </button>
              {authToken ? (
                <button
                  type="button"
                  className="toolbarBtn"
                  onClick={handleLogout}
                >
                  {t("退出")}
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {pasteModalOpen ? (
        <div
          className="pasteModalOverlay"
          onClick={() => setPasteModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pasteModalTitle"
        >
          <div
            className="pasteModalBox"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="pasteModalTitle" className="pasteModalTitle">{t("粘贴到终端")}</h3>
            <textarea
              ref={pasteModalTextareaRef}
              className="pasteModalTextarea"
              value={pasteModalText}
              onChange={(e) => setPasteModalText(e.target.value)}
              placeholder={t("在此输入或粘贴内容，点击确定发送到终端")}
              rows={6}
            />
            <div className="pasteModalActions">
              <button
                type="button"
                className="btn"
                onClick={() => setPasteModalOpen(false)}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const sid = termSessionIdRef.current;
                  const client = termClientRef.current;
                  if (sid && client && pasteModalText) {
                    void client.stdin(sid, pasteModalText).catch(() => {});
                  }
                  setPasteModalOpen(false);
                  setPasteModalText("");
                }}
              >
                {t("确定")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createModalOpen ? (
        <div
          className="pasteModalOverlay"
          onClick={() => setCreateModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="createModalTitle"
        >
          <div
            className="pasteModalBox"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="createModalTitle" className="pasteModalTitle">
              {t("新建{type}", { type: createModalType === "folder" ? t("文件夹") : t("文件") })}
            </h3>
            <p className="fileMeta" style={{ marginBottom: 8 }}>
              {t("在当前目录下新建。")}
              {t("当前目录: {path}", { path: createModalParent || t("(未选择目录)") })}
            </p>
            <input
              ref={createModalInputRef}
              type="text"
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: 14,
                fontFamily: "var(--mono)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                boxSizing: "border-box",
              }}
              placeholder={
                createModalType === "folder"
                  ? t("例如：src 或 docs")
                  : t("例如：index.ts 或 README.md")
              }
              value={createModalName}
              onChange={(e) => setCreateModalName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreateConfirm();
                }
              }}
            />
            <div className="pasteModalActions">
              <button
                type="button"
                className="btn"
                onClick={() => setCreateModalOpen(false)}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void handleCreateConfirm();
                }}
              >
                {t("确定")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteModalOpen ? (
        <div
          className="pasteModalOverlay"
          onClick={() => setDeleteModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="deleteModalTitle"
        >
          <div
            className="deleteModalBox"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="deleteModalTitle" className="deleteModalTitle">{t("二次确认删除")}</h3>
            <p className="fileMeta" style={{ marginBottom: 8 }}>
              {t("即将删除{type}：", { type: deleteTarget?.type === "dir" ? t("文件夹") : t("文件") })}
              <strong style={{ marginLeft: 6 }}>{deleteTarget?.name || baseName(deleteTarget?.path || "")}</strong>
            </p>
            <p className="fileMeta" style={{ marginTop: 0 }}>
              {t("路径：{path}", { path: deleteTarget?.path || "-" })}
            </p>
            <p className="fileMeta" style={{ marginTop: 8 }}>
              {t("请输入 DELETE 以确认删除")}
            </p>
            <input
              ref={deleteConfirmInputRef}
              className="deleteModalInput"
              type="text"
              placeholder="DELETE"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (deleteConfirmText.trim().toUpperCase() === "DELETE") {
                    void handleDeleteConfirm();
                  }
                }
              }}
            />
            <div className="pasteModalActions">
              <button
                type="button"
                className="btn"
                onClick={() => setDeleteModalOpen(false)}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="btn btnDanger"
                disabled={deleteConfirmText.trim().toUpperCase() !== "DELETE"}
                onClick={() => {
                  void handleDeleteConfirm();
                }}
              >
                {t("删除")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {replayOpen ? (
        <div
          className="pasteModalOverlay"
          onClick={() => setReplayOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={replayTitle || t("终端回放")}
        >
          <div
            className="replayModalBox"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="replayModalHeader">
              <h3 className="replayModalTitle">{replayTitle || t("终端回放")}</h3>
              <button className="btn btnSm" onClick={() => setReplayOpen(false)}>{t("关闭")}</button>
            </div>
            <div className="replayModalBody">
              {replayLoading ? (
                <div className="fileMeta">{t("加载中…")}</div>
              ) : (
                <pre className="replayModalPre">{replayText}</pre>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {status ? (
        <div
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "10px 12px",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--text)",
            boxShadow: "var(--shadow)",
            maxWidth: 520,
            zIndex: 50,
          }}
        >
          {status}
        </div>
      ) : null}
    </>
  );
}

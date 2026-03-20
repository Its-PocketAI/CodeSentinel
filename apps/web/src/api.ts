/** API base resolution:
 * - If VITE_API_BASE is set, use it.
 * - In dev, default to same host with backend port 3990 (works for LAN/Tailscale).
 * - If already on backend port, use same origin.
 * - In production, prefer same-origin unless overridden.
 */
function resolveApiBase(): string {
  const envBase =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.VITE_API_BASE as string | undefined)
      : undefined;
  if (envBase && envBase.trim()) return envBase.trim().replace(/\/$/, "");

  if (typeof window === "undefined") return "";
  const loc = window.location;
  const isDev = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
  if (!isDev) return "";

  if (loc.port === "3990") return loc.origin;
  const proto = loc.protocol;
  const host = loc.hostname;
  return `${proto}//${host}:3990`;
}

export const API_BASE = resolveApiBase();

const AUTH_TOKEN_KEY = "codesentinel:authToken";
const AUTH_EVENT = "codesentinel:auth-changed";

export function getAuthToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function clearAuthToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

function withAuth(options?: RequestInit): RequestInit {
  const token = getAuthToken();
  if (!token) return options || {};
  const headers = new Headers(options?.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return { ...options, headers };
}

function authedFetch(path: string, options?: RequestInit) {
  return fetch(apiUrl(path), withAuth(options));
}

export async function apiFetch(path: string, options?: RequestInit) {
  const res = await authedFetch(path, options);
  if (res.status == 401) {
    clearAuthToken();
  }
  return res;
}

export function apiUrl(path: string): string {
  const base = API_BASE.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

export type FsEntry = {
  name: string;
  type: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
};

async function j<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (res.status === 401) {
    clearAuthToken();
  }
  if (!res.ok || (data && typeof data === "object" && (data as any).ok === false)) {
    const msg = (data as any)?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** 后端可能晚几秒就绪，对初始请求做重试，避免 500 / ECONNREFUSED */
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxAttempts = 6,
  delayMs = 1500
): Promise<Response> {
  let lastErr: unknown;
  for (let n = 0; n < maxAttempts; n++) {
    try {
      const res = await authedFetch(url, options);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error(`${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (n < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

export type AuthStatus = {
  ok: true;
  enabled: boolean;
  authenticated: boolean;
  expiresAt?: number;
  error?: string;
};

export async function apiAuthStatus() {
  return j<AuthStatus>(await authedFetch("/api/auth/status"));
}

export type AuthCaptcha = {
  ok: true;
  enabled: boolean;
  id?: string;
  question?: string;
  ttlSec?: number;
};

export async function apiAuthCaptcha() {
  return j<AuthCaptcha>(await authedFetch("/api/auth/captcha"));
}

export type AuthPublicKey = {
  ok: true;
  enabled: boolean;
  publicKey?: string;
  algorithm?: string;
};

let cachedAuthPublicKey: AuthPublicKey | null = null;
let cachedAuthPublicKeyAt = 0;
const AUTH_PUBLIC_KEY_CACHE_MS = 5 * 60 * 1000;

export async function apiAuthPublicKey() {
  return j<AuthPublicKey>(await authedFetch("/api/auth/public-key"));
}

async function getAuthPublicKey(): Promise<AuthPublicKey | null> {
  if (typeof window === "undefined") return null;
  const now = Date.now();
  if (cachedAuthPublicKey && now - cachedAuthPublicKeyAt < AUTH_PUBLIC_KEY_CACHE_MS) {
    return cachedAuthPublicKey;
  }
  const res = await apiAuthPublicKey();
  cachedAuthPublicKey = res;
  cachedAuthPublicKeyAt = now;
  return res;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const clean = pem.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function encryptPayload(publicKeyPem: string, payload: string): Promise<string> {
  if (typeof window === "undefined") throw new Error("crypto_unavailable");
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("crypto_unavailable");
  const key = await subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKeyPem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encoded = new TextEncoder().encode(payload);
  const encrypted = await subtle.encrypt({ name: "RSA-OAEP" }, key, encoded);
  return arrayBufferToBase64(encrypted);
}

export async function apiAuthLogin(params: {
  username: string;
  password: string;
  captchaId?: string;
  captchaAnswer?: string;
}) {
  const payload = {
    username: params.username,
    password: params.password,
    captchaId: params.captchaId,
    captchaAnswer: params.captchaAnswer,
  };
  let body: Record<string, unknown> = payload;
  const key = await getAuthPublicKey();
  if (key?.enabled) {
    if (!key.publicKey) {
      throw new Error("auth_encrypt_unavailable");
    }
    const encrypted = await encryptPayload(key.publicKey, JSON.stringify(payload));
    body = { payload: encrypted };
  }
  const res = await authedFetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && typeof data === "object" && data.ok === false)) {
    const err = data?.error || `HTTP ${res.status}`;
    if (err === "auth_locked") {
      const sec = Number(data?.retryAfterSec ?? 0);
      throw new Error(sec > 0 ? `auth_locked:${sec}` : "auth_locked");
    }
    throw new Error(err);
  }
  return data as { ok: true; enabled: boolean; token?: string; expiresAt?: number; ttlDays?: number };
}

export async function apiAuthLogout() {
  return j<{ ok: true }>(
    await authedFetch("/api/auth/logout", {
      method: "POST",
    }),
  );
}

export async function apiRoots() {
  return j<{ ok: true; roots: string[] }>(await fetchWithRetry("/api/roots"));
}

export async function apiGetActiveRoot() {
  return j<{ ok: true; root: string | null }>(await authedFetch("/api/app/active-root"));
}

export async function apiSetActiveRoot(root: string) {
  return j<{ ok: true }>(
    await authedFetch("/api/app/active-root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    }),
  );
}

export type UiToolSetting = {
  id: string;
  enabled: boolean;
};

export async function apiGetUiTools() {
  return j<{ ok: true; tools: UiToolSetting[] }>(await authedFetch("/api/ui/tools"));
}

export async function apiSetUiTools(tools: UiToolSetting[]) {
  return j<{ ok: true; tools: UiToolSetting[] }>(
    await authedFetch("/api/ui/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools }),
    }),
  );
}

export type CommandSettings = {
  mode: "denylist" | "allowlist";
  whitelist: string[];
  denylist: string[];
  timeoutSec: number;
  maxOutputKB: number;
  sessionIdleHours: number;
};

export async function apiGetCommandSettings() {
  return j<{ ok: true; settings: CommandSettings }>(await authedFetch("/api/ui/command"));
}

export async function apiSetCommandSettings(settings: CommandSettings) {
  return j<{ ok: true; settings: CommandSettings }>(
    await authedFetch("/api/ui/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    }),
  );
}

export type UiState = {
  mobileTab: "explorer" | "editor" | "terminal" | "windows" | "settings";
  leftPanelTab: "files" | "settings" | "windows";
  termMode: "cursor" | "codex" | "claude" | "opencode" | "gemini" | "kimi" | "qwen" | "cursor-cli" | "restricted";
  cursorMode: "agent" | "plan" | "ask";
  cursorCliMode: "agent" | "plan" | "ask";
  editorMode: "edit" | "preview";
  panelExplorerCollapsed: boolean;
  panelEditorCollapsed: boolean;
  panelTerminalCollapsed: boolean;
  leftWidth: number;
  topHeight: number;
  mobileKeysVisible: boolean;
  fontSize: number;
};

export async function apiGetUiState() {
  return j<{ ok: true; state: UiState }>(await authedFetch("/api/ui/state"));
}

export async function apiSetUiState(state: UiState) {
  return j<{ ok: true; state: UiState }>(
    await authedFetch("/api/ui/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }),
  );
}

export async function apiList(path: string) {
  return j<{ ok: true; path: string; entries: FsEntry[] }>(
    await authedFetch(`/api/list?path=${encodeURIComponent(path)}`),
  );
}

export async function apiStat(path: string) {
  return j<{ ok: true; path: string; type: "file" | "dir" | "other"; size: number; mtimeMs: number }>(
    await authedFetch(`/api/stat?path=${encodeURIComponent(path)}`),
  );
}

export async function apiRead(path: string, opts?: { maxBytes?: number }) {
  const params = new URLSearchParams();
  params.set("path", path);
  if (opts?.maxBytes && Number.isFinite(opts.maxBytes)) {
    params.set("maxBytes", String(opts.maxBytes));
  }
  return j<{ ok: true; path: string; text: string; size: number; mtimeMs: number }>(
    await authedFetch(`/api/read?${params.toString()}`),
  );
}

export async function apiDownload(path: string) {
  const res = await authedFetch(`/api/download?path=${encodeURIComponent(path)}`);
  if (res.status === 401) {
    clearAuthToken();
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = (data as any)?.error || msg;
    } catch {
      try {
        msg = (await res.text()) || msg;
      } catch {}
    }
    throw new Error(msg);
  }
  return res.blob();
}

export async function apiDelete(path: string) {
  return j<{ ok: true }>(
    await authedFetch(`/api/delete?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  );
}

export async function apiWrite(path: string, text: string) {
  return j<{ ok: true; path: string; size: number; mtimeMs: number }>(
    await authedFetch("/api/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, text }),
    }),
  );
}

export async function apiMkdir(path: string) {
  return j<{ ok: true; path: string; mtimeMs: number }>(
    await authedFetch("/api/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function apiUploadFile(dirPath: string, file: File, opts?: { fileName?: string }) {
  const form = new FormData();
  form.append("file", file);
  form.append("path", dirPath);
  if (opts?.fileName) form.append("filename", opts.fileName);
  return j<{ ok: true; path: string; size: number; mtimeMs: number }>(
    await authedFetch(`/api/upload?path=${encodeURIComponent(dirPath)}`, {
      method: "POST",
      body: form,
    }),
  );
}

// Editor last opened file
export async function apiGetLastOpenedFile(root: string) {
  return j<{ ok: true; filePath: string | null }>(
    await authedFetch(`/api/editor/last?root=${encodeURIComponent(root)}`),
  );
}

export async function apiSetLastOpenedFile(root: string, filePath: string) {
  return j<{ ok: true }>(
    await authedFetch("/api/editor/last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, filePath }),
    }),
  );
}

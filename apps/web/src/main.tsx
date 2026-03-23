import React, { useState, useEffect, useCallback } from "react";
import ReactDOM from "react-dom/client";
import "xterm/css/xterm.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { apiFetch, apiAuthStatus, apiAuthCaptcha, apiAuthLogin, setAuthToken, clearAuthToken, type AuthStatus } from "./api";
import { App } from "./ui/App";
import { SetupPage } from "./ui/SetupPage";
import { I18nProvider, useI18n, type Lang } from "./i18n";

// Tencent vConsole: enable only when explicitly requested.
if (localStorage.getItem("vconsole") === "1") {
  void import("vconsole").then(({ default: VConsole }) => {
    new VConsole();
  });
}

// Monaco Editor 在布局变化（如切换 Codex/终端模式）时会取消内部异步操作并抛出 Canceled，属于预期行为，忽略即可
function isMonacoCanceledError(reason: unknown, fallbackMessage = "", filename = "") {
  const name = typeof reason === "object" && reason !== null ? (reason as { name?: unknown }).name : null;
  const msg =
    typeof reason === "object" && reason !== null && "message" in reason
      ? String((reason as { message?: unknown }).message ?? fallbackMessage)
      : String(fallbackMessage || (reason ?? ""));
  return (
    (name === "Canceled" && msg === "Canceled") ||
    msg.includes("Canceled") ||
    (filename.includes("editor.api") && msg.includes("ERR Canceled"))
  );
}

window.addEventListener("unhandledrejection", (event) => {
  if (isMonacoCanceledError(event.reason)) {
    event.preventDefault();
    event.stopPropagation();
  }
});

window.addEventListener("error", (event) => {
  if (isMonacoCanceledError(event.error, event.message, event.filename || "")) {
    event.preventDefault();
    event.stopPropagation();
  }
});

type BoundaryState = { error: Error | null };

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[AppErrorBoundary]", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, fontFamily: "var(--mono)", whiteSpace: "pre-wrap", color: "#b91c1c" }}>
          {"[App Crash] " + (this.state.error.stack || this.state.error.message || String(this.state.error))}
        </div>
      );
    }
    return this.props.children;
  }
}

function Root() {
  const { t, lang, setLang } = useI18n();
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  const [setupChecked, setSetupChecked] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const isMainRoute = hash === "#/" || hash === "";

  const [authChecked, setAuthChecked] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaId, setCaptchaId] = useState("");
  const [captchaQuestion, setCaptchaQuestion] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const langSwitch = (
    <div className="langSwitch">
      <span className="langLabel">{t("语言")}</span>
      <select
        className="select"
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label={t("语言")}
      >
        <option value="zh">{t("中文")}</option>
        <option value="en">{t("英文")}</option>
      </select>
    </div>
  );

  const checkAuth = useCallback(() => {
    setAuthError(null);
    apiAuthStatus()
      .then((res) => {
        setAuthStatus(res);
        setAuthChecked(true);
      })
      .catch((err: Error) => {
        setAuthError(err?.message || String(err));
        setAuthChecked(true);
      });
  }, []);

  const loadCaptcha = useCallback(() => {
    if (!authStatus?.enabled) return;
    setCaptchaLoading(true);
    setCaptchaError(null);
    apiAuthCaptcha()
      .then((res) => {
        if (res?.enabled && res.id && res.question) {
          setCaptchaEnabled(true);
          setCaptchaId(res.id);
          setCaptchaQuestion(res.question);
          setCaptchaAnswer("");
        } else {
          setCaptchaEnabled(false);
          setCaptchaId("");
          setCaptchaQuestion("");
        }
      })
      .catch((err: Error) => {
        setCaptchaEnabled(false);
        setCaptchaId("");
        setCaptchaQuestion("");
        setCaptchaError(err?.message || String(err));
      })
      .finally(() => {
        setCaptchaLoading(false);
      });
  }, [authStatus?.enabled]);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    checkAuth();
    const onAuth = () => checkAuth();
    window.addEventListener("codesentinel:auth-changed", onAuth);
    return () => {
      window.removeEventListener("codesentinel:auth-changed", onAuth);
    };
  }, [checkAuth]);

  const handleLogin = useCallback(async () => {
    const uname = loginUsername.trim();
    if (!uname) {
      setLoginError(t("请输入用户名"));
      return;
    }
    const pwd = loginPassword.trim();
    if (!pwd) {
      setLoginError(t("请输入密码"));
      return;
    }
    const capAns = captchaAnswer.trim();
    if (captchaEnabled) {
      if (!captchaId || !capAns) {
        setLoginError(t("请完成验证码"));
        if (!captchaId) loadCaptcha();
        return;
      }
    }
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await apiAuthLogin({
        username: uname,
        password: pwd,
        captchaId,
        captchaAnswer: capAns,
      });
      if (res?.token) {
        setAuthToken(res.token);
        setLoginPassword("");
        setCaptchaAnswer("");
      } else {
        setLoginError(t("登录失败"));
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (typeof msg === "string" && msg.startsWith("auth_locked")) {
        const parts = msg.split(":");
        const sec = Number(parts[1] ?? 0);
        if (Number.isFinite(sec) && sec > 0) {
          setLoginError(t("登录失败次数过多，请在 {sec}s 后再试", { sec }));
        } else {
          setLoginError(t("登录失败次数过多，请稍后再试"));
        }
      } else if (msg === "invalid_credentials") {
        setLoginError(t("用户名或密码错误"));
      } else if (msg === "auth_payload_required" || msg === "auth_payload_invalid" || msg === "auth_encrypt_unavailable" || msg === "crypto_unavailable") {
        setLoginError(t("加密不可用，请刷新页面或联系管理员"));
      } else if (msg === "captcha_required") {
        setLoginError(t("请完成验证码"));
        loadCaptcha();
      } else if (msg === "captcha_invalid") {
        setLoginError(t("验证码错误，请重试"));
        loadCaptcha();
      } else if (msg === "captcha_expired") {
        setLoginError(t("验证码已过期，请重试"));
        loadCaptcha();
      } else {
        setLoginError(msg);
      }
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword, captchaEnabled, captchaId, captchaAnswer, loadCaptcha, t]);

  const needsLogin = authChecked && authStatus?.enabled && !authStatus?.authenticated;

  useEffect(() => {
    if (!needsLogin) {
      setCaptchaEnabled(false);
      setCaptchaId("");
      setCaptchaQuestion("");
      setCaptchaAnswer("");
      setCaptchaError(null);
      setCaptchaLoading(false);
      return;
    }
    loadCaptcha();
  }, [needsLogin, loadCaptcha]);

  // 打开主页面时检测 config/.setup-done，没有则自动进入安装页
  useEffect(() => {
    if (!authChecked) return;
    if (authStatus?.enabled && !authStatus?.authenticated) return;
    if (hash !== "#/setup" && !isMainRoute) {
      setSetupChecked(true);
      return;
    }
    if (hash === "#/setup") {
      setSetupChecked(true);
      return;
    }
    let cancelled = false;
    const maxAttempts = 8;
    const delayMs = 1500;
    function attempt(n: number) {
      if (cancelled) return;
      apiFetch("/api/setup/check")
        .then(async (r) => {
          if (r.status === 401) {
            clearAuthToken();
            return Promise.reject(new Error("auth_required"));
          }
          const body = await r.text();
          if (!r.ok) {
            let errMsg = `${r.status}`;
            try {
              const j = JSON.parse(body) as { error?: string };
              if (j?.error) errMsg = j.error;
            } catch {
              if (body) errMsg = body.slice(0, 200);
            }
            return Promise.reject(new Error(errMsg));
          }
          try {
            return JSON.parse(body) as { ok?: boolean; setupDone?: boolean; roots?: unknown[] };
          } catch {
            return Promise.reject(new Error(t("无效的 JSON")));
          }
        })
        .then((data) => {
          if (cancelled) return;
          setSetupChecked(true);
          const needSetup = data?.ok && (
            data.setupDone === false ||
            (Array.isArray(data.roots) && data.roots.length === 0)
          );
          if (needSetup) {
            window.location.hash = "#/setup";
            setHash("#/setup");
          }
        })
        .catch((err: Error) => {
          if (cancelled) return;
          const msg = err?.message || String(err);
          if (n < maxAttempts) {
            if (n === 0) console.warn("[setup/check] attempt failed:", msg);
            setTimeout(() => attempt(n + 1), delayMs);
          } else {
            console.error("[setup/check] all retries failed. Backend may be down or returning 500:", msg);
            setSetupError(msg);
            setSetupChecked(true);
          }
        });
    }
    attempt(0);
    return () => {
      cancelled = true;
    };
  }, [hash, isMainRoute, authChecked, authStatus?.enabled, authStatus?.authenticated]);

  if (!authChecked && isMainRoute) {
    return (
      <div className="authGate">
        {langSwitch}
        <div className="authCard">
          <div className="authTitle">{t("正在连接服务…")}</div>
          <div className="authHint">{t("等待后端就绪")}</div>
        </div>
      </div>
    );
  }

  if (authError && isMainRoute) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui", color: "#64748b", gap: 8, padding: 24, textAlign: "center" }}>
        {langSwitch}
        <span style={{ color: "#dc2626" }}>{t("后端未就绪或出错")}</span>
        <span style={{ fontSize: 14 }}>{t("请确认已运行：pnpm dev 或 pnpm dev:server")}</span>
        <span style={{ fontSize: 12, maxWidth: 400 }}>{t("错误信息：{msg}", { msg: authError })}</span>
        <button
          type="button"
          style={{ marginTop: 8, padding: "6px 12px", cursor: "pointer" }}
          onClick={() => { setAuthError(null); window.location.reload(); }}
        >
          {t("重试")}
        </button>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="authGate">
        {langSwitch}
        <div className="authCard">
          <div className="authTitle">{t("需要登录")}</div>
          <div className="authHint">{t("请输入用户名与密码")}</div>
          <input
            className="authInput"
            type="text"
            value={loginUsername}
            onChange={(e) => setLoginUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleLogin(); }}
            placeholder={t("用户名")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="authInput"
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleLogin(); }}
            placeholder={t("密码")}
          />
          {captchaEnabled ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, color: "#64748b" }}>{t("验证码")}</div>
                <div style={{ fontSize: 13, color: "#0f172a", flex: 1, textAlign: "right" }}>
                  {captchaQuestion || (captchaLoading ? t("加载中…") : "--")}
                </div>
                <button
                  type="button"
                  className="authLink"
                  style={{ padding: 0 }}
                  onClick={() => loadCaptcha()}
                  disabled={captchaLoading}
                >
                  {t("刷新")}
                </button>
              </div>
              <input
                className="authInput"
                type="text"
                value={captchaAnswer}
                onChange={(e) => setCaptchaAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleLogin(); }}
                placeholder={t("请输入验证码答案")}
              />
              {captchaError ? <div className="authError">{captchaError}</div> : null}
            </div>
          ) : null}
          {loginError ? <div className="authError">{loginError}</div> : null}
          <button className="authButton" onClick={handleLogin} disabled={loginLoading}>
            {loginLoading ? t("登录中…") : t("登录")}
          </button>
          <button className="authLink" onClick={() => { clearAuthToken(); }}>
            {t("重新检测")}
          </button>
        </div>
      </div>
    );
  }

  if (hash === "#/setup") {
    return <SetupPage />;
  }
  if (isMainRoute && setupError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui", color: "#64748b", gap: 8, padding: 24, textAlign: "center" }}>
        {langSwitch}
        <span style={{ color: "#dc2626" }}>{t("后端未就绪或出错")}</span>
        <span style={{ fontSize: 14 }}>{t("请确认已运行：pnpm dev 或 pnpm dev:server")}</span>
        <span style={{ fontSize: 12, maxWidth: 400 }}>{t("错误信息：{msg}", { msg: setupError })}</span>
        <button
          type="button"
          style={{ marginTop: 8, padding: "6px 12px", cursor: "pointer" }}
          onClick={() => { setSetupError(null); window.location.reload(); }}
        >
          {t("重试")}
        </button>
      </div>
    );
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </AppErrorBoundary>,
);

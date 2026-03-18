import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import { useI18n } from "../i18n";

type ToolStatus = { ok: true; path: string | null; version: string | null; error: null } | { ok: false; path: string | null; version: null; error: string | null };

type InstallHintsByPlatform = { darwin: string; win32: string; linux: string };

type SetupCheck = {
  ok: boolean;
  platform?: string;
  roots?: string[];
  defaultRoot?: string;
  tools?: { agent: ToolStatus; codex: ToolStatus; claude: ToolStatus; opencode: ToolStatus; cursor: ToolStatus; rg: ToolStatus };
  installHints?: { agent: InstallHintsByPlatform; rg: InstallHintsByPlatform; codex: InstallHintsByPlatform; claude: InstallHintsByPlatform; opencode: InstallHintsByPlatform };
};

const STEPS = [
  { id: 1, titleKey: "选择根目录" },
  { id: 2, titleKey: "安装 Cursor / Codex / Claude / OpenCode（手动）" },
  { id: 3, titleKey: "初始化数据库" },
] as const;

export function SetupPage() {
  const { t, lang, setLang } = useI18n();
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [setupData, setSetupData] = useState<SetupCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [rootsInput, setRootsInput] = useState("");
  const [addRootLoading, setAddRootLoading] = useState(false);
  const [installResult, setInstallResult] = useState<{ tool: string; ok: boolean; msg?: string } | null>(null);
  const [step2Skipped, setStep2Skipped] = useState(false);
  const [dbInitLoading, setDbInitLoading] = useState(false);
  const [dbInitDone, setDbInitDone] = useState(false);
  const [completeLoading, setCompleteLoading] = useState(false);

  const fetchCheck = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await apiFetch("/api/setup/check");
      const data = await r.json();
      if (data?.ok) {
        setSetupData(data);
      } else {
        setError(data?.error ?? `HTTP ${r.status}`);
        setSetupData(null);
      }
    } catch (e: any) {
      setError(e?.message ?? t("无法连接后端，请确认服务已启动（如 pnpm dev）"));
      setSetupData(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCheck();
  }, [fetchCheck]);

  useEffect(() => {
    if (!setupData) return;
    if (rootsInput.trim()) return;
    if (setupData.defaultRoot) {
      setRootsInput(setupData.defaultRoot);
    }
  }, [setupData, rootsInput]);

  const roots = setupData?.roots ?? [];
  const step1Done = roots.length > 0;

  const handleAddRoots = async () => {
    const lines = rootsInput
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const failureSep = lang === "en" ? "; " : "；";
    setAddRootLoading(true);
    setInstallResult(null);
    const added: string[] = [];
    const failed: string[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        const path = lines[i];
        const setActive = i === lines.length - 1;
        try {
          const r = await apiFetch("/api/setup/add-root", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ root: path, setActive }),
          });
          const data = await r.json();
          if (data?.ok) {
            setSetupData((prev) => (prev ? { ...prev, roots: data.roots } : null));
            added.push(path);
          } else {
            failed.push(`${path}: ${data?.error ?? t("添加失败")}`);
          }
        } catch (e: any) {
          failed.push(`${path}: ${e?.message ?? t("请求失败")}`);
        }
      }
      if (failed.length === 0) {
        setRootsInput("");
        setInstallResult({ tool: "root", ok: true, msg: t("已添加 {count} 个根目录", { count: added.length }) });
      } else if (added.length > 0) {
        setInstallResult({
          tool: "root",
          ok: false,
          msg: t("已添加 {added} 个，失败 {failed} 个：{detail}", { added: added.length, failed: failed.length, detail: failed.join(failureSep) }),
        });
      } else {
        setInstallResult({ tool: "root", ok: false, msg: failed.join(failureSep) });
      }
    } finally {
      setAddRootLoading(false);
    }
  };

  const handleInitDb = async () => {
    setDbInitLoading(true);
    setInstallResult(null);
    try {
      const r = await apiFetch("/api/setup/ensure-db");
      const data = await r.json();
      if (data?.ok) {
        setDbInitDone(true);
      } else {
        setInstallResult({ tool: "db", ok: false, msg: data?.error ?? t("初始化失败") });
      }
    } catch (e: any) {
      setInstallResult({ tool: "db", ok: false, msg: e?.message ?? t("请求失败") });
    } finally {
      setDbInitLoading(false);
    }
  };

  const handleComplete = async () => {
    setCompleteLoading(true);
    try {
      const r = await apiFetch("/api/setup/complete", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await r.json();
      if (data?.ok) {
        window.location.hash = "#/";
      } else {
        setInstallResult({ tool: "complete", ok: false, msg: data?.error ?? t("完成失败") });
      }
    } catch (e: any) {
      setInstallResult({ tool: "complete", ok: false, msg: e?.message ?? t("请求失败") });
    } finally {
      setCompleteLoading(false);
    }
  };

  const goNext = () => {
    if (currentStep === 1 && step1Done) setCurrentStep(2);
    if (currentStep === 2) setCurrentStep(3);
  };

  const goPrev = () => {
    if (currentStep === 2) setCurrentStep(1);
    if (currentStep === 3) setCurrentStep(2);
  };

  if (loading && !setupData) {
    return (
      <div className="setupPage">
        <div className="langSwitch">
          <span className="langLabel">{t("语言")}</span>
          <select className="select" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en")}>
            <option value="zh">{t("中文")}</option>
            <option value="en">{t("英文")}</option>
          </select>
        </div>
        <div className="setupLoading">
          <p>{t("正在检测环境…")}</p>
        </div>
      </div>
    );
  }

  const tools = setupData?.tools;
  const hints = setupData?.installHints;
  const platform = setupData?.platform ?? "";
  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  const rootsHint =
    isMac
      ? t("每行一个绝对路径，如 /Users/你的用户名/项目 或 /Users/你的用户名/Desktop")
      : isWin
        ? t("每行一个绝对路径，如 C:\\Users\\你的用户名\\项目 或 D:\\workspace（反斜杠写一条或两条均可）")
        : t("每行一个绝对路径，如 /home/你的用户名/project");
  const rootsPlaceholder =
    isMac
      ? t("/Users/你的用户名/project\n/Users/你的用户名/Desktop")
      : isWin
        ? t("C:\\Users\\你的用户名\\project\nD:\\workspace")
        : t("/home/你的用户名/project");

  const canGoNextStep1 = step1Done;
  const canGoNextStep2 = true;
  const showPrev = currentStep > 1;

  return (
    <div className="setupPage">
      <div className="langSwitch">
        <span className="langLabel">{t("语言")}</span>
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en")}>
          <option value="zh">{t("中文")}</option>
          <option value="en">{t("英文")}</option>
        </select>
      </div>
      <header className="setupHeader">
        <h1 className="setupTitle">{t("配置与安装")}</h1>
        <div className="setupStepper">
          {STEPS.map((s) => (
            <span
              key={s.id}
              className={"setupStepperDot" + (currentStep === s.id ? " setupStepperDotActive" : "") + (currentStep > s.id ? " setupStepperDotDone" : "")}
              title={t(s.titleKey)}
            >
              {s.id}
            </span>
          ))}
          <span className="setupStepperLabel">{t(STEPS[currentStep - 1].titleKey)}</span>
        </div>
      </header>

      <main className="setupMain">
        {error && (
          <section className="setupSection setupError">
            <p>{t("无法连接后端：{msg}", { msg: error })}</p>
            <button type="button" className="setupSecondaryBtn" onClick={fetchCheck}>
              {t("重试")}
            </button>
          </section>
        )}

        {setupData && !error && (
          <section className="setupSection setupStepBody">
            {/* 第一步：选择根目录 */}
            {currentStep === 1 && (
              <>
                <h2>{t("第一步：选择根目录")}</h2>
                <p>{t("添加允许在 CodeSentinel（盯码侠）中访问的根目录（至少一个）。每行一个路径，可一次添加多个。")}</p>
                {roots.length > 0 && (
                  <ul className="setupRootList">
                    {roots.map((r) => (
                      <li key={r} className="setupRootItem">
                        <code>{r}</code>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="setupHint">{rootsHint}</p>
                <textarea
                  className="setupTextarea"
                  placeholder={rootsPlaceholder}
                  value={rootsInput}
                  onChange={(e) => setRootsInput(e.target.value)}
                  disabled={addRootLoading}
                  rows={4}
                />
                <div className="setupRow">
                  <button
                    type="button"
                    className="setupSecondaryBtn"
                    onClick={handleAddRoots}
                    disabled={!rootsInput.trim() || addRootLoading}
                  >
                    {addRootLoading ? t("添加中…") : t("添加")}
                  </button>
                </div>
                {installResult?.tool === "root" && (
                  <p className={installResult.ok ? "setupStatus setupStatusOk" : "setupStatus setupStatusFail"}>
                    {installResult.ok ? "✓ " : "✗ "}{installResult.msg}
                  </p>
                )}
              </>
            )}

            {/* 第二步：安装 Cursor / Codex / Claude / OpenCode（仅手动安装说明） */}
            {currentStep === 2 && (
              <>
                <h2>{t("第二步：安装 Cursor / Codex / Claude / OpenCode（手动安装）")}</h2>
                <p>{t("以下工具用于 Cursor Chat、Codex/Claude/OpenCode 终端等功能。请根据当前检测状态，在终端中按下方说明手动安装。未安装也可跳过，但相关功能将无法使用。")}</p>
                <div className="setupToolGrid">
                  {tools?.agent !== undefined && (
                    <div className="setupToolCard">
                      <div className="setupToolRow">
                        <span className="setupToolName">Cursor CLI（agent）</span>
                        {tools.agent.ok ? (
                          <span className="setupToolStatus setupStatusOk">✓ {t("已安装")}{tools.agent.version ? ` ${tools.agent.version}` : null}</span>
                        ) : (
                          <span className="setupToolStatus setupStatusFail">✗ {t("未安装")}</span>
                        )}
                      </div>
                      {!tools.agent.ok && hints?.agent && (
                        <div className="setupToolStatusBody">
                          <div className="setupManualBlock">
                            <span className="setupManualLabel">{t("安装方法")}</span>
                            <ul className="setupPlatformHints">
                              <li><span className="setupPlatformLabel">macOS</span><code className="setupToolHint">{hints.agent.darwin}</code></li>
                              <li><span className="setupPlatformLabel">Windows</span><code className="setupToolHint">{hints.agent.win32}</code></li>
                              <li><span className="setupPlatformLabel">Linux</span><code className="setupToolHint">{hints.agent.linux}</code></li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {tools?.codex !== undefined && (
                    <div className="setupToolCard">
                      <div className="setupToolRow">
                        <span className="setupToolName">Codex</span>
                        {tools.codex.ok ? (
                          <span className="setupToolStatus setupStatusOk">✓ {t("已安装")}{tools.codex.version ? ` ${tools.codex.version}` : null}</span>
                        ) : (
                          <span className="setupToolStatus setupStatusFail">✗ {t("未安装")}</span>
                        )}
                      </div>
                      {!tools.codex.ok && hints?.codex && (
                        <div className="setupToolStatusBody">
                          <div className="setupManualBlock">
                            <span className="setupManualLabel">{t("安装方法")}</span>
                            <ul className="setupPlatformHints">
                              <li><span className="setupPlatformLabel">macOS</span><code className="setupToolHint">{hints.codex.darwin}</code></li>
                              <li><span className="setupPlatformLabel">Windows</span><code className="setupToolHint">{hints.codex.win32}</code></li>
                              <li><span className="setupPlatformLabel">Linux</span><code className="setupToolHint">{hints.codex.linux}</code></li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {tools?.claude !== undefined && (
                    <div className="setupToolCard">
                      <div className="setupToolRow">
                        <span className="setupToolName">Claude Code</span>
                        {tools.claude.ok ? (
                          <span className="setupToolStatus setupStatusOk">✓ {t("已安装")}{tools.claude.version ? ` ${tools.claude.version}` : null}</span>
                        ) : (
                          <span className="setupToolStatus setupStatusFail">✗ {t("未安装")}</span>
                        )}
                      </div>
                      {!tools.claude.ok && hints?.claude && (
                        <div className="setupToolStatusBody">
                          <div className="setupManualBlock">
                            <span className="setupManualLabel">{t("安装方法")}</span>
                            <ul className="setupPlatformHints">
                              <li><span className="setupPlatformLabel">macOS</span><code className="setupToolHint">{hints.claude.darwin}</code></li>
                              <li><span className="setupPlatformLabel">Windows</span><code className="setupToolHint">{hints.claude.win32}</code></li>
                              <li><span className="setupPlatformLabel">Linux</span><code className="setupToolHint">{hints.claude.linux}</code></li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {tools?.opencode !== undefined && (
                    <div className="setupToolCard">
                      <div className="setupToolRow">
                        <span className="setupToolName">OpenCode</span>
                        {tools.opencode.ok ? (
                          <span className="setupToolStatus setupStatusOk">✓ {t("已安装")}{tools.opencode.version ? ` ${tools.opencode.version}` : null}</span>
                        ) : (
                          <span className="setupToolStatus setupStatusFail">✗ {t("未安装")}</span>
                        )}
                      </div>
                      {!tools.opencode.ok && hints?.opencode && (
                        <div className="setupToolStatusBody">
                          <div className="setupManualBlock">
                            <span className="setupManualLabel">{t("安装方法")}</span>
                            <ul className="setupPlatformHints">
                              <li><span className="setupPlatformLabel">macOS</span><code className="setupToolHint">{hints.opencode.darwin}</code></li>
                              <li><span className="setupPlatformLabel">Windows</span><code className="setupToolHint">{hints.opencode.win32}</code></li>
                              <li><span className="setupPlatformLabel">Linux</span><code className="setupToolHint">{hints.opencode.linux}</code></li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {tools?.rg !== undefined && (
                    <div className="setupToolCard">
                      <div className="setupToolRow">
                        <span className="setupToolName">Ripgrep（rg）</span>
                        {tools.rg.ok ? (
                          <span className="setupToolStatus setupStatusOk">✓ {t("已安装")}{tools.rg.version ? ` ${tools.rg.version}` : null}</span>
                        ) : (
                          <span className="setupToolStatus setupStatusFail">✗ {t("未安装")}</span>
                        )}
                      </div>
                      {!tools.rg.ok && hints?.rg && (
                        <div className="setupToolStatusBody">
                          <div className="setupManualBlock">
                            <span className="setupManualLabel">{t("安装方法")}</span>
                            <ul className="setupPlatformHints">
                              <li><span className="setupPlatformLabel">macOS</span><code className="setupToolHint">{hints.rg.darwin}</code></li>
                              <li><span className="setupPlatformLabel">Windows</span><code className="setupToolHint">{hints.rg.win32}</code></li>
                              <li><span className="setupPlatformLabel">Linux</span><code className="setupToolHint">{hints.rg.linux}</code></li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="setupRow setupSkipRow">
                  <button type="button" className="setupSkipBtn" onClick={() => setStep2Skipped(true)}>
                    {t("跳过此步")}
                  </button>
                  <span className="setupSkipHint">{t("跳过则无法正常使用 Cursor Chat、Codex/Claude/OpenCode 终端等功能。")}</span>
                </div>
              </>
            )}

            {/* 第三步：初始化数据库 */}
            {currentStep === 3 && (
              <>
                <h2>{t("第三步：初始化数据库")}</h2>
                <p>{t("初始化本地数据库，用于保存聊天记录、工作区等。")}</p>
                {!dbInitDone ? (
                  <>
                    <div className="setupRow">
                      <button
                        type="button"
                        className="setupPrimaryBtn"
                        onClick={handleInitDb}
                        disabled={dbInitLoading}
                      >
                        {dbInitLoading ? t("初始化中…") : t("初始化数据库")}
                      </button>
                     
                    </div>
                    {installResult?.tool === "db" && !installResult?.ok && (
                      <p className="setupStatus setupStatusFail">✗ {installResult.msg}</p>
                    )}
                    {installResult?.tool === "complete" && !installResult?.ok && (
                      <p className="setupStatus setupStatusFail">✗ {installResult.msg}</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="setupStatus setupStatusOk">✓ {t("数据库已初始化")}</p>
                    <button
                      type="button"
                      className="setupPrimaryBtn"
                      onClick={handleComplete}
                      disabled={completeLoading}
                    >
                      {completeLoading ? t("处理中…") : t("完成安装，进入 CodeSentinel")}
                    </button>
                    {installResult?.tool === "complete" && !installResult?.ok && (
                      <p className="setupStatus setupStatusFail">✗ {installResult.msg}</p>
                    )}
                  </>
                )}
              </>
            )}

            {/* 底部：上一步 / 下一步 */}
            <div className="setupStepActions">
              {showPrev && (
                <button type="button" className="setupSecondaryBtn" onClick={goPrev}>
                  {t("上一步")}
                </button>
              )}
              <div style={{ flex: 1 }} />
              {currentStep === 1 && (
                <button
                  type="button"
                  className="setupPrimaryBtn"
                  onClick={goNext}
                  disabled={!canGoNextStep1}
                  title={!canGoNextStep1 ? t("请先添加至少一个根目录") : undefined}
                >
                  {t("下一步")}
                </button>
              )}
              {currentStep === 2 && (
                <button type="button" className="setupPrimaryBtn" onClick={goNext}>
                  {t("下一步")}
                </button>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

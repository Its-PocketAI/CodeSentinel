import React, { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  ControlPlaneArtifactItem,
  ControlPlaneAttentionItem,
  ControlPlaneSessionCard,
} from "./controlPlaneStore";

type QuickAction = {
  id: string;
  label: string;
  description: string;
  onSelect: () => void;
};

type OpenFileItem = {
  path: string;
  dirty?: boolean;
  current?: boolean;
};

type FoldKey = "guide" | "quickEntry" | "current" | "reminders" | "sessions" | "artifacts" | "files";

type Props = {
  mode: "overview" | "now" | "artifacts";
  isMobile?: boolean;
  connected: boolean;
  stale: boolean;
  sessions: ControlPlaneSessionCard[];
  attention: ControlPlaneAttentionItem[];
  artifacts: ControlPlaneArtifactItem[];
  quickActions: QuickAction[];
  currentSurface?: {
    lifecycle: string;
    capability: string;
    detail: string;
  } | null;
  openFiles?: OpenFileItem[];
  onActivateSession: (sessionId: string) => void;
  onViewReplay: (sessionId: string) => void;
  onViewArtifact?: (sessionId: string, kind: "replay" | "snapshot" | "diff") => void;
  onCloseSession: (sessionId: string) => void;
  onAcknowledgeSession?: (sessionId: string) => void;
  onActivateFile?: (path: string) => void;
  onCloseFile?: (path: string) => void;
  onBackToTerminal?: () => void;
  onClearArtifacts?: () => void;
  clearingArtifacts?: boolean;
};

function defaultFoldState(mode: Props["mode"]): Record<FoldKey, boolean> {
  if (mode === "artifacts") {
    return {
      guide: false,
      quickEntry: false,
      current: false,
      reminders: false,
      sessions: false,
      artifacts: true,
      files: false,
    };
  }
  if (mode === "now") {
    return {
      guide: false,
      quickEntry: false,
      current: true,
      reminders: false,
      sessions: false,
      artifacts: false,
      files: false,
    };
  }
  return {
    guide: false,
    quickEntry: true,
    current: true,
    reminders: false,
    sessions: false,
    artifacts: false,
    files: false,
  };
}

function modeLabel(mode: string): string {
  if (!mode) return "未知";
  if (mode === "restricted-pty") return "安全终端";
  if (mode === "restricted-exec") return "安全命令";
  if (mode.startsWith("cursor-cli-")) return `Cursor CLI · ${mode.replace("cursor-cli-", "")}`;
  if (mode === "cursor") return "Cursor Chat";
  if (mode === "codex") return "Codex CLI";
  if (mode === "claude") return "Claude Code";
  if (mode === "opencode") return "OpenCode CLI";
  if (mode === "gemini") return "Gemini CLI";
  if (mode === "kimi") return "Kimi CLI";
  if (mode === "qwen") return "Qwen Code";
  if (mode === "restricted") return "安全终端";
  return mode;
}

function attentionKindLabel(kind: ControlPlaneAttentionItem["kind"]) {
  if (kind === "approval") return "确认";
  return "异常";
}

function confidenceLabel(confidence: ControlPlaneAttentionItem["confidence"]) {
  if (confidence === "high") return "高置信";
  if (confidence === "medium") return "中置信";
  return "低置信";
}

function artifactKindLabel(kind: ControlPlaneArtifactItem["kind"]) {
  if (kind === "snapshot") return "实时快照";
  if (kind === "diff") return "Diff 线索";
  return "终端回放";
}

function statusMeta(status: ControlPlaneSessionCard["status"]) {
  if (status === "running") return { label: "在线", tone: "accent" };
  if (status === "completed") return { label: "待继续", tone: "success" };
  if (status === "closed") return { label: "已关闭", tone: "warning" };
  if (status === "idle") return { label: "已超时", tone: "warning" };
  if (status === "queued") return { label: "待启动", tone: "neutral" };
  return { label: "已退出", tone: "danger" };
}

function levelTone(level: ControlPlaneAttentionItem["level"]) {
  if (level === "error") return "danger";
  if (level === "warning") return "warning";
  if (level === "success") return "success";
  return "accent";
}

function formatTime(value: number) {
  if (!value) return "刚刚";
  const diffSec = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (diffSec < 60) return `${diffSec || 1}s 前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m 前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h 前`;
  return `${Math.floor(diffSec / 86400)}d 前`;
}

function panelGuide(mode: Props["mode"]) {
  if (mode === "now") {
    return {
      title: "当前会话",
      detail: "这里是你现在正在输入的那个 AI 或终端窗口。切到这里，意味着你要继续当前工作。",
    };
  }
  if (mode === "artifacts") {
    return {
      title: "历史记录",
      detail: "这里是自动保存的会话回看区，用来找回刚才输出、排查报错、回看 diff；不需要时可以直接删除或清空。",
    };
  }
  return {
    title: "怎么区分这些区域",
    detail: "Qwen Code / Codex CLI / 安全终端是工具；当前会话是你现在正在操作的窗口；提醒是需要你看一眼的确认或异常；历史记录是过去会话的回看。",
  };
}

function ConceptMap() {
  const items = [
    {
      kicker: "工具",
      title: "Qwen Code / Codex CLI / 安全终端",
      detail: "决定你的输入发给谁。",
    },
    {
      kicker: "当前",
      title: "当前会话",
      detail: "你现在正在操作的那个窗口。",
    },
    {
      kicker: "提醒",
      title: "提醒",
      detail: "确认、异常都在这里。",
    },
    {
      kicker: "历史",
      title: "历史记录",
      detail: "回放、快照、diff 都是回看，不直接输入。",
    },
  ];

  return (
    <div className="controlPlaneMap">
      {items.map((item) => (
        <div className="controlPlaneMapCard" key={item.title}>
          <div className="controlPlaneMapKicker">{item.kicker}</div>
          <div className="controlPlaneMapTitle">{item.title}</div>
          <div className="controlPlaneMapDetail">{item.detail}</div>
        </div>
      ))}
    </div>
  );
}

function SessionCard({
  session,
  onActivateSession,
  onViewReplay,
  onCloseSession,
}: {
  session: ControlPlaneSessionCard;
  onActivateSession: (sessionId: string) => void;
  onViewReplay: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}) {
  const meta = statusMeta(session.status);
  return (
    <div className={"controlPlaneCard" + (session.current ? " controlPlaneCardCurrent" : "")}>
      <div className="controlPlaneCardHeader">
        <div className="controlPlaneCardTitleWrap">
          <div className="controlPlaneCardTitleRow">
            <div className="controlPlaneCardTitle">{session.current ? "当前会话" : session.sessionId}</div>
            <span className={`termStatusChip termStatusChip-${meta.tone}`}>{meta.label}</span>
            {session.current ? <span className="controlPlaneCardPill">当前</span> : null}
            {session.stale ? <span className="controlPlaneCardPill controlPlaneCardPillMuted">待同步</span> : null}
            {session.attentionCount > 0 ? (
              <span className="controlPlaneCardPill controlPlaneCardPillWarn">{session.attentionCount} 提醒</span>
            ) : null}
          </div>
          <div className="controlPlaneCardMeta">
            <span>{modeLabel(session.mode)}</span>
            <span>{formatTime(session.updatedAt)}</span>
            {session.cwd ? <span title={session.cwd}>{session.cwd}</span> : null}
          </div>
        </div>
      </div>
      <div className="controlPlaneCardBody">
        <div className="controlPlaneCardDetail">{session.detail || "等待新输出"}</div>
        <div className="controlPlaneCardActions">
          <button className="btn btnSm" onClick={() => onActivateSession(session.sessionId)}>
            {session.current ? "聚焦终端" : session.active ? "接入" : "恢复"}
          </button>
          <button className="btn btnSm" disabled={!session.replayAvailable} onClick={() => onViewReplay(session.sessionId)}>
            回放
          </button>
          <button className="btn btnSm" disabled={session.current} onClick={() => onCloseSession(session.sessionId)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function AttentionList({
  items,
  onActivateSession,
  onViewReplay,
  onAcknowledgeSession,
}: {
  items: ControlPlaneAttentionItem[];
  onActivateSession: (sessionId: string) => void;
  onViewReplay: (sessionId: string) => void;
  onAcknowledgeSession?: (sessionId: string) => void;
}) {
  if (!items.length) {
    return <div className="controlPlaneEmpty">当前没有提醒。</div>;
  }
  return (
    <div className="controlPlaneList">
      {items.map((item) => (
        <div className="controlPlaneInboxItem" key={item.id}>
          <div className="controlPlaneInboxMain">
            <div className="controlPlaneInboxTitleRow">
              <div className="controlPlaneInboxTitle">{item.title}</div>
              <span className={`termStatusChip termStatusChip-${levelTone(item.level)}`}>{attentionKindLabel(item.kind)}</span>
              <span className="controlPlaneInboxConfidence">{confidenceLabel(item.confidence)}</span>
            </div>
            <div className="controlPlaneInboxMeta">
              <span>{item.sessionId}</span>
              <span>{formatTime(item.updatedAt)}</span>
            </div>
            <div className="controlPlaneInboxDetail">{item.detail || "进入会话查看上下文。"}</div>
          </div>
          <div className="controlPlaneInboxActions">
            <button
              className="btn btnSm"
              onClick={() => (
                item.action === "view-replay" || item.action === "view-artifacts"
                  ? onViewReplay(item.sessionId)
                  : onActivateSession(item.sessionId)
              )}
            >
              {item.action === "view-replay" || item.action === "view-artifacts" ? "查看回放" : "打开会话"}
            </button>
            {onAcknowledgeSession ? (
              <button className="btn btnSm" onClick={() => onAcknowledgeSession(item.sessionId)}>
                已读
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtifactList({
  items,
  sessions,
  onActivateSession,
  onViewReplay,
  onViewArtifact,
  onDeleteSession,
}: {
  items: ControlPlaneArtifactItem[];
  sessions: ControlPlaneSessionCard[];
  onActivateSession: (sessionId: string) => void;
  onViewReplay: (sessionId: string) => void;
  onViewArtifact?: (sessionId: string, kind: "replay" | "snapshot" | "diff") => void;
  onDeleteSession?: (sessionId: string) => void;
}) {
  if (!items.length) {
    return <div className="controlPlaneEmpty">还没有历史记录。</div>;
  }
  const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
  return (
    <div className="controlPlaneList">
      {items.map((item) => {
        const session = sessionMap.get(item.sessionId);
        const isCurrent = Boolean(session?.current);
        const isActive = Boolean(session?.active);
        const deleteTitle = isCurrent
          ? "会直接关闭当前终端，并删除这条历史记录"
          : isActive
            ? "会先关闭该会话，再删除回放、快照与 diff"
            : "删除该会话的回放、快照与 diff";

        return (
          <div className="controlPlaneArtifactItem" key={item.id}>
            <div className="controlPlaneInboxMain">
              <div className="controlPlaneInboxTitleRow">
                <div className="controlPlaneInboxTitle">{item.title}</div>
                <span className="controlPlaneCardPill">{artifactKindLabel(item.kind)}</span>
                {isCurrent ? <span className="controlPlaneCardPill controlPlaneCardPillWarn">当前会话</span> : null}
                {!isCurrent && isActive ? <span className="controlPlaneCardPill">运行中</span> : null}
              </div>
              <div className="controlPlaneInboxMeta">
                <span>{item.sessionId}</span>
                <span>{formatTime(item.updatedAt)}</span>
              </div>
              <div className="controlPlaneInboxDetail">{item.detail}</div>
            </div>
            <div className="controlPlaneInboxActions">
              <button
                className="btn btnSm"
                onClick={() => {
                  if (onViewArtifact) {
                    onViewArtifact(item.sessionId, item.kind);
                    return;
                  }
                  if (item.kind === "snapshot") {
                    onActivateSession(item.sessionId);
                    return;
                  }
                  onViewReplay(item.sessionId);
                }}
              >
                {item.kind === "snapshot" ? "查看快照" : item.kind === "diff" ? "查看 diff" : "看回放"}
              </button>
              {onDeleteSession ? (
                <button
                  className="btn btnSm"
                  title={deleteTitle}
                  onClick={() => onDeleteSession(item.sessionId)}
                >
                  删除
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ControlPlanePanel({
  mode,
  isMobile,
  connected,
  stale,
  sessions,
  attention,
  artifacts,
  quickActions,
  currentSurface,
  openFiles,
  onActivateSession,
  onViewReplay,
  onViewArtifact,
  onCloseSession,
  onAcknowledgeSession,
  onActivateFile,
  onCloseFile,
  onBackToTerminal,
  onClearArtifacts,
  clearingArtifacts,
}: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredActions = useMemo(() => {
    if (!normalizedQuery) return quickActions;
    return quickActions.filter((action) => {
      const haystack = `${action.label} ${action.description}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, quickActions]);
  const currentSession = sessions.find((session) => session.current) ?? sessions[0] ?? null;
  const topAttention = attention.slice(0, 4);
  const guide = panelGuide(mode);
  const [foldOpen, setFoldOpen] = useState<Record<FoldKey, boolean>>(() => defaultFoldState(mode));
  const [artifactLimit, setArtifactLimit] = useState<number | "all">(mode === "artifacts" ? "all" : 6);
  useEffect(() => {
    setArtifactLimit(mode === "artifacts" ? "all" : 6);
  }, [mode]);
  const toggleFold = (key: FoldKey) => {
    setFoldOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const visibleArtifacts = useMemo(
    () => (artifactLimit === "all" ? artifacts : artifacts.slice(0, artifactLimit)),
    [artifactLimit, artifacts],
  );
  const artifactCountLabel =
    artifactLimit === "all"
      ? `全部 ${artifacts.length} 条`
      : `显示 ${Math.min(artifactLimit, artifacts.length)} / ${artifacts.length} 条`;
  const artifactLimitControls =
    artifacts.length > 6 ? (
      <div className="controlPlaneArtifactControls" role="group" aria-label="历史记录显示数量">
        <span className="controlPlaneArtifactSummary">{artifactCountLabel}</span>
        {[6, 12, 24].filter((value) => artifacts.length > value || artifactLimit === value).map((value) => (
          <button
            key={value}
            className="btn btnSm"
            disabled={artifactLimit === value}
            onClick={() => setArtifactLimit(value)}
          >
            {value}
          </button>
        ))}
        <button
          className="btn btnSm"
          disabled={artifactLimit === "all"}
          onClick={() => setArtifactLimit("all")}
        >
          全部
        </button>
        {onClearArtifacts ? (
          <button className="btn btnSm btnDanger" disabled={Boolean(clearingArtifacts)} onClick={onClearArtifacts}>
            {clearingArtifacts ? "清空中…" : "清空历史"}
          </button>
        ) : null}
      </div>
    ) : (
      <div className="controlPlaneArtifactControls" role="group" aria-label="历史记录操作">
        <span className="controlPlaneArtifactSummary">{artifactCountLabel}</span>
        {onClearArtifacts ? (
          <button className="btn btnSm btnDanger" disabled={Boolean(clearingArtifacts)} onClick={onClearArtifacts}>
            {clearingArtifacts ? "清空中…" : "清空历史"}
          </button>
        ) : null}
      </div>
    );
  const mobileReturnBar =
    isMobile && onBackToTerminal && mode === "artifacts" ? (
      <div className="controlPlaneMobileReturn">
        <div className="controlPlaneMobileReturnText">看完这里，直接回到终端继续输入。</div>
        <button type="button" className="btn btnSm" onClick={onBackToTerminal}>
          返回终端
        </button>
      </div>
    ) : null;
  const FoldSection = ({
    id,
    title,
    hint,
    actions,
    children,
  }: {
    id: FoldKey;
    title: string;
    hint?: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => {
    const open = foldOpen[id];
    const bodyId = `control-plane-${mode}-${id}`;
    return (
      <div className={"controlPlaneFold" + (open ? " controlPlaneFoldOpen" : "")}>
        <div className="controlPlaneFoldHeaderRow">
          <button
            type="button"
            className="controlPlaneFoldHeader"
            onClick={() => toggleFold(id)}
            aria-expanded={open}
            aria-controls={bodyId}
            title={open ? "折叠" : "展开"}
          >
            <span className="controlPlaneFoldIcon" aria-hidden>{open ? "▾" : "▸"}</span>
            <span className="controlPlaneFoldTitle">{title}</span>
          </button>
          {actions ? <div className="controlPlaneFoldActions">{actions}</div> : null}
        </div>
        {open ? (
          <div className="controlPlaneFoldBody" id={bodyId}>
            {hint ? <div className="controlPlaneSectionHint">{hint}</div> : null}
            {children}
          </div>
        ) : null}
      </div>
    );
  };

  const guideSection = (
    <FoldSection id="guide" title="控制台说明" hint="控制台信息很多时，可以先折叠次要模块。">
      <div className="controlPlaneCurrentSurface">
        <div className="controlPlaneCurrentSurfaceMeta">
          <span className="controlPlaneCardPill">{guide.title}</span>
        </div>
        <div className="controlPlaneCurrentSurfaceDetail">{guide.detail}</div>
      </div>
      <ConceptMap />
    </FoldSection>
  );

  const quickEntry = (
    <FoldSection
      id="quickEntry"
      title="快速入口"
      hint="这里只提供安全动作入口，不直接执行自由命令。"
      actions={
        <span
          className={
            "controlPlaneStatusDot" +
            (connected ? " controlPlaneStatusDotLive" : stale ? " controlPlaneStatusDotStale" : " controlPlaneStatusDotOffline")
          }
        >
          {connected ? "已连接" : stale ? "待同步" : "离线"}
        </span>
      }
    >
      <input
        className="input controlPlaneQuickEntryInput"
        placeholder="筛选动作，例如：codex / 恢复 / 回放"
        value={query}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => setQuery(next));
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          filteredActions[0]?.onSelect();
        }}
      />
      <div className="controlPlaneQuickActionList">
        {filteredActions.slice(0, 8).map((action) => (
          <button key={action.id} type="button" className="controlPlaneQuickAction" onClick={action.onSelect}>
            <span className="controlPlaneQuickActionLabel">{action.label}</span>
            <span className="controlPlaneQuickActionDesc">{action.description}</span>
          </button>
        ))}
      </div>
    </FoldSection>
  );

  if (mode === "artifacts") {
    return (
      <div className="controlPlanePanel">
        {mobileReturnBar}
        {guideSection}
        <FoldSection
          id="artifacts"
          title="历史记录"
          hint="需要回看刚才发生了什么时看这里；如果只是堆积内容，可以直接删掉或清空。"
          actions={artifactLimitControls}
        >
          <ArtifactList
            items={visibleArtifacts}
            sessions={sessions}
            onActivateSession={onActivateSession}
            onViewReplay={onViewReplay}
            onViewArtifact={onViewArtifact}
            onDeleteSession={onCloseSession}
          />
        </FoldSection>
      </div>
    );
  }

  return (
    <div className="controlPlanePanel">
      {quickEntry}
      {guideSection}
      <FoldSection
        id="current"
        title="当前会话"
        hint="继续你手上的那个 AI / 终端会话。"
        actions={<span className="controlPlaneFoldCount">{currentSession ? 1 : 0}</span>}
      >
        {currentSession ? (
          <SessionCard
            session={currentSession}
            onActivateSession={onActivateSession}
            onViewReplay={onViewReplay}
            onCloseSession={onCloseSession}
          />
        ) : (
          <div className="controlPlaneEmpty">当前没有活动会话，使用上面的 Quick Entry 创建一个。</div>
        )}
        {currentSurface ? (
          <div className="controlPlaneCurrentSurface">
            <div className="controlPlaneCurrentSurfaceMeta">
              {currentSurface.lifecycle ? <span className="controlPlaneCardPill">{currentSurface.lifecycle}</span> : null}
              {currentSurface.capability ? <span className="controlPlaneCardPill">{currentSurface.capability}</span> : null}
            </div>
            <div className="controlPlaneCurrentSurfaceDetail">{currentSurface.detail}</div>
          </div>
        ) : null}
      </FoldSection>

      {mode === "now" ? null : (
        <>
          <FoldSection
            id="reminders"
            title="提醒"
            hint="这里只保留会打断节奏的确认和异常。"
            actions={<span className="controlPlaneFoldCount">{attention.length}</span>}
          >
            <AttentionList
              items={topAttention}
              onActivateSession={onActivateSession}
              onViewReplay={onViewReplay}
              onAcknowledgeSession={onAcknowledgeSession}
            />
          </FoldSection>

          <FoldSection
            id="sessions"
            title="会话列表"
            hint="所有会话都保留原始终端入口，便于继续或回看。"
            actions={<span className="controlPlaneFoldCount">{sessions.length}</span>}
          >
            {sessions.length ? (
              <div className="controlPlaneList">
                {sessions.map((session) => (
                  <SessionCard
                    key={session.sessionId}
                    session={session}
                    onActivateSession={onActivateSession}
                    onViewReplay={onViewReplay}
                    onCloseSession={onCloseSession}
                  />
                ))}
              </div>
            ) : (
              <div className="controlPlaneEmpty">还没有任何会话记录。</div>
            )}
          </FoldSection>

          <FoldSection
            id="artifacts"
            title="历史记录"
            hint="这里保存最近的回放、快照和 diff；主要用于回看问题，不需要时可以直接清空。"
            actions={artifactLimitControls}
          >
            <ArtifactList
              items={visibleArtifacts}
              sessions={sessions}
              onActivateSession={onActivateSession}
              onViewReplay={onViewReplay}
              onViewArtifact={onViewArtifact}
              onDeleteSession={onCloseSession}
            />
          </FoldSection>
        </>
      )}

      {mode === "overview" && openFiles?.length && onActivateFile && onCloseFile ? (
        <FoldSection
          id="files"
          title="Open Files"
          hint="保留当前工作区上下文，不再单独叫“窗口列表”。"
          actions={<span className="controlPlaneFoldCount">{openFiles.length}</span>}
        >
          <div className="controlPlaneList">
            {openFiles.map((file) => (
              <div className="controlPlaneOpenFile" key={file.path}>
                <div className="controlPlaneInboxMain">
                  <div className="controlPlaneInboxTitleRow">
                    <div className="controlPlaneInboxTitle">{file.path.split(/[\\/]/).pop()}{file.dirty ? " *" : ""}</div>
                    {file.current ? <span className="controlPlaneCardPill">当前</span> : null}
                  </div>
                  <div className="controlPlaneInboxDetail">{file.path}</div>
                </div>
                <div className="controlPlaneInboxActions">
                  <button className="btn btnSm" onClick={() => onActivateFile(file.path)}>打开</button>
                  <button className="btn btnSm" onClick={() => onCloseFile(file.path)}>关闭</button>
                </div>
              </div>
            ))}
          </div>
        </FoldSection>
      ) : null}
    </div>
  );
}

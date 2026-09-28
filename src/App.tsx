import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  FileText,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatRequest,
  HealthResponse,
  KnowledgeItem,
  StreamEvent,
} from "../shared/types";
import { readSSE } from "../shared/sse";
import {
  createConversation,
  restoreState,
  STORAGE_KEY,
  type Conversation,
  type Message,
  type SavedState,
} from "./state";
import ToolCard, { copyText } from "./ToolCard";

interface ActiveRun {
  id: string;
  conversationId: string;
  messageId: string;
  controller: AbortController;
}
type Modal =
  | { type: "rename" | "delete"; conversation: Conversation }
  | { type: "about" }
  | null;
const suggestions = [
  {
    icon: Pencil,
    category: "灵感写作",
    title: "让想法，变成好表达",
    prompt:
      "帮我写一段面试自我介绍，突出我的前端开发能力。先问我需要哪些背景信息。",
    color: "violet",
  },
  {
    icon: Code2,
    category: "编程助手",
    title: "把复杂问题，拆解清楚",
    prompt:
      "用简单例子解释 SSE 流式输出，以及如何用 AbortController 打断请求。",
    color: "blue",
  },
  {
    icon: BookOpen,
    category: "资料探索",
    title: "从资料中，找到答案",
    prompt:
      "请检索本地演示资料，介绍流式输出和工具调用的实现要点，并注明资料来源。",
    color: "green",
  },
  {
    icon: Wrench,
    category: "工具助理",
    title: "交给工具，算得更准确",
    prompt: "请调用计算器计算 (128 * 35 + 256) / 12，并解释计算过程。",
    color: "orange",
  },
];

function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <Sparkles size={small ? 19 : 31} strokeWidth={1.8} />
    </span>
  );
}

function CodeBlock({
  children,
  onToast,
}: {
  children: ReactNode;
  onToast: (text: string) => void;
}) {
  const child = Children.toArray(children).find((node) =>
    isValidElement<{ className?: string; children?: ReactNode }>(node),
  );
  const code = isValidElement<{ className?: string; children?: ReactNode }>(
    child,
  )
    ? child
    : null;
  const language =
    /language-([\w+-]+)/.exec(code?.props.className || "")?.[1] || "代码";
  const content =
    typeof code?.props.children === "string"
      ? code.props.children.replace(/\n$/, "")
      : "";
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          aria-label="复制代码"
          onClick={() => void copyText(content, onToast)}
        >
          <Copy size={14} />
          复制代码
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Markdown({
  content,
  onToast,
}: {
  content: string;
  onToast: (text: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <CodeBlock onToast={onToast}>{children}</CodeBlock>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function App() {
  const [saved, setSaved] = useState<SavedState>(restoreState);
  const stateRef = useRef(saved);
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const activeRun = useRef<ActiveRun | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followScroll = useRef(true);
  const composing = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback((fn: (state: SavedState) => SavedState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setSaved(next);
  }, []);
  const updateMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      fn: (message: Message) => Message,
    ) => {
      update((s) => ({
        ...s,
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? fn(m) : m,
                ),
              }
            : c,
        ),
      }));
    },
    [update],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setHealth)
      .catch(() => {
        if (!controller.signal.aborted) setHealthError(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
    }, 350);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [saved]);
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current));
      } catch {
        /* Page is closing. */
      }
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  const conversation = saved.conversations.find(
    (c) => c.id === saved.activeId,
  )!;
  const isEmpty = !conversation?.messages.length;
  const currentGenerating =
    activeRun.current?.conversationId === saved.activeId && !!activeRunId;
  const searchQuery = historySearch.trim().toLocaleLowerCase();
  const visibleConversations = saved.conversations
    .filter(
      (c) =>
        c.messages.length &&
        (!searchQuery ||
          c.title.toLocaleLowerCase().includes(searchQuery) ||
          c.messages.some((m) =>
            m.content.toLocaleLowerCase().includes(searchQuery),
          )),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  useEffect(() => {
    if (followScroll.current && scrollArea.current)
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [conversation?.messages, saved.activeId]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
  }, [draft]);

  const stop = useCallback(() => {
    const run = activeRun.current;
    if (!run) return;
    activeRun.current = null;
    setActiveRunId(null);
    run.controller.abort();
    void fetch(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {
      method: "POST",
    }).catch(() => undefined);
    updateMessage(run.conversationId, run.messageId, (m) => ({
      ...m,
      status: "stopped",
      tools: m.tools?.map((t) =>
        ["receiving", "queued", "running"].includes(t.status)
          ? { ...t, status: "cancelled" }
          : t,
      ),
    }));
  }, [updateMessage]);

  async function send(text = draft) {
    const content = text.trim();
    if (!content) return;
    if (content.length > 16_000) {
      setToast("单条消息请控制在 16,000 字以内");
      return;
    }
    stop();
    const state = stateRef.current;
    const current = state.conversations.find((c) => c.id === state.activeId)!;
    const user: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      status: "done",
      createdAt: Date.now(),
    };
    const assistant: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
      status: "streaming",
      createdAt: Date.now(),
    };
    const run: ActiveRun = {
      id: crypto.randomUUID(),
      conversationId: current.id,
      messageId: assistant.id,
      controller: new AbortController(),
    };
    activeRun.current = run;
    setActiveRunId(run.id);
    update((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === current.id
          ? {
              ...c,
              title: c.messages.length ? c.title : content.slice(0, 22),
              updatedAt: Date.now(),
              messages: [...c.messages, user, assistant],
            }
          : c,
      ),
    }));
    setDraft("");
    followScroll.current = true;
    setShowLatest(false);
    textarea.current?.focus();
    const body: ChatRequest = {
      runId: run.id,
      conversationId: current.id,
      messageId: assistant.id,
      messages: [...current.messages, user]
        .filter((m) => m.content || m.tools?.length)
        .slice(-40)
        .map(({ role, content: messageContent, tools }) => ({
          role,
          content: messageContent,
          tools,
        })),
      useTools: state.useTools,
      thinking: state.thinking,
    };
    let completed = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: run.controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : `请求失败（${response.status}）`,
        );
      }
      if (!response.body) throw new Error("未收到有效的回复数据");
      for await (const raw of readSSE(response.body, run.controller.signal)) {
        if (activeRun.current?.id !== run.id) break;
        const event = JSON.parse(raw) as StreamEvent;
        if (
          event.runId !== run.id ||
          event.conversationId !== current.id ||
          event.messageId !== assistant.id
        )
          continue;
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "done") {
          completed = true;
          updateMessage(current.id, assistant.id, (m) => ({
            ...m,
            status: "done",
            error:
              event.reason === "limit"
                ? "本轮已达到处理上限，可以继续追问。"
                : undefined,
          }));
          break;
        }
        updateMessage(current.id, assistant.id, (m) => {
          if (event.type === "text-delta")
            return { ...m, content: m.content + event.delta };
          if (event.type === "reasoning-delta")
            return { ...m, reasoning: (m.reasoning || "") + event.delta };
          if (event.type === "tool-update") {
            const tools = [...(m.tools || [])];
            const index = tools.findIndex((t) => t.id === event.tool.id);
            if (index < 0) tools.push(event.tool);
            else tools[index] = event.tool;
            return { ...m, tools };
          }
          return m;
        });
      }
      if (!completed && activeRun.current?.id === run.id)
        throw new Error("连接提前结束，请重新发送或继续提问。");
    } catch (error) {
      if (activeRun.current?.id !== run.id || run.controller.signal.aborted)
        return;
      updateMessage(current.id, assistant.id, (m) => ({
        ...m,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "服务暂时不可用，请稍后再试。",
        tools: m.tools?.map((t) =>
          ["receiving", "queued", "running"].includes(t.status)
            ? { ...t, status: "error", error: "请求已结束" }
            : t,
        ),
      }));
    } finally {
      if (activeRun.current?.id === run.id) {
        activeRun.current = null;
        setActiveRunId(null);
      }
    }
  }

  const newConversation = useCallback(() => {
    const empty = stateRef.current.conversations.find(
      (c) => c.messages.length === 0,
    );
    const next = empty || createConversation();
    update((s) => ({
      ...s,
      activeId: next.id,
      conversations: empty ? s.conversations : [next, ...s.conversations],
    }));
    setDraft("");
    setHistorySearch("");
    followScroll.current = true;
    setShowLatest(false);
    setMenuId(null);
    textarea.current?.focus();
  }, [update]);
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || composing.current || event.repeat) return;
      if (event.key === "Escape") {
        if (modal) setModal(null);
        else if (menuId) setMenuId(null);
        else if (activeRun.current) {
          event.preventDefault();
          stop();
          textarea.current?.focus();
        }
        return;
      }
      if (modal) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        newConversation();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        textarea.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [newConversation, stop, modal, menuId]);
  function selectConversation(id: string) {
    update((s) => ({ ...s, activeId: id }));
    setDraft("");
    followScroll.current = true;
    setShowLatest(false);
    setMenuId(null);
  }
  function followUp(item: KnowledgeItem) {
    setDraft(
      `请基于以下本地资料进一步解释，并给出具体示例：\n【${item.title}】\n来源：${item.source}\n${item.content}`,
    );
    textarea.current?.focus();
    setToast("资料已加入输入框，可编辑后发送");
  }
  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composing.current
    ) {
      event.preventDefault();
      void send();
    }
  }
  function confirmModal(event: FormEvent) {
    event.preventDefault();
    if (!modal || modal.type === "about") return;
    const id = modal.conversation.id;
    if (modal.type === "rename") {
      const title = renameValue.trim();
      if (!title) return;
      update((s) => ({
        ...s,
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, title: title.slice(0, 100) } : c,
        ),
      }));
    } else {
      if (activeRun.current?.conversationId === id) stop();
      update((s) => {
        let remaining = s.conversations.filter((c) => c.id !== id);
        if (!remaining.length) remaining = [createConversation()];
        return {
          ...s,
          conversations: remaining,
          activeId: s.activeId === id ? remaining[0].id : s.activeId,
        };
      });
    }
    setModal(null);
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar" aria-label="会话侧边栏">
        <div className="sidebar-brand">
          <Brand small />
          <span>
            千问<span className="brand-caption">桌面助手</span>
          </span>
          <button
            className="icon-button collapse-button"
            aria-label="收起侧边栏"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button
          className="new-chat"
          aria-label="开启新对话"
          onClick={newConversation}
          title="新对话（Ctrl / ⌘ + K）"
        >
          <Plus size={19} />
          开启新对话
          <span>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</span>
        </button>
        <div className="history-search">
          <Search size={15} />
          <input
            type="search"
            data-testid="history-search"
            aria-label="搜索历史对话"
            placeholder="搜索历史对话"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
          />
          {historySearch && (
            <button
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => setHistorySearch("")}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="history-heading">
          {searchQuery ? "搜索结果" : "最近对话"}{" "}
          <span>{visibleConversations.length}</span>
        </div>
        <nav className="conversation-list" aria-label="历史对话">
          {visibleConversations.map((c) => (
            <div
              key={c.id}
              className={`conversation-row ${c.id === saved.activeId ? "selected" : ""}`}
              data-testid="conversation-item"
            >
              <button
                className="conversation-button"
                title={c.title}
                onClick={() => selectConversation(c.id)}
              >
                <MessageCircle size={15} />
                <span>{c.title}</span>
                {activeRun.current?.conversationId === c.id && (
                  <span className="generating-dot" />
                )}
              </button>
              <button
                className="conversation-more icon-button"
                aria-label={`管理对话：${c.title}`}
                onClick={() => setMenuId(menuId === c.id ? null : c.id)}
              >
                <MoreHorizontal size={17} />
              </button>
              {menuId === c.id && (
                <div className="conversation-menu">
                  <button
                    onClick={() => {
                      setRenameValue(c.title);
                      setModal({ type: "rename", conversation: c });
                      setMenuId(null);
                    }}
                  >
                    <Pencil size={14} />
                    重命名
                  </button>
                  <button
                    className="danger-text"
                    onClick={() => {
                      setModal({ type: "delete", conversation: c });
                      setMenuId(null);
                    }}
                  >
                    <Trash2 size={14} />
                    删除对话
                  </button>
                </div>
              )}
            </div>
          ))}
          {visibleConversations.length === 0 && (
            <div className="empty-history">
              {searchQuery ? <Search size={23} /> : <MessageCircle size={23} />}
              <p>{searchQuery ? "没有找到相关对话" : "好问题，值得留下"}</p>
              <span>
                {searchQuery
                  ? "换个词试试，标题和正文都能搜"
                  : "你的对话会保存在这里"}
              </span>
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-dot" />
            会话仅保存在本机
          </div>
          <button
            className="profile-button"
            onClick={() => setModal({ type: "about" })}
          >
            <span className="avatar">你</span>
            <span>
              <strong>我的工作空间</strong>
              <small>本地体验版</small>
            </span>
            <CircleHelp size={17} />
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button
                className="icon-button"
                aria-label="展开侧边栏"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={20} />
              </button>
            )}
            <span className="topbar-title">
              {isEmpty ? "千问" : conversation.title}
            </span>
            <span className="model-badge">{health?.model || "Qwen"}</span>
          </div>
          <div
            className={`connection-status ${health?.configured ? "online" : ""}`}
          >
            <span />
            {healthError
              ? "服务未连接"
              : health
                ? health.configured
                  ? "已连接千问"
                  : "未配置密钥"
                : "连接中"}
          </div>
        </header>
        {(healthError || health?.configured === false || storageError) && (
          <div className="notice-banner" role="status">
            {storageError
              ? "浏览器存储空间不足，当前消息仍可查看，但可能无法在刷新后恢复。"
              : healthError
                ? "本地服务未连接，请检查服务是否启动并刷新页面。"
                : "请在启动终端配置系统环境变量 Qianwen_api_key，然后重启服务。"}
          </div>
        )}
        <div
          className={`chat-scroll ${isEmpty ? "empty" : ""}`}
          ref={scrollArea}
          onScroll={() => {
            const el = scrollArea.current!;
            followScroll.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            setShowLatest(!followScroll.current);
          }}
        >
          {isEmpty ? (
            <section className="welcome">
              <div className="welcome-brand">
                <Brand />
              </div>
              <div className="welcome-eyebrow">你的灵感，一起实现</div>
              <h1>有什么我能帮你？</h1>
              <p className="welcome-description">
                聊想法、写代码、查资料。让每一个问题，都有新的可能。
              </p>
              <div className="suggestion-grid">
                {suggestions.map(
                  ({ icon: Icon, category, title, prompt, color }) => (
                    <button
                      className="suggestion-card"
                      key={category}
                      onClick={() => {
                        setDraft(prompt);
                        textarea.current?.focus();
                      }}
                    >
                      <span className={`suggestion-icon ${color}`}>
                        <Icon size={20} />
                      </span>
                      <strong>{category}</strong>
                      <span>{title}</span>
                      <ChevronRight className="suggestion-arrow" size={16} />
                    </button>
                  ),
                )}
              </div>
              <div className="welcome-hint">
                <span />
                从一个问题开始，探索更多可能
              </div>
            </section>
          ) : (
            <div className="messages">
              {conversation.messages.map((message, index) =>
                message.role === "user" ? (
                  <article className="user-message" key={message.id}>
                    <div>{message.content}</div>
                  </article>
                ) : (
                  <article
                    className="assistant-message"
                    key={message.id}
                    data-testid="assistant-message"
                  >
                    <div className="assistant-avatar">
                      <Brand small />
                    </div>
                    <div className="assistant-body">
                      <div className="assistant-label">
                        千问
                        <span>
                          {message.status === "streaming"
                            ? "正在回答"
                            : message.status === "done"
                              ? "回答完成"
                              : ""}
                        </span>
                      </div>
                      {message.reasoning && (
                        <details className="reasoning-panel">
                          <summary>
                            <BrainCircuit size={15} />
                            {message.status === "streaming" && !message.content
                              ? "思考中"
                              : "思考过程"}
                            <ChevronDown size={14} />
                          </summary>
                          <div>{message.reasoning}</div>
                        </details>
                      )}
                      {message.tools?.map((tool) => (
                        <ToolCard
                          key={tool.id}
                          tool={tool}
                          onFollowUp={followUp}
                          onToast={setToast}
                        />
                      ))}
                      {message.content && (
                        <div
                          className={`markdown ${message.status === "streaming" ? "streaming-text" : ""}`}
                        >
                          <Markdown
                            content={message.content}
                            onToast={setToast}
                          />
                        </div>
                      )}
                      {message.status === "streaming" &&
                        !message.content &&
                        !message.tools?.length && (
                          <div className="thinking-dots" aria-label="等待回复">
                            <i />
                            <i />
                            <i />
                          </div>
                        )}
                      {message.status === "stopped" && (
                        <div className="message-status">
                          <Square size={11} />
                          已停止生成
                          {!message.content && !message.tools?.length
                            ? "，你可以继续提问"
                            : ""}
                        </div>
                      )}
                      {message.error && (
                        <div
                          className={`message-error ${message.status !== "error" ? "info" : ""}`}
                          role="status"
                        >
                          {message.error}
                        </div>
                      )}
                      {message.status !== "streaming" && (
                        <div className="message-actions">
                          {message.content && (
                            <button
                              className="icon-button"
                              aria-label="复制回复"
                              title="复制回复"
                              onClick={() =>
                                void copyText(message.content, setToast)
                              }
                            >
                              <Copy size={15} />
                            </button>
                          )}
                          {message.status === "error" && (
                            <button
                              className="retry-button"
                              onClick={() => {
                                const prompt = conversation.messages
                                  .slice(0, index)
                                  .reverse()
                                  .find((m) => m.role === "user");
                                if (prompt) {
                                  setDraft(prompt.content);
                                  textarea.current?.focus();
                                }
                              }}
                            >
                              编辑后重试
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                ),
              )}
            </div>
          )}
        </div>
        <div className={`composer-area ${isEmpty ? "welcome-composer" : ""}`}>
          {showLatest && (
            <button
              className="back-to-latest"
              aria-label="回到最新消息"
              onClick={() => {
                followScroll.current = true;
                setShowLatest(false);
                scrollArea.current?.scrollTo({
                  top: scrollArea.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={15} />
              回到最新
            </button>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textarea}
              data-testid="message-input"
              aria-label="消息输入框"
              title="聚焦输入：Ctrl / ⌘ + /"
              placeholder={
                currentGenerating
                  ? "输入新问题，发送后将打断当前回答…"
                  : "尽管问，交给我来想办法"
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKey}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              rows={2}
              maxLength={16_001}
            />
            <div className="composer-toolbar">
              <div className="composer-options">
                <button
                  type="button"
                  className={`option-chip ${saved.thinking ? "active" : ""}`}
                  aria-pressed={saved.thinking}
                  onClick={() =>
                    update((s) => ({ ...s, thinking: !s.thinking }))
                  }
                >
                  <BrainCircuit size={16} />
                  深度思考
                </button>
                <button
                  type="button"
                  className={`option-chip ${saved.useTools ? "active" : ""}`}
                  aria-pressed={saved.useTools}
                  onClick={() =>
                    update((s) => ({ ...s, useTools: !s.useTools }))
                  }
                >
                  <Wrench size={15} />
                  工具<span className="chip-count">2</span>
                </button>
              </div>
              <div className="send-controls">
                {currentGenerating && (
                  <button
                    type="button"
                    data-testid="stop-button"
                    className="stop-button"
                    aria-label="停止生成"
                    title="停止生成（Esc）"
                    onClick={stop}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                )}
                <button
                  type="submit"
                  data-testid="send-button"
                  className="send-button"
                  aria-label={currentGenerating ? "打断并发送消息" : "发送消息"}
                  title={currentGenerating ? "打断并发送" : "发送消息"}
                  disabled={!draft.trim()}
                >
                  <ArrowUp size={21} strokeWidth={2.4} />
                </button>
              </div>
            </div>
          </form>
          <div className="composer-footer">
            <span>内容由 AI 生成，请仔细甄别</span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭弹窗"
              onClick={() => setModal(null)}
            >
              <X size={18} />
            </button>
            {modal.type === "about" ? (
              <>
                <Brand />
                <h2 id="modal-title">千问 · 桌面助手</h2>
                <p>一个让想法成为可能的本地 AI 工作空间。</p>
                <div className="about-features">
                  <span>
                    <Sparkles size={16} />
                    真实千问流式对话
                  </span>
                  <span>
                    <Square size={14} />
                    随时停止，继续提问
                  </span>
                  <span>
                    <Wrench size={16} />
                    计算器与本地资料检索
                  </span>
                </div>
                <p className="about-note">
                  独立面试演示项目。聊天记录存于当前浏览器；模型请求会发送至千问
                  API。资料检索使用项目自带的演示文档。
                </p>
                <button
                  className="primary-button"
                  onClick={() => setModal(null)}
                >
                  开始探索
                </button>
              </>
            ) : (
              <form onSubmit={confirmModal}>
                <h2 id="modal-title">
                  {modal.type === "rename" ? "重命名对话" : "删除这段对话？"}
                </h2>
                {modal.type === "rename" ? (
                  <input
                    autoFocus
                    aria-label="对话名称"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    maxLength={100}
                  />
                ) : (
                  <p>
                    “{modal.conversation.title}
                    ”及其中的消息将从本机删除，无法恢复。
                  </p>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className={
                      modal.type === "delete"
                        ? "danger-button"
                        : "primary-button"
                    }
                  >
                    {modal.type === "delete" ? "删除对话" : "保存"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

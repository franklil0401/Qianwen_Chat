import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
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
  Globe2,
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
import type {
  ChatRequest,
  Attachment,
  HealthResponse,
  KnowledgeItem,
  StreamEvent,
} from "../shared/types";
import { readSSE } from "../shared/sse";
import {
  createConversation,
  createSnapshot,
  restoreState,
  STORAGE_KEY,
  type Conversation,
  type Message,
  type SavedState,
  type ComposerDraft,
} from "./state";
import ToolCard, { copyText } from "./ToolCard";
import Markdown from "./MessageMarkdown";
import AttachmentComposer from "./AttachmentComposer";
import MessageAttachments from "./MessageAttachments";
import VoiceControls from "./VoiceControls";
import SearchSources from "./SearchSources";
import SpeechButton from "./SpeechButton";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { apiFetch, setActiveAccount } from "./api";
import { attachmentMetadata } from "./multimodal";
import { searchSourceSchema } from "../shared/schemas";
import { prepareHistory, serializeSources } from "./history";
import ReadingPreferences from "./ReadingPreferences";
import BackupControls from "./BackupControls";
import AccountPanel from "./AccountPanel";
import { createBranch, findBranchPoint, type BranchMode } from "./branches";
import {
  BranchBanner,
  EditingBanner,
  EditMessageButton,
  RegenerateButton,
} from "./BranchControls";

interface ActiveRun {
  id: string;
  conversationId: string;
  messageId: string;
  controller: AbortController;
}
interface BranchRequest {
  conversationId: string;
  messageId: string;
  mode: BranchMode;
  sources: KnowledgeItem[];
  attachments?: Attachment[];
}
interface EditingSession {
  conversationId: string;
  messageId: string;
  title: string;
  text: string;
  sources: KnowledgeItem[];
  attachments?: Attachment[];
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

function hasDraft(conversation: Conversation) {
  return Boolean(
    conversation.draft?.text.length ||
    conversation.draft?.sources.length ||
    conversation.draft?.attachments?.length,
  );
}

function conversationLabel(conversation: Conversation) {
  if (conversation.messages.length || conversation.title !== "新对话")
    return conversation.title;
  return (
    conversation.draft?.text.trim().slice(0, 22) ||
    conversation.draft?.sources[0]?.title ||
    conversation.draft?.attachments?.[0]?.name ||
    conversation.title
  );
}

export default function App() {
  const [saved, setSaved] = useState<SavedState>(restoreState);
  const stateRef = useRef(saved);
  const [identity, setIdentity] = useState<string | null | undefined>(
    undefined,
  );
  const identityRef = useRef<string | null | undefined>(undefined);
  const storageKey = useRef(STORAGE_KEY);
  const workspaceCache = useRef(new Map<string, SavedState>());
  const [composerEpoch, setComposerEpoch] = useState(0);
  const identityReady = identity !== undefined;
  const [editing, setEditing] = useState<EditingSession | null>(null);
  const conversation = saved.conversations.find(
    (c) => c.id === saved.activeId,
  )!;
  const draft =
    editing?.conversationId === saved.activeId
      ? editing.text
      : conversation.draft?.text || "";
  const selectedSources =
    editing?.conversationId === saved.activeId
      ? editing.sources
      : conversation.draft?.sources || [];
  const selectedAttachments =
    editing?.conversationId === saved.activeId
      ? editing.attachments || []
      : conversation.draft?.attachments || [];
  const [uploading, setUploading] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [healthChecking, setHealthChecking] = useState(true);
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
  const focusComposerAfterRender = useRef(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followScroll = useRef(true);
  const composing = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthRequest = useRef<AbortController | null>(null);
  const modalElement = useRef<HTMLDivElement>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const speech = useSpeechPlayback(
    `${identity}:${saved.activeId}:${composerEpoch}`,
    setToast,
  );
  const composerScope = `${identity}:${saved.activeId}:${editing?.messageId || "draft"}:${composerEpoch}`;
  const composerScopeRef = useRef(composerScope);
  composerScopeRef.current = composerScope;
  useLayoutEffect(() => {
    // A removed textarea may never emit compositionend. Its IME session must
    // not disable Enter or keyboard shortcuts in the replacement composer.
    composing.current = false;
  }, [composerScope]);
  useLayoutEffect(() => {
    if (focusComposerAfterRender.current && textarea.current) {
      focusComposerAfterRender.current = false;
      textarea.current.focus();
    }
  });

  const update = useCallback((fn: (state: SavedState) => SavedState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setSaved(next);
  }, []);

  function updateComposer(transform: (value: ComposerDraft) => ComposerDraft) {
    if (editing?.conversationId === stateRef.current.activeId) {
      setEditing((current) =>
        current
          ? {
              ...current,
              ...transform({
                text: current.text,
                sources: current.sources,
                attachments: current.attachments,
              }),
            }
          : current,
      );
      return;
    }
    const id = stateRef.current.activeId;
    update((state) => ({
      ...state,
      conversations: state.conversations.map((item) =>
        item.id === id
          ? {
              ...item,
              draft: transform(item.draft || { text: "", sources: [] }),
              updatedAt: Date.now(),
            }
          : item,
      ),
    }));
  }
  function setDraft(value: string | ((previous: string) => string)) {
    updateComposer((current) => ({
      ...current,
      text: typeof value === "function" ? value(current.text) : value,
    }));
  }
  function setSelectedSources(
    value: KnowledgeItem[] | ((previous: KnowledgeItem[]) => KnowledgeItem[]),
  ) {
    updateComposer((current) => ({
      ...current,
      sources: typeof value === "function" ? value(current.sources) : value,
    }));
  }
  function addAttachment(attachment: Attachment) {
    updateComposer((current) => ({
      ...current,
      attachments: [
        ...(current.attachments || []),
        attachmentMetadata(attachment),
      ].slice(0, 4),
    }));
  }
  function removeAttachment(id: string) {
    updateComposer((current) => ({
      ...current,
      attachments: current.attachments?.filter((item) => item.id !== id),
    }));
  }
  function appendTranscript(text: string) {
    if (draft.length + text.length + (draft ? 1 : 0) > 16_000)
      throw new Error("转写后内容超过 16,000 字，请先缩短输入框中的文字。");
    setDraft((value) => (value ? `${value}\n${text}` : text));
    textarea.current?.focus();
  }
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

  const checkHealth = useCallback(async () => {
    healthRequest.current?.abort();
    const controller = new AbortController();
    healthRequest.current = controller;
    setHealthChecking(true);
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/health", {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("本地服务状态异常");
      const result = (await response.json()) as HealthResponse;
      if (
        typeof result.configured !== "boolean" ||
        typeof result.model !== "string"
      )
        throw new Error("本地服务响应异常");
      if (healthRequest.current !== controller) return;
      setHealth(result);
      setHealthError(false);
    } catch {
      if (healthRequest.current === controller) {
        setHealthError(true);
        setHealth(null);
      }
    } finally {
      clearTimeout(timer);
      if (healthRequest.current === controller) {
        healthRequest.current = null;
        setHealthChecking(false);
      }
    }
  }, []);
  useEffect(() => {
    void checkHealth();
    return () => {
      healthRequest.current?.abort();
      healthRequest.current = null;
    };
  }, [checkHealth]);
  function openModal(next: Exclude<Modal, null>) {
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    modalReturnFocus.current =
      active
        ?.closest(".conversation-row")
        ?.querySelector<HTMLElement>(".conversation-more") || active;
    setModal(next);
  }
  useEffect(() => {
    if (!modal || !modalElement.current) return;
    const dialog = modalElement.current;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.getClientRects().length > 0);
    const initial =
      dialog.querySelector<HTMLElement>("input, .secondary-button") ||
      focusable()[0] ||
      dialog;
    initial.focus();
    const trapTab = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target))
        (focusable()[0] || dialog).focus();
    };
    document.addEventListener("keydown", trapTab);
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("keydown", trapTab);
      document.removeEventListener("focusin", keepFocus);
      const target = modalReturnFocus.current;
      queueMicrotask(() => {
        if (target?.isConnected) target.focus();
        else textarea.current?.focus();
      });
    };
  }, [modal]);
  useEffect(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    if (!identityReady) return;
    const key = storageKey.current;
    persistTimer.current = setTimeout(() => {
      if (key !== storageKey.current) return;
      try {
        localStorage.setItem(key, JSON.stringify(createSnapshot(saved)));
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
    }, 350);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [saved, identityReady, identity]);
  useEffect(() => {
    const save = () => {
      if (identityRef.current === undefined) return;
      try {
        localStorage.setItem(
          storageKey.current,
          JSON.stringify(createSnapshot(stateRef.current)),
        );
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
  const isEmpty = !conversation?.messages.length;
  const currentGenerating =
    activeRun.current?.conversationId === saved.activeId && !!activeRunId;
  const searchQuery = historySearch.trim().toLocaleLowerCase();
  const visibleConversations = saved.conversations
    .filter(
      (c) =>
        (c.messages.length || hasDraft(c)) &&
        (!searchQuery ||
          c.title.toLocaleLowerCase().includes(searchQuery) ||
          c.draft?.text.toLocaleLowerCase().includes(searchQuery) ||
          c.draft?.sources.some((source) =>
            source.title.toLocaleLowerCase().includes(searchQuery),
          ) ||
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
    void apiFetch(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {
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
    if (
      run.conversationId === stateRef.current.activeId &&
      !modalElement.current
    )
      textarea.current?.focus();
  }, [updateMessage]);

  function resetWorkspaceControls() {
    speech.stop();
    composerScopeRef.current = "switching";
    setComposerEpoch((value) => value + 1);
    setEditing(null);
    setUploading(false);
    setVoiceBusy(false);
    setHistorySearch("");
    setMenuId(null);
    setModal(null);
    followScroll.current = true;
    setShowLatest(false);
  }

  function acceptIdentity(nextId: string | null) {
    if (identityRef.current === nextId) return;
    stop();
    resetWorkspaceControls();
    if (persistTimer.current) clearTimeout(persistTimer.current);
    // Keep an in-memory copy even when browser storage is full.
    workspaceCache.current.set(storageKey.current, stateRef.current);
    if (identityRef.current !== undefined) {
      try {
        localStorage.setItem(
          storageKey.current,
          JSON.stringify(createSnapshot(stateRef.current)),
        );
      } catch {
        setToast(
          "浏览器存储空间不足；原工作区仍保留在当前页面，请及时导出备份。",
        );
      }
    }
    const nextKey = nextId ? `${STORAGE_KEY}:user:${nextId}` : STORAGE_KEY;
    const next = workspaceCache.current.get(nextKey) || restoreState(nextKey);
    storageKey.current = nextKey;
    identityRef.current = nextId;
    setActiveAccount(nextId);
    update(() => next);
    setIdentity(nextId);
    setStorageError(false);
  }

  function applyWorkspace(next: SavedState) {
    if (!identityReady || activeRun.current || uploading || voiceBusy)
      throw new Error("请等待当前生成、上传或语音输入结束后再导入。");
    const snapshot = JSON.stringify(createSnapshot(next));
    if (snapshot.length > 6_000_000)
      throw new Error(
        "合并后的工作区超出本机存储容量，请先导出并删除部分对话。",
      );
    try {
      localStorage.setItem(storageKey.current, snapshot);
    } catch {
      throw new Error(
        "浏览器空间不足，未导入任何会话。请清理浏览器存储后重试。",
      );
    }
    if (persistTimer.current) clearTimeout(persistTimer.current);
    resetWorkspaceControls();
    workspaceCache.current.set(storageKey.current, next);
    update(() => next);
    setStorageError(false);
  }

  async function send(text = draft, branchRequest?: BranchRequest) {
    if (!identityReady) return;
    if (uploading || voiceBusy) {
      setToast("请等待附件上传或语音输入完成后再发送。");
      return;
    }
    const attachments = branchRequest?.attachments ?? selectedAttachments;
    const content =
      text.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!content) return;
    const sourceItems = branchRequest?.sources ?? selectedSources;
    const branchIntent =
      branchRequest ||
      (editing
        ? { ...editing, mode: "edit" as const, sources: sourceItems }
        : undefined);
    if (branchIntent && activeRun.current) {
      setToast("请先停止当前生成，再编辑或重新生成回答。");
      return;
    }
    if (serializeSources(content, sourceItems).length > 16_000) {
      setToast(
        "消息与引用资料合计不能超过 16,000 字，请缩短消息或移除部分引用",
      );
      return;
    }
    const state = stateRef.current;
    const original = state.conversations.find(
      (c) => c.id === (branchIntent?.conversationId || state.activeId),
    );
    if (!original) {
      setToast("原对话已不存在，请重新选择要发送的会话。");
      return;
    }
    let current: Conversation;
    try {
      current = branchIntent
        ? createBranch(
            original,
            branchIntent.messageId,
            branchIntent.mode,
            crypto.randomUUID(),
            Date.now(),
          )
        : original;
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "无法创建分支，请重新选择消息。",
      );
      return;
    }
    const user: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      status: "done",
      createdAt: Date.now(),
      sources: sourceItems.length ? structuredClone(sourceItems) : undefined,
      attachments: attachments.length
        ? attachments.map(attachmentMetadata)
        : undefined,
    };
    let messages: ChatRequest["messages"];
    try {
      messages = prepareHistory(
        [...current.messages, user]
          .filter(
            (message) =>
              message.content ||
              message.tools?.length ||
              message.attachments?.length,
          )
          .map(
            ({
              role,
              content: messageContent,
              tools,
              sources,
              attachments: files,
            }) => ({
              role,
              content: serializeSources(messageContent, sources),
              attachments: files?.map(attachmentMetadata),
              tools: tools?.map((tool) =>
                ["receiving", "queued", "running"].includes(tool.status)
                  ? { ...tool, status: "cancelled" as const }
                  : tool,
              ),
            }),
          ),
      );
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "本轮上下文过长，请缩短问题或减少引用后重试。",
      );
      return;
    }
    stop();
    speech.stop();
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
    update((s) => {
      const target = {
        ...current,
        draft: undefined,
        title:
          branchIntent || current.messages.length
            ? current.title
            : content.slice(0, 22),
        updatedAt: Date.now(),
        messages: [
          ...(branchIntent
            ? current.messages
            : s.conversations.find((c) => c.id === current.id)!.messages),
          user,
          assistant,
        ],
      };
      return {
        ...s,
        activeId: current.id,
        conversations: branchIntent
          ? [target, ...s.conversations]
          : s.conversations.map((c) => (c.id === current.id ? target : c)),
      };
    });
    setEditing(null);
    if (branchIntent) setHistorySearch("");
    followScroll.current = true;
    setShowLatest(false);
    focusComposerAfterRender.current = true;
    const body: ChatRequest = {
      runId: run.id,
      conversationId: current.id,
      messageId: assistant.id,
      messages,
      useTools: state.useTools,
      thinking: state.thinking,
      webSearch: state.webSearch === true,
    };
    let completed = false;
    try {
      const response = await apiFetch("/api/chat", {
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
          if (event.type === "sources")
            return {
              ...m,
              searchSources: event.sources.slice(0, 20).flatMap((source) => {
                const result = searchSourceSchema.safeParse(source);
                return result.success ? [result.data] : [];
              }),
            };
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

  function beginEditing(messageId: string) {
    if (activeRun.current || editing || uploading || voiceBusy) return;
    const current = stateRef.current.conversations.find(
      (c) => c.id === stateRef.current.activeId,
    );
    if (!current) return;
    try {
      const { question } = findBranchPoint(current, messageId);
      composerScopeRef.current = "switching";
      focusComposerAfterRender.current = true;
      setEditing({
        conversationId: current.id,
        messageId: question.id,
        title: current.title,
        text: question.content,
        sources: question.sources || [],
        attachments: question.attachments || [],
      });
      textarea.current?.focus();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法编辑这条消息。");
    }
  }

  function cancelEditing() {
    if (!editing) return;
    composerScopeRef.current = "switching";
    focusComposerAfterRender.current = true;
    setEditing(null);
    textarea.current?.focus();
  }

  function regenerate(messageId: string) {
    if (activeRun.current || editing || uploading || voiceBusy) return;
    const current = stateRef.current.conversations.find(
      (c) => c.id === stateRef.current.activeId,
    );
    if (!current) return;
    try {
      const { question } = findBranchPoint(current, messageId);
      void send(question.content, {
        conversationId: current.id,
        messageId: question.id,
        mode: "regenerate",
        sources: question.sources || [],
        attachments: question.attachments || [],
      });
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "无法重新生成这条回复。",
      );
    }
  }

  const newConversation = useCallback(() => {
    composerScopeRef.current = "switching";
    // Empty conversations can be reused; uploads and recordings still belong
    // to the previous composer and must be disposed on every new-chat action.
    setComposerEpoch((value) => value + 1);
    setUploading(false);
    setVoiceBusy(false);
    focusComposerAfterRender.current = true;
    const empty = stateRef.current.conversations.find(
      (c) => c.messages.length === 0 && !hasDraft(c),
    );
    const next = empty || createConversation();
    update((s) => ({
      ...s,
      activeId: next.id,
      conversations: empty ? s.conversations : [next, ...s.conversations],
    }));
    setEditing(null);
    setHistorySearch("");
    followScroll.current = true;
    setShowLatest(false);
    setMenuId(null);
    textarea.current?.focus();
  }, [update]);
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        !identityReady ||
        event.isComposing ||
        composing.current ||
        event.repeat
      )
        return;
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
  }, [newConversation, stop, modal, menuId, identityReady]);
  function selectConversation(id: string) {
    composerScopeRef.current = "switching";
    update((s) => ({ ...s, activeId: id }));
    setEditing(null);
    followScroll.current = true;
    setShowLatest(false);
    setMenuId(null);
  }
  function followUp(item: KnowledgeItem) {
    if (selectedSources.some((source) => source.id === item.id)) {
      setToast("这份资料已在引用中");
      textarea.current?.focus();
      return;
    }
    if (selectedSources.length >= 3) {
      setToast("每条消息最多引用 3 份资料，请先移除一份");
      return;
    }
    setSelectedSources((sources) => [...sources, item]);
    setDraft((value) =>
      value.trim() ? value : "请解释这份资料的关键内容，并给出一个实际例子。",
    );
    textarea.current?.focus();
    setToast("已添加资料引用，你可以继续编辑问题");
  }
  function searchAgain(query: string) {
    const prefix = "请检索本地演示资料，关键词：";
    setDraft(`${prefix}${query}`);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(
        prefix.length,
        prefix.length + query.length,
      );
    });
    setToast("修改选中的关键词后发送");
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
      if (stateRef.current.activeId === id) {
        setEditing(null);
      }
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
      <aside
        className="sidebar"
        aria-label="会话侧边栏"
        inert={!!modal || !identityReady}
      >
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
                title={conversationLabel(c)}
                onClick={() => selectConversation(c.id)}
              >
                <MessageCircle size={15} />
                <span>{conversationLabel(c)}</span>
                {hasDraft(c) && (
                  <span className="draft-badge" data-testid="draft-badge">
                    草稿
                  </span>
                )}
                {activeRun.current?.conversationId === c.id && (
                  <span className="generating-dot" />
                )}
              </button>
              <button
                className="conversation-more icon-button"
                aria-label={`管理对话：${conversationLabel(c)}`}
                onClick={() => setMenuId(menuId === c.id ? null : c.id)}
              >
                <MoreHorizontal size={17} />
              </button>
              {menuId === c.id && (
                <div className="conversation-menu">
                  <button
                    onClick={() => {
                      setRenameValue(c.title);
                      openModal({ type: "rename", conversation: c });
                      setMenuId(null);
                    }}
                  >
                    <Pencil size={14} />
                    重命名
                  </button>
                  <button
                    className="danger-text"
                    onClick={() => {
                      openModal({ type: "delete", conversation: c });
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
          <AccountPanel
            getState={() => stateRef.current}
            onApply={applyWorkspace}
            onIdentityChange={acceptIdentity}
            disabled={!identityReady || !!activeRunId || uploading || voiceBusy}
            onToast={setToast}
          />
          <BackupControls
            getState={() => stateRef.current}
            disabled={!identityReady || !!activeRunId || uploading || voiceBusy}
            onToast={setToast}
            onImport={applyWorkspace}
          />
          <ReadingPreferences />
          <div className="local-note">
            <span className="local-dot" />
            {identity
              ? "本机自动保存 · 账户手动同步"
              : "访客工作区 · 本机自动保存"}
          </div>
          <button
            className="profile-button"
            onClick={() => openModal({ type: "about" })}
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
      <main className="main-panel" inert={!!modal || !identityReady}>
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
            className={`connection-status ${health && !healthError ? "online" : ""}`}
          >
            <span />
            {healthChecking
              ? "正在检查本地服务"
              : healthError
                ? "服务未连接"
                : health
                  ? health.configured
                    ? "本地服务正常 · 千问已配置"
                    : "本地服务正常 · 未配置密钥"
                  : "等待检查"}
          </div>
        </header>
        {(healthError || health?.configured === false) && (
          <div className="notice-banner notice-with-action" role="status">
            <span>
              {healthError
                ? "暂时无法连接本地服务，请确认服务已启动后重试。"
                : "请在启动终端配置系统环境变量 Qianwen_api_key，然后重启服务。"}
            </span>
            <button
              className="notice-action"
              aria-label="重新连接"
              disabled={healthChecking}
              onClick={() => void checkHealth()}
            >
              {healthChecking ? "正在重连…" : "重新连接"}
            </button>
          </div>
        )}
        {storageError && (
          <div className="notice-banner" role="status">
            浏览器存储空间不足，当前消息仍可查看，但可能无法在刷新后恢复。
          </div>
        )}
        {saved.recoveryNotice && (
          <div
            className="notice-banner notice-with-action recovery-notice"
            role="status"
          >
            <span>{saved.recoveryNotice}</span>
            <button
              className="icon-button"
              aria-label="关闭恢复提示"
              onClick={() =>
                update((state) => ({ ...state, recoveryNotice: undefined }))
              }
            >
              <X size={16} />
            </button>
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
              {conversation.branchFrom && (
                <BranchBanner
                  origin={conversation.branchFrom}
                  available={saved.conversations.some(
                    (item) =>
                      item.id === conversation.branchFrom?.conversationId,
                  )}
                  onOpen={() =>
                    selectConversation(conversation.branchFrom!.conversationId)
                  }
                />
              )}
              {conversation.messages.map((message) =>
                message.role === "user" ? (
                  <article className="user-message" key={message.id}>
                    <div>
                      {message.content}
                      <MessageAttachments attachments={message.attachments} />
                      {message.sources?.map((source) => (
                        <details
                          key={source.id}
                          className="user-source"
                          data-testid="source-message"
                        >
                          <summary>
                            <FileText size={15} />
                            <span>{source.title}</span>
                            <ChevronDown size={13} />
                          </summary>
                          <span className="source-message-origin">
                            来源：{source.source} · {source.id}
                          </span>
                          <p>{source.content}</p>
                        </details>
                      ))}
                    </div>
                    <EditMessageButton
                      disabled={
                        !!activeRunId || !!editing || uploading || voiceBusy
                      }
                      onClick={() => beginEditing(message.id)}
                    />
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
                          onSearchAgain={searchAgain}
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
                      <SearchSources sources={message.searchSources} />
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
                          {message.content && (
                            <SpeechButton
                              messageId={message.id}
                              state={speech.state}
                              onPlay={() =>
                                void speech.play(message.id, message.content)
                              }
                              onStop={speech.stop}
                              disabled={!!activeRunId || !health?.configured}
                            />
                          )}
                          <RegenerateButton
                            failed={message.status === "error"}
                            disabled={
                              !!activeRunId ||
                              !!editing ||
                              uploading ||
                              voiceBusy
                            }
                            onClick={() => regenerate(message.id)}
                          />
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
          {editing && (
            <EditingBanner title={editing.title} onCancel={cancelEditing} />
          )}
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
            {selectedSources.length > 0 && (
              <div className="source-context-list">
                {selectedSources.map((source) => (
                  <div
                    className="source-context"
                    data-testid="source-context"
                    key={source.id}
                  >
                    <span className="source-context-icon">
                      <FileText size={18} />
                    </span>
                    <div>
                      <strong>{source.title}</strong>
                      <span>引用资料 · {source.source}</span>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="移除引用"
                      title={`移除引用：${source.title}`}
                      onClick={() =>
                        setSelectedSources((sources) =>
                          sources.filter((item) => item.id !== source.id),
                        )
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <AttachmentComposer
              key={composerScope}
              value={selectedAttachments}
              onAdd={(item) => {
                if (composerScopeRef.current === composerScope)
                  addAttachment(item);
              }}
              onRemove={removeAttachment}
              onBusyChange={setUploading}
              disabled={
                !identityReady ||
                !!activeRunId ||
                health?.capabilities?.uploads === false
              }
              extraControls={
                <VoiceControls
                  disabled={
                    !identityReady || !!activeRunId || !health?.configured
                  }
                  onTranscript={(text) => {
                    if (composerScopeRef.current === composerScope)
                      appendTranscript(text);
                  }}
                  onBusyChange={setVoiceBusy}
                />
              }
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
                maxLength={16_000}
              />
              <div className="composer-toolbar">
                <div className="composer-options">
                  <button
                    type="button"
                    className={`option-chip ${saved.webSearch ? "active" : ""}`}
                    aria-pressed={saved.webSearch === true}
                    aria-label="联网搜索"
                    disabled={health?.capabilities?.webSearch === false}
                    onClick={() =>
                      update((state) => ({
                        ...state,
                        webSearch: !state.webSearch,
                      }))
                    }
                  >
                    <Globe2 size={15} />
                    联网搜索
                  </button>
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
                    aria-label={
                      editing
                        ? "发送编辑后的问题"
                        : currentGenerating
                          ? "打断并发送消息"
                          : "发送消息"
                    }
                    title={
                      editing
                        ? "在新分支中发送"
                        : currentGenerating
                          ? "打断并发送"
                          : "发送消息"
                    }
                    disabled={
                      !identityReady ||
                      (!draft.trim() && !selectedAttachments.length) ||
                      uploading ||
                      voiceBusy ||
                      (!!editing && !!activeRunId)
                    }
                  >
                    <ArrowUp size={21} strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            </AttachmentComposer>
          </form>
          <div className="composer-footer">
            <span>内容由 AI 生成，请仔细甄别</span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </main>
      {!identityReady && (
        <div className="workspace-loading" role="status">
          <Brand />
          <span>正在打开你的工作空间…</span>
        </div>
      )}
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
            ref={modalElement}
            tabIndex={-1}
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
                  <span>
                    <FileText size={16} />
                    图片与文档提问 · 语音输入和朗读
                  </span>
                  <span>
                    <Globe2 size={16} />
                    联网搜索与来源 · 账户手动同步
                  </span>
                </div>
                {health?.capabilities && (
                  <dl className="capability-info">
                    <div>
                      <dt>图片理解模型</dt>
                      <dd>{health.capabilities.visionModel}</dd>
                    </div>
                    <div>
                      <dt>语音转写模型</dt>
                      <dd>{health.capabilities.asrModel}</dd>
                    </div>
                    <div>
                      <dt>语音合成模型</dt>
                      <dd>{health.capabilities.ttsModel}</dd>
                    </div>
                    <div>
                      <dt>服务配置</dt>
                      <dd>
                        {health.configured
                          ? "已配置千问凭证，实际可用性以请求结果为准"
                          : "尚未配置千问凭证"}
                      </dd>
                    </div>
                  </dl>
                )}
                <p className="about-note">
                  独立面试演示项目。会话在当前浏览器自动保存，登录后可手动同步到账户；附件保存在当前服务。发送问题、图片、文档或语音时，对应内容会交给千问处理。本地资料检索使用项目自带的演示文档。
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

import { z } from "zod";
import { attachmentsSchema, searchSourceSchema } from "../shared/schemas";
import type {
  HistoryMessage,
  Attachment,
  SearchSource,
  KnowledgeItem,
  ToolCall,
  ToolResult,
} from "../shared/types";

export type MessageStatus = "streaming" | "done" | "stopped" | "error";
export interface Message extends HistoryMessage {
  id: string;
  reasoning?: string;
  status: MessageStatus;
  error?: string;
  createdAt: number;
  sources?: KnowledgeItem[];
  searchSources?: SearchSource[];
}
export interface ComposerDraft {
  text: string;
  sources: KnowledgeItem[];
  attachments?: Attachment[];
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  draft?: ComposerDraft;
  branchFrom?: {
    conversationId: string;
    messageId: string;
    title: string;
    mode: "edit" | "regenerate";
  };
}
export interface SavedState {
  version: 1;
  conversations: Conversation[];
  activeId: string;
  useTools: boolean;
  thinking: boolean;
  webSearch?: boolean;
  recoveryNotice?: string;
}
export const STORAGE_KEY = "qianwen-workspace-v1";
export const createConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  title: "新对话",
  messages: [],
  updatedAt: Date.now(),
});

const knowledgeSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(300),
  summary: z.string().max(2000),
  content: z.string().max(8000),
  source: z.string().max(500),
});
const resultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("calculator"),
    expression: z.string().max(256),
    value: z.number().finite(),
  }),
  z.object({
    type: z.literal("knowledge"),
    query: z.string().max(300),
    items: z.array(knowledgeSchema).max(5),
  }),
  z.object({ type: z.literal("error"), message: z.string().max(1000) }),
]);
const toolSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(100),
  arguments: z.string().max(8000),
  status: z.enum([
    "receiving",
    "queued",
    "running",
    "success",
    "error",
    "cancelled",
  ]),
});
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeTime = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Date.now();
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,100}$/.test(value);

const branchSchema = z.object({
  conversationId: z.string().regex(/^[\w-]{1,100}$/),
  messageId: z.string().regex(/^[\w-]{1,100}$/),
  title: z.string().max(100),
  mode: z.enum(["edit", "regenerate"]),
});

/** Apply the same limits when saving and restoring, prioritizing the active conversation. */
export function createSnapshot(state: SavedState): SavedState {
  const active = state.conversations.find(
    (conversation) => conversation.id === state.activeId,
  );
  const ordered = [...state.conversations].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const retained = active
    ? [
        active,
        ...ordered.filter((conversation) => conversation.id !== active.id),
      ].slice(0, 50)
    : ordered.slice(0, 50);
  return {
    version: 1,
    activeId: active?.id ?? retained[0]?.id ?? state.activeId,
    useTools: state.useTools,
    thinking: state.thinking,
    webSearch: state.webSearch === true,
    conversations: retained.map((conversation) => {
      let start = Math.max(0, conversation.messages.length - 100);
      while (
        start > 0 &&
        start < conversation.messages.length &&
        conversation.messages[start].role !== "user"
      )
        start++;
      return { ...conversation, messages: conversation.messages.slice(start) };
    }),
  };
}

export function restoreState(storageKey = STORAGE_KEY): SavedState {
  const initial = createConversation();
  const fallback: SavedState = {
    version: 1,
    conversations: [initial],
    activeId: initial.id,
    useTools: true,
    thinking: false,
  };
  const failed = (message: string) => ({
    ...fallback,
    recoveryNotice: message,
  });
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    if (raw.length > 6_000_000)
      return failed("历史数据体积过大，已打开新对话。请检查浏览器存储空间。");
    const parsed: unknown = JSON.parse(raw);
    if (
      !record(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.conversations)
    )
      return failed("历史数据格式无法识别，已打开新对话。");
    let repaired = false;
    let interrupted = false;
    const conversationIds = new Set<string>();
    const conversations: Conversation[] = [];
    for (const candidate of parsed.conversations) {
      if (
        !record(candidate) ||
        !validId(candidate.id) ||
        typeof candidate.title !== "string" ||
        !Array.isArray(candidate.messages) ||
        conversationIds.has(candidate.id)
      ) {
        repaired = true;
        continue;
      }
      conversationIds.add(candidate.id);
      const messages: Message[] = [];
      const messageIds = new Set<string>();
      for (const original of candidate.messages) {
        if (
          !record(original) ||
          (original.role !== "user" && original.role !== "assistant") ||
          typeof original.content !== "string"
        ) {
          repaired = true;
          continue;
        }
        let id = original.id;
        if (!validId(id) || messageIds.has(id)) {
          id = crypto.randomUUID();
          repaired = true;
        }
        messageIds.add(id as string);
        const tools: ToolCall[] = [];
        const toolIds = new Set<string>();
        if (original.tools !== undefined && !Array.isArray(original.tools))
          repaired = true;
        for (const value of (Array.isArray(original.tools)
          ? original.tools
          : []
        ).slice(0, 16)) {
          const basic = toolSchema.safeParse(value);
          if (!basic.success || !record(value) || toolIds.has(basic.data.id)) {
            repaired = true;
            continue;
          }
          toolIds.add(basic.data.id);
          const pending = ["receiving", "queued", "running"].includes(
            basic.data.status,
          );
          const parsedResult =
            value.result === undefined
              ? undefined
              : resultSchema.safeParse(value.result);
          let result: ToolResult | undefined = parsedResult?.success
            ? parsedResult.data
            : undefined;
          let error =
            typeof value.error === "string"
              ? value.error.slice(0, 1000)
              : undefined;
          let status: ToolCall["status"] = pending
            ? "cancelled"
            : basic.data.status;
          if (pending) interrupted = true;
          if (
            (parsedResult && !parsedResult.success) ||
            (status === "success" && !result)
          ) {
            repaired = true;
            status = "error";
            error = "历史工具结果无法恢复，请重新提问。";
            result = { type: "error", message: error };
          }
          tools.push({
            ...basic.data,
            status,
            result,
            error,
            durationMs:
              typeof value.durationMs === "number" &&
              Number.isFinite(value.durationMs) &&
              value.durationMs >= 0
                ? value.durationMs
                : undefined,
          });
        }
        const sources: KnowledgeItem[] = [];
        if (original.sources !== undefined && !Array.isArray(original.sources))
          repaired = true;
        for (const value of (Array.isArray(original.sources)
          ? original.sources
          : []
        ).slice(0, 3)) {
          const result = knowledgeSchema.safeParse(value);
          if (
            result.success &&
            !sources.some((source) => source.id === result.data.id)
          )
            sources.push(result.data);
          else repaired = true;
        }
        if (original.error !== undefined && typeof original.error !== "string")
          repaired = true;
        const status: MessageStatus =
          original.status === "streaming"
            ? "stopped"
            : original.status === "stopped" || original.status === "error"
              ? original.status
              : "done";
        if (original.status === "streaming") interrupted = true;
        const attachments = attachmentsSchema.safeParse(
          original.attachments ?? [],
        );
        if (!attachments.success) repaired = true;
        const searchSources: SearchSource[] = [];
        if (
          original.searchSources !== undefined &&
          !Array.isArray(original.searchSources)
        )
          repaired = true;
        for (const value of (Array.isArray(original.searchSources)
          ? original.searchSources
          : []
        ).slice(0, 20)) {
          const parsedSource = searchSourceSchema.safeParse(value);
          if (
            parsedSource.success &&
            !searchSources.some((source) => source.id === parsedSource.data.id)
          )
            searchSources.push(parsedSource.data);
          else repaired = true;
        }
        messages.push({
          id: id as string,
          role: original.role,
          content: original.content.slice(0, 120_000),
          status,
          tools,
          sources: sources.length ? sources : undefined,
          attachments:
            attachments.success && attachments.data.length
              ? attachments.data
              : undefined,
          searchSources: searchSources.length ? searchSources : undefined,
          reasoning:
            typeof original.reasoning === "string"
              ? original.reasoning.slice(0, 120_000)
              : undefined,
          error:
            typeof original.error === "string"
              ? original.error.slice(0, 2000)
              : undefined,
          createdAt: safeTime(original.createdAt),
        });
      }
      const branch = branchSchema.safeParse(candidate.branchFrom);
      if (candidate.branchFrom !== undefined && !branch.success)
        repaired = true;
      let draft: Conversation["draft"];
      if (candidate.draft !== undefined) {
        if (
          !record(candidate.draft) ||
          typeof candidate.draft.text !== "string"
        ) {
          repaired = true;
        } else {
          const sources: KnowledgeItem[] = [];
          if (!Array.isArray(candidate.draft.sources)) repaired = true;
          for (const item of (Array.isArray(candidate.draft.sources)
            ? candidate.draft.sources
            : []
          ).slice(0, 3)) {
            const result = knowledgeSchema.safeParse(item);
            if (
              result.success &&
              !sources.some((source) => source.id === result.data.id)
            )
              sources.push(result.data);
            else repaired = true;
          }
          if (candidate.draft.text.length > 16000) repaired = true;
          const attachments = attachmentsSchema.safeParse(
            candidate.draft.attachments ?? [],
          );
          if (!attachments.success) repaired = true;
          draft = {
            text: candidate.draft.text.slice(0, 16000),
            sources,
            ...(attachments.success && attachments.data.length
              ? { attachments: attachments.data }
              : {}),
          };
        }
      }
      conversations.push({
        id: candidate.id,
        title: candidate.title.slice(0, 100) || "未命名对话",
        messages,
        updatedAt: safeTime(candidate.updatedAt),
        branchFrom: branch.success ? branch.data : undefined,
        draft,
      });
    }
    if (!conversations.length)
      return failed("未找到可恢复的会话，已打开新对话。");
    const limited =
      conversations.length > 50 ||
      conversations.some((conversation) => conversation.messages.length > 100);
    const snapshot = createSnapshot({
      version: 1,
      conversations,
      activeId:
        typeof parsed.activeId === "string"
          ? parsed.activeId
          : conversations[0].id,
      useTools: parsed.useTools !== false,
      thinking: parsed.thinking === true,
      webSearch: parsed.webSearch === true,
    });
    const notes = [
      repaired ? "部分历史数据损坏，已恢复可用内容。" : "",
      interrupted ? "上次未完成的回复已标记为中断。" : "",
      limited ? "已保留当前及最近 50 个会话，每个会话最多 100 条消息。" : "",
    ].filter(Boolean);
    return {
      ...snapshot,
      recoveryNotice: notes.length ? notes.join(" ") : undefined,
    };
  } catch {
    return failed("无法读取本地历史，已打开新对话；当前仍可正常聊天。");
  }
}

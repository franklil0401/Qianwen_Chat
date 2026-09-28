import { z } from "zod";
import { createSnapshot, type Conversation, type SavedState } from "./state";

export const BACKUP_FORMAT = "qianwen-chat-backup";
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORTED_CONVERSATIONS = 50;
export const MAX_IMPORTED_MESSAGES = 100;
const MAX_STORED_CHARACTERS = 6_000_000;
const id = z.string().regex(/^[\w-]{1,100}$/);
const timestamp = z.number().finite().nonnegative();
const knowledge = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().max(300),
    summary: z.string().max(2000),
    content: z.string().max(8000),
    source: z.string().max(500),
  })
  .strict();
const sources = z
  .array(knowledge)
  .max(3)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "资料 ID 不能重复",
  );
const result = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("calculator"),
      expression: z.string().max(256),
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal("knowledge"),
      query: z.string().max(300),
      items: z.array(knowledge).max(5),
    })
    .strict(),
  z
    .object({ type: z.literal("error"), message: z.string().max(1000) })
    .strict(),
]);
const tool = z
  .object({
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
    result: result.optional(),
    error: z.string().max(1000).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine(
    (item) => item.status !== "success" || item.result !== undefined,
    "完成的工具缺少结果",
  );
const message = z
  .object({
    id,
    role: z.enum(["user", "assistant"]),
    content: z.string().max(120_000),
    status: z.enum(["streaming", "done", "stopped", "error"]),
    createdAt: timestamp,
    reasoning: z.string().max(120_000).optional(),
    error: z.string().max(2000).optional(),
    sources: sources.optional(),
    tools: z
      .array(tool)
      .max(16)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "工具 ID 不能重复",
      )
      .optional(),
  })
  .strict();
const conversation = z
  .object({
    id,
    title: z.string().min(1).max(100),
    updatedAt: timestamp,
    messages: z
      .array(message)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "同一会话的消息 ID 不能重复",
      )
      .refine(
        (items) => !items.length || items[0].role === "user",
        "会话需要从用户提问开始",
      ),
    draft: z
      .object({ text: z.string().max(16_000), sources })
      .strict()
      .optional(),
    branchFrom: z
      .object({
        conversationId: id,
        messageId: id,
        title: z.string().max(100),
        mode: z.enum(["edit", "regenerate"]),
      })
      .strict()
      .optional(),
  })
  .strict();
const backupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    conversations: z
      .array(conversation)
      .min(1)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "备份中的会话 ID 不能重复",
      ),
  })
  .strict();

export type ChatBackup = z.infer<typeof backupSchema>;
export interface ImportPreview {
  backup: ChatBackup;
  conversations: Conversation[];
  conversationCount: number;
  originalMessageCount: number;
  messageCount: number;
  trimmedMessageCount: number;
  combinedConversationCount: number;
  remapsIds: boolean;
  interruptedMessageCount: number;
}

/** Export an explicit allowlist from memory, including histories beyond storage limits. */
export function serializeBackup(state: SavedState, now = new Date()): string {
  const conversations = state.conversations.map((item) => ({
    id: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    messages: item.messages.map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      status: entry.status,
      createdAt: entry.createdAt,
      reasoning: entry.reasoning,
      error: entry.error,
      sources: entry.sources?.map((source) => ({
        id: source.id,
        title: source.title,
        summary: source.summary,
        content: source.content,
        source: source.source,
      })),
      tools: entry.tools?.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: call.status,
        error: call.error,
        durationMs: call.durationMs,
        result:
          call.result?.type === "calculator"
            ? {
                type: "calculator",
                expression: call.result.expression,
                value: call.result.value,
              }
            : call.result?.type === "knowledge"
              ? {
                  type: "knowledge",
                  query: call.result.query,
                  items: call.result.items.map((source) => ({
                    id: source.id,
                    title: source.title,
                    summary: source.summary,
                    content: source.content,
                    source: source.source,
                  })),
                }
              : call.result?.type === "error"
                ? { type: "error", message: call.result.message }
                : undefined,
      })),
    })),
    draft: item.draft
      ? {
          text: item.draft.text,
          sources: item.draft.sources.map((source) => ({
            id: source.id,
            title: source.title,
            summary: source.summary,
            content: source.content,
            source: source.source,
          })),
        }
      : undefined,
    branchFrom: item.branchFrom
      ? {
          conversationId: item.branchFrom.conversationId,
          messageId: item.branchFrom.messageId,
          title: item.branchFrom.title,
          mode: item.branchFrom.mode,
        }
      : undefined,
  }));
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: now.toISOString(),
      conversations,
    },
    null,
    2,
  );
}

export function parseBackup(text: string): ChatBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES)
    throw new Error("备份文件超过 10 MB，请选择更小的文件。");
  let candidate: unknown;
  try {
    candidate = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("无法读取 JSON，请选择由本应用导出的备份文件。");
  }
  const parsed = backupSchema.safeParse(candidate);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "文件格式";
    throw new Error(
      `备份内容不完整或格式不受支持（${path}），未导入任何会话。`,
    );
  }
  return parsed.data;
}

function remapConversations(
  items: Conversation[],
  mapping: Map<string, string>,
): Conversation[] {
  return items.map((item) => ({
    ...item,
    id: mapping.get(item.id)!,
    branchFrom: item.branchFrom
      ? {
          ...item.branchFrom,
          conversationId:
            mapping.get(item.branchFrom.conversationId) ||
            item.branchFrom.conversationId,
        }
      : undefined,
  }));
}

function assertStorageCapacity(current: SavedState, imported: Conversation[]) {
  const candidate = {
    ...current,
    activeId: imported[0]?.id || current.activeId,
    conversations: [...current.conversations, ...imported],
  };
  if (
    JSON.stringify(createSnapshot(candidate)).length > MAX_STORED_CHARACTERS
  ) {
    throw new Error(
      "导入后的历史超过本机恢复容量，未导入任何会话。请减少已有历史或选择较小的备份。",
    );
  }
}

/** Preview trimming only imported conversations; never rewrite existing state. */
export function planImport(
  backup: ChatBackup,
  current: SavedState,
): ImportPreview {
  const combinedConversationCount =
    current.conversations.length + backup.conversations.length;
  if (combinedConversationCount > MAX_IMPORTED_CONVERSATIONS)
    throw new Error(
      `当前 ${current.conversations.length} 个会话，加上备份的 ${backup.conversations.length} 个会话，共 ${combinedConversationCount} 个，超过 50 个上限。请先整理已有会话后重试。`,
    );
  let originalMessageCount = 0;
  let messageCount = 0;
  let interruptedMessageCount = 0;
  const conversations = backup.conversations.map((item) => {
    originalMessageCount += item.messages.length;
    let start = Math.max(0, item.messages.length - MAX_IMPORTED_MESSAGES);
    while (start < item.messages.length && item.messages[start].role !== "user")
      start++;
    const kept = structuredClone(item.messages.slice(start));
    messageCount += kept.length;
    for (const entry of kept) {
      if (entry.status === "streaming") {
        entry.status = "stopped";
        interruptedMessageCount++;
      }
      for (const call of entry.tools || [])
        if (["receiving", "queued", "running"].includes(call.status))
          call.status = "cancelled";
    }
    return { ...structuredClone(item), messages: kept };
  });
  const existingIds = new Set(current.conversations.map((item) => item.id));
  const remapsIds = conversations.some((item) => existingIds.has(item.id));
  const previewIds = new Map<string, string>();
  const occupied = new Set([
    ...existingIds,
    ...conversations.map((item) => item.id),
  ]);
  let index = 0;
  for (const item of conversations) {
    let previewId = item.id;
    if (remapsIds) {
      do {
        previewId = `backup-preview-${String(index++).padStart(21, "0")}`;
      } while (occupied.has(previewId));
      occupied.add(previewId);
    }
    previewIds.set(item.id, previewId);
  }
  assertStorageCapacity(current, remapConversations(conversations, previewIds));
  return {
    backup,
    conversations,
    conversationCount: conversations.length,
    originalMessageCount,
    messageCount,
    trimmedMessageCount: originalMessageCount - messageCount,
    combinedConversationCount,
    remapsIds,
    interruptedMessageCount,
  };
}

/** Recalculate against the current state at confirmation time to avoid lost updates. */
export function applyImport(
  current: SavedState,
  backup: ChatBackup,
  makeId: () => string = () => crypto.randomUUID(),
): SavedState {
  const preview = planImport(backup, current);
  const blocked = new Set(
    [...current.conversations, ...preview.conversations].map((item) => item.id),
  );
  const mapping = new Map<string, string>();
  for (const item of preview.conversations) {
    let newId = item.id;
    if (preview.remapsIds) {
      let attempts = 0;
      do {
        newId = makeId();
        if (++attempts > 100)
          throw new Error("无法分配新会话标识，请重试导入。");
      } while (!/^[\w-]{1,100}$/.test(newId) || blocked.has(newId));
      blocked.add(newId);
    }
    mapping.set(item.id, newId);
  }
  const imported = remapConversations(preview.conversations, mapping);
  assertStorageCapacity(current, imported);
  return {
    ...current,
    activeId: imported[0]?.id || current.activeId,
    conversations: [...current.conversations, ...imported],
  };
}

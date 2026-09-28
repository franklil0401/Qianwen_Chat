import { describe, expect, it } from "vitest";
import {
  applyImport,
  MAX_BACKUP_BYTES,
  parseBackup,
  planImport,
  serializeBackup,
} from "../src/backup";
import type { Conversation, Message, SavedState } from "../src/state";

const entry = (index: number): Message => ({
  id: `m-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `消息 ${index}`,
  status: "done",
  createdAt: index,
});
const source = {
  id: "source-1",
  title: "演示资料",
  source: "本地资料",
  summary: "摘要",
  content: "完整原文",
};
const chat = (id: string, count = 2): Conversation => ({
  id,
  title: `会话 ${id}`,
  updatedAt: 1,
  messages: Array.from({ length: count }, (_, index) => entry(index)),
});
const state = (
  conversations: Conversation[] = [chat("existing")],
): SavedState => ({
  version: 1,
  conversations,
  activeId: conversations[0]?.id || "",
  useTools: true,
  thinking: false,
});
const backup = (conversations: Conversation[]) =>
  parseBackup(
    serializeBackup(state(conversations), new Date("2026-09-28T00:00:00.000Z")),
  );

describe("local JSON backup", () => {
  it("exports every in-memory message, drafts and nested data without exporting unrelated settings", () => {
    const original = chat("all-history", 122);
    original.draft = { text: "未发送草稿", sources: [source] };
    original.messages[1].tools = [
      {
        id: "tool-1",
        name: "calculate",
        arguments: '{"expression":"1+1"}',
        status: "success",
        result: { type: "calculator", expression: "1+1", value: 2 },
      },
    ];
    original.messages[2].sources = [source];
    const current = {
      ...state([original]),
      Qianwen_api_key: "SHOULD_NOT_EXPORT",
    };
    const encoded = serializeBackup(current);
    const result = parseBackup(encoded);
    expect(result.format).toBe("qianwen-chat-backup");
    expect(result.conversations[0].messages).toHaveLength(122);
    expect(result.conversations[0].draft?.sources[0].content).toBe("完整原文");
    expect(result.conversations[0].messages[1].tools?.[0].result).toEqual({
      type: "calculator",
      expression: "1+1",
      value: 2,
    });
    expect(encoded).not.toContain("SHOULD_NOT_EXPORT");
  });

  it("rejects oversized, unknown-version and malformed nested data without modifying existing records", () => {
    const current = state();
    const before = structuredClone(current);
    const invalid = JSON.parse(serializeBackup(state([chat("incoming")])));
    invalid.conversations[0].messages[0].sources = [{ ...source, content: {} }];
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow("格式不受支持");
    invalid.conversations[0].messages[0].sources = [source];
    invalid.version = 999;
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow("格式不受支持");
    expect(() => parseBackup(" ".repeat(MAX_BACKUP_BYTES + 1))).toThrow(
      "超过 10 MB",
    );
    expect(current).toEqual(before);
  });

  it("reports exact trimming at a complete user turn and does not truncate existing histories", () => {
    const current = state([chat("existing", 124)]);
    const pending = backup([chat("incoming", 103)]);
    const preview = planImport(pending, current);
    expect(preview).toMatchObject({
      conversationCount: 1,
      originalMessageCount: 103,
      messageCount: 99,
      trimmedMessageCount: 4,
      combinedConversationCount: 2,
    });
    expect(preview.conversations[0].messages[0].id).toBe("m-4");
    const next = applyImport(current, pending);
    expect(next.conversations[0]).toBe(current.conversations[0]);
    expect(next.conversations[0].messages).toHaveLength(124);
    expect(next.conversations[1].messages).toHaveLength(99);
    expect(pending.conversations[0].messages).toHaveLength(103);
  });

  it("changes every imported conversation ID on collision and remaps internal branch origins", () => {
    const origin = chat("existing");
    const child = {
      ...chat("child"),
      branchFrom: {
        conversationId: "existing",
        messageId: "m-0",
        title: "来源会话",
        mode: "edit" as const,
      },
    };
    const pending = backup([origin, child]);
    const ids = ["new-origin", "new-child"];
    const current = state();
    const next = applyImport(current, pending, () => ids.shift()!);
    expect(next.conversations.map((item) => item.id)).toEqual([
      "existing",
      "new-origin",
      "new-child",
    ]);
    expect(next.conversations[2].branchFrom?.conversationId).toBe("new-origin");
    expect(next.conversations[2].branchFrom?.messageId).toBe("m-0");
    expect(current.conversations).toHaveLength(1);
    expect(pending.conversations.map((item) => item.id)).toEqual([
      "existing",
      "child",
    ]);
  });

  it("marks pending replies and tools as interrupted without executing anything", () => {
    const incoming = chat("incoming");
    incoming.messages[1].status = "streaming";
    incoming.messages[1].tools = [
      {
        id: "pending-tool",
        name: "calculate",
        arguments: "{",
        status: "receiving",
      },
    ];
    const pending = backup([incoming]);
    const preview = planImport(pending, state());
    expect(preview.interruptedMessageCount).toBe(1);
    expect(preview.conversations[0].messages[1]).toMatchObject({
      status: "stopped",
      tools: [{ status: "cancelled" }],
    });
    expect(pending.conversations[0].messages[1].status).toBe("streaming");
  });

  it("rechecks capacity and merges against the latest state when confirming a preview", () => {
    const pending = backup([chat("incoming")]);
    const earlier = state(
      Array.from({ length: 49 }, (_, index) => chat(`old-${index}`)),
    );
    expect(planImport(pending, earlier).combinedConversationCount).toBe(50);
    const latest = {
      ...earlier,
      conversations: [...earlier.conversations, chat("created-after-preview")],
    };
    expect(() => applyImport(latest, pending)).toThrow("超过 50 个上限");
    expect(latest.conversations).toHaveLength(50);
    const changed = state([chat("existing"), chat("created-after-preview")]);
    expect(
      applyImport(changed, pending).conversations.map((item) => item.id),
    ).toEqual(["existing", "created-after-preview", "incoming"]);
  });

  it("rejects a combined snapshot over the recovery limit even when conversation count is small", () => {
    const existing = chat("large-existing", 64);
    const incoming = chat("large-import", 64);
    for (const item of [...existing.messages, ...incoming.messages])
      if (item.role === "assistant") item.content = "x".repeat(100_000);
    const pending = backup([incoming]);
    expect(planImport(pending, state()).conversationCount).toBe(1);
    expect(() => planImport(pending, state([existing]))).toThrow(
      "超过本机恢复容量",
    );
    expect(() => applyImport(state([existing]), pending)).toThrow(
      "超过本机恢复容量",
    );
    expect(existing.messages).toHaveLength(64);
    expect(existing.messages[1].content).toHaveLength(100_000);
  });

  it("rejects user messages over the API limit, including the serialized source content", () => {
    const oversized = chat("oversized-user");
    oversized.messages[0].content = "问".repeat(16_001);
    expect(() => backup([oversized])).toThrow("格式不受支持");
    const cited = chat("oversized-citation");
    cited.messages[0].content = "请解释这些资料";
    cited.messages[0].sources = [
      { ...source, id: "first-source", content: "x".repeat(8000) },
      { ...source, id: "second-source", content: "y".repeat(8000) },
    ];
    expect(() => backup([cited])).toThrow("格式不受支持");
    const largeAnswer = chat("large-answer");
    largeAnswer.messages[1].content = "答".repeat(100_000);
    expect(
      backup([largeAnswer]).conversations[0].messages[1].content,
    ).toHaveLength(100_000);
  });
});

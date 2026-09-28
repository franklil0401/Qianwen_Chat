import { describe, expect, it } from "vitest";
import { createBranch, findBranchPoint } from "../src/branches";
import type { Conversation, Message } from "../src/state";

const message = (
  id: string,
  role: Message["role"],
  content: string,
): Message => ({ id, role, content, status: "done", createdAt: 1 });
const original: Conversation = {
  id: "original",
  title: "原始对话",
  updatedAt: 1,
  messages: [
    message("u1", "user", "前置问题"),
    message("a1", "assistant", "前置答案"),
    {
      ...message("u2", "user", "目标问题"),
      sources: [
        {
          id: "source",
          title: "来源",
          source: "本地",
          summary: "摘要",
          content: "原文",
        },
      ],
    },
    message("a2", "assistant", "目标旧答案"),
    message("u3", "user", "后续问题"),
    message("a3", "assistant", "后续答案"),
  ],
};

describe("conversation branching", () => {
  it("regenerates the selected turn without its old answer or later turns", () => {
    const point = findBranchPoint(original, "a2");
    expect(point.question.id).toBe("u2");
    expect(point.question.sources?.[0].content).toBe("原文");
    expect(point.previousMessages.map((item) => item.id)).toEqual(["u1", "a1"]);
  });
  it("editing a question creates an independent prefix and clear source metadata", () => {
    const branch = createBranch(original, "u2", "edit", "new-branch", 100);
    expect(branch).toMatchObject({
      id: "new-branch",
      title: "原始对话 · 编辑分支",
      updatedAt: 100,
      branchFrom: {
        conversationId: "original",
        messageId: "u2",
        title: "原始对话",
        mode: "edit",
      },
    });
    branch.messages[0].content = "分支修改";
    expect(original.messages[0].content).toBe("前置问题");
    expect(original.messages).toHaveLength(6);
  });
  it("the first turn produces an empty prefix so the question is appended once", () => {
    expect(
      createBranch(original, "a1", "regenerate", "first", 2).messages,
    ).toEqual([]);
  });
  it("rejects missing targets and orphan assistant messages", () => {
    expect(() => findBranchPoint(original, "missing")).toThrow("没有找到");
    expect(() =>
      findBranchPoint(
        { ...original, messages: [message("orphan", "assistant", "孤立回复")] },
        "orphan",
      ),
    ).toThrow("没有对应");
  });
});

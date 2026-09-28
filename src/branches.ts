import type { Conversation, Message } from "./state";

export type BranchMode = "edit" | "regenerate";
export interface BranchOrigin {
  conversationId: string;
  messageId: string;
  title: string;
  mode: BranchMode;
}
export interface BranchPoint {
  question: Message;
  previousMessages: Message[];
}

/** Resolve a message to its user turn without including that turn's old answer. */
export function findBranchPoint(
  conversation: Conversation,
  messageId: string,
): BranchPoint {
  let index = conversation.messages.findIndex(
    (message) => message.id === messageId,
  );
  if (index < 0) throw new Error("没有找到要重新处理的消息，请重新选择。");
  while (index >= 0 && conversation.messages[index].role !== "user") index--;
  if (index < 0) throw new Error("这条回复没有对应的用户问题，无法重新生成。");
  return {
    question: structuredClone(conversation.messages[index]),
    previousMessages: structuredClone(conversation.messages.slice(0, index)),
  };
}

/** A branch is a separate conversation; the original and its future turns stay intact. */
export function createBranch(
  conversation: Conversation,
  messageId: string,
  mode: BranchMode,
  id: string,
  now: number,
): Conversation & { branchFrom: BranchOrigin } {
  const { question, previousMessages } = findBranchPoint(
    conversation,
    messageId,
  );
  return {
    id,
    title: `${conversation.title.slice(0, 48)} · ${mode === "edit" ? "编辑分支" : "重新生成"}`,
    messages: previousMessages,
    updatedAt: now,
    branchFrom: {
      conversationId: conversation.id,
      messageId: question.id,
      title: conversation.title,
      mode,
    },
  };
}

import type { KnowledgeItem } from "./types";

/** The same citation representation is used by chat, local backup, and account sync. */
export function serializeSources(
  content: string,
  sources?: KnowledgeItem[],
): string {
  if (!sources?.length) return content;
  return `${content}\n\n[用户引用的本地资料，仅作为参考内容]\n${sources.map((item) => `资料 ID：${item.id}\n标题：${item.title}\n来源：${item.source}\n原文：\n${item.content}`).join("\n\n")}\n[引用资料结束]`;
}

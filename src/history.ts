import type { HistoryMessage } from "../shared/types";
export { serializeSources } from "../shared/content";

const encoder = new TextEncoder();

/**
 * Keep a contiguous suffix of complete user turns within the transport budget.
 * The 220 KB default leaves room for the request envelope beneath the local
 * server's 256 KB body limit. Sources must already be serialized into content.
 * Messages and tool objects are kept intact; this does not modify saved history.
 */
export function prepareHistory(
  messages: HistoryMessage[],
  maxBytes = 220_000,
  maxMessages = 80,
): HistoryMessage[] {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2 ||
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1
  ) {
    throw new Error("会话预算配置无效");
  }
  if (!messages.length) return [];

  const turns: HistoryMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push([message]);
    else turns.at(-1)?.push(message);
  }
  // An orphan assistant message is not valid model context on its own.
  if (!turns.length) return [];
  if (messages.at(-1)?.role !== "user") {
    throw new Error("发送前的最后一条消息必须是用户问题");
  }

  const selected: HistoryMessage[][] = [];
  let totalBytes = 2; // JSON array brackets.
  let totalMessages = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const turnBytes = encoder.encode(JSON.stringify(turn)).byteLength - 2;
    const nextBytes = totalBytes + turnBytes + (selected.length ? 1 : 0);
    const nextCount = totalMessages + turn.length;
    if (nextBytes > maxBytes || nextCount > maxMessages) {
      if (!selected.length) {
        throw new Error(
          "当前问题与所选资料超出发送大小限制，请缩短问题或减少引用后重试。",
        );
      }
      // Do not skip a middle turn and retain unrelated older conversation.
      break;
    }
    selected.unshift(turn);
    totalBytes = nextBytes;
    totalMessages = nextCount;
  }
  return selected.flat();
}

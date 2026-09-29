import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSnapshot,
  restoreState,
  STORAGE_KEY,
  type SavedState,
} from "../src/state";
import { parseBackup, serializeBackup } from "../src/backup";
import { createBranch } from "../src/branches";
import { prepareHistory } from "../src/history";
import type { Attachment, SearchSource } from "../shared/types";

const attachment: Attachment = {
  id: "document-1",
  name: "需求.md",
  kind: "document",
  mimeType: "text/markdown",
  size: 80,
  textPreview: "服务端提取的摘要",
  extractedCharacters: 40,
  truncated: false,
};
const source: SearchSource = {
  id: "web-1",
  title: "官方文档",
  url: "https://example.com/docs",
  snippet: "检索摘要",
};
function workspace(): SavedState {
  return {
    version: 1,
    activeId: "chat-1",
    useTools: true,
    thinking: false,
    webSearch: true,
    conversations: [
      {
        id: "chat-1",
        title: "附件对话",
        updatedAt: 1,
        draft: { text: "原草稿", sources: [], attachments: [attachment] },
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "解释附件",
            status: "done",
            createdAt: 1,
            attachments: [attachment],
          },
          {
            id: "answer-1",
            role: "assistant",
            content: "有来源的回答",
            status: "done",
            createdAt: 2,
            searchSources: [source],
          },
          {
            id: "user-2",
            role: "user",
            content: "继续",
            status: "done",
            createdAt: 3,
          },
        ],
      },
    ],
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("multimodal workspace persistence", () => {
  it("restores each account bucket separately with attachment drafts, message metadata and real sources", () => {
    const guest = workspace();
    const account = workspace();
    account.conversations[0].draft!.text = "账户草稿";
    const values = new Map([
      [STORAGE_KEY, JSON.stringify(createSnapshot(guest))],
      [
        `${STORAGE_KEY}:user:account-1`,
        JSON.stringify(createSnapshot(account)),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
    });
    const restored = restoreState();
    expect(restored.webSearch).toBe(true);
    expect(restored.conversations[0].draft).toEqual(
      guest.conversations[0].draft,
    );
    expect(restored.conversations[0].messages[0].attachments).toEqual([
      attachment,
    ]);
    expect(restored.conversations[0].messages[1].searchSources).toEqual([
      source,
    ]);
    expect(
      restoreState(`${STORAGE_KEY}:user:account-1`).conversations[0].draft
        ?.text,
    ).toBe("账户草稿");
    expect(
      restoreState(`${STORAGE_KEY}:user:unknown`).conversations[0].messages,
    ).toEqual([]);
  });

  it("exports metadata only and rejects imported inline data or executable source URLs", () => {
    const state = workspace();
    Object.assign(state.conversations[0].messages[0].attachments![0], {
      base64: "DO_NOT_STORE_INLINE",
      content: "DO_NOT_STORE_DOCUMENT",
    });
    const encoded = serializeBackup(state);
    expect(encoded).not.toContain("DO_NOT_STORE");
    const backup = parseBackup(encoded);
    expect(backup.conversations[0].draft?.attachments?.[0].id).toBe(
      attachment.id,
    );
    expect(backup.conversations[0].messages[1].searchSources).toEqual([source]);
    const invalid = JSON.parse(encoded);
    invalid.conversations[0].messages[0].attachments[0].previewUrl =
      "data:image/png;base64,unsafe";
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow(
      "未导入任何会话",
    );
    invalid.conversations[0].messages[0].attachments[0] = {
      ...attachment,
      base64: "inline",
    };
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow(
      "未导入任何会话",
    );
    invalid.conversations[0].messages[0].attachments = [];
    invalid.conversations[0].messages[1].searchSources[0].url =
      "javascript:alert(1)";
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow(
      "未导入任何会话",
    );
  });

  it("keeps earlier attachments in branch context and repairs invalid stored attachment metadata", () => {
    const saved = workspace();
    const branch = createBranch(
      saved.conversations[0],
      "user-2",
      "edit",
      "branch-1",
      10,
    );
    expect(branch.messages[0].attachments?.[0].id).toBe(attachment.id);
    const history = prepareHistory([
      ...branch.messages,
      saved.conversations[0].messages[2],
    ]);
    expect(history[0].attachments?.[0].id).toBe(attachment.id);
    const malformed = JSON.parse(JSON.stringify(saved));
    malformed.conversations[0].draft.attachments[0].previewUrl =
      "https://untrusted.example/file";
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(malformed) });
    const recovered = restoreState();
    expect(recovered.conversations[0].draft?.text).toBe("原草稿");
    expect(recovered.conversations[0].draft?.attachments).toBeUndefined();
    expect(recovered.recoveryNotice).toContain("数据损坏");
  });
});

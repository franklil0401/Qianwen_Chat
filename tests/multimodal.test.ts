import { describe, expect, it } from "vitest";
import {
  attachmentMetadata,
  secureSourceUrl,
  sourceMetadata,
  speechSegments,
  validateUpload,
} from "../src/multimodal";
import type { Attachment, SearchSource } from "../shared/types";

describe("multimodal client boundaries", () => {
  it("accepts exact image/document limits and rejects oversized, empty and unsupported uploads", () => {
    expect(
      validateUpload({ name: "图片.PNG", size: 5 * 1024 * 1024 }),
    ).toBeNull();
    expect(
      validateUpload({ name: "image.webp", size: 5 * 1024 * 1024 + 1 }),
    ).toContain("5 MB");
    expect(
      validateUpload({ name: "notes.pdf", size: 10 * 1024 * 1024 }),
    ).toBeNull();
    expect(
      validateUpload({ name: "notes.docx", size: 10 * 1024 * 1024 + 1 }),
    ).toContain("10 MB");
    expect(validateUpload({ name: "empty.txt", size: 0 })).toContain("为空");
    expect(validateUpload({ name: "script.exe", size: 10 })).toContain("支持");
  });
  it("segments long Chinese and emoji text without splitting surrogate pairs or dropping text", () => {
    const text = "讨论流式输出😀。".repeat(150);
    const segments = speechSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join("")).toBe(text);
    for (const part of segments) {
      expect(part.length).toBeLessThanOrEqual(380);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(speechSegments("   ")).toEqual([]);
  });
  it("reads markdown labels and substitutes a screen hint for fenced code", () => {
    const result = speechSegments(
      '# 标题\n**阅读** [官方文档](https://example.com/docs)\n![图片](https://example.com/p.png)\n```ts\nconsole.log("skip-code");\n```\n结束。',
    ).join("");
    expect(result).toContain("标题");
    expect(result).toContain("阅读 官方文档");
    expect(result).toContain("代码块请查看屏幕");
    expect(result).toContain("结束。");
    expect(result).not.toContain("skip-code");
    expect(result).not.toContain("https://");
    expect(result).not.toContain("**");
    expect(result).not.toContain("图片");
  });
  it("only permits HTTPS source links", () => {
    expect(secureSourceUrl("https://example.com/article?q=1")).toBe(
      "https://example.com/article?q=1",
    );
    for (const value of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,test",
      "/relative",
      "not a url",
    ])
      expect(secureSourceUrl(value)).toBeUndefined();
  });
  it("copies public metadata without leaking document bodies or extra provider fields", () => {
    const attachment = {
      id: "a",
      name: "notes.txt",
      kind: "document",
      mimeType: "text/plain",
      size: 10,
      textPreview: "摘要",
      extractedCharacters: 100,
      truncated: false,
      text: "full document",
      owner: "user:private",
      apiKey: "private",
    } as Attachment;
    const copied = attachmentMetadata(attachment);
    expect(copied).toMatchObject({
      id: "a",
      textPreview: "摘要",
      extractedCharacters: 100,
      truncated: false,
    });
    expect(copied).not.toHaveProperty("text");
    expect(copied).not.toHaveProperty("owner");
    expect(copied).not.toHaveProperty("apiKey");
    const source = {
      id: "s",
      title: "来源",
      url: "https://example.com",
      snippet: "公开摘要",
      rawProviderResponse: "hidden",
      token: "hidden",
    } as SearchSource;
    expect(sourceMetadata(source)).toMatchObject({
      id: "s",
      snippet: "公开摘要",
    });
    expect(sourceMetadata(source)).not.toHaveProperty("rawProviderResponse");
    expect(sourceMetadata(source)).not.toHaveProperty("token");
  });
});

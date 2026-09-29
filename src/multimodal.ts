import type { Attachment, SearchSource } from "../shared/types";

export const CLIENT_HEADERS = { "X-Qianwen-Client": "web" };
export const MAX_ATTACHMENTS = 4;
export const acceptedFiles = ".png,.jpg,.jpeg,.webp,.txt,.md,.pdf,.docx";
export function validateUpload(
  file: Pick<File, "name" | "size">,
): string | null {
  const extension = file.name.toLowerCase().split(".").at(-1);
  const image = ["png", "jpg", "jpeg", "webp"].includes(extension || "");
  if (!image && !["txt", "md", "pdf", "docx"].includes(extension || ""))
    return "支持 PNG、JPG、WebP 图片，以及 TXT、Markdown、PDF、Word 文档。";
  if (!file.size) return "文件为空，请选择有内容的文件。";
  if (file.size > (image ? 5 : 10) * 1024 * 1024)
    return image ? "单张图片不能超过 5 MB。" : "单份文档不能超过 10 MB。";
  return null;
}
export function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function attachmentMetadata(item: Attachment): Attachment {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    mimeType: item.mimeType,
    size: item.size,
    previewUrl: item.previewUrl,
    textPreview: item.textPreview,
    extractedCharacters: item.extractedCharacters,
    truncated: item.truncated,
  };
}
export function sourceMetadata(item: SearchSource): SearchSource {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    siteName: item.siteName,
    snippet: item.snippet,
  };
}
export function secureSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
/** Keep utterances under the backend's 500-character limit without dropping text. */
export function speechSegments(content: string, limit = 380): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 500)
    throw new Error("朗读分段长度必须在 2 到 500 字之间。");
  const text = content
    .replace(/```[\s\S]*?```/g, "。代码块请查看屏幕。")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .trim();
  const points = Array.from(text);
  const segments: string[] = [];
  while (points.length) {
    let end = 0;
    let characters = 0;
    while (end < points.length && characters + points[end].length <= limit) {
      characters += points[end].length;
      end++;
    }
    if (end < points.length) {
      for (let index = end - 1; index > Math.floor(end / 2); index--)
        if (/[。！？!?；;\n]/.test(points[index])) {
          end = index + 1;
          break;
        }
    }
    const part = points.splice(0, end).join("").trim();
    if (part) segments.push(part);
  }
  return segments;
}

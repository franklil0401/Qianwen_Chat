import { useState } from "react";
import { FileText, ImageIcon, X } from "lucide-react";
import type { Attachment } from "../shared/types";
import { formatFileSize } from "./multimodal";
import "./multimodal.css";

export function AttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: () => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview =
    attachment.previewUrl === `/api/attachments/${attachment.id}/content`
      ? attachment.previewUrl
      : undefined;
  return (
    <div
      className={`attachment-card attachment-${attachment.kind}`}
      data-testid="attachment-card"
    >
      {attachment.kind === "image" && preview && !previewFailed ? (
        <a
          className="attachment-thumbnail"
          href={preview}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`查看图片：${attachment.name}`}
        >
          <img
            src={preview}
            alt={attachment.name}
            onError={() => setPreviewFailed(true)}
          />
        </a>
      ) : (
        <span className="attachment-symbol">
          {attachment.kind === "image" ? (
            <ImageIcon size={22} />
          ) : (
            <FileText size={22} />
          )}
        </span>
      )}
      <div className="attachment-info">
        <strong title={attachment.name}>{attachment.name}</strong>
        <span>
          {formatFileSize(attachment.size)}
          {attachment.kind === "document" &&
          attachment.extractedCharacters !== undefined
            ? ` · ${attachment.extractedCharacters} 字`
            : ""}
        </span>
        {attachment.truncated && (
          <small>文档较长，将使用已提取的部分内容</small>
        )}
        {previewFailed && <small>预览不可用，请确认文件仍在当前账户</small>}
        {attachment.textPreview && (
          <details>
            <summary>查看文档摘要</summary>
            <p>{attachment.textPreview}</p>
          </details>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          className="icon-button"
          aria-label={`移除附件：${attachment.name}`}
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export default function MessageAttachments({
  attachments,
}: {
  attachments?: Attachment[];
}) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments" data-testid="message-attachments">
      {attachments.map((item) => (
        <AttachmentCard key={item.id} attachment={item} />
      ))}
    </div>
  );
}

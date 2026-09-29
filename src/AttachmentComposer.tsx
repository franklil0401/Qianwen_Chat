import { apiFetch } from "./api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Paperclip, RotateCcw, X } from "lucide-react";
import type { Attachment } from "../shared/types";
import { attachmentSchema } from "../shared/schemas";
import {
  acceptedFiles,
  CLIENT_HEADERS,
  MAX_ATTACHMENTS,
  validateUpload,
} from "./multimodal";
import { AttachmentCard } from "./MessageAttachments";

interface Transfer {
  id: string;
  file: File;
  status: "uploading" | "error";
  error?: string;
}
interface Props {
  value: Attachment[];
  onAdd: (item: Attachment) => void;
  onRemove: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
  extraControls?: ReactNode;
  children: ReactNode;
}

export default function AttachmentComposer({
  value,
  onAdd,
  onRemove,
  onBusyChange,
  disabled,
  extraControls,
  children,
}: Props) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const transferRef = useRef<Transfer[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const latest = useRef({ value, onAdd, onBusyChange, disabled });
  latest.current = { value, onAdd, onBusyChange, disabled };
  function updateTransfers(fn: (items: Transfer[]) => Transfer[]) {
    transferRef.current = fn(transferRef.current);
    setTransfers(transferRef.current);
  }
  useEffect(() => {
    onBusyChange(transfers.some((item) => item.status === "uploading"));
  }, [transfers, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      latest.current.onBusyChange(false);
    };
  }, []);

  function removeTransfer(id: string) {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    updateTransfers((items) => items.filter((item) => item.id !== id));
  }
  async function upload(item: Transfer) {
    if (latest.current.disabled) return;
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    updateTransfers((items) =>
      items.some((entry) => entry.id === item.id)
        ? items.map((entry) =>
            entry.id === item.id
              ? { ...entry, status: "uploading", error: undefined }
              : entry,
          )
        : [...items, item],
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45_000);
    try {
      const form = new FormData();
      form.append("file", item.file);
      const response = await apiFetch("/api/attachments", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: form,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : "文件上传失败，请重试。",
        );
      const attachment = attachmentSchema.parse(body.attachment);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        controllers.current.get(item.id) !== controller
      )
        return;
      latest.current.onAdd(attachment);
      updateTransfers((items) => items.filter((entry) => entry.id !== item.id));
    } catch (cause) {
      if (!mounted.current || controllers.current.get(item.id) !== controller)
        return;
      updateTransfers((items) =>
        items.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                status: "error",
                error: timedOut
                  ? "上传超时，请重试。"
                  : cause instanceof Error
                    ? cause.message
                    : "文件上传失败。",
              }
            : entry,
        ),
      );
    } finally {
      clearTimeout(timer);
      if (controllers.current.get(item.id) === controller)
        controllers.current.delete(item.id);
    }
  }
  function addFiles(files: File[]) {
    if (disabled) return;
    setError("");
    for (const file of files) {
      const message = validateUpload(file);
      if (message) {
        setError(`${file.name}：${message}`);
        continue;
      }
      if (
        latest.current.value.length + transferRef.current.length >=
        MAX_ATTACHMENTS
      ) {
        setError("每条消息最多添加 4 个附件，请先移除一项。");
        break;
      }
      void upload({ id: crypto.randomUUID(), file, status: "uploading" });
    }
  }
  return (
    <div
      className={`attachment-composer ${dragging ? "attachment-dragging" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="composer-media-actions">
        <button
          type="button"
          className="media-action"
          aria-label="添加图片或文档"
          disabled={
            disabled || value.length + transfers.length >= MAX_ATTACHMENTS
          }
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={16} />
          添加附件
        </button>
        <span className="attachment-format-hint">图片 / PDF / Word / 文本</span>
        {extraControls}
      </div>
      <input
        ref={fileInput}
        hidden
        type="file"
        multiple
        accept={acceptedFiles}
        data-testid="attachment-input"
        aria-label="选择图片或文档"
        disabled={disabled}
        onChange={(event) => {
          addFiles(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      {(value.length > 0 || transfers.length > 0) && (
        <div className="composer-attachments">
          {value.map((item) => (
            <AttachmentCard
              key={item.id}
              attachment={item}
              onRemove={disabled ? undefined : () => onRemove(item.id)}
            />
          ))}
          {transfers.map((item) => (
            <div
              className={`attachment-transfer ${item.status}`}
              key={item.id}
              data-testid="attachment-transfer"
            >
              {item.status === "uploading" && (
                <LoaderCircle size={16} className="spin" />
              )}
              <div>
                <strong>{item.file.name}</strong>
                <span>
                  {item.status === "uploading" ? "正在上传并解析…" : item.error}
                </span>
              </div>
              {item.status === "error" && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`重试上传：${item.file.name}`}
                  onClick={() => void upload(item)}
                  disabled={disabled}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`取消上传：${item.file.name}`}
                onClick={() => removeTransfer(item.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="media-error" role="alert">
          {error}
          <button
            type="button"
            aria-label="关闭附件错误"
            onClick={() => setError("")}
          >
            <X size={13} />
          </button>
        </p>
      )}
      {dragging && (
        <div className="attachment-drop-hint">松开以添加图片或文档</div>
      )}
      {children}
    </div>
  );
}

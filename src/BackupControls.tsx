import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Archive, Check, ChevronDown, Download, Upload, X } from "lucide-react";
import type { SavedState } from "./state";
import {
  applyImport,
  MAX_BACKUP_BYTES,
  parseBackup,
  planImport,
  serializeBackup,
  type ImportPreview,
} from "./backup";
import "./backup.css";

interface Props {
  getState: () => SavedState;
  onImport: (next: SavedState) => void;
  disabled: boolean;
  onToast?: (message: string) => void;
}

export default function BackupControls({
  getState,
  onImport,
  disabled,
  onToast,
}: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [panelLayout, setPanelLayout] = useState({
    maxHeight: 360,
    above: true,
  });
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const readVersion = useRef(0);
  useEffect(
    () => () => {
      readVersion.current++;
    },
    [],
  );

  function reset() {
    readVersion.current++;
    setPreview(null);
    setFileName("");
    setError("");
    setReading(false);
    if (input.current) input.current.value = "";
  }
  function positionPanel() {
    if (!panel.current?.open || !summary.current) return;
    const rect = summary.current.getBoundingClientRect();
    const above = rect.top - 22;
    const below = window.innerHeight - rect.bottom - 22;
    setPanelLayout({
      above: above >= below,
      maxHeight: Math.max(80, Math.min(590, Math.max(above, below))),
    });
  }
  useEffect(() => {
    const close = () => {
      if (panel.current) panel.current.open = false;
      reset();
    };
    const cancelFile = () => reset();
    const closeOutside = (event: PointerEvent) => {
      if (
        panel.current?.open &&
        event.target instanceof Node &&
        !panel.current.contains(event.target)
      )
        close();
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !panel.current?.open)
        return;
      event.preventDefault();
      event.stopPropagation();
      close();
      summary.current?.focus();
    };
    const control = input.current;
    control?.addEventListener("cancel", cancelFile);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape, true);
    window.addEventListener("resize", positionPanel);
    return () => {
      control?.removeEventListener("cancel", cancelFile);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape, true);
      window.removeEventListener("resize", positionPanel);
    };
  }, []);
  function download() {
    try {
      const state = getState();
      const blob = new Blob([serializeBackup(state)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `qianwen-chat-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError("");
      onToast?.(
        `已导出 ${state.conversations.length} 个会话，包含完整消息和草稿`,
      );
    } catch {
      setError("导出失败，请检查浏览器下载设置后重试。");
    }
  }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    reset();
    if (!file || disabled) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setError("备份文件超过 10 MB，请选择更小的文件。");
      return;
    }
    const version = readVersion.current;
    setReading(true);
    setFileName(file.name);
    try {
      const backup = parseBackup(await file.text());
      if (version !== readVersion.current || !panel.current?.open) return;
      setPreview(planImport(backup, getState()));
    } catch (cause) {
      if (version === readVersion.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "读取失败，请重新选择备份文件。",
        );
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }
  function confirm() {
    if (!preview || disabled || reading) return;
    try {
      const next = applyImport(getState(), preview.backup);
      onImport(next);
      const count = preview.conversationCount;
      reset();
      onToast?.(`已追加导入 ${count} 个会话`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "导入失败，请重新预览后重试。",
      );
    }
  }
  return (
    <details
      className="backup-controls"
      ref={panel}
      data-testid="backup-controls"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
          reset();
        }
      }}
      onToggle={(event) => {
        if (!event.currentTarget.open) reset();
        else {
          positionPanel();
          document
            .querySelectorAll<HTMLDetailsElement>(".reading-settings[open]")
            .forEach((other) => {
              other.open = false;
            });
        }
      }}
    >
      <summary ref={summary} aria-label="本地备份">
        <Archive size={15} />
        <span>本地备份</span>
        <ChevronDown size={14} />
      </summary>
      <div
        className="backup-content"
        style={{
          maxHeight: panelLayout.maxHeight,
          ...(panelLayout.above
            ? { bottom: "calc(100% + 9px)", top: "auto" }
            : { top: "calc(100% + 9px)", bottom: "auto" }),
        }}
      >
        <p>导出当前全部会话、消息与草稿。导入仅从本机文件追加恢复。</p>
        <div className="backup-buttons">
          <button type="button" onClick={download} aria-label="导出全部会话">
            <Download size={14} />
            导出 JSON
          </button>
          <button
            type="button"
            aria-label="选择备份文件"
            disabled={disabled || reading}
            onClick={() => {
              reset();
              input.current?.click();
            }}
          >
            <Upload size={14} />
            {reading ? "正在读取…" : "导入 JSON"}
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          aria-label="导入备份文件"
          data-testid="backup-file-input"
          hidden
          disabled={disabled}
          onChange={(event) => void selectFile(event)}
        />
        <p className="backup-limits">
          导入限制：10 MB；合计最多 50
          个会话，每个导入会话保留最近完整回合、最多 100
          条消息。导出不裁剪内存中的历史。
        </p>
        {disabled && <p className="backup-disabled">生成结束后可导入备份。</p>}
        {error && (
          <p className="backup-error" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <section
            className="backup-preview"
            data-testid="backup-preview"
            aria-label="备份导入预览"
          >
            <div className="backup-preview-title">
              <strong>导入预览</strong>
              <button type="button" aria-label="取消导入" onClick={reset}>
                <X size={14} />
              </button>
            </div>
            <p className="backup-file-name" title={fileName}>
              {fileName}
            </p>
            <dl>
              <div>
                <dt>新增会话</dt>
                <dd>{preview.conversationCount} 个</dd>
              </div>
              <div>
                <dt>备份消息</dt>
                <dd>{preview.originalMessageCount} 条</dd>
              </div>
              <div>
                <dt>将导入消息</dt>
                <dd>{preview.messageCount} 条</dd>
              </div>
              <div>
                <dt>容量裁剪</dt>
                <dd>{preview.trimmedMessageCount} 条</dd>
              </div>
              <div>
                <dt>导入后会话</dt>
                <dd>{preview.combinedConversationCount} 个</dd>
              </div>
            </dl>
            {preview.trimmedMessageCount > 0 && (
              <p className="backup-trim-notice">
                确认后将跳过 {preview.trimmedMessageCount}{" "}
                条较早消息，按完整提问回合保留。原始备份文件仍包含全部内容。
              </p>
            )}
            {preview.remapsIds && (
              <p>
                检测到会话标识重复，将为本次导入的全部会话分配新标识，并保留分支关系。
              </p>
            )}
            {preview.interruptedMessageCount > 0 && (
              <p>
                {preview.interruptedMessageCount}{" "}
                条未完成回复将标记为中断；工具不会重新执行。
              </p>
            )}
            <button
              type="button"
              className="backup-confirm"
              aria-label="确认导入备份"
              disabled={disabled || reading}
              onClick={confirm}
            >
              <Check size={14} />
              确认追加导入
            </button>
          </section>
        )}
      </div>
    </details>
  );
}

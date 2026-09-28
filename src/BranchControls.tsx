import { GitBranch, Pencil, RotateCcw, X } from "lucide-react";
import type { BranchOrigin } from "./branches";

export function EditMessageButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="edit-message-button"
      data-testid="edit-message"
      aria-label="编辑并重发"
      title={
        disabled ? "请先结束生成或取消当前编辑" : "编辑问题，在新分支中发送"
      }
      disabled={disabled}
      onClick={onClick}
    >
      <Pencil size={14} />
      <span>编辑并重发</span>
    </button>
  );
}

export function RegenerateButton({
  failed,
  disabled,
  onClick,
}: {
  failed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = failed ? "重新尝试" : "重新生成";
  return (
    <button
      className="regenerate-button"
      data-testid="regenerate-response"
      aria-label={label}
      title={
        disabled
          ? "请先结束生成或取消当前编辑"
          : `${label}，保留原回答并创建新分支`
      }
      disabled={disabled}
      onClick={onClick}
    >
      <RotateCcw size={14} />
      <span>{label}</span>
    </button>
  );
}

export function EditingBanner({
  title,
  onCancel,
}: {
  title: string;
  onCancel: () => void;
}) {
  return (
    <div className="editing-banner" data-testid="editing-banner" role="status">
      <Pencil size={16} />
      <div>
        <strong>编辑提问</strong>
        <span>发送后将从「{title}」创建新分支，原对话会保留。</span>
      </div>
      <button type="button" aria-label="取消编辑" onClick={onCancel}>
        <X size={14} />
        取消编辑
      </button>
    </div>
  );
}

export function BranchBanner({
  origin,
  available,
  onOpen,
}: {
  origin: BranchOrigin;
  available: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="branch-banner" data-testid="branch-origin">
      <GitBranch size={16} />
      <span>
        {origin.mode === "edit" ? "编辑分支" : "重新生成"} · 来源：
        {origin.title}
      </span>
      {available ? (
        <button onClick={onOpen}>查看原对话</button>
      ) : (
        <small>原对话已删除</small>
      )}
    </div>
  );
}

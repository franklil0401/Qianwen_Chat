import { useState } from "react";
import {
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  LoaderCircle,
  Search,
  XCircle,
  Wrench,
} from "lucide-react";
import type { ToolCall, ToolResult, KnowledgeItem } from "../shared/types";

type ResultProps = {
  result: ToolResult;
  onFollowUp: (item: KnowledgeItem) => void;
  onToast: (text: string) => void;
  onSearchAgain: (query: string) => void;
};
export async function copyText(value: string, onToast: (text: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
    onToast("已复制");
  } catch {
    onToast("复制失败，请手动选择文字复制");
  }
}
function CalculatorResult({ result, onToast }: ResultProps) {
  if (result.type !== "calculator") return null;
  return (
    <div className="calculation">
      <span>{result.expression}</span>
      <div>
        <strong>{String(result.value)}</strong>
        <button
          className="icon-button"
          aria-label="复制计算结果"
          title="复制结果"
          onClick={() => void copyText(String(result.value), onToast)}
        >
          <Copy size={15} />
        </button>
      </div>
    </div>
  );
}
function KnowledgeResult({ result, onFollowUp, onSearchAgain }: ResultProps) {
  if (result.type !== "knowledge") return null;
  return (
    <div className="knowledge-results">
      <div className="source-label">
        本地演示资料 · {result.items.length} 条结果
      </div>
      {result.items.length === 0 && (
        <div className="empty-tool-result">
          <Search size={20} />
          <p>没有找到与“{result.query}”匹配的资料</p>
          <span>试试「流式输出」「工具调用」或「打断」。</span>
          <button onClick={() => onSearchAgain(result.query)}>
            换个关键词 <span>↗</span>
          </button>
        </div>
      )}
      {result.items.map((item) => (
        <article className="knowledge-item" key={item.id}>
          <h4>
            <FileText size={16} />
            <span>{item.title}</span>
          </h4>
          <p className="knowledge-summary">{item.summary}</p>
          <div className="knowledge-source">来源：{item.source}</div>
          <div className="knowledge-actions">
            <details className="knowledge-original">
              <summary>
                查看原文
                <ChevronDown size={13} />
              </summary>
              <p className="knowledge-content">{item.content}</p>
            </details>
            <button className="follow-up" onClick={() => onFollowUp(item)}>
              基于这份资料追问 <span>↗</span>
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
const resultRenderers = {
  calculator: CalculatorResult,
  knowledge: KnowledgeResult,
};
const statusLabels: Record<ToolCall["status"], string> = {
  receiving: "接收参数",
  queued: "等待执行",
  running: "正在执行",
  success: "已完成",
  error: "执行失败",
  cancelled: "已取消",
};
export default function ToolCard({
  tool,
  onFollowUp,
  onToast,
  onSearchAgain,
}: {
  tool: ToolCall;
  onFollowUp: (item: KnowledgeItem) => void;
  onToast: (text: string) => void;
  onSearchAgain: (query: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pending = ["receiving", "queued", "running"].includes(tool.status);
  const Icon =
    tool.name === "calculate"
      ? Calculator
      : tool.name === "search_knowledge"
        ? Search
        : Wrench;
  const label =
    tool.name === "calculate"
      ? "计算器"
      : tool.name === "search_knowledge"
        ? "资料检索"
        : tool.name;
  const Renderer =
    tool.result && tool.result.type !== "error"
      ? resultRenderers[tool.result.type]
      : null;
  let prettyArguments = tool.arguments;
  try {
    prettyArguments = JSON.stringify(JSON.parse(tool.arguments), null, 2);
  } catch {
    /* Parameters can be incomplete while streaming. */
  }
  return (
    <section
      className={`tool-card tool-${tool.status}`}
      data-testid="tool-card"
      aria-label={`${label}工具卡片`}
    >
      <div className="tool-header">
        <span className="tool-icon">
          <Icon size={17} />
        </span>
        <strong>{label}</strong>
        <span className="tool-status">
          {pending ? (
            <LoaderCircle size={13} className="spin" />
          ) : tool.status === "success" ? (
            <CheckCircle2 size={13} />
          ) : (
            <XCircle size={13} />
          )}
          {statusLabels[tool.status]}
        </span>
      </div>
      {Renderer && tool.result && (
        <Renderer
          result={tool.result}
          onFollowUp={onFollowUp}
          onToast={onToast}
          onSearchAgain={onSearchAgain}
        />
      )}
      {(tool.error || tool.result?.type === "error") && (
        <p className="tool-error-message">
          {tool.error ||
            (tool.result?.type === "error" ? tool.result.message : "")}
        </p>
      )}
      {pending && (
        <p className="tool-progress">
          {tool.status === "receiving"
            ? "正在整理工具所需参数…"
            : tool.status === "queued"
              ? "准备就绪，等待执行…"
              : "正在处理，请稍候…"}
        </p>
      )}
      {tool.status === "cancelled" && (
        <p className="tool-progress">本次调用已停止，可以继续提问。</p>
      )}
      <button
        className="tool-details-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronDown size={13} className={expanded ? "rotated" : ""} />
        {expanded ? "收起调用详情" : "查看调用详情"}
        {tool.durationMs !== undefined && (
          <span>{(tool.durationMs / 1000).toFixed(2)} 秒</span>
        )}
      </button>
      {expanded && (
        <pre className="tool-arguments">
          <code>{prettyArguments || "正在接收参数…"}</code>
        </pre>
      )}
    </section>
  );
}

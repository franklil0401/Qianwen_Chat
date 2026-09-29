import { Children, isValidElement, memo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "./ToolCard";

function CodeBlock({
  children,
  onToast,
}: {
  children: ReactNode;
  onToast: (text: string) => void;
}) {
  const child = Children.toArray(children).find((node) =>
    isValidElement<{ className?: string; children?: ReactNode }>(node),
  );
  const code = isValidElement<{ className?: string; children?: ReactNode }>(
    child,
  )
    ? child
    : null;
  const language =
    /language-([\w+-]+)/.exec(code?.props.className || "")?.[1] || "代码";
  const content =
    typeof code?.props.children === "string"
      ? code.props.children.replace(/\n$/, "")
      : "";
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          aria-label="复制代码"
          onClick={() => void copyText(content, onToast)}
        >
          <Copy size={14} />
          复制代码
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const Markdown = memo(function Markdown({
  content,
  onToast,
}: {
  content: string;
  onToast: (text: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <CodeBlock onToast={onToast}>{children}</CodeBlock>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export default Markdown;

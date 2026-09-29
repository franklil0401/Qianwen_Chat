import { ChevronDown, ExternalLink, Globe2 } from "lucide-react";
import type { SearchSource } from "../shared/types";
import { secureSourceUrl } from "./multimodal";
export default function SearchSources({
  sources,
}: {
  sources?: SearchSource[];
}) {
  if (!sources?.length) return null;
  return (
    <details className="search-sources" data-testid="search-sources">
      <summary>
        <Globe2 size={15} />
        <span>参考了 {sources.length} 个网页来源</span>
        <ChevronDown size={14} />
      </summary>
      <ol>
        {sources.map((source, index) => {
          const url = secureSourceUrl(source.url);
          return (
            <li key={source.id}>
              <span className="search-source-index">{index + 1}</span>
              <div>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {source.title || source.siteName || new URL(url).hostname}
                    <ExternalLink size={12} />
                  </a>
                ) : (
                  <strong>
                    {source.title || source.siteName || "网页来源"}
                  </strong>
                )}
                {source.siteName && <small>{source.siteName}</small>}
                {source.snippet && <p>{source.snippet}</p>}
                {!url && <small>此来源未提供安全的 HTTPS 链接</small>}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

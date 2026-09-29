export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  content: string;
  source: string;
}

/** Public metadata only. Contents are resolved by the server for the current owner. */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'document';
  mimeType: string;
  size: number;
  previewUrl?: string;
  textPreview?: string;
  extractedCharacters?: number;
  truncated?: boolean;
}
export interface SearchSource {
  id: string;
  title: string;
  url: string;
  siteName?: string;
  snippet?: string;
}

export type ToolResult =
  | { type: 'calculator'; expression: string; value: number }
  | { type: 'knowledge'; query: string; items: KnowledgeItem[] }
  | { type: 'error'; message: string };

export type ToolStatus = 'receiving' | 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status: ToolStatus;
  result?: ToolResult;
  error?: string;
  durationMs?: number;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCall[];
  attachments?: Attachment[];
}

export interface ChatRequest {
  runId: string;
  conversationId: string;
  messageId: string;
  messages: HistoryMessage[];
  useTools: boolean;
  thinking: boolean;
  webSearch?: boolean;
}

export interface EventIdentity {
  runId: string;
  conversationId: string;
  messageId: string;
}
export type StreamEvent = EventIdentity & (
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'sources'; sources: SearchSource[] }
  | { type: 'tool-update'; tool: ToolCall }
  | { type: 'done'; reason: 'stop' | 'limit' }
  | { type: 'error'; error: string }
);

export interface HealthResponse {
  configured: boolean;
  model: string;
  tools: string[];
  capabilities?: {
    uploads: boolean;
    visionModel: string;
    asrModel: string;
    ttsModel: string;
    webSearch: boolean;
    accountSync: boolean;
    deployment: 'local' | 'server';
  };
}

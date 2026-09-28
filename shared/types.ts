export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  content: string;
  source: string;
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
}

export interface ChatRequest {
  runId: string;
  conversationId: string;
  messageId: string;
  messages: HistoryMessage[];
  useTools: boolean;
  thinking: boolean;
}

export interface EventIdentity {
  runId: string;
  conversationId: string;
  messageId: string;
}
export type StreamEvent = EventIdentity & (
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-update'; tool: ToolCall }
  | { type: 'done'; reason: 'stop' | 'limit' }
  | { type: 'error'; error: string }
);

export interface HealthResponse { configured: boolean; model: string; tools: string[] }

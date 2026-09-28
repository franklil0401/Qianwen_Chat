import type { HistoryMessage, ToolCall } from '../shared/types';

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';
export interface Message extends HistoryMessage {
  id: string;
  reasoning?: string;
  status: MessageStatus;
  error?: string;
  createdAt: number;
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}
export interface SavedState { version: 1; conversations: Conversation[]; activeId: string; useTools: boolean; thinking: boolean }
export const STORAGE_KEY = 'qianwen-workspace-v1';
export const createConversation = (): Conversation => ({ id: crypto.randomUUID(), title: '新对话', messages: [], updatedAt: Date.now() });

const isTool = (value: unknown): value is ToolCall => {
  if (!value || typeof value !== 'object') return false;
  const tool = value as ToolCall;
  return typeof tool.id === 'string' && typeof tool.name === 'string' && typeof tool.arguments === 'string'
    && ['receiving', 'queued', 'running', 'success', 'error', 'cancelled'].includes(tool.status);
};

export function restoreState(): SavedState {
  const initial = createConversation();
  const fallback: SavedState = { version: 1, conversations: [initial], activeId: initial.id, useTools: true, thinking: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 6_000_000) return fallback;
    const parsed = JSON.parse(raw) as SavedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) return fallback;
    const conversations = parsed.conversations.slice(0, 50).filter(c => c && typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages)).map(c => ({
      id: c.id, title: c.title.slice(0, 100), updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
      messages: c.messages.slice(-100).filter(m => m && typeof m.id === 'string' && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({
        ...m, content: m.content.slice(0, 100_000), reasoning: typeof m.reasoning === 'string' ? m.reasoning.slice(0, 100_000) : undefined,
        status: m.status === 'streaming' ? 'stopped' : ['done', 'stopped', 'error'].includes(m.status) ? m.status : 'done',
        tools: Array.isArray(m.tools) ? m.tools.filter(isTool).map(t => ({ ...t, status: ['receiving', 'queued', 'running'].includes(t.status) ? 'cancelled' : t.status })) : [],
      } as Message)),
    }));
    return conversations.length ? { version: 1, conversations, activeId: conversations.some(c => c.id === parsed.activeId) ? parsed.activeId : conversations[0].id, useTools: parsed.useTools !== false, thinking: parsed.thinking === true } : fallback;
  } catch { return fallback; }
}

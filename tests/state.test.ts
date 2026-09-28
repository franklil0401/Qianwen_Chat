import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshot, restoreState, type Conversation, type SavedState } from '../src/state';

const conversation = (id = 'conversation-1'): Conversation => ({ id, title: '测试对话', updatedAt: 1, messages: [{ id: 'user-1', role: 'user', content: '你好', status: 'done', createdAt: 1 }] });
const state = (conversations = [conversation()]): SavedState => ({ version: 1, conversations, activeId: conversations[0].id, thinking: false, useTools: true });
function stored(value: unknown) { vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) }); }
afterEach(() => vi.unstubAllGlobals());

describe('local history is an untrusted persistence boundary', () => {
  it('repairs malformed nested tool results, references and errors without preserving crashable fields', () => {
    const saved = state() as unknown as { conversations: { messages: unknown[] }[] };
    saved.conversations[0].messages.push({ id: 'answer-1', role: 'assistant', content: '保留的回复', status: 'done', createdAt: 1, error: { invalid: true }, tools: [{ id: 'tool-1', name: 'search_knowledge', arguments: '{}', status: 'success', result: { type: 'knowledge', query: '流式', items: {} } }] });
    saved.conversations[0].messages.push({ id: 'user-2', role: 'user', content: '继续提问', status: 'done', sources: {}, createdAt: 2 });
    stored(saved);
    const recovered = restoreState();
    const messages = recovered.conversations[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toBe('保留的回复');
    expect(messages[1].error).toBeUndefined();
    expect(messages[1].tools?.[0]).toMatchObject({ status: 'error', result: { type: 'error' } });
    expect(messages[2].sources).toBeUndefined();
    expect(recovered.recoveryNotice).toContain('数据损坏');
  });
  it('restores unfinished output as interrupted and never reruns pending tools', () => {
    const saved = state();
    saved.conversations[0].messages.push({ id: 'answer-1', role: 'assistant', content: '尚未完成', status: 'streaming', createdAt: 1, tools: [{ id: 'tool-1', name: 'calculate', arguments: '{', status: 'receiving' }] });
    stored(saved);
    const message = restoreState().conversations[0].messages[1];
    expect(message.status).toBe('stopped');
    expect(message.tools?.[0].status).toBe('cancelled');
    expect(message.content).toBe('尚未完成');
  });
  it('keeps the active conversation when more than 50 have been saved', () => {
    const saved = state(Array.from({ length: 51 }, (_, i) => ({ ...conversation(`c${i}`), updatedAt: i })));
    saved.activeId = 'c0';
    stored(saved);
    const recovered = restoreState();
    expect(recovered.activeId).toBe('c0');
    expect(recovered.conversations).toHaveLength(50);
    expect(recovered.conversations.some(item => item.id === 'c50')).toBeTruthy();
    expect(recovered.conversations.some(item => item.id === 'c1')).toBeFalsy();
    expect(createSnapshot(saved).conversations.map(item => item.id)).toEqual(recovered.conversations.map(item => item.id));
  });
  it('keeps valid source contents across a persistence round trip', () => {
    const saved = state();
    saved.conversations[0].messages[0].sources = [{ id: 'streaming', title: '流式', summary: '摘要', source: '本地资料', content: '真实原文' }];
    stored(createSnapshot(saved));
    expect(restoreState().conversations[0].messages[0].sources).toEqual(saved.conversations[0].messages[0].sources);
  });
  it('handles invalid JSON and blocked storage with a usable new conversation', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{broken' });
    expect(restoreState().conversations).toHaveLength(1);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage unavailable'); } });
    expect(restoreState().recoveryNotice).toContain('仍可正常聊天');
  });
  it('snapshot trimming starts at a complete user turn and excludes transient recovery notices', () => {
    const saved = state();
    saved.recoveryNotice = '仅本次显示';
    saved.conversations[0].messages = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}`, status: 'done', createdAt: i }));
    const snapshot = createSnapshot(saved);
    expect(snapshot.conversations[0].messages.length).toBeLessThanOrEqual(100);
    expect(snapshot.conversations[0].messages[0].role).toBe('user');
    expect(snapshot.conversations[0].messages.at(-1)?.content).toBe('消息100');
    expect(snapshot.recoveryNotice).toBeUndefined();
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chatSchema, createApp } from '../server/app';
import { buildContext } from '../server/provider';
import { prepareHistory } from '../src/history';
import type { ChatRequest, HistoryMessage, SearchSource } from '../shared/types';

const source: SearchSource = { id: '1', title: '最初的网页', url: 'https://example.com/original', siteName: '资料站', snippet: '这段摘要来自上一轮保存的搜索结果。' };
const messages: HistoryMessage[] = [
  { role: 'user', content: '搜索相关资料' },
  { role: 'assistant', content: '找到这份资料。[1]', searchSources: [source] },
  { role: 'user', content: '给我刚才第一个来源链接，不要重新搜索' },
];
const request: ChatRequest = { runId: 'r', conversationId: 'c', messageId: 'm', useTools: false, thinking: false, webSearch: false, messages };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); } });

describe('search sources in follow-up history', () => {
  it('carries retained source links through the HTTP schema to the actual provider without claiming a fresh search', async () => {
    let providerBody = '';
    const app = createApp({ apiKey: 'controlled-placeholder', inMemoryAccounts: true, fetch: (async (_url, init) => {
      providerBody = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"这是上一轮保留的链接。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch });
    const server = createServer(app); servers.push(server); server.once('close', () => app.locals.dispose());
    await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, messages: prepareHistory(messages) }) });
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain('"type":"done"');
    expect(events).not.toContain('"type":"sources"');
    expect(providerBody).toContain(source.url);
    expect(providerBody).toContain(source.snippet);
    expect(providerBody).toContain('本轮未重新检索或读取网页全文');
    expect(JSON.parse(providerBody).enable_search).not.toBe(true);
    const answer = JSON.parse(providerBody).messages.find((item: { role: string }) => item.role === 'assistant');
    expect(answer.content).toContain('找到这份资料。[1]');
    expect(answer.content).toContain('"number":1');
  });

  it('keeps repeated citation numbers scoped to their own answer and retains source-only interrupted messages', () => {
    const previous = { ...source, url: 'https://example.com/second' };
    const history: HistoryMessage[] = [...messages, { role: 'assistant', content: '', searchSources: [previous] }, { role: 'user', content: '分别列出两轮来源' }];
    const answers = buildContext(history).filter(message => message.role === 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers[0].content).toContain(source.url);
    expect(answers[0].content).not.toContain(previous.url);
    expect(answers[1].content).toContain(previous.url);
    expect(answers[1].content).not.toContain(source.url);
    expect(answers.every(answer => String(answer.content).includes('"number":1'))).toBe(true);
  });

  it('validates retained metadata and rejects excessive, unsafe and credential-bearing URLs', () => {
    expect(chatSchema.parse(request).messages[1]).toMatchObject({ searchSources: [source] });
    const withSources = (searchSources: SearchSource[]) => ({ ...request, messages: [messages[0], { ...messages[1], searchSources }, messages[2]] });
    expect(chatSchema.safeParse(withSources(Array.from({ length: 21 }, () => source))).success).toBe(false);
    for (const url of ['javascript:alert(1)', 'file:///secret', 'https://username:password@example.com']) expect(chatSchema.safeParse(withSources([{ ...source, url }])).success).toBe(false);
  });

  it('counts UTF-8 source metadata in transport and context budgets and drops complete old turns', () => {
    const enriched: HistoryMessage[] = [messages[0], { ...messages[1], searchSources: [{ ...source, snippet: '中文来源'.repeat(400) }] }, messages[2]];
    const exactBytes = new TextEncoder().encode(JSON.stringify(enriched)).byteLength;
    expect(prepareHistory(enriched, exactBytes)).toEqual(enriched);
    expect(prepareHistory(enriched, exactBytes - 1)).toEqual([messages[2]]);
    const context = buildContext(enriched, 300);
    expect(context).toHaveLength(2);
    expect(context[1]).toEqual(messages[2]);
    expect(enriched[1].searchSources?.[0].snippet).toHaveLength(1600);
  });
});

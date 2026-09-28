import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chatSchema, createApp } from '../server/app';
import { runChat } from '../server/provider';
import { readSSE } from '../shared/sse';
import type { ChatRequest, StreamEvent, ToolCall } from '../shared/types';

const request: ChatRequest = { runId: 'recovery', conversationId: 'conversation', messageId: 'message', messages: [{ role: 'user', content: '调用工具' }], useTools: true, thinking: false };
const config = { apiKey: 'test-placeholder', model: 'controlled', baseUrl: 'https://example.invalid/v1' };
function response(deltas: unknown[], finishReason: string) {
  const chunks = deltas.map(delta => ({ choices: [{ delta, finish_reason: null as string | null }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: finishReason }] });
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
}

describe('strict provider completion', () => {
  it.each(['unexpected_reason', 'function_call', ''])('rejects unsupported finish_reason %j without false completion', async reason => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => response([{ content: '这只是中间说明' }], reason)) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('未知的结束原因');
    expect(events.some(event => event.type === 'text-delta')).toBe(true);
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('rejects tool_calls completion without calls instead of accepting intermediate text as the final answer', async () => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => response([{ content: '我将执行工具' }], 'tool_calls')) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('未返回调用内容');
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('marks pending tools failed on an invalid finish reason without executing them', async () => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => response([{ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] }], 'unexpected_reason')) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('未知的结束原因');
    expect(events.filter(event => event.type === 'tool-update').at(-1)).toMatchObject({ tool: { status: 'error' } });
    expect(events.some(event => event.type === 'tool-update' && ['running', 'success'].includes(event.tool.status))).toBe(false);
  });
});

describe('bounded tool error records', () => {
  it.each(['arguments', 'name'] as const)('retains the previous safe %s when a subsequent delta exceeds its limit', async field => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => response([
      { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'calculate', arguments: '{"expression":' } }] },
      { tool_calls: [{ index: 0, function: { [field]: 'x'.repeat(field === 'arguments' ? 8_001 : 101) } }] },
    ], 'tool_calls')) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('工具参数超过限制');
    const updates = events.filter(event => event.type === 'tool-update');
    expect(updates.at(-1)).toMatchObject({ tool: { status: 'error', name: 'calculate', arguments: '{"expression":' } });
    expect(updates.every(event => event.tool.arguments.length <= 8000 && event.tool.name.length <= 100)).toBe(true);
    expect(updates.some(event => event.tool.status === 'running')).toBe(false);
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('continuing after a streamed tool error', () => {
  it('accepts the saved error card and completes the next question instead of returning HTTP 400', async () => {
    const args = `{"query":"${'资料'.repeat(4200)}"}`;
    let providerCalls = 0;
    const fetcher = (async () => ++providerCalls === 1 ? response([
      { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'search_knowledge', arguments: args.slice(0, 100) } }] },
      { tool_calls: [{ index: 0, function: { arguments: args.slice(100) } }] },
    ], 'tool_calls') : response([{ content: '可以继续提问。' }], 'stop')) as typeof fetch;
    const server = createServer(createApp({ ...config, fetch: fetcher }));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
    const send = (body: ChatRequest) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await send(request);
    expect(first.status).toBe(200);
    const events: StreamEvent[] = [];
    for await (const data of readSSE(first.body!)) events.push(JSON.parse(data) as StreamEvent);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: '千问工具参数超过限制。' });
    const card = events.filter(event => event.type === 'tool-update').at(-1)?.tool as ToolCall;
    expect(card.status).toBe('error');
    expect(card.arguments.length).toBe(100);

    const next: ChatRequest = { ...request, runId: 'recovery-next', messageId: 'message-next', messages: [...request.messages, { role: 'assistant', content: '', tools: [card] }, { role: 'user', content: '继续提问' }] };
    expect(chatSchema.safeParse(next).success).toBe(true);
    const second = await send(next);
    expect(second.status).toBe(200);
    const result = await second.text();
    expect(result).toContain('可以继续提问。');
    expect(result).toContain('"type":"done"');
    expect(providerCalls).toBe(2);
  });
});

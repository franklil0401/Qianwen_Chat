import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { prepareHistory } from '../src/history';
import type { ChatRequest, HistoryMessage, ToolCall } from '../shared/types';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string): HistoryMessage => ({ role: 'assistant', content });
const tool: ToolCall = {
  id: 'completed-tool', name: 'calculate', arguments: '{"expression":"2+3"}', status: 'success',
  result: { type: 'calculator', expression: '2+3', value: 5 },
};

describe('history transport budget', () => {
  it('handles empty history and drops leading orphan assistant messages', () => {
    expect(prepareHistory([])).toEqual([]);
    expect(prepareHistory([assistant('orphan')])).toEqual([]);
    expect(prepareHistory([assistant('orphan'), user('最新问题')])).toEqual([user('最新问题')]);
  });

  it('preserves the latest question and keeps only complete recent turns', () => {
    const newest = user('最新问题');
    const previous = [user('上个问题'), assistant('完整回答')];
    const input = [user('更早问题'), assistant('更早回答'), ...previous, newest];
    expect(prepareHistory(input, bytes([...previous, newest]))).toEqual([...previous, newest]);
    expect(prepareHistory(input, bytes([newest]))).toEqual([newest]);
    expect(input).toHaveLength(5);
  });

  it('measures serialized UTF-8 bytes including emoji, escaping and citations', () => {
    const latest = user('解释 🧑‍💻 与中文\n引用原文："上下文完整性"');
    const exactSize = bytes([latest]);
    expect(exactSize).toBeGreaterThan(JSON.stringify([latest]).length);
    expect(prepareHistory([latest], exactSize)).toEqual([latest]);
    expect(() => prepareHistory([latest], exactSize - 1)).toThrow('当前问题与所选资料超出发送大小限制');
    expect(latest.content).toContain('🧑‍💻');
  });

  it('keeps tool groups unchanged or excludes their entire user turn', () => {
    const toolTurn: HistoryMessage[] = [user('计算一下'), { role: 'assistant', content: '结果是 5', tools: [tool] }];
    const latest = user('继续');
    const entire = [...toolTurn, latest];
    expect(prepareHistory(entire, bytes(entire))).toEqual(entire);
    expect(prepareHistory(entire, bytes(entire) - 1)).toEqual([latest]);
    expect(prepareHistory(entire)[1].tools?.[0]).toBe(tool);
  });

  it('stops at an oversized older turn instead of cutting or skipping its contents', () => {
    const latest = user('最新问题');
    const previous = [user('上个问题'), assistant('简短回答')];
    const input = [user('很早的问题'), assistant('很早的回答'), user('过大的旧回合'), assistant('长'.repeat(5000)), ...previous, latest];
    expect(prepareHistory(input, 1000)).toEqual([...previous, latest]);
  });

  it('enforces the message count without leaving an orphan assistant or half a turn', () => {
    const input: HistoryMessage[] = [];
    for (let index = 0; index < 45; index++) input.push(user(`问题${index}`), assistant(`回答${index}`));
    input.push(user('最新问题'));
    const output = prepareHistory(input);
    expect(output).toHaveLength(79);
    expect(output[0]).toEqual(user('问题6'));
    expect(output.at(-1)).toEqual(user('最新问题'));
    expect(prepareHistory(input, 220_000, 1)).toEqual([user('最新问题')]);
    const turnWithTwoReplies = [user('问题'), assistant('先解释'), assistant('再补充'), user('继续')];
    expect(prepareHistory(turnWithTwoReplies, 220_000, 4)).toEqual(turnWithTwoReplies);
    expect(prepareHistory(turnWithTwoReplies, 220_000, 3)).toEqual([user('继续')]);
  });

  it('rejects invalid limits and a request that does not end with a user prompt', () => {
    expect(() => prepareHistory([user('问题')], 1)).toThrow('预算配置无效');
    expect(() => prepareHistory([user('问题')], 220_000, 0)).toThrow('预算配置无效');
    expect(() => prepareHistory([user('问题'), assistant('回答')])).toThrow('最后一条消息必须是用户问题');
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('long Chinese conversation integration', () => {
  it('reduces the reproduced 303396-byte request and reaches the provider instead of HTTP 413', async () => {
    const messages: HistoryMessage[] = [];
    for (let index = 0; index < 12; index++) {
      messages.push(user(`问题${index}`), assistant('这是之前已经完成的中文回答。'.repeat(600)));
    }
    messages.push(user('请继续'));
    const request: ChatRequest = { runId: 'long-history', conversationId: 'review', messageId: 'reply', messages, useTools: true, thinking: false };
    expect(bytes(request)).toBe(303_396);

    let providerCalls = 0;
    const fetcher = (async () => {
      providerCalls++;
      return new Response('data: {"choices":[{"delta":{"content":"已保留最近完整上下文。"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch;
    const server = createServer(createApp({ apiKey: 'test-placeholder', fetch: fetcher }));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
    const send = (body: ChatRequest) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const oversized = await send(request);
    expect(oversized.status).toBe(413);
    await oversized.body?.cancel();
    expect(providerCalls).toBe(0);

    const prepared = prepareHistory(messages);
    expect(bytes(prepared)).toBeLessThan(220_000);
    expect(prepared.length).toBeLessThan(messages.length);
    expect(prepared[0].role).toBe('user');
    expect(prepared.at(-1)).toEqual(user('请继续'));
    const trimmed = { ...request, messages: prepared };
    expect(bytes(trimmed)).toBeLessThan(220_000);
    const response = await send(trimmed);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('已保留最近完整上下文。');
    expect(stream).toContain('"type":"done"');
    expect(providerCalls).toBe(1);
  });
});

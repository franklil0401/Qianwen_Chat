import { describe, expect, it } from 'vitest';
import { buildContext, runChat } from '../server/provider.ts';
import type { ChatRequest, HistoryMessage, StreamEvent, ToolCall } from '../shared/types.ts';

const request: ChatRequest = { runId: 'run', conversationId: 'conversation', messageId: 'message', messages: [{ role: 'user', content: '计算 2+3' }], useTools: true, thinking: false };
const config = { apiKey: 'test-secret', model: 'qwen-plus', baseUrl: 'https://example.invalid/v1' };
function streamResponse(deltas: unknown[], ending: string | null = 'stop') {
  const chunks = deltas.map(delta => ({ choices: [{ delta, finish_reason: null }] }));
  if (ending) chunks.push({ choices: [{ delta: {}, finish_reason: ending }] } as never);
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (ending ? 'data: [DONE]\n\n' : '');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
const complete: ToolCall = { id: 'complete', name: 'calculate', arguments: '{"expression":"2+3"}', status: 'success', result: { type: 'calculator', expression: '2+3', value: 5 } };

describe('context rebuilding', () => {
  it('keeps complete call/result pairs and excludes unfinished tools', () => {
    const messages: HistoryMessage[] = [{ role: 'user', content: 'first' }, { role: 'assistant', content: '5', tools: [complete, { ...complete, id: 'interrupted', status: 'cancelled', result: undefined }] }, { role: 'user', content: 'continue' }];
    const context = buildContext(messages);
    const calls = context.flatMap(message => message.tool_calls ?? []);
    expect(calls.map(call => call.id)).toEqual(['complete']);
    expect(context.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['complete']);
    expect(context.at(-1)).toEqual({ role: 'user', content: 'continue' });
  });
  it('trims full turns and never leaves orphan tool messages', () => {
    const context = buildContext([{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: '5', tools: [complete] }, { role: 'user', content: 'new question' }], 200);
    expect(context).toHaveLength(2);
    expect(context[1].content).toBe('new question');
    const oversized = buildContext([{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: '', tools: [complete] }], 300);
    expect(oversized).toHaveLength(2);
    expect(oversized[1].role).toBe('user');
  });
  it('excludes partial arguments marked failed by an interrupted response', () => {
    const context = buildContext([{ role: 'user', content: 'calculate' }, { role: 'assistant', content: '', tools: [{ ...complete, status: 'error', arguments: '{"expression":', result: { type: 'error', message: '调用未完成' } }] }, { role: 'user', content: 'continue' }]);
    expect(context.some(message => message.tool_calls || message.role === 'tool')).toBe(false);
  });
});

describe('provider streaming and tool loop', () => {
  it('assembles split tool arguments, executes, and sends paired results to the model', async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: StreamEvent[] = [];
    const fetcher = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? streamResponse([
        { reasoning_content: '需要计算' },
        { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'calculate', arguments: '{"expression":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '"2+3"}' } }] },
      ], 'tool_calls') : streamResponse([{ content: '结果' }, { content: '是 5。' }]);
    }) as typeof fetch;
    await runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event));
    expect(bodies).toHaveLength(2);
    const secondMessages = bodies[1].messages as { role: string; tool_call_id?: string; content: string }[];
    expect(secondMessages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-a' });
    expect(JSON.parse(secondMessages.at(-1)!.content)).toMatchObject({ type: 'calculator', value: 5 });
    const updates = events.filter(event => event.type === 'tool-update');
    expect(new Set(updates.map(event => event.tool.id)).size).toBe(1);
    expect(updates.map(event => event.tool.status)).toEqual(['receiving', 'receiving', 'queued', 'running', 'success']);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
    expect(events.some(event => event.type === 'reasoning-delta')).toBe(true);
  });
  it('handles all calls in a response including invalid parameters', async () => {
    let count = 0;
    const events: StreamEvent[] = [];
    const fetcher = (async () => ++count === 1 ? streamResponse([{ tool_calls: [
      { index: 0, id: 'a', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } },
      { index: 1, id: 'b', function: { name: 'calculate', arguments: 'invalid' } },
    ] }], 'tool_calls') : streamResponse([{ content: '第一个计算完成，第二个参数无效。' }])) as typeof fetch;
    await runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event));
    expect(events.filter(event => event.type === 'tool-update' && ['success', 'error'].includes(event.tool.status)).map(event => event.type === 'tool-update' && event.tool.status)).toEqual(['success', 'error']);
    expect(count).toBe(2);
  });
  it('stops when tool limits are reached without executing extra tools', async () => {
    let count = 0;
    const events: StreamEvent[] = [];
    const fetcher = (async () => { count++; return streamResponse([{ tool_calls: [{ index: 0, id: `a${count}`, function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] }], 'tool_calls'); }) as typeof fetch;
    await runChat(request, { ...config, fetch: fetcher, maxToolCalls: 1 }, new AbortController().signal, event => events.push(event));
    expect(count).toBe(2);
    expect(events.filter(event => event.type === 'tool-update' && event.tool.status === 'success')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'limit' });
  });
  it('never executes truncated tool arguments', async () => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => streamResponse([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] }], null)) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('提前结束');
    expect(events.some(event => event.type === 'tool-update' && event.tool.status === 'running')).toBe(false);
  });
  it('honors cancellation before starting another tool or provider call', async () => {
    const controller = new AbortController();
    let count = 0;
    const fetcher = (async () => { count++; return streamResponse([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] }], 'tool_calls'); }) as typeof fetch;
    const events: StreamEvent[] = [];
    await expect(runChat(request, { ...config, fetch: fetcher }, controller.signal, event => { events.push(event); if (event.type === 'tool-update' && event.tool.status === 'success') controller.abort(); })).rejects.toBeDefined();
    expect(count).toBe(1);
    expect(events.some(event => event.type === 'done')).toBe(false);
  });
  it('does not expose upstream response bodies or API credentials in errors', async () => {
    const fetcher = (async () => new Response('test-secret private upstream detail', { status: 401 })) as typeof fetch;
    await expect(runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, () => {})).rejects.toThrow('鉴权失败');
    try { await runChat(request, { ...config, fetch: fetcher }, new AbortController().signal, () => {}); } catch (error) { expect(String(error)).not.toContain('test-secret'); }
  });
});

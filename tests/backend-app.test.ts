import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chatSchema, createApp, type AppOptions } from '../server/app.ts';

const servers: Server[] = [];
const clients = new Map<string, string>();
const request = { runId: 'run', conversationId: 'conversation', messageId: 'message', messages: [{ role: 'user', content: '你好' }], useTools: true, thinking: false };
async function serve(options: AppOptions = {}) {
  const app = createApp({ apiKey: 'test-secret', inMemoryAccounts: true, ...options });
  const server = createServer(app);
  server.once('close', () => app.locals.dispose());
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/account/session`);
  clients.set(base, session.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '));
  return base;
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
function cancellableProvider() {
  let resolveAbort!: (reason: unknown) => void;
  let resolveStarted!: () => void;
  const aborted = new Promise<unknown>(resolve => { resolveAbort = resolve; });
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const fetcher = (async (_url, init) => {
    const signal = init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      signal!.addEventListener('abort', () => { resolveAbort(signal!.reason); try { controller.error(signal!.reason); } catch {} }, { once: true });
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开始"},"finish_reason":null}]}\n\n'));
      resolveStarted();
    } });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetcher, aborted, started };
}
const post = (url: string, body = request, signal?: AbortSignal) => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: clients.get(url) || '' }, body: JSON.stringify(body), signal });

describe('local API', () => {
  it('accepts long prior assistant answers while bounding user input', () => {
    expect(chatSchema.safeParse({ ...request, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'a'.repeat(20_000) }, ...request.messages] }).success).toBe(true);
    expect(chatSchema.safeParse({ ...request, messages: [{ role: 'user', content: 'a'.repeat(16_001) }] }).success).toBe(false);
  });
  it('reports health without exposing credentials and validates input', async () => {
    const base = await serve();
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health).toMatchObject({ configured: true, model: 'qwen-plus', tools: ['calculate', 'search_knowledge'] });
    expect(JSON.stringify(health)).not.toContain('test-secret');
    expect((await post(base, { ...request, messages: [] })).status).toBe(400);
    expect((await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const missing = await serve({ apiKey: '' });
    expect((await post(missing)).status).toBe(503);
  });
  it('explicit cancel aborts the actual provider AbortSignal', async () => {
    const provider = cancellableProvider();
    const base = await serve({ fetch: provider.fetcher });
    const response = await post(base);
    await provider.started;
    const cancelled = await fetch(`${base}/api/runs/run/cancel`, { method: 'POST', headers: { Cookie: clients.get(base) || '' } });
    expect(await cancelled.json()).toEqual({ cancelled: true });
    await expect(provider.aborted).resolves.toMatchObject({ name: 'AbortError' });
    await response.text();
  });
  it('HTTP client disconnect aborts the actual provider AbortSignal', async () => {
    const provider = cancellableProvider();
    const base = await serve({ fetch: provider.fetcher });
    const client = new AbortController();
    const response = await post(base, request, client.signal);
    await provider.started;
    client.abort();
    await expect(provider.aborted).resolves.toMatchObject({ name: 'AbortError' });
    await response.body?.cancel().catch(() => undefined);
  });
  it('request timeout cancels upstream and sends a useful SSE error', async () => {
    const provider = cancellableProvider();
    const base = await serve({ fetch: provider.fetcher, requestTimeoutMs: 30 });
    const response = await post(base);
    const result = await response.text();
    await expect(provider.aborted).resolves.toMatchObject({ name: 'TimeoutError' });
    expect(result).toContain('本轮请求超时');
    expect(result).not.toContain('test-secret');
  });
});

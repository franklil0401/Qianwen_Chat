import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const body = { runId: 'same-run-id', conversationId: 'conv', messageId: 'm1', useTools: false, thinking: false, messages: [{ role: 'user', content: '持续回答' }] };
async function serve() {
  const signals: AbortSignal[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal);
    const signal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => { try { controller.error(signal.reason); } catch {} });
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开始"},"finish_reason":null}]}\n\n'));
    } }));
  }) as typeof fetch;
  const app = createApp({ apiKey: 'controlled', fetch: fetcher, inMemoryAccounts: true });
  const server = createServer(app);
  server.once('close', () => app.locals.dispose());
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const guest = async () => { const res = await fetch(`${base}/api/account/session`); return res.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); };
  const post = (cookie: string, runId = body.runId) => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...body, runId }) });
  const cancel = (cookie: string, runId = body.runId) => fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: { Cookie: cookie } });
  return { base, signals, guest, post, cancel };
}

describe('request ownership', () => {
  it('does not race the first session cookie when health and identity load together', async () => {
    const service = await serve();
    const [health, session] = await Promise.all([fetch(`${service.base}/api/health`), fetch(`${service.base}/api/account/session`)]);
    expect(health.status).toBe(200);
    expect(health.headers.getSetCookie()).toEqual([]);
    expect(session.headers.getSetCookie()).toHaveLength(1);
    expect(session.headers.getSetCookie()[0]).toMatch(/^qianwen_guest=/);
  });

  it('isolates overlapping run IDs and cancellation between browser identities', async () => {
    const service = await serve();
    const first = await service.guest(); const second = await service.guest();
    expect(first).not.toBe(second);
    const a = await service.post(first); const b = await service.post(second);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    await expect.poll(() => service.signals.length).toBe(2);
    expect(service.signals[0].aborted).toBe(false);
    expect((await service.post(first)).status).toBe(409);
    expect(await (await service.cancel(first)).json()).toEqual({ cancelled: true });
    await expect.poll(() => service.signals[0].aborted).toBe(true);
    expect(service.signals[1].aborted).toBe(false);
    expect(await (await service.cancel(first)).json()).toEqual({ cancelled: false });
    await service.cancel(second); await a.text(); await b.text();
  });

  it('rejects stale displayed-account headers before a model call and blocks foreign origins', async () => {
    const service = await serve(); const cookie = await service.guest();
    const stale = await fetch(`${service.base}/api/chat`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Qianwen-Account': 'not-the-cookie-user' }, body: JSON.stringify(body) });
    expect(stale.status).toBe(409); expect((await stale.json()).code).toBe('identity_changed');
    expect(service.signals).toHaveLength(0);
    const foreign = await fetch(`${service.base}/api/attachments`, { method: 'POST', headers: { Origin: 'https://foreign.example' } });
    expect(foreign.status).toBe(403);
    const localForeignPort = await fetch(`${service.base}/api/account/session`, { headers: { Origin: 'http://localhost:8765' } });
    expect(localForeignPort.status).toBe(403);
  });
});

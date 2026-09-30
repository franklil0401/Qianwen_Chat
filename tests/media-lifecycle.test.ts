import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { textPdf } from './media-fixtures';

const parserProcesses = vi.hoisted(() => [] as { child: ChildProcess; exited: Promise<void> }[]);
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: (...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args);
    const exited = new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()); child.once('error', () => resolveExit()); });
    parserProcesses.push({ child, exited });
    return child;
  } };
});

const instances: { server: Server; app: ReturnType<typeof createApp>; dataDir: string }[] = [];
const testRoot = resolve('.local');
async function serve(fetcher?: typeof fetch) {
  await mkdir(testRoot, { recursive: true });
  const dataDir = await mkdtemp(resolve(testRoot, 'media-lifecycle-'));
  const app = createApp({ apiKey: 'controlled-placeholder', inMemoryAccounts: true, dataDir, fetch: fetcher });
  const server = createServer(app);
  instances.push({ server, app, dataDir });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return { app, dataDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}

afterEach(async () => {
  for (const { server, app, dataDir } of instances.splice(0)) {
    app.locals.dispose(); server.closeAllConnections();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
    if (!dataDir.startsWith(resolve(testRoot, 'media-lifecycle-'))) throw new Error('Unexpected cleanup path');
    await rm(dataDir, { recursive: true, force: true });
  }
  for (const { child, exited } of parserProcesses.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
});

describe('media lifecycle during application shutdown', () => {
  it('aborts ASR and TTS upstream requests without relying on browser socket closure', async () => {
    const signals: AbortSignal[] = [];
    const service = await serve((async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch);
    const form = new FormData(); form.append('file', new Blob([Buffer.from('RIFF0000WAVE0000')]), 'recording.wav');
    const asr = fetch(`${service.base}/audio/transcriptions`, { method: 'POST', body: form });
    const tts = fetch(`${service.base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '正在朗读' }) });
    await expect.poll(() => signals.length).toBe(2);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    service.app.locals.dispose(); service.app.locals.dispose();
    expect(signals.every(signal => signal.aborted && signal.reason.name === 'AbortError')).toBe(true);
    const responses = await Promise.all([asr, tts]);
    expect(responses.map(response => response.status)).toEqual([503, 503]);
    expect(await responses[0].json()).toEqual({ error: '服务已停止，请重新启动应用。' });
    const rejected = await fetch(`${service.base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '不能新建请求' }) });
    expect(rejected.status).toBe(503);
    expect((await fetch(`${service.base}/account/session`)).status).toBe(503);
    expect(signals).toHaveLength(2);
  });

  it('terminates a real document parser process and does not save its cancelled upload', async () => {
    const service = await serve();
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(textPdf())]), 'pending.pdf');
    const response = fetch(`${service.base}/attachments`, { method: 'POST', body: form });
    await expect.poll(() => parserProcesses.length, { interval: 1 }).toBe(1);
    const parser = parserProcesses[0];
    expect(parser.child.pid).toBeGreaterThan(0);
    expect(parser.child.exitCode).toBeNull();
    service.app.locals.dispose();
    expect((await response).status).toBe(503);
    await parser.exited;
    expect(() => process.kill(parser.child.pid!, 0)).toThrow();
    const uploads = await readdir(resolve(service.dataDir, 'uploads'), { recursive: true }).catch(() => []);
    expect(uploads.some(file => file.endsWith('.bin') || file.endsWith('.json'))).toBe(false);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { documentWorkerConfig } from '../server/media';

const token = 'controlled-desktop-token-never-rendered';
const tokenHeaders = { 'X-Qianwen-Desktop-Token': token };
const instances: { server: Server; directory: string }[] = [];
const testRoot = resolve('.local');
async function serve(desktop = true) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(resolve(testRoot, 'desktop-server-'));
  await mkdir(resolve(directory, 'assets'));
  await writeFile(resolve(directory, 'index.html'), '<!doctype html><title>Desktop fixture</title><script src="/assets/main.js"></script>');
  await writeFile(resolve(directory, 'assets/main.js'), 'window.desktopFixture = true;');
  const app = createApp({ apiKey: 'controlled-placeholder', inMemoryAccounts: true, staticDir: directory, ...(desktop ? { desktopToken: token } : {}) });
  const server = createServer(app); server.once('close', () => app.locals.dispose());
  instances.push({ server, directory });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const { server, directory } of instances.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
    if (!directory.startsWith(resolve(testRoot, 'desktop-server-'))) throw new Error('Unexpected cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('desktop local service boundary', () => {
  it('denies missing or incorrect tokens before all static and API routes without creating an identity', async () => {
    const base = await serve();
    for (const path of ['/', '/assets/main.js', '/deep/link', '/api/health', '/api/account/session']) {
      for (const value of ['', `${token}x`, token.replace('controlled', 'xxxxxxxxxx')]) {
        const response = await fetch(`${base}${path}`, { headers: { 'X-Qianwen-Desktop-Token': value } });
        expect(response.status).toBe(403);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await response.text()).not.toContain(token);
      }
    }
    const malformed = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ malformed' });
    expect(malformed.status).toBe(403);
    expect(malformed.headers.getSetCookie()).toEqual([]);
  });

  it('serves authorized desktop requests with CSP and keeps the token out of responses', async () => {
    const base = await serve();
    for (const path of ['/', '/assets/main.js', '/api/health', '/api/account/session']) {
      const response = await fetch(`${base}${path}`, { headers: tokenHeaders });
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy')!;
      for (const directive of ["script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(directive);
      expect(csp).not.toContain('unsafe-eval');
      expect(await response.text()).not.toContain(token);
      expect(JSON.stringify([...response.headers])).not.toContain(token);
      if (path === '/api/account/session') expect(response.headers.getSetCookie()[0]).toContain('qianwen_guest=');
    }
  });

  it('keeps the web service accessible without a desktop token or desktop-only CSP', async () => {
    const base = await serve(false);
    for (const path of ['/', '/api/health', '/api/account/session']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBeNull();
    }
    expect(() => createApp({ desktopToken: '' })).toThrow('桌面访问令牌不能为空');
  });
});

describe('document parser launch in packaged desktop and web processes', () => {
  const env = { PATH: 'normal-system-path', SystemRoot: 'C:\\Windows', Qianwen_api_key: 'private-fixture', qwen_desktop_token: 'private-fixture', QWEN_BASE_URL: 'private-fixture', QWEN_DATA_DIR: 'private-fixture' };
  it('runs the unpacked worker with the Electron executable as Node and without service secrets', () => {
    const launch = documentWorkerConfig('C:\\installed\\resources\\app.asar\\server\\document-worker.mjs', { env, execPath: 'C:\\installed\\Qianwen.exe', versions: { electron: '41.0.0' } });
    expect(launch.workerPath).toBe('C:\\installed\\resources\\app.asar.unpacked\\server\\document-worker.mjs');
    expect(launch.options.execPath).toBe('C:\\installed\\Qianwen.exe');
    expect(launch.options.env).toEqual({ PATH: env.PATH, SystemRoot: env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' });
    expect(launch.options.execArgv).toEqual(['--max-old-space-size=128']);
    expect(launch.options.windowsHide).toBe(true);
    expect(launch.options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect(env.Qianwen_api_key).toBe('private-fixture');
    const unpacked = documentWorkerConfig('/resources/app.asar.unpacked/server/document-worker.mjs', { env, execPath: '/Qianwen', versions: { electron: '41.0.0' } });
    expect(unpacked.workerPath).toBe('/resources/app.asar.unpacked/server/document-worker.mjs');
  });

  it('retains the ordinary web worker path and Node fork defaults without adding Electron mode', () => {
    const launch = documentWorkerConfig('/project/server/document-worker.mjs', { env: { ...env, ELECTRON_RUN_AS_NODE: 'inherited-unwanted-mode' }, execPath: '/node', versions: {} });
    expect(launch.workerPath).toBe('/project/server/document-worker.mjs');
    expect(launch.options.execPath).toBeUndefined();
    expect(launch.options.env).toEqual({ PATH: env.PATH, SystemRoot: env.SystemRoot });
  });
});

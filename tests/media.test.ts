import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMediaService, extractDocument, inspectImage, MEDIA_LIMITS, validateDocxArchive } from '../server/media';
import type { Attachment } from '../shared/types';
import { textDocx, textPdf } from './media-fixtures';

const servers: Server[] = [];
const directories: string[] = [];
const testRoot = resolve('.local');
async function service(upstream?: typeof fetch, existingDir?: string) {
  await mkdir(testRoot, { recursive: true });
  const storageDir = existingDir ?? await mkdtemp(resolve(testRoot, 'media-tests-'));
  if (!existingDir) directories.push(storageDir);
  const media = createMediaService({ getOwner: req => req.get('x-test-owner') ?? 'user:one', storageDir, config: { apiKey: 'secret-test-key' }, fetch: upstream });
  const app = express(); app.use('/api', media.router);
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return { ...media, storageDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); }
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(`${testRoot}\\media-tests-`) && !resolve(directory).startsWith(`${testRoot}/media-tests-`)) throw new Error('Unexpected cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});
function upload(base: string, bytes: Uint8Array, filename: string, mime = 'application/octet-stream', owner = 'user:one', endpoint = '/attachments', signal?: AbortSignal) {
  const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  return fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'x-test-owner': owner }, body: form, signal });
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6fUAAAAASUVORK5CYII=', 'base64');
function wave() { const data = Buffer.alloc(76); data.write('RIFF'); data.writeUInt32LE(68, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(32, 40); return data; }

describe('owned attachments', () => {
  it('extracts and persists trusted text and rejects access by a different owner', async () => {
    const media = await service();
    const response = await upload(media.base, new TextEncoder().encode('这是可信的文档正文。'), 'notes.txt', 'text/plain');
    expect(response.status).toBe(201);
    const { attachment } = await response.json() as { attachment: Attachment };
    expect(attachment).toMatchObject({ kind: 'document', name: 'notes.txt', textPreview: '这是可信的文档正文。', truncated: false });
    expect(attachment).not.toHaveProperty('text');
    const forged = { ...attachment, name: 'forged', textPreview: '伪造正文', previewUrl: 'http://127.0.0.1/private' };
    expect(await media.resolveAttachments('user:one', [forged])).toMatchObject([{ attachment: { name: 'notes.txt' }, text: '这是可信的文档正文。' }]);
    await expect(media.resolveAttachments('user:two', [attachment])).rejects.toThrow('不属于当前用户');
    expect((await fetch(`${media.base}/attachments/${attachment.id}/content`, { headers: { 'x-test-owner': 'user:two' } })).status).toBe(404);
    const restarted = await service(undefined, media.storageDir);
    expect(await restarted.resolveAttachments('user:one', [attachment])).toMatchObject([{ text: '这是可信的文档正文。' }]);
  });
  it('returns an owner-scoped preview and resolves actual image bytes', async () => {
    const media = await service();
    const response = await upload(media.base, png, 'photo.png', 'image/png');
    const { attachment } = await response.json() as { attachment: Attachment };
    expect(attachment.previewUrl).toBe(`/api/attachments/${attachment.id}/content`);
    const result = await media.resolveAttachments('user:one', [attachment]);
    expect(result[0].dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
    const preview = await fetch(`${media.base}/attachments/${attachment.id}/content`);
    expect(preview.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
  });
  it('marks document truncation and rejects unsupported or overlarge files', async () => {
    const media = await service();
    const response = await upload(media.base, new TextEncoder().encode('文'.repeat(9000)), 'large.md');
    const { attachment } = await response.json() as { attachment: Attachment };
    expect(attachment).toMatchObject({ truncated: true, extractedCharacters: 9000 });
    expect((await media.resolveAttachments('user:one', [attachment]))[0].text).toHaveLength(8000);
    expect((await upload(media.base, new TextEncoder().encode('<svg/>'), 'script.svg', 'image/svg+xml')).status).toBe(400);
    const huge = Buffer.alloc(MEDIA_LIMITS.imageBytes + 1); png.copy(huge);
    expect((await upload(media.base, huge, 'huge.png')).status).toBe(413);
  });
  it('serializes per-owner quota checks so simultaneous uploads cannot exceed the file count', async () => {
    const media = await service();
    const directory = resolve(media.storageDir, createHash('sha256').update('user:one').digest('hex'));
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 199 }, (_, index) => writeFile(resolve(directory, `${index}.bin`), 'x')));
    const responses = await Promise.all([upload(media.base, Buffer.from('one'), 'one.txt'), upload(media.base, Buffer.from('two'), 'two.txt')]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 413]);
    expect((await readdir(directory)).filter(file => file.endsWith('.bin'))).toHaveLength(200);
  });
});

describe('document parser limits', () => {
  it('rejects invalid UTF-8, binary text, forged PDFs and malformed archives', async () => {
    await expect(extractDocument(Buffer.from([0xff]), 'txt')).rejects.toThrow('UTF-8');
    await expect(extractDocument(Buffer.from('a\0b'), 'txt')).rejects.toThrow('二进制');
    await expect(extractDocument(Buffer.from('not a pdf'), 'pdf')).rejects.toThrow('有效的 PDF');
    expect(() => validateDocxArchive(Buffer.from('not zip'))).toThrow('压缩结构');
    const hugeImage = Buffer.from(png); hugeImage.writeUInt32BE(50000, 16);
    expect(() => inspectImage(hugeImage)).toThrow('图片尺寸');
  });
  it('honors cancellation before parsing', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(extractDocument(Buffer.from('text'), 'txt', controller.signal)).rejects.toBeDefined();
  });
  it('actually extracts PDF and DOCX text in isolated parsers', async () => {
    expect(await extractDocument(textPdf(), 'pdf')).toMatchObject({ text: expect.stringContaining('PDF_TEST_SECRET_7421'), truncated: false });
    expect(await extractDocument(textDocx(), 'docx')).toMatchObject({ text: 'DOCX_TEST_SECRET_9357', truncated: false });
  });
});

describe('voice endpoints', () => {
  it('sends audio bytes to ASR and returns recognized text without exposing the key', async () => {
    let body: Record<string, unknown> = {};
    const media = await service((async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { content: '识别成功' } }] }); }) as typeof fetch);
    const response = await upload(media.base, wave(), 'speech.wav', 'audio/wav', 'user:one', '/audio/transcriptions');
    expect(await response.json()).toEqual({ text: '识别成功' });
    expect(body.model).toBe('qwen3-asr-flash');
    expect(JSON.stringify(body)).toContain('data:audio/wav;base64,');
    expect(JSON.stringify(body)).not.toContain('secret-test-key');
  });
  it('downloads only the official TTS audio URL and returns WAV bytes', async () => {
    const calls: { url: string; auth: unknown }[] = [];
    const media = await service((async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return calls.length === 1 ? Response.json({ output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?signature=example' } } }) : new Response(wave());
    }) as typeof fetch);
    const response = await fetch(`${media.base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wave());
    expect(calls[1].url).toMatch(/^https:\/\/dashscope-result/);
    expect(calls[1].auth).toBeNull();
  });
  it('rejects arbitrary TTS URLs without requesting them and validates speech length', async () => {
    let calls = 0;
    const media = await service((async () => { calls++; return Response.json({ output: { audio: { url: 'http://127.0.0.1/private' } } }); }) as typeof fetch);
    const speak = (text: string) => fetch(`${media.base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    expect((await speak('你好')).status).toBe(502); expect(calls).toBe(1);
    expect((await speak('a'.repeat(501))).status).toBe(400); expect(calls).toBe(1);
  });
  it('aborts the actual ASR request when the browser cancels transcription', async () => {
    let started!: () => void; let aborted!: (reason: unknown) => void;
    const began = new Promise<void>(resolveStarted => { started = resolveStarted; });
    const ended = new Promise<unknown>(resolveAborted => { aborted = resolveAborted; });
    const media = await service((async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted(init!.signal!.reason); reject(init!.signal!.reason); }, { once: true }); started();
    })) as typeof fetch);
    const controller = new AbortController();
    const result = upload(media.base, wave(), 'speech.wav', 'audio/wav', 'user:one', '/audio/transcriptions', controller.signal).catch(error => error);
    await began; controller.abort(); await result;
    await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
  });
});

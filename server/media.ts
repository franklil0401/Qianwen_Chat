import express, { type Request, type Response, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir, stat, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Attachment } from '../shared/types.ts';
import { attachmentSchema } from '../shared/schemas.ts';
import type { ProviderConfig } from './provider.ts';

export const MEDIA_LIMITS = { imageBytes: 5 * 1024 * 1024, documentBytes: 10 * 1024 * 1024, audioBytes: 6 * 1024 * 1024, documentCharacters: 8000, speechCharacters: 500 } as const;
export interface ResolvedAttachment { attachment: Attachment; text?: string; dataUrl?: string }
export interface MediaServiceOptions { getOwner(req: Request): string; config?: Partial<ProviderConfig>; storageDir?: string; fetch?: typeof fetch }
class MediaError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
interface StoredAttachment { attachment: Attachment; text?: string }

export function dashscopeBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/api/v1`;
}

function safeName(original: string): string {
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  const candidate = [...original].every(char => char.charCodeAt(0) <= 255) && !decoded.includes('\uFFFD') ? decoded : original;
  return (candidate.split(/[\\/]/).at(-1) ?? '附件').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || '附件';
}

export function inspectImage(buffer: Buffer): string | undefined {
  let mime: string | undefined;
  let width = 0;
  let height = 0;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png'; width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    mime = 'image/jpeg';
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) { offset++; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7); break;
      }
      offset += length + 2;
    }
  } else if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    const format = buffer.toString('ascii', 12, 16);
    if (format === 'VP8X') { width = 1 + buffer.readUIntLE(24, 3); height = 1 + buffer.readUIntLE(27, 3); }
    else if (format === 'VP8 ') { width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff; }
    else if (format === 'VP8L' && buffer[20] === 0x2f) { width = 1 + (buffer.readUInt32LE(21) & 0x3fff); height = 1 + ((buffer.readUInt32LE(21) >>> 14) & 0x3fff); }
  }
  if (mime && (!width || !height || width > 16384 || height > 16384 || width * height > 25_000_000)) throw new MediaError('图片尺寸无效或超过 2500 万像素，请缩小后上传。');
  return mime;
}

/** Check ZIP central-directory sizes before a DOCX decompressor sees the file. */
export function validateDocxArchive(buffer: Buffer): void {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new MediaError('DOCX 压缩结构无效。');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count > 2000 || offset === 0xffffffff) throw new MediaError('DOCX 内容过于复杂，请拆分后上传。');
  let uncompressed = 0;
  let hasDocument = false;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new MediaError('DOCX 压缩目录无效。');
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    uncompressed += size;
    if (size > 20 * 1024 * 1024 || uncompressed > 25 * 1024 * 1024) throw new MediaError('DOCX 解压后超过 25 MB，请拆分后上传。');
    if (buffer.toString('utf8', offset + 46, offset + 46 + nameLength) === 'word/document.xml') hasDocument = true;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!hasDocument) throw new MediaError('文件不是有效的 DOCX 文档。');
}

export async function extractDocument(buffer: Buffer, extension: string, signal?: AbortSignal): Promise<{ text: string; extractedCharacters: number; truncated: boolean }> {
  signal?.throwIfAborted();
  if (extension === 'txt' || extension === 'md') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '').trim(); }
    catch { throw new MediaError('TXT / Markdown 请使用 UTF-8 编码。'); }
    if (text.includes('\u0000')) throw new MediaError('文本文件包含二进制内容，无法读取。');
    if (!text) throw new MediaError('文档没有可读取的文字。');
    return { text: text.slice(0, MEDIA_LIMITS.documentCharacters), extractedCharacters: text.length, truncated: text.length > MEDIA_LIMITS.documentCharacters };
  }
  if (extension === 'pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new MediaError('文件不是有效的 PDF。');
  if (extension === 'docx') validateDocxArchive(buffer);
  if (!['pdf', 'docx'].includes(extension)) throw new MediaError('仅支持 TXT、Markdown、PDF 和 DOCX 文档。');
  return new Promise((resolveResult, reject) => {
    const worker = fork(fileURLToPath(new URL('./document-worker.mjs', import.meta.url)), [], { execArgv: ['--max-old-space-size=128'], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const finish = (error?: Error, result?: { text: string; extractedCharacters: number; truncated: boolean }) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.kill();
      if (error) reject(error); else resolveResult(result!);
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new MediaError('文档解析超时，请拆分后上传。')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => { const result = value as { error?: string; text: string; extractedCharacters: number; truncated: boolean }; finish(result.error ? new MediaError(result.error) : !result.text ? new MediaError('文档没有可读取的文字；扫描版 PDF 请改为上传图片。') : undefined, result); });
    worker.once('error', () => finish(new MediaError('文档解析失败，请检查文件或拆分后重试。')));
    worker.once('exit', code => { if (!settled) finish(new MediaError(`文档解析未完成${code ? '，文件可能过于复杂' : ''}。`)); });
    worker.send({ base64: buffer.toString('base64'), kind: extension, maxCharacters: MEDIA_LIMITS.documentCharacters });
    if (signal?.aborted) abort();
  });
}

function audioMime(buffer: Buffer): string {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  throw new MediaError('录音格式不受支持，请使用 WebM、Ogg、WAV、MP3 或 M4A。');
}

async function boundedAudio(response: globalThis.Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body) throw new MediaError('合成音频下载失败，请重试。', 502);
  if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) { await response.body.cancel(); throw new MediaError('合成音频过大，请缩短朗读内容。', 502); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 10 * 1024 * 1024) throw new MediaError('合成音频过大，请缩短朗读内容。', 502); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function createMediaService(options: MediaServiceOptions) {
  const router = express.Router();
  const root = resolve(options.storageDir ?? '.local/uploads');
  const config = options.config ?? {};
  const upstreamFetch = options.fetch ?? config.fetch ?? fetch;
  const apiKey = config.apiKey ?? process.env.Qianwen_api_key ?? '';
  const base = config.baseUrl ?? process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const nativeBase = config.dashscopeBaseUrl ?? process.env.QWEN_DASHSCOPE_BASE_URL ?? dashscopeBase(base);
  const asrModel = config.asrModel ?? process.env.QWEN_ASR_MODEL ?? 'qwen3-asr-flash';
  const ttsModel = config.ttsModel ?? process.env.QWEN_TTS_MODEL ?? 'qwen3-tts-flash';
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.documentBytes, files: 1, fields: 0 } });
  const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.audioBytes, files: 1, fields: 0 } });
  const pendingWrites = new Map<string, Promise<void>>();
  const activeRequests = new Set<AbortController>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const controller of activeRequests) controller.abort(new DOMException('服务已停止', 'AbortError'));
    activeRequests.clear();
  };
  router.use((_req, res, next) => {
    if (disposed) { res.status(503).json({ error: '服务已停止，请重新启动应用。' }); return; }
    next();
  });
  async function withOwnerWrite<T>(owner: string, action: () => Promise<T>): Promise<T> {
    const previous = pendingWrites.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    pendingWrites.set(owner, tail);
    await previous.catch(() => undefined);
    try { return await action(); }
    finally { release(); if (pendingWrites.get(owner) === tail) pendingWrites.delete(owner); }
  }
  const ownerDir = (owner: string) => { if (!owner) throw new MediaError('无法确认附件所属用户。', 401); return join(root, createHash('sha256').update(owner).digest('hex')); };
  async function readOwned(owner: string, id: string): Promise<StoredAttachment> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new MediaError('附件不存在或无权访问。', 404);
    try {
      const value = JSON.parse(await readFile(join(ownerDir(owner), `${id}.json`), 'utf8')) as StoredAttachment;
      const attachment = attachmentSchema.parse(value.attachment);
      if (attachment.id !== id || (attachment.kind === 'document' && typeof value.text !== 'string')) throw new Error();
      return { attachment, text: value.text?.slice(0, MEDIA_LIMITS.documentCharacters) };
    } catch { throw new MediaError('附件不存在、已过期或不属于当前用户，请重新上传。', 404); }
  }
  async function resolveAttachments(owner: string, refs: Attachment[], signal?: AbortSignal): Promise<ResolvedAttachment[]> {
    if (refs.length > 4) throw new MediaError('每条消息最多使用 4 个附件。');
    const results: ResolvedAttachment[] = [];
    for (const ref of refs) {
      signal?.throwIfAborted();
      const stored = await readOwned(owner, ref.id);
      if (stored.attachment.kind === 'image') {
        const buffer = await readFile(join(ownerDir(owner), `${ref.id}.bin`), { signal });
        if (buffer.length > MEDIA_LIMITS.imageBytes) throw new MediaError('图片超过大小限制。');
        results.push({ attachment: stored.attachment, dataUrl: `data:${stored.attachment.mimeType};base64,${buffer.toString('base64')}` });
      } else results.push({ attachment: stored.attachment, text: stored.text });
    }
    return results;
  }
  const wrap = (action: (req: Request, res: Response, signal: AbortSignal) => Promise<void>) => async (req: Request, res: Response) => {
    // Multipart parsing runs before this handler and may finish during shutdown.
    if (disposed) { res.status(503).json({ error: '服务已停止，请重新启动应用。' }); return; }
    const controller = new AbortController();
    activeRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), 90_000);
    const close = () => { if (!res.writableEnded) controller.abort(new DOMException('已取消', 'AbortError')); };
    res.on('close', close);
    try { await action(req, res, controller.signal); }
    catch (error) {
      if (!res.destroyed && !res.headersSent) res.status(disposed ? 503 : controller.signal.reason?.name === 'TimeoutError' ? 504 : error instanceof MediaError ? error.status : 500).json({ error: disposed ? '服务已停止，请重新启动应用。' : controller.signal.reason?.name === 'TimeoutError' ? '媒体处理超时，请重试。' : error instanceof MediaError ? error.message : '媒体处理失败，请检查文件或网络后重试。' });
    } finally { activeRequests.delete(controller); clearTimeout(timeout); res.off('close', close); }
  };
  const requireKey = () => { if (!apiKey) throw new MediaError('未配置 Qianwen_api_key，无法使用语音服务。', 503); };
  const checkUpstream = async (response: globalThis.Response) => {
    if (!response.ok) { await response.body?.cancel(); throw new MediaError(response.status === 401 || response.status === 403 ? '语音模型鉴权失败，请检查密钥和模型权限。' : response.status === 429 ? '语音服务繁忙或额度不足，请稍后重试。' : `语音服务暂时不可用（HTTP ${response.status}）。`, 502); }
  };
  router.post('/attachments', upload.single('file'), wrap(async (req, res, signal) => {
    if (!req.file?.buffer.length) throw new MediaError('请选择一个非空文件。');
    const name = safeName(req.file.originalname);
    const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
    const buffer = req.file.buffer;
    const imageType = inspectImage(buffer);
    const kind = imageType ? 'image' : 'document';
    if (imageType && buffer.length > MEDIA_LIMITS.imageBytes) throw new MediaError('图片不能超过 5 MB。', 413);
    if (!imageType && !['txt', 'md', 'pdf', 'docx'].includes(extension)) throw new MediaError('支持 PNG、JPG、WebP 图片及 TXT、Markdown、PDF、DOCX 文档。');
    const parsed = kind === 'document' ? await extractDocument(buffer, extension, signal) : undefined;
    signal.throwIfAborted();
    const owner = options.getOwner(req); const directory = ownerDir(owner);
    const attachment = await withOwnerWrite(owner, async () => {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true });
      const files = (await readdir(directory)).filter(file => file.endsWith('.bin'));
      const totalBytes = (await Promise.all(files.map(file => stat(join(directory, file))))).reduce((total, entry) => total + entry.size, 0);
      if (files.length >= 200 || totalBytes + buffer.length > 200 * 1024 * 1024) throw new MediaError('当前用户的附件空间已满，请联系服务管理员清理。', 413);
      const id = randomUUID();
      const attachment: Attachment = { id, name, kind, mimeType: imageType ?? ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown', txt: 'text/plain' }[extension]!), size: buffer.length, ...(imageType ? { previewUrl: `/api/attachments/${id}/content` } : { textPreview: parsed!.text.slice(0, 500), extractedCharacters: parsed!.extractedCharacters, truncated: parsed!.truncated }) };
      try {
        await writeFile(join(directory, `${id}.bin`), buffer, { flag: 'wx', signal });
        await writeFile(join(directory, `${id}.tmp`), JSON.stringify({ attachment, text: parsed?.text }), { flag: 'wx', signal });
        signal.throwIfAborted();
        await rename(join(directory, `${id}.tmp`), join(directory, `${id}.json`));
      } catch (error) { await Promise.all([unlink(join(directory, `${id}.bin`)).catch(() => undefined), unlink(join(directory, `${id}.json`)).catch(() => undefined), unlink(join(directory, `${id}.tmp`)).catch(() => undefined)]); throw error; }
      return attachment;
    });
    res.status(201).json({ attachment });
  }));
  router.get('/attachments/:id/content', wrap(async (req, res, signal) => {
    const owner = options.getOwner(req); const id = String(req.params.id);
    const { attachment } = await readOwned(owner, id);
    const buffer = await readFile(join(ownerDir(owner), `${id}.bin`), { signal });
    res.set({ 'Content-Type': attachment.mimeType, 'Content-Disposition': `${attachment.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(buffer);
  }));
  router.post('/audio/transcriptions', audioUpload.single('file'), wrap(async (req, res, signal) => {
    requireKey(); options.getOwner(req);
    if (!req.file?.buffer.length) throw new MediaError('录音内容为空，请重新录制。');
    const mime = audioMime(req.file.buffer);
    const response = await upstreamFetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: asrModel, stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${req.file.buffer.toString('base64')}` } }] }], asr_options: { enable_itn: true } }) });
    await checkUpstream(response);
    const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new MediaError('没有识别到清晰语音，请重新录制。', 422);
    if (text.length > 16_000) throw new MediaError('识别文字过长，请分段录音。', 422);
    res.json({ text: text.trim() });
  }));
  router.post('/audio/speech', express.json({ limit: '8kb' }), wrap(async (req, res, signal) => {
    requireKey(); options.getOwner(req);
    const parsed = z.object({ text: z.string().trim().min(1).max(MEDIA_LIMITS.speechCharacters) }).strict().safeParse(req.body);
    if (!parsed.success) throw new MediaError('每段朗读内容需为 1–500 字。');
    const response = await upstreamFetch(`${nativeBase.replace(/\/$/, '')}/services/aigc/multimodal-generation/generation`, { method: 'POST', signal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ttsModel, input: { text: parsed.data.text, voice: config.ttsVoice ?? process.env.QWEN_TTS_VOICE ?? 'Cherry', language_type: 'Auto' } }) });
    await checkUpstream(response);
    const data = await response.json() as { output?: { audio?: { url?: string } } };
    let url: URL;
    try { url = new URL(data.output?.audio?.url ?? ''); } catch { throw new MediaError('语音服务未返回可用音频。', 502); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !/^dashscope-result(?:-[a-z0-9-]+)?\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.hostname)) throw new MediaError('语音服务返回了不受支持的音频地址。', 502);
    url.protocol = 'https:';
    const audio = await boundedAudio(await upstreamFetch(url, { signal, redirect: 'error' }), signal);
    if (audioMime(audio) !== 'audio/wav') throw new MediaError('语音服务返回的音频格式不受支持。', 502);
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(audio);
  }));
  const mediaErrors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof multer.MulterError) { res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '文件超过上传大小限制。' : '每次只能上传一个文件，请使用 file 字段。' }); return; }
    next(error);
  };
  router.use(mediaErrors);
  return { router, resolveAttachments, dispose, models: { asrModel, ttsModel }, limits: MEDIA_LIMITS };
}

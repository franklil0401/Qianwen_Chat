import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { StreamEvent } from '../shared/types.ts';
import { PublicError, runChat, type ProviderConfig } from './provider.ts';
import { toolDefinitions } from './tools.ts';
import { attachmentsSchema, idSchema, searchSourceSchema, toolSchema } from '../shared/schemas.ts';
import { validateWorkspace } from '../shared/workspace.ts';
import { createAccountService } from './accounts.ts';
import { createMediaService } from './media.ts';

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(16_000), tools: z.array(toolSchema).max(16).optional(), attachments: attachmentsSchema.optional() }),
  z.object({ role: z.literal('assistant'), content: z.string().max(120_000), tools: z.array(toolSchema).max(16).optional(), searchSources: z.array(searchSourceSchema).max(20).optional() }),
]);
export const chatSchema = z.object({ runId: idSchema, conversationId: idSchema, messageId: idSchema, messages: z.array(messageSchema).min(1).max(80), useTools: z.boolean(), thinking: z.boolean(), webSearch: z.boolean().optional() }).strict().refine(value => { const last = value.messages.at(-1); return last?.role === 'user' && Boolean(last.content.trim() || last.attachments?.length); }, { message: '最后一条消息必须是用户问题或附件' });

export interface AppOptions extends Partial<ProviderConfig> { requestTimeoutMs?: number; staticDir?: string; dataDir?: string; publicOrigin?: string; inMemoryAccounts?: boolean }
export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const config: ProviderConfig = { apiKey: options.apiKey ?? process.env.Qianwen_api_key ?? '', model: options.model ?? process.env.QWEN_MODEL ?? 'qwen-plus', baseUrl: options.baseUrl ?? process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1', fetch: options.fetch, maxToolRounds: options.maxToolRounds, maxToolCalls: options.maxToolCalls, toolTimeoutMs: options.toolTimeoutMs, visionModel: options.visionModel ?? process.env.QWEN_VISION_MODEL ?? 'qwen3-vl-plus', asrModel: options.asrModel ?? process.env.QWEN_ASR_MODEL ?? 'qwen3-asr-flash', ttsModel: options.ttsModel ?? process.env.QWEN_TTS_MODEL ?? 'qwen3-tts-flash', ttsVoice: options.ttsVoice ?? process.env.QWEN_TTS_VOICE ?? 'Cherry' };
  config.dashscopeBaseUrl = options.dashscopeBaseUrl ?? process.env.QWEN_DASHSCOPE_BASE_URL;
  const dataDir = options.dataDir ?? process.env.QWEN_DATA_DIR ?? join(process.cwd(), '.local');
  const publicOrigin = options.publicOrigin ?? process.env.QWEN_PUBLIC_ORIGIN;
  const publicUrl = publicOrigin ? new URL(publicOrigin) : undefined;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password)) throw new Error('QWEN_PUBLIC_ORIGIN 必须是完整的 HTTPS 站点来源，不含路径或凭据');
  if (process.env.QWEN_TRUST_PROXY === '1') app.set('trust proxy', 1);
  const accounts = createAccountService({ databasePath: options.inMemoryAccounts ? ':memory:' : join(dataDir, 'accounts.sqlite'), secureCookies: Boolean(publicUrl), validateWorkspace });
  const media = createMediaService({ getOwner: accounts.getOwner, config, storageDir: join(dataDir, 'uploads'), fetch: options.fetch });
  const runs = new Map<string, { owner: string; controller: AbortController }>();
  let disposed = false;
  app.locals.dispose = () => { if (disposed) return; disposed = true; for (const run of runs.values()) run.controller.abort(); runs.clear(); media.dispose(); accounts.close(); };
  app.use('/api', (req, res, next) => {
    if (disposed) { res.status(503).json({ error: '服务已停止，请重新启动应用。' }); return; }
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (publicUrl) allowed.add(publicUrl.hostname);
    if (!allowed.has(req.hostname)) { res.status(403).json({ error: '仅允许本机访问' }); return; }
    const origin = req.get('origin');
    if (origin) { try {
      const originUrl = new URL(origin);
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(originUrl.hostname) && ['http:', 'https:'].includes(originUrl.protocol) && [String(process.env.PORT ?? 3001), '5173', String(req.socket.localPort)].includes(originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80'));
      if (!local && originUrl.origin !== publicUrl?.origin) throw new Error();
    } catch { res.status(403).json({ error: '拒绝跨站请求' }); return; } }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Health and session load concurrently on first visit. Only the session route
  // should establish identity; competing guest cookies can orphan early uploads.
  app.get('/api/health', (_req, res) => res.json({ configured: Boolean(config.apiKey.trim()), model: config.model, tools: toolDefinitions.map(tool => tool.function.name), capabilities: { uploads: true, visionModel: config.visionModel, asrModel: config.asrModel, ttsModel: config.ttsModel, webSearch: true, accountSync: true, deployment: publicUrl ? 'server' : 'local' } }));
  app.use('/api', accounts.middleware);
  app.use('/api/account', accounts.router);
  app.use('/api', (req, res, next) => {
    const displayedAccount = req.get('X-Qianwen-Account');
    const owner = accounts.getOwner(req);
    if (displayedAccount && req.path !== '/health' && displayedAccount !== (owner.startsWith('user:') ? owner.slice(5) : 'guest')) { res.status(409).json({ code: 'identity_changed', error: '登录状态已在其他页面变化，请刷新后再试。' }); return; }
    if (publicUrl && (req.path === '/chat' || req.path.startsWith('/audio/') || req.path.startsWith('/attachments')) && !accounts.getOwner(req).startsWith('user:')) { res.status(401).json({ error: '请先登录后使用模型和附件功能' }); return; }
    next();
  });
  app.use('/api', media.router);
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/runs/:runId/cancel', (req, res) => {
    const controller = runs.get(`${accounts.getOwner(req)}\0${req.params.runId}`)?.controller;
    controller?.abort(new DOMException('用户已停止生成', 'AbortError'));
    res.json({ cancelled: Boolean(controller) });
  });
  app.post('/api/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: '对话请求格式不正确或超出长度限制' }); return; }
    if (!config.apiKey.trim()) { res.status(503).json({ error: '未配置系统环境变量 Qianwen_api_key，请设置后重启本地服务。' }); return; }
    const request = parsed.data;
    const owner = accounts.getOwner(req);
    const runKey = `${owner}\0${request.runId}`;
    if (runs.has(runKey)) { res.status(409).json({ error: '该任务正在运行，请勿重复提交' }); return; }
    for (const run of runs.values()) if (run.owner === owner) run.controller.abort(new DOMException('被新消息打断', 'AbortError'));
    const controller = new AbortController();
    runs.set(runKey, { owner, controller });
    const timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), options.requestTimeoutMs ?? (request.thinking ? 300_000 : 120_000));
    const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('客户端已断开', 'AbortError')); };
    res.on('close', disconnected);
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const emit = (event: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);
    try { await runChat(request, { ...config, resolveAttachments: (refs, signal) => media.resolveAttachments(owner, refs, signal) }, controller.signal, emit); }
    catch (error) {
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
        emit({ type: 'error', runId: request.runId, conversationId: request.conversationId, messageId: request.messageId, error: controller.signal.reason?.name === 'TimeoutError' ? '本轮请求超时，已保留收到的内容，请重试。' : error instanceof PublicError ? error.message : '生成时发生异常，已保留收到的内容，请重试。' });
      }
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); res.off('close', disconnected);
      if (runs.get(runKey)?.controller === controller) runs.delete(runKey);
      if (!res.writableEnded) res.end();
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const staticDir = options.staticDir ?? fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html', setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } }));
    app.get('/{*path}', (_req, res) => res.sendFile(`${staticDir}/index.html`));
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.type === 'entity.too.large' ? '请求数据过大，请缩短会话后重试' : '请求数据格式错误' }); };
  app.use(errorHandler);
  return app;
}

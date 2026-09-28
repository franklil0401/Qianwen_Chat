import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { StreamEvent } from '../shared/types.ts';
import { PublicError, runChat, type ProviderConfig } from './provider.ts';
import { toolDefinitions } from './tools.ts';

const knowledgeSchema = z.object({ id: z.string().max(100), title: z.string().max(300), summary: z.string().max(2000), content: z.string().max(8000), source: z.string().max(500) });
const resultSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('calculator'), expression: z.string().max(256), value: z.number().finite() }), z.object({ type: z.literal('knowledge'), query: z.string().max(300), items: z.array(knowledgeSchema).max(5) }), z.object({ type: z.literal('error'), message: z.string().max(1000) })]);
const toolSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(100), arguments: z.string().max(8000), status: z.enum(['receiving', 'queued', 'running', 'success', 'error', 'cancelled']), result: resultSchema.optional(), error: z.string().max(1000).optional(), durationMs: z.number().nonnegative().optional() });
const idSchema = z.string().min(1).max(100).regex(/^[\w-]+$/);
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(16_000), tools: z.array(toolSchema).max(16).optional() }),
  z.object({ role: z.literal('assistant'), content: z.string().max(120_000), tools: z.array(toolSchema).max(16).optional() }),
]);
export const chatSchema = z.object({ runId: idSchema, conversationId: idSchema, messageId: idSchema, messages: z.array(messageSchema).min(1).max(80), useTools: z.boolean(), thinking: z.boolean() }).strict().refine(value => value.messages.at(-1)?.role === 'user' && Boolean(value.messages.at(-1)?.content.trim()), { message: '最后一条消息必须是非空用户消息' });

export interface AppOptions extends Partial<ProviderConfig> { requestTimeoutMs?: number; staticDir?: string }
export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const config = { apiKey: options.apiKey ?? process.env.Qianwen_api_key ?? '', model: options.model ?? process.env.QWEN_MODEL ?? 'qwen-plus', baseUrl: options.baseUrl ?? process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1', fetch: options.fetch, maxToolRounds: options.maxToolRounds, maxToolCalls: options.maxToolCalls, toolTimeoutMs: options.toolTimeoutMs };
  const runs = new Map<string, AbortController>();
  app.use('/api', (req, res, next) => {
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (!allowed.has(req.hostname)) { res.status(403).json({ error: '仅允许本机访问' }); return; }
    const origin = req.get('origin');
    if (origin) { try { if (!allowed.has(new URL(origin).hostname)) throw new Error(); } catch { res.status(403).json({ error: '拒绝跨站请求' }); return; } }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_req, res) => res.json({ configured: Boolean(config.apiKey.trim()), model: config.model, tools: toolDefinitions.map(tool => tool.function.name) }));
  app.post('/api/runs/:runId/cancel', (req, res) => {
    const controller = runs.get(req.params.runId);
    controller?.abort(new DOMException('用户已停止生成', 'AbortError'));
    res.json({ cancelled: Boolean(controller) });
  });
  app.post('/api/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: '对话请求格式不正确或超出长度限制' }); return; }
    if (!config.apiKey.trim()) { res.status(503).json({ error: '未配置系统环境变量 Qianwen_api_key，请设置后重启本地服务。' }); return; }
    const request = parsed.data;
    if (runs.has(request.runId)) { res.status(409).json({ error: '该任务正在运行，请勿重复提交' }); return; }
    for (const controller of runs.values()) controller.abort(new DOMException('被新消息打断', 'AbortError'));
    const controller = new AbortController();
    runs.set(request.runId, controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), options.requestTimeoutMs ?? (request.thinking ? 300_000 : 120_000));
    const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('客户端已断开', 'AbortError')); };
    res.on('close', disconnected);
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const emit = (event: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);
    try { await runChat(request, config, controller.signal, emit); }
    catch (error) {
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
        emit({ type: 'error', runId: request.runId, conversationId: request.conversationId, messageId: request.messageId, error: controller.signal.reason?.name === 'TimeoutError' ? '本轮请求超时，已保留收到的内容，请重试。' : error instanceof PublicError ? error.message : '生成时发生异常，已保留收到的内容，请重试。' });
      }
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); res.off('close', disconnected);
      if (runs.get(request.runId) === controller) runs.delete(request.runId);
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

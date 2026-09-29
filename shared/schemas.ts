import { z } from 'zod';

export const idSchema = z.string().min(1).max(100).regex(/^[\w-]+$/);
export const attachmentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  kind: z.enum(['image', 'document']),
  mimeType: z.string().max(100),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  previewUrl: z.string().max(200).optional(),
  textPreview: z.string().max(500).optional(),
  extractedCharacters: z.number().int().nonnegative().max(100_000_000).optional(),
  truncated: z.boolean().optional(),
}).strict().refine(value => !value.previewUrl || value.previewUrl === `/api/attachments/${value.id}/content`, '附件预览地址无效')
  .refine(value => value.kind !== 'image' || value.size <= 5 * 1024 * 1024, '图片不能超过 5 MB');
export const attachmentsSchema = z.array(attachmentSchema).max(4).refine(items => new Set(items.map(item => item.id)).size === items.length, '附件不可重复');
export const searchSourceSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(500),
  url: z.string().url().max(4000).refine(value => /^https?:\/\//i.test(value), '来源必须是网页地址'),
  siteName: z.string().max(300).optional(),
  snippet: z.string().max(2000).optional(),
}).strict();
export const knowledgeSchema = z.object({ id: z.string().min(1).max(100), title: z.string().max(300), summary: z.string().max(2000), content: z.string().max(8000), source: z.string().max(500) }).strict();
export const toolResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('calculator'), expression: z.string().max(256), value: z.number().finite() }).strict(),
  z.object({ type: z.literal('knowledge'), query: z.string().max(300), items: z.array(knowledgeSchema).max(5) }).strict(),
  z.object({ type: z.literal('error'), message: z.string().max(1000) }).strict(),
]);
export const toolSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().max(100), arguments: z.string().max(8000),
  status: z.enum(['receiving', 'queued', 'running', 'success', 'error', 'cancelled']),
  result: toolResultSchema.optional(), error: z.string().max(1000).optional(), durationMs: z.number().finite().nonnegative().optional(),
}).strict();

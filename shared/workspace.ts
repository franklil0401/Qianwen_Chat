import { z } from 'zod';
import { attachmentsSchema, idSchema, knowledgeSchema, searchSourceSchema, toolSchema } from './schemas';
import { serializeSources } from './content';

const messageSchema = z.object({
  id: idSchema, role: z.enum(['user', 'assistant']), content: z.string().max(120_000),
  status: z.enum(['streaming', 'done', 'stopped', 'error']), createdAt: z.number().finite().nonnegative(),
  reasoning: z.string().max(120_000).optional(), error: z.string().max(2000).optional(),
  sources: z.array(knowledgeSchema).max(3).optional(), tools: z.array(toolSchema).max(16).optional(),
  attachments: attachmentsSchema.optional(), searchSources: z.array(searchSourceSchema).max(20).optional(),
}).strict();
export const workspaceSchema = z.object({
  version: z.literal(1), activeId: idSchema, useTools: z.boolean(), thinking: z.boolean(), webSearch: z.boolean().optional(),
  conversations: z.array(z.object({
    id: idSchema, title: z.string().max(100), updatedAt: z.number().finite().nonnegative(),
    messages: z.array(messageSchema).max(100),
    draft: z.object({ text: z.string().max(16_000), sources: z.array(knowledgeSchema).max(3), attachments: attachmentsSchema.optional() }).strict().optional(),
    branchFrom: z.object({ conversationId: idSchema, messageId: idSchema, title: z.string().max(100), mode: z.enum(['edit', 'regenerate']) }).strict().optional(),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.conversations.map(conversation => conversation.id));
  if (ids.size !== value.conversations.length || !ids.has(value.activeId)) ctx.addIssue({ code: 'custom', message: '会话标识重复或当前会话不存在' });
  for (const conversation of value.conversations) {
    const messageIds = new Set(conversation.messages.map(message => message.id));
    if (messageIds.size !== conversation.messages.length) ctx.addIssue({ code: 'custom', message: '消息标识重复' });
    for (const message of conversation.messages) if (message.role === 'user' && serializeSources(message.content, message.sources).length > 16_000) ctx.addIssue({ code: 'custom', message: '用户问题与引用超过 16,000 字符' });
  }
});

/** Validate persisted workspaces; never resume unfinished requests on another device. */
export function validateWorkspace(value: unknown) {
  const result = workspaceSchema.parse(value);
  for (const conversation of result.conversations) for (const message of conversation.messages) {
    if (message.status === 'streaming') message.status = 'stopped';
    for (const tool of message.tools ?? []) if (['receiving', 'queued', 'running'].includes(tool.status)) tool.status = 'cancelled';
  }
  return result;
}

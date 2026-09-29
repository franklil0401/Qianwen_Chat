import { describe, expect, it } from 'vitest';
import { normalizeSearchSources, runChat } from '../server/provider';
import type { Attachment, ChatRequest, StreamEvent } from '../shared/types';

const config = { apiKey: 'placeholder', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const request: ChatRequest = { runId: 'media-run', conversationId: 'conversation', messageId: 'response', messages: [{ role: 'user', content: '请分析附件' }], useTools: true, thinking: false };
const attachment: Attachment = { id: 'attachment', name: 'client-name', kind: 'document', mimeType: 'text/plain', size: 20, textPreview: '不可信客户端正文' };
const compatible = (text = '完成') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const native = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''));

describe('trusted multimodal context', () => {
  it('resolves document data on the server and never sends client preview text', async () => {
    let sent: Record<string, unknown> = {};
    await runChat({ ...request, messages: [{ role: 'user', content: '总结文件', attachments: [attachment] }] }, { ...config, resolveAttachments: async refs => { expect(refs[0].id).toBe('attachment'); return [{ attachment: { ...attachment, name: 'trusted.txt' }, text: '服务端真实正文' }]; }, fetch: (async (_url, init) => { sent = JSON.parse(String(init?.body)); return compatible(); }) as typeof fetch }, new AbortController().signal, () => {});
    const serialized = JSON.stringify(sent);
    expect(serialized).toContain('服务端真实正文'); expect(serialized).toContain('trusted.txt');
    expect(serialized).not.toContain('不可信客户端正文'); expect(serialized).not.toContain('attachmentRefs');
  });
  it('sends image bytes to the actual vision model and retains function tools', async () => {
    let sent: Record<string, unknown> = {};
    await runChat({ ...request, messages: [{ role: 'user', content: '图是什么颜色', attachments: [{ ...attachment, kind: 'image' }] }] }, { ...config, visionModel: 'qwen3-vl-plus', resolveAttachments: async () => [{ attachment: { ...attachment, kind: 'image', name: 'trusted.png' }, dataUrl: 'data:image/png;base64,realbytes' }], fetch: (async (_url, init) => { sent = JSON.parse(String(init?.body)); return compatible('红色'); }) as typeof fetch }, new AbortController().signal, () => {});
    expect(sent.model).toBe('qwen3-vl-plus'); expect(JSON.stringify(sent)).toContain('data:image/png;base64,realbytes');
    expect(sent.tools).toBeDefined();
  });
  it('fails before model invocation when attachment ownership cannot be established', async () => {
    let called = false;
    await expect(runChat({ ...request, messages: [{ role: 'user', content: '文件', attachments: [attachment] }] }, { ...config, resolveAttachments: async () => { throw new Error('private filesystem detail'); }, fetch: (async () => { called = true; return compatible(); }) as typeof fetch }, new AbortController().signal, () => {})).rejects.toThrow('不属于当前用户');
    expect(called).toBe(false);
  });
  it('allows a replacement upload when an older attachment is unavailable without using its client preview', async () => {
    let sent = '';
    const previous = { ...attachment, id: 'missing-old-file', name: '旧文档.txt' };
    const replacement = { ...attachment, id: 'valid-new-file', name: '新图片.png', kind: 'image' as const };
    const events: StreamEvent[] = [];
    await runChat({ ...request, messages: [
      { role: 'user', content: '请阅读旧文档', attachments: [previous] },
      { role: 'assistant', content: '之前的回复' },
      { role: 'user', content: '我重新上传了，请看新的图片', attachments: [replacement] },
    ] }, { ...config, resolveAttachments: async refs => {
      if (refs[0].id === previous.id) throw new Error('missing or wrong owner');
      return [{ attachment: replacement, dataUrl: 'data:image/png;base64,new-owned-bytes' }];
    }, fetch: (async (_url, init) => { sent = String(init?.body); return compatible('根据新上传的图片回答。'); }) as typeof fetch }, new AbortController().signal, event => events.push(event));
    expect(sent).toContain('历史附件不可用：旧文档.txt');
    expect(sent).toContain('本轮未读取这些附件的原文或图片');
    expect(sent).not.toContain('不可信客户端正文');
    expect(sent).toContain('data:image/png;base64,new-owned-bytes');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
  });
  it('allows a plain-text follow-up after historical attachments become unavailable', async () => {
    let sent = '';
    await runChat({ ...request, messages: [{ role: 'user', content: '之前的文件', attachments: [attachment] }, { role: 'assistant', content: '之前的回答' }, { role: 'user', content: '我们聊一个新话题' }] }, { ...config, resolveAttachments: async () => { throw new Error('missing file'); }, fetch: (async (_url, init) => { sent = String(init?.body); return compatible(); }) as typeof fetch }, new AbortController().signal, () => {});
    expect(sent).toContain('历史附件不可用');
    expect(sent).toContain('我们聊一个新话题');
    expect(sent).not.toContain('不可信客户端正文');
  });
  it('still rejects missing attachments on the latest user message', async () => {
    let called = false;
    const latest = { ...attachment, id: 'latest-missing' };
    await expect(runChat({ ...request, messages: [{ role: 'user', content: '旧问题', attachments: [attachment] }, { role: 'assistant', content: '旧回答' }, { role: 'user', content: '请分析新文件', attachments: [latest] }] }, { ...config, resolveAttachments: async refs => { if (refs[0].id === latest.id) throw new Error('missing'); return [{ attachment, text: '旧文件正文' }]; }, fetch: (async () => { called = true; return compatible(); }) as typeof fetch }, new AbortController().signal, () => {})).rejects.toThrow('附件不存在或不属于当前用户');
    expect(called).toBe(false);
  });
  it('does not swallow cancellation while resolving historical attachments', async () => {
    const controller = new AbortController(); let called = false;
    await expect(runChat({ ...request, messages: [{ role: 'user', content: '旧问题', attachments: [attachment] }, { role: 'user', content: '新问题' }] }, { ...config, resolveAttachments: async () => { controller.abort(); throw controller.signal.reason; }, fetch: (async () => { called = true; return compatible(); }) as typeof fetch }, controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
  });
});

describe('real-source search protocol', () => {
  it('normalizes safe sources and rejects unsafe or duplicated links', () => {
    expect(normalizeSearchSources([{ index: 1, title: '来源', url: 'https://example.com/a', site_name: '官网' }, { index: 2, title: '重复', url: 'https://example.com/a' }, { title: 'unsafe', url: 'javascript:alert(1)' }, { title: 'credentials', url: 'https://name:secret@example.com' }])).toEqual([{ id: '1', title: '来源', url: 'https://example.com/a', siteName: '官网' }]);
  });
  it('emits upstream sources, executes streamed tools, and handles native EOF completion without DONE', async () => {
    const events: StreamEvent[] = []; const bodies: Record<string, unknown>[] = []; const urls: string[] = [];
    const fetcher = (async (url, init) => {
      urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? native([
        { output: { choices: [{ message: { content: '' }, finish_reason: 'null' }], search_info: { search_results: [{ index: 1, title: '真实来源', url: 'https://example.com/source' }] } } },
        { output: { choices: [{ message: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'calculate', arguments: '{"expression":"13*17"}' } }] }, finish_reason: 'tool_calls' }] } },
      ]) : native([{ output: { choices: [{ message: { content: '计算结果 221，并参考网页[1]。' }, finish_reason: 'stop' }] } }]);
    }) as typeof fetch;
    await runChat({ ...request, webSearch: true }, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event));
    expect(urls.every(url => url.endsWith('/api/v1/services/aigc/text-generation/generation'))).toBe(true);
    expect((bodies[0].parameters as Record<string, unknown>).enable_search).toBe(true);
    expect(events.find(event => event.type === 'sources')).toMatchObject({ sources: [{ url: 'https://example.com/source' }] });
    expect(events.some(event => event.type === 'tool-update' && event.tool.status === 'success' && event.tool.result?.type === 'calculator' && event.tool.result.value === 221)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
  });
  it('does not claim a native stream completed without a terminal finish reason', async () => {
    const fetcher = (async () => native([{ output: { choices: [{ message: { content: '未完成' }, finish_reason: 'null' }] } }])) as typeof fetch;
    await expect(runChat({ ...request, webSearch: true }, { ...config, fetch: fetcher }, new AbortController().signal, () => {})).rejects.toThrow('提前结束');
  });
  it('reports an unverifiable web search instead of presenting an unsourced model answer as successful search', async () => {
    const events: StreamEvent[] = [];
    const fetcher = (async () => native([{ output: { choices: [{ message: { content: '普通模型回答' }, finish_reason: 'stop' }] } }])) as typeof fetch;
    await expect(runChat({ ...request, webSearch: true }, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event))).rejects.toThrow('未返回可核验');
    expect(events.some(event => event.type === 'done')).toBe(false);
  });
  it('keeps source IDs unique across tool rounds and remaps split citation numbers to the displayed order', async () => {
    let calls = 0; const events: StreamEvent[] = [];
    const fetcher = (async () => ++calls === 1 ? native([
      { output: { search_info: { search_results: [{ index: 1, title: '第一轮来源', url: 'https://example.com/first' }] }, choices: [{ message: { content: '第一轮参考[1]。' }, finish_reason: 'null' }] } },
      { output: { choices: [{ message: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] }, finish_reason: 'tool_calls' }] } },
    ]) : native([
      { output: { search_info: { search_results: [{ index: 1, title: '第二轮来源', url: 'https://example.com/second' }] }, choices: [{ message: { content: '第二轮参考[' }, finish_reason: 'null' }] } },
      { output: { choices: [{ message: { content: '1' }, finish_reason: 'null' }] } },
      { output: { choices: [{ message: { content: ']。' }, finish_reason: 'stop' }] } },
    ])) as typeof fetch;
    await runChat({ ...request, webSearch: true }, { ...config, fetch: fetcher }, new AbortController().signal, event => events.push(event));
    expect(events.filter(event => event.type === 'sources').at(-1)?.sources.map(source => source.id)).toEqual(['1', '2']);
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta).join('')).toBe('第一轮参考[1]。第二轮参考[2]。');
  });
  it('combines actual web evidence and actual image bytes through two explicit model stages', async () => {
    const requests: Record<string, unknown>[] = []; const events: StreamEvent[] = [];
    const fetcher = (async (_url, init) => { const body = JSON.parse(String(init?.body)); requests.push(body); return requests.length === 1 ? native([{ output: { search_info: { search_results: [{ index: 1, title: '公开资料', url: 'https://example.com/facts' }] }, choices: [{ message: { content: '检索到的公开事实' }, finish_reason: 'stop' }] } }]) : compatible('结合图片与网页回答'); }) as typeof fetch;
    await runChat({ ...request, webSearch: true, messages: [{ role: 'user', content: '结合网页分析图片', attachments: [{ ...attachment, kind: 'image' }] }] }, { ...config, fetch: fetcher, resolveAttachments: async () => [{ attachment: { ...attachment, kind: 'image' }, dataUrl: 'data:image/png;base64,ownedimage' }] }, new AbortController().signal, event => events.push(event));
    expect(requests).toHaveLength(2); expect(requests[0].model).toBe('qwen-plus'); expect(requests[1].model).toBe('qwen3-vl-plus');
    expect(JSON.stringify(requests[1])).toContain('检索到的公开事实'); expect(JSON.stringify(requests[1])).toContain('data:image/png;base64,ownedimage');
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta).join('')).toBe('结合图片与网页回答');
    expect(events.some(event => event.type === 'sources')).toBe(true);
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import { readSSE } from '../shared/sse';
import type { Attachment, ChatRequest, HistoryMessage, StreamEvent } from '../shared/types';
import { redPng, textDocx, textPdf } from '../tests/media-fixtures';

const base = process.env.LOCAL_APP_URL ?? 'http://127.0.0.1:3001';
const cookies = new Map<string, string>();
const report: { scenario: string; ok: boolean; detail: string; durationMs: number }[] = [];
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
  const response = await fetch(`${base}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(90_000) });
  for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'); const index = pair.indexOf('='); if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
  return response;
}
async function check(scenario: string, action: () => Promise<string>) {
  const started = Date.now();
  try { const detail = await action(); report.push({ scenario, ok: true, detail, durationMs: Date.now() - started }); console.log(`PASS ${scenario}: ${detail}`); }
  catch (error) { const detail = error instanceof Error ? error.message : '未知异常'; report.push({ scenario, ok: false, detail, durationMs: Date.now() - started }); console.error(`FAIL ${scenario}: ${detail}`); }
}
async function upload(bytes: Uint8Array, name: string, mime: string) {
  const body = new FormData(); body.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
  const response = await request('/api/attachments', { method: 'POST', body });
  const data = await response.json() as { attachment?: Attachment; error?: string };
  if (!response.ok || !data.attachment) throw new Error(data.error ?? `上传 HTTP ${response.status}`);
  return data.attachment;
}
async function chat(prompt: string, attachments: Attachment[] = [], webSearch = false, useTools = false, previous: HistoryMessage[] = []) {
  const body: ChatRequest = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(), messages: [...previous, { role: 'user', content: prompt, attachments }], thinking: false, useTools, webSearch };
  const response = await request('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) throw new Error(`对话 HTTP ${response.status}`);
  const events: StreamEvent[] = [];
  for await (const raw of readSSE(response.body)) { const event = JSON.parse(raw) as StreamEvent; events.push(event); if (event.type === 'error') throw new Error(event.error); }
  if (!events.some(event => event.type === 'done' && event.reason === 'stop')) throw new Error('未正常完成');
  return { events, text: events.filter(event => event.type === 'text-delta').map(event => event.delta).join('') };
}

await request('/api/account/session');
await check('图片上传与真实视觉理解', async () => {
  const attachment = await upload(redPng(), 'red-sample.png', 'image/png');
  const { text } = await chat('只回答图片主要是什么颜色。', [attachment]);
  if (!/红|red/i.test(text)) throw new Error(`图片颜色识别不符合预期：${text.slice(0, 200)}`);
  return `视觉模型根据原始图片回答：${text.trim()}`;
});
await check('TXT / PDF / DOCX解析后参与模型回答', async () => {
  const attachments = [
    await upload(new TextEncoder().encode('TXT verification code: TXT_TOKEN_8624.'), 'verification.txt', 'text/plain'),
    await upload(textPdf(), 'verification.pdf', 'application/pdf'),
    await upload(textDocx(), 'verification.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ];
  if (attachments.some(attachment => !attachment.extractedCharacters)) throw new Error('文档未提取文字');
  const { text } = await chat('请逐个抄写这三个文件正文中的验证代码；只列代码，不解释。', attachments);
  for (const token of ['TXT_TOKEN_8624', 'PDF_TEST_SECRET_7421', 'DOCX_TEST_SECRET_9357']) if (!text.includes(token)) throw new Error(`回复未包含文件真实正文的 ${token}`);
  return '三个文件的正文均被实际解析，模型正确读出各自验证代码';
});
let previousSearch: HistoryMessage[] = [];
let firstSourceUrl = '';
await check('联网来源与计算工具同轮闭环', async () => {
  const prompt = '联网查询杭州今天的天气，然后必须使用 calculate 工具计算 13*17，最后简短汇总。';
  const { events, text } = await chat(prompt, [], true, true);
  const sources = events.filter(event => event.type === 'sources').at(-1)?.sources ?? [];
  if (!sources.length || sources.some(source => !/^https?:\/\//.test(source.url))) throw new Error('没有真实网页来源');
  if (!events.some(event => event.type === 'tool-update' && event.tool.status === 'success' && event.tool.result?.type === 'calculator' && event.tool.result.value === 221)) throw new Error('计算工具未成功得到221');
  previousSearch = [{ role: 'user', content: prompt }, { role: 'assistant', content: text, searchSources: sources }];
  firstSourceUrl = sources[0].url;
  return `返回 ${sources.length} 个真实来源，计算工具返回 221，模型完成回答`;
});
await check('关闭联网后追问上一轮来源', async () => {
  if (!firstSourceUrl) throw new Error('上一轮未获得可用来源');
  const { text, events } = await chat('上一条回答的来源列表第 1 条的完整 URL 是什么？不要重新搜索，原样输出 URL。', [], false, false, previousSearch);
  if (!text.includes(firstSourceUrl)) throw new Error('回复未包含上一轮第一个来源的原始 URL');
  if (events.some(event => event.type === 'sources')) throw new Error('历史来源被错误标记为新检索');
  return '模型从会话元数据准确返回原始来源 URL，没有新搜索事件';
});
await check('真实语音合成与语音识别', async () => {
  const speech = await request('/api/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，这是语音识别测试。' }) });
  if (!speech.ok || !speech.headers.get('content-type')?.includes('audio/')) throw new Error(`语音合成 HTTP ${speech.status}`);
  const audio = new Uint8Array(await speech.arrayBuffer());
  if (audio.length < 1000) throw new Error('合成音频过短');
  const form = new FormData(); form.append('file', new Blob([audio], { type: 'audio/wav' }), 'tts-roundtrip.wav');
  const transcription = await request('/api/audio/transcriptions', { method: 'POST', body: form });
  const data = await transcription.json() as { text?: string; error?: string };
  if (!transcription.ok || !data.text?.includes('语音识别测试')) throw new Error(data.error ?? '识别文字与合成内容不一致');
  return `合成 ${audio.length} 字节 WAV，识别结果：${data.text}`;
});

await mkdir('.local', { recursive: true });
await writeFile('.local/live-features.json', JSON.stringify({ checkedAt: new Date().toISOString(), base, report }, null, 2));
if (report.some(item => !item.ok)) process.exitCode = 1;

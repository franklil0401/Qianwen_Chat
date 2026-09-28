import { mkdir, writeFile } from 'node:fs/promises';
import { readSSE } from '../shared/sse';
import type { ChatRequest, StreamEvent } from '../shared/types';

const base = process.env.LOCAL_APP_URL || 'http://127.0.0.1:3001';
const report: { scenario: string; ok: boolean; detail: string; durationMs: number }[] = [];

async function check(scenario: string, prompt: string, validate: (events: StreamEvent[]) => string, stopEarly = false) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const request: ChatRequest = {
    runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    messages: [{ role: 'user', content: prompt }], useTools: !stopEarly, thinking: false,
  };
  const events: StreamEvent[] = [];
  try {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    for await (const data of readSSE(response.body, controller.signal)) {
      const event = JSON.parse(data) as StreamEvent;
      if (event.runId !== request.runId) throw new Error('事件任务标识不一致');
      events.push(event);
      if (event.type === 'error') throw new Error(event.error);
      if (stopEarly && event.type === 'text-delta') {
        const cancellation = await fetch(`${base}/api/runs/${request.runId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) });
        if (!cancellation.ok) throw new Error(`取消接口 HTTP ${cancellation.status}`);
        if (!(await cancellation.json()).cancelled) throw new Error('取消时任务已不在运行，未覆盖生成中取消');
        controller.abort();
        break;
      }
    }
    const detail = validate(events);
    report.push({ scenario, ok: true, detail, durationMs: Date.now() - started });
    console.log(`PASS ${scenario}: ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    report.push({ scenario, ok: false, detail: message, durationMs: Date.now() - started });
    console.error(`FAIL ${scenario}: ${message}`);
  } finally { clearTimeout(timeout); controller.abort(); }
}

function requireDone(events: StreamEvent[]) {
  if (!events.some(event => event.type === 'done' && event.reason === 'stop')) throw new Error('未收到正常完成事件');
}

function requireAnswerAfterTool(events: StreamEvent[], name: string) {
  const successIndex = events.findIndex(event => event.type === 'tool-update' && event.tool.name === name && event.tool.status === 'success');
  if (successIndex < 0 || !events.slice(successIndex + 1).some(event => event.type === 'text-delta' && event.delta.trim())) {
    throw new Error('工具执行成功之后没有收到模型回答');
  }
}

await check('真实流式回复', '用简短的三句话解释什么是流式输出。', events => {
  requireDone(events);
  const count = events.filter(event => event.type === 'text-delta').length;
  if (count < 2) throw new Error('未观察到多个文本增量');
  return `收到 ${count} 个文本增量并正常完成`;
});
await check('真实计算器闭环', '必须调用 calculate 工具，计算 (128 * 35 + 256) / 12，然后告诉我结果。', events => {
  requireDone(events);
  const event = events.find(event => event.type === 'tool-update' && event.tool.status === 'success' && event.tool.result?.type === 'calculator');
  if (!event || event.type !== 'tool-update' || event.tool.result?.type !== 'calculator') throw new Error('没有成功的计算器结果');
  if (Math.abs(event.tool.result.value - 394.6666666666667) > 0.0001) throw new Error('计算结果不正确');
  requireAnswerAfterTool(events, 'calculate');
  return `模型调用工具、返回 ${event.tool.result.value} 并继续回答`;
});
await check('真实本地检索闭环', '请调用 search_knowledge 检索本地资料关于“流式输出”的内容，给出资料来源和简短总结。', events => {
  requireDone(events);
  const event = events.find(event => event.type === 'tool-update' && event.tool.status === 'success' && event.tool.result?.type === 'knowledge');
  if (!event || event.type !== 'tool-update' || event.tool.result?.type !== 'knowledge') throw new Error('没有成功的检索结果');
  if (!event.tool.result.items.length) throw new Error('检索没有命中资料');
  requireAnswerAfterTool(events, 'search_knowledge');
  return `命中 ${event.tool.result.items.length} 条本地资料并继续回答`;
});
await check('真实流式中途取消', '请写一篇至少三千字的长文，详细介绍计算机网络的历史和未来发展。', events => {
  if (!events.some(event => event.type === 'text-delta')) throw new Error('取消前未收到文本');
  if (events.some(event => event.type === 'done')) throw new Error('请求已经完成，未覆盖生成中取消');
  return '首段文本后取消接口成功，客户端中断读取';
}, true);

await mkdir('.local', { recursive: true });
await writeFile('.local/live-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), report }, null, 2));
if (report.some(item => !item.ok)) process.exitCode = 1;

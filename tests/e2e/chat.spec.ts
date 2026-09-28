import { expect, test, type Page, type Route } from '@playwright/test';
import type { ChatRequest, StreamEvent } from '../../shared/types';

type Payload = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'runId' | 'conversationId' | 'messageId'> : never : never;
function responseBody(request: ChatRequest, payloads: Payload[]) {
  const identity = { runId: request.runId, conversationId: request.conversationId, messageId: request.messageId };
  return payloads.map(payload => `data: ${JSON.stringify({ ...identity, ...payload })}\n\n`).join('');
}
async function reply(route: Route, payloads: Payload[]) {
  const request = route.request().postDataJSON() as ChatRequest;
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: responseBody(request, payloads) }).catch(() => undefined);
}
async function send(page: Page, prompt: string) {
  await page.getByTestId('message-input').fill(prompt);
  await page.getByTestId('send-button').click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { configured: true, model: 'qwen-plus', tools: ['calculate', 'search_knowledge'] } }));
  await page.route('**/api/runs/*/cancel', route => route.fulfill({ json: { cancelled: true } }));
});

test('PC welcome, multi-turn text and refresh persistence', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/chat', async route => {
    const request = route.request().postDataJSON() as ChatRequest;
    requests++;
    if (requests === 2) expect(request.messages.some(message => message.content.includes('第一轮完成'))).toBeTruthy();
    await reply(route, [{ type: 'text-delta', delta: requests === 1 ? '第一轮完成。\n\n**你好，千问。**' : '第二轮记住了上下文。' }, { type: 'done', reason: 'stop' }]);
  });
  await page.goto('/');
  await expect(page.getByTestId('message-input')).toBeVisible();
  await send(page, '请记住我叫小林');
  await expect(page.getByTestId('assistant-message').last()).toContainText('第一轮完成');
  await send(page, '我叫什么名字？');
  await expect(page.getByTestId('assistant-message').last()).toContainText('第二轮记住了上下文');
  await page.reload();
  await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  await expect(page.getByTestId('assistant-message').last()).toContainText('第二轮记住了上下文');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('stop then send isolates late content from the old request', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/chat', async route => {
    requests++;
    if (requests === 1) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await reply(route, [{ type: 'text-delta', delta: '不应出现的旧回复' }, { type: 'done', reason: 'stop' }]);
    } else {
      await reply(route, [{ type: 'text-delta', delta: '这是新请求的正确回复' }, { type: 'done', reason: 'stop' }]);
    }
  });
  await page.goto('/');
  await send(page, '请生成很长的内容');
  await expect(page.getByTestId('stop-button')).toBeVisible();
  await page.getByTestId('stop-button').click();
  await send(page, '现在换一个问题');
  await expect(page.getByTestId('assistant-message').last()).toContainText('这是新请求的正确回复');
  await page.waitForTimeout(1400);
  await expect(page.getByText('不应出现的旧回复', { exact: true })).toHaveCount(0);
});

test('calculator tool card and continued answer render together', async ({ page }) => {
  await page.route('**/api/chat', route => reply(route, [
    { type: 'tool-update', tool: { id: 'calc-1', name: 'calculate', arguments: '{"expression":"128*35"}', status: 'running' } },
    { type: 'tool-update', tool: { id: 'calc-1', name: 'calculate', arguments: '{"expression":"128*35"}', status: 'success', durationMs: 3, result: { type: 'calculator', expression: '128*35', value: 4480 } } },
    { type: 'text-delta', delta: '计算结果是 4480。' }, { type: 'done', reason: 'stop' },
  ]));
  await page.goto('/');
  await send(page, '计算 128*35');
  await expect(page.getByTestId('tool-card')).toContainText(/4,?480/);
  await expect(page.getByTestId('assistant-message').last()).toContainText('计算结果是 4480');
});

test('network error leaves a usable composer', async ({ page }) => {
  await page.route('**/api/chat', route => route.abort('failed'));
  await page.goto('/');
  await send(page, '网络异常测试');
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
  await expect(page.getByTestId('message-input')).toBeEnabled();
  await page.getByTestId('message-input').fill('重试输入');
  await expect(page.getByTestId('send-button')).toBeEnabled();
});

test('1024px layout remains within viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.getByTestId('message-input')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

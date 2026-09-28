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

test('desktop shortcut creates a conversation and history search finds content', async ({ page }) => {
  await page.route('**/api/chat', route => reply(route, [{ type: 'text-delta', delta: '关于流式解析的详细回答。' }, { type: 'done', reason: 'stop' }]));
  await page.goto('/');
  await send(page, '讨论流式输出');
  await expect(page.getByTestId('assistant-message')).toContainText('详细回答');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('assistant-message')).toHaveCount(0);
  await expect(page.getByTestId('message-input')).toBeFocused();
  await send(page, '讨论计算器');
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await page.getByTestId('history-search').fill('计算器');
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await expect(page.getByTestId('conversation-item')).toContainText('讨论计算器');
  await page.getByTestId('history-search').fill('详细回答');
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await page.getByTestId('history-search').fill('不存在的对话');
  await expect(page.getByTestId('conversation-item')).toHaveCount(0);
});

test('code can be copied without the rest of the answer', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/chat', route => reply(route, [{ type: 'text-delta', delta: '这是代码示例：\n\n```ts\nconst message = "你好，千问";\n```\n\n这部分不应进入剪贴板。' }, { type: 'done', reason: 'stop' }]));
  await page.goto('/');
  await send(page, '给我代码');
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).trim())).toBe('const message = "你好，千问";');
});

test('Chinese composition and Shift+Enter do not accidentally send', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/chat', async route => { requests++; await reply(route, [{ type: 'text-delta', delta: '已收到两行内容。' }, { type: 'done', reason: 'stop' }]); });
  await page.goto('/');
  const input = page.getByTestId('message-input');
  await input.fill('中文输入中');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  expect(requests).toBe(0);
  await input.dispatchEvent('compositionend');
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('第一行\n第二行');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-message')).toContainText('已收到两行内容');
  expect(requests).toBe(1);
});

test('long code and tables stay inside the desktop conversation width', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const content = '# 技术笔记\n\n' + Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段内容。`.repeat(12)).join('\n\n')
    + '\n\n```js\n' + 'const longIdentifier = "' + 'x'.repeat(240) + '";\n```\n\n'
    + '| 功能 | 说明 |\n| --- | --- |\n| SSE | ' + '流式输出'.repeat(70) + ' |';
  await page.route('**/api/chat', route => reply(route, [{ type: 'text-delta', delta: content }, { type: 'done', reason: 'stop' }]));
  await page.goto('/');
  await send(page, '长文阅读测试');
  await expect(page.getByTestId('assistant-message')).toContainText('技术笔记');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const scroll = page.locator('.chat-scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(100);
});

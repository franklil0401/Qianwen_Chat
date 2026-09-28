import { expect, test, type Page, type Route } from '@playwright/test';
import type { ChatRequest, StreamEvent } from '../../shared/types';

type Payload = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'runId' | 'conversationId' | 'messageId'> : never : never;
async function reply(route: Route, text: string) {
  const { runId, conversationId, messageId } = route.request().postDataJSON() as ChatRequest;
  const payloads: Payload[] = [{ type: 'text-delta', delta: text }, { type: 'done', reason: 'stop' }];
  await route.fulfill({ contentType: 'text/event-stream', body: payloads.map(p => `data: ${JSON.stringify({ ...p, runId, conversationId, messageId })}\n\n`).join('') }).catch(() => undefined);
}
async function send(page: Page, text: string) {
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { configured: true, model: 'qwen-plus', tools: ['calculate', 'search_knowledge'] } }));
  await page.route('**/api/runs/*/cancel', route => route.fulfill({ json: { cancelled: true } }));
});

test('regeneration branches from the selected turn and preserves original future messages', async ({ page }) => {
  const requests: ChatRequest[] = [];
  await page.route('**/api/chat', async route => { requests.push(route.request().postDataJSON()); await reply(route, `回答${requests.length}`); });
  await page.goto('/');
  await send(page, '第一问题');
  await send(page, '第二问题');
  await send(page, '第三问题');
  await page.getByTestId('regenerate-response').nth(1).click();
  await expect(page.getByTestId('assistant-message').last()).toContainText('回答4');
  expect(requests[3].messages.map(m => m.content)).toEqual(['第一问题', '回答1', '第二问题']);
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await expect(page.getByTestId('branch-origin')).toContainText('重新生成');
  await page.reload();
  await expect(page.getByTestId('branch-origin')).toContainText('重新生成');
  await page.getByRole('button', { name: '查看原对话' }).click();
  await expect(page.getByTestId('assistant-message')).toHaveCount(3);
  await expect(page.getByTestId('assistant-message').last()).toContainText('回答3');
});

test('editing can be cancelled without losing draft and submits a separate conversation', async ({ page }) => {
  const requests: ChatRequest[] = [];
  await page.route('**/api/chat', async route => { requests.push(route.request().postDataJSON()); await reply(route, `编辑回复${requests.length}`); });
  await page.goto('/');
  await send(page, '原始问题');
  await page.getByTestId('message-input').fill('未发送的草稿');
  await page.getByTestId('edit-message').click();
  await expect(page.getByTestId('message-input')).toHaveValue('原始问题');
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('未发送的草稿');
  expect(requests).toHaveLength(1);
  await page.getByTestId('edit-message').click();
  await page.getByTestId('message-input').fill('修改后的问题');
  await page.screenshot({ path: 'docs/screenshots/round4-edit.png', fullPage: true });
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message').last()).toContainText('编辑回复2');
  expect(requests[1].messages.map(m => m.content)).toEqual(['修改后的问题']);
  await page.getByRole('button', { name: '查看原对话' }).click();
  await expect(page.getByText('原始问题', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('assistant-message')).toContainText('编辑回复1');
});

test('drafts and citations survive conversation switches and immediate refresh', async ({ page }) => {
  const source = { id: 'draft-source', title: '草稿引用资料', summary: '用于恢复', content: '这是真实进入上下文的引用内容', source: '本地演示' };
  await page.addInitScript(value => {
    if (localStorage.getItem('qianwen-workspace-v1')) return;
    localStorage.setItem('qianwen-workspace-v1', JSON.stringify({ version: 1, activeId: 'a', useTools: true, thinking: false, conversations: [
      { id: 'a', title: '会话甲', updatedAt: 2, messages: [{ id: 'u1', role: 'user', content: '原问题', status: 'done', createdAt: 1 }], draft: { text: '甲的草稿', sources: [value] } },
      { id: 'b', title: '会话乙', updatedAt: 1, messages: [], draft: { text: '乙的草稿', sources: [] } },
    ] }));
  }, source);
  const requests: ChatRequest[] = [];
  await page.route('**/api/chat', async route => { requests.push(route.request().postDataJSON()); await reply(route, '发送成功'); });
  await page.goto('/');
  await expect(page.getByTestId('message-input')).toHaveValue('甲的草稿');
  await expect(page.getByTestId('source-context')).toContainText(source.title);
  await page.locator('.conversation-button').filter({ hasText: '会话乙' }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('乙的草稿');
  await expect(page.getByTestId('source-context')).toHaveCount(0);
  await page.getByTestId('message-input').fill('乙修改后尚未发送');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('qianwen-workspace-v1')!).conversations.length)).toBe(3);
  await expect(page.getByTestId('message-input')).toHaveValue('');
  await page.locator('.conversation-button').filter({ hasText: '会话乙' }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('乙修改后尚未发送');
  await page.locator('.conversation-button').filter({ hasText: '会话甲' }).click();
  await page.getByTestId('message-input').fill('甲也修改后尚未发送');
  await page.reload();
  await expect(page.getByTestId('message-input')).toHaveValue('甲也修改后尚未发送');
  await expect(page.getByTestId('source-context')).toContainText(source.title);
  await page.screenshot({ path: 'docs/screenshots/round5-drafts.png', fullPage: true });
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message')).toContainText('发送成功');
  expect(requests[0].messages.at(-1)?.content).toContain(source.content);
  await expect(page.getByTestId('message-input')).toHaveValue('');
  await expect(page.getByTestId('source-context')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('message-input')).toHaveValue('');
  await page.locator('.conversation-button').filter({ hasText: '会话乙' }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('乙修改后尚未发送');
});

test('editing and regeneration never move or consume the original conversation draft', async ({ page }) => {
  await page.route('**/api/chat', route => reply(route, '分支回答'));
  await page.goto('/');
  await send(page, '原问题');
  await page.getByTestId('message-input').fill('原会话未发送草稿');
  await page.getByTestId('edit-message').click();
  await page.getByTestId('message-input').fill('待编辑提交');
  await page.reload();
  await expect(page.getByTestId('message-input')).toHaveValue('原会话未发送草稿');
  await expect(page.getByTestId('editing-banner')).toHaveCount(0);
  await page.getByTestId('regenerate-response').click();
  await expect(page.getByTestId('branch-origin')).toBeVisible();
  await expect(page.getByTestId('message-input')).toHaveValue('');
  await page.getByRole('button', { name: '查看原对话' }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('原会话未发送草稿');
  await page.getByTestId('edit-message').click();
  await send(page, '编辑后发送');
  await page.getByRole('button', { name: '查看原对话' }).click();
  await expect(page.getByTestId('message-input')).toHaveValue('原会话未发送草稿');
});

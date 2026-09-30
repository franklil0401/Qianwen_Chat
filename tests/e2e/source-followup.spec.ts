import { expect, test } from '@playwright/test';
import type { ChatRequest } from '../../shared/types';

test('a follow-up retains prior web sources while fresh search is disabled', async ({ page }) => {
  const requests: ChatRequest[] = [];
  const source = { id: '1', title: '千问官方接口文档', url: 'https://help.aliyun.com/zh/model-studio/', siteName: '阿里云' };
  await page.route('**/api/chat', async route => {
    const request = route.request().postDataJSON() as ChatRequest;
    requests.push(request);
    const events = requests.length === 1
      ? [{ type: 'sources', sources: [source] }, { type: 'text-delta', delta: '这里是之前检索到的资料[1]。' }, { type: 'done', reason: 'stop' }]
      : [{ type: 'text-delta', delta: `之前第 1 个来源是：[千问官方接口文档](${source.url})，本轮没有重新搜索。` }, { type: 'done', reason: 'stop' }];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify({ ...event, runId: request.runId, conversationId: request.conversationId, messageId: request.messageId })}\n\n`).join('') });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '联网搜索', exact: true }).click();
  await page.getByTestId('message-input').fill('查找官方资料');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('search-sources')).toContainText('1 个网页来源');
  await page.reload();
  await expect(page.getByTestId('assistant-message')).toHaveCount(1);
  await page.getByRole('button', { name: '联网搜索', exact: true }).click();
  await page.getByTestId('message-input').fill('刚才第1个来源的链接是什么？');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message').last()).toContainText('本轮没有重新搜索');
  expect(requests[1].webSearch).toBe(false);
  expect(requests[1].messages.find(message => message.role === 'assistant')?.searchSources).toEqual([source]);
  await expect(page.getByTestId('assistant-message').last().getByRole('link')).toHaveAttribute('href', source.url);
  await expect(page.getByTestId('assistant-message').last().getByTestId('search-sources')).toHaveCount(0);
});

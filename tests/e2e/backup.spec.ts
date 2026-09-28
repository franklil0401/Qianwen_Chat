import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const original = { id: 'original', title: '原有会话', updatedAt: 1, draft: { text: '不能被覆盖的草稿', sources: [] }, messages: [
  { id: 'u1', role: 'user', content: '原有问题', status: 'done', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: '原有回答', status: 'done', createdAt: 2 },
] };
const backupFile = (conversations: unknown[]) => Buffer.from(JSON.stringify({ format: 'qianwen-chat-backup', version: 1, exportedAt: '2026-09-28T12:00:00.000Z', conversations }));

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { configured: true, model: 'qwen-plus', tools: [] } }));
  await page.addInitScript(conversation => {
    if (localStorage.getItem('qianwen-workspace-v1')) return;
    localStorage.setItem('qianwen-workspace-v1', JSON.stringify({ version: 1, activeId: conversation.id, conversations: [conversation], useTools: true, thinking: false }));
  }, original);
});

test('export and explicit import preserve original chats and drafts without calling the model', async ({ page }) => {
  let chatCalls = 0;
  await page.route('**/api/chat', route => { chatCalls++; return route.abort(); });
  await page.goto('/');
  await page.locator('.backup-controls > summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出全部会话' }).click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!);
  const json = JSON.parse(contents.toString());
  expect(json.format).toBe('qianwen-chat-backup');
  expect(json.conversations[0].draft.text).toBe(original.draft.text);
  expect(json.conversations[0].messages).toHaveLength(2);
  await page.getByTestId('backup-file-input').setInputFiles({ name: 'exported.json', mimeType: 'application/json', buffer: contents });
  await expect(page.getByTestId('backup-preview')).toContainText('新增会话');
  await expect(page.getByTestId('backup-preview')).toContainText('标识重复');
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  if (process.env.UPDATE_SCREENSHOTS === '1') await page.screenshot({ path: 'docs/screenshots/round7-backup.png', fullPage: true });
  await page.getByRole('button', { name: '确认导入备份' }).click();
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await expect(page.getByTestId('message-input')).toHaveValue(original.draft.text);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('qianwen-workspace-v1')!));
  expect(new Set(saved.conversations.map((c: { id: string }) => c.id)).size).toBe(2);
  expect(saved.conversations.find((c: { id: string }) => c.id === 'original').messages.map((m: { content: string }) => m.content)).toEqual(['原有问题', '原有回答']);
  expect(chatCalls).toBe(0);
});

test('invalid backups and cancelled previews leave current conversations untouched', async ({ page }) => {
  await page.goto('/');
  await page.locator('.backup-controls > summary').click();
  await page.getByTestId('backup-file-input').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: backupFile([{ ...original, messages: [{ ...original.messages[0], sources: {} }] }]) });
  await expect(page.locator('.backup-error')).toContainText('未导入任何会话');
  await expect(page.getByTestId('backup-preview')).toHaveCount(0);
  await page.getByTestId('backup-file-input').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: backupFile([original]) });
  await expect(page.getByTestId('backup-preview')).toBeVisible();
  await page.getByRole('button', { name: '取消导入' }).click();
  await expect(page.getByTestId('backup-preview')).toHaveCount(0);
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await expect(page.getByTestId('message-input')).toHaveValue(original.draft.text);
});

test('unfinished tool calls import as interrupted and failed storage rolls back the entire import', async ({ page }) => {
  const incoming = { ...original, id: 'incoming', title: '未完成的备份', messages: [original.messages[0], { ...original.messages[1], status: 'streaming', tools: [{ id: 't1', name: 'calculate', arguments: '{', status: 'receiving' }] }] };
  let chatCalls = 0;
  await page.route('**/api/chat', route => { chatCalls++; return route.abort(); });
  await page.goto('/');
  await page.locator('.backup-controls > summary').click();
  await page.getByTestId('backup-file-input').setInputFiles({ name: 'interrupted.json', mimeType: 'application/json', buffer: backupFile([incoming]) });
  await expect(page.getByTestId('backup-preview')).toContainText('标记为中断');
  await page.evaluate(() => { const originalSet = Storage.prototype.setItem; (window as unknown as { restoreStorage: () => void }).restoreStorage = () => { Storage.prototype.setItem = originalSet; }; Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: '确认导入备份' }).click();
  await expect(page.locator('.backup-error')).toContainText('未导入');
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { restoreStorage: () => void }).restoreStorage());
  await page.getByRole('button', { name: '确认导入备份' }).click();
  await expect(page.getByTestId('conversation-item')).toHaveCount(2);
  await page.locator('.conversation-button').filter({ hasText: '未完成的备份' }).click();
  await expect(page.getByTestId('tool-card')).toContainText('已取消');
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
  expect(chatCalls).toBe(0);
});

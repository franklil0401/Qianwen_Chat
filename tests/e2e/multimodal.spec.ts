import { expect, test, type Route } from '@playwright/test';
import type { ChatRequest, StreamEvent } from '../../shared/types';
import { redPng } from '../media-fixtures';

type Payload = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'runId' | 'conversationId' | 'messageId'> : never : never;
async function reply(route: Route, events: Payload[]) {
  const request = route.request().postDataJSON() as ChatRequest;
  const identity = { runId: request.runId, conversationId: request.conversationId, messageId: request.messageId };
  await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify({ ...identity, ...event })}\n\n`).join('') }).catch(() => undefined);
}
const answer: Payload[] = [{ type: 'text-delta', delta: '已经读取附件并生成回答。' }, { type: 'done', reason: 'stop' }];

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { configured: true, model: 'qwen-plus', tools: ['calculate', 'search_knowledge'], capabilities: { uploads: true, visionModel: 'qwen3-vl-plus', asrModel: 'qwen3-asr-flash', ttsModel: 'qwen3-tts-flash', webSearch: true, accountSync: true, deployment: 'local' } } }));
});

test('real document upload preserves draft, reaches history, and can be removed', async ({ page }) => {
  const requests: ChatRequest[] = [];
  await page.route('**/api/chat', async route => { requests.push(route.request().postDataJSON()); await reply(route, answer); });
  await page.goto('/');
  await page.getByTestId('message-input').fill('请根据文档回答');
  await page.getByTestId('attachment-input').setInputFiles({ name: '验收说明.txt', mimeType: 'text/plain', buffer: Buffer.from('项目代号是蓝鲸，版本是42。') });
  await expect(page.getByTestId('attachment-card')).toContainText('验收说明.txt');
  await page.reload();
  await expect(page.getByTestId('attachment-card')).toContainText('验收说明.txt');
  await expect(page.getByTestId('message-input')).toHaveValue('请根据文档回答');
  await page.getByText('查看文档摘要', { exact: true }).click();
  await expect(page.getByTestId('attachment-card')).toContainText('蓝鲸');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message')).toContainText('已经读取附件');
  expect(requests[0].messages.at(-1)?.attachments?.[0].name).toBe('验收说明.txt');
  await page.getByTestId('message-input').fill('继续');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  expect(requests[1].messages[0].attachments?.[0].id).toBe(requests[0].messages[0].attachments?.[0].id);
  await page.getByTestId('attachment-input').setInputFiles({ name: '待移除.md', mimeType: 'text/markdown', buffer: Buffer.from('# 临时文件') });
  await page.getByRole('button', { name: '移除附件：待移除.md', exact: true }).click();
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
});

test('image preview and filename fit inside the attachment card before and after sending', async ({ page }) => {
  await page.route('**/api/chat', route => reply(route, answer));
  await page.goto('/');
  await expect(page.getByTestId('attachment-input')).toBeEnabled();
  await page.getByTestId('attachment-input').setInputFiles({ name: '红色预览.png', mimeType: 'image/png', buffer: redPng() });
  for (let index = 0; index < 2; index++) {
    const card = page.getByTestId('attachment-card');
    await expect(card.locator('strong')).toHaveText('红色预览.png');
    const [box, label] = await Promise.all([card.boundingBox(), card.locator('strong').boundingBox()]);
    expect(label!.width).toBeGreaterThan(40);
    expect(label!.x + label!.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(label!.y + label!.height).toBeLessThanOrEqual(box!.y + box!.height);
    await expect.poll(() => card.locator('img').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    if (index === 0) {
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('assistant-message')).toContainText('已经读取附件');
    }
  }
});

test('bad formats and upload failures remain actionable without sending a message', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', route => { calls++; return reply(route, answer); });
  await page.goto('/');
  await expect(page.getByTestId('attachment-input')).toBeEnabled();
  await page.getByTestId('attachment-input').setInputFiles({ name: 'binary.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  await expect(page.getByRole('alert')).toContainText(/支持|格式/);
  await page.getByRole('button', { name: '关闭附件错误' }).click();
  await page.route('**/api/attachments', route => route.fulfill({ status: 413, json: { error: '当前用户的附件空间已满' } }));
  await page.getByTestId('attachment-input').setInputFiles({ name: '失败.txt', mimeType: 'text/plain', buffer: Buffer.from('内容') });
  await expect(page.getByTestId('attachment-transfer')).toContainText('附件空间已满');
  await expect(page.getByRole('button', { name: '重试上传：失败.txt' })).toBeEnabled();
  await page.getByRole('button', { name: '取消上传：失败.txt' }).click();
  await expect(page.getByTestId('attachment-transfer')).toHaveCount(0);
  expect(calls).toBe(0);
});

test('late upload cannot attach to another conversation', async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/attachments', async route => {
    await gate;
    await route.fulfill({ status: 201, json: { attachment: { id: 'late-file', name: '旧文件.txt', kind: 'document', mimeType: 'text/plain', size: 6, textPreview: '旧文件', extractedCharacters: 3 } } }).catch(() => undefined);
  });
  await page.goto('/');
  await expect(page.getByTestId('attachment-input')).toBeEnabled();
  await page.getByTestId('attachment-input').setInputFiles({ name: '旧文件.txt', mimeType: 'text/plain', buffer: Buffer.from('旧文件') });
  await expect(page.getByTestId('attachment-transfer')).toBeVisible();
  await page.keyboard.press('Control+k');
  release();
  await expect(page.getByTestId('attachment-card')).toHaveCount(0);
  await expect(page.getByTestId('attachment-transfer')).toHaveCount(0);
  await expect(page.getByTestId('message-input')).toHaveValue('');
});

test('web search sends preference and shows persistent real-source links', async ({ page }) => {
  let received: ChatRequest | undefined;
  await page.route('**/api/chat', route => {
    received = route.request().postDataJSON();
    return reply(route, [
      { type: 'sources', sources: [{ id: '1', title: '千问官方文档', url: 'https://help.aliyun.com/zh/model-studio/web-search/', siteName: '阿里云', snippet: '联网检索文档。' }] },
      { type: 'text-delta', delta: '可通过网页检索查看最新资料[1]。' },
      { type: 'done', reason: 'stop' },
    ]);
  });
  await page.goto('/');
  await page.getByRole('button', { name: /联网搜索/ }).click();
  await page.getByTestId('message-input').fill('搜索最新资料');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('search-sources')).toContainText('1 个网页来源');
  expect(received?.webSearch).toBe(true);
  await page.getByTestId('search-sources').locator('summary').click();
  await expect(page.getByRole('link', { name: '千问官方文档' })).toHaveAttribute('href', 'https://help.aliyun.com/zh/model-studio/web-search/');
  await expect(page.getByRole('link', { name: '千问官方文档' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.reload();
  await expect(page.getByTestId('search-sources')).toContainText('1 个网页来源');
  await expect(page.getByRole('button', { name: /联网搜索/ })).toHaveAttribute('aria-pressed', 'true');
});

test('record preview and transcription preserve typed draft; cancelling discards late results', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  let release: () => void = () => undefined;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/audio/transcriptions', async route => {
    calls++;
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    if (calls === 2) await gate;
    await route.fulfill({ json: { text: calls === 1 ? '这是语音识别内容' : '迟到语音不应出现' } }).catch(() => undefined);
  });
  await page.goto('/');
  await page.getByTestId('message-input').fill('原来的草稿');
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '开始语音输入' }).click();
    await expect(page.getByTestId('voice-recorder')).toContainText('录音');
    await page.waitForTimeout(400); // Allow MediaRecorder to produce a real fake-device WebM chunk.
    await page.getByRole('button', { name: '结束录音' }).click();
    await expect(page.getByLabel('录音预览')).toBeVisible();
    await page.getByRole('button', { name: '转成文字', exact: true }).click();
    if (index === 0) await expect(page.getByTestId('message-input')).toHaveValue(/原来的草稿[\s\S]*这是语音识别内容/);
    else {
      await expect.poll(() => calls).toBe(2);
      await page.getByRole('button', { name: '取消语音输入' }).click();
      release();
      await expect(page.getByTestId('message-input')).not.toHaveValue(/迟到语音/);
    }
  }
  await expect(page.getByRole('button', { name: '开始语音输入' })).toBeEnabled();
});

test('microphone permission failure leaves text composer usable', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await page.goto('/');
  await page.getByRole('button', { name: '开始语音输入' }).click();
  await expect(page.getByRole('alert')).toContainText('麦克风权限未开启');
  await page.getByTestId('message-input').fill('继续打字');
  await expect(page.getByTestId('send-button')).toBeEnabled();
});

test('speech can stop during synthesis and playback; switching conversation stops audio', async ({ page }) => {
  await page.route('**/api/chat', route => reply(route, answer));
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const wav = Buffer.alloc(44 + 16000 * 2 * 10);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/audio/speech', async route => {
    calls++;
    expect(route.request().postDataJSON().text).toContain('读取附件');
    if (calls === 1) await gate;
    await route.fulfill({ contentType: 'audio/wav', body: wav }).catch(() => undefined);
  });
  await page.goto('/');
  await page.getByTestId('message-input').fill('你好');
  await page.getByTestId('send-button').click();
  await page.getByRole('button', { name: '朗读回复' }).click();
  await expect.poll(() => calls).toBe(1);
  await page.getByRole('button', { name: '停止朗读' }).click();
  release();
  await expect(page.getByRole('button', { name: '朗读回复' })).toBeEnabled();
  await page.getByRole('button', { name: '朗读回复' }).click();
  await expect(page.getByRole('button', { name: '停止朗读' })).toContainText('正在朗读');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('button', { name: '停止朗读' })).toHaveCount(0);
});

import { _electron, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redPng, textPdf, textDocx } from '../tests/media-fixtures';

// Explicit opt-in command: connects the installed application to real Qwen APIs.
if (!process.env.Qianwen_api_key) throw new Error('请先配置 Qianwen_api_key');
const executablePath = process.env.QWEN_DESKTOP_EXECUTABLE;
if (!executablePath) throw new Error('请设置 QWEN_DESKTOP_EXECUTABLE 为待验收的桌面程序路径');
const profile = resolve('.local', `desktop-live-${Date.now()}`);
await mkdir(profile, { recursive: true });
await mkdir('docs/screenshots', { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({ executablePath: resolve(executablePath), args: ['--autoplay-policy=no-user-gesture-required'], chromiumSandbox: true, env: { ...env, QWEN_DESKTOP_USER_DATA: profile, QWEN_DESKTOP_TEST_HIDE: '1' }, timeout: 45_000 });
const page = await application.firstWindow();
const errors: string[] = [];
const report: { scenario: string; ok: boolean; detail: string }[] = [];
page.on('pageerror', error => errors.push(error.message));
async function screenshot(path: string) {
  const window = await application.browserWindow(page);
  await window.evaluate(window => window.webContents.setBackgroundThrottling(false));
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const base64 = await window.evaluate(async window => (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(path, Buffer.from(base64, 'base64'));
  await window.dispose();
}
async function check(scenario: string, action: () => Promise<string>) {
  try { const detail = await action(); report.push({ scenario, ok: true, detail }); console.log(`PASS ${scenario}: ${detail}`); }
  catch (error) { report.push({ scenario, ok: false, detail: error instanceof Error ? error.message : '未知错误' }); throw error; }
}
async function ask(prompt: string) {
  const before = await page.getByTestId('assistant-message').count();
  await page.getByTestId('message-input').fill(prompt);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-message')).toHaveCount(before + 1);
  await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 120_000 });
  const answer = page.getByTestId('assistant-message').last();
  await expect(answer.locator('.message-error')).toHaveCount(0);
  return answer;
}
try {
  await page.waitForURL('http://127.0.0.1:18439/');
  await expect(page.getByTestId('message-input')).toBeEnabled();
  await check('安装后图片及 PDF/DOCX 真实问答', async () => {
    await page.getByTestId('attachment-input').setInputFiles([
      { name: '红色样例.png', mimeType: 'image/png', buffer: redPng() },
      { name: '解析验证.pdf', mimeType: 'application/pdf', buffer: textPdf() },
      { name: '解析验证.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: textDocx() },
    ]);
    await expect(page.getByTestId('attachment-card')).toHaveCount(3);
    const answer = await ask('请说明图片主要颜色，并抄写两个文档正文中的验证代码，简短回答。');
    await expect(answer).toContainText('红');
    await expect(answer).toContainText('PDF_TEST_SECRET_7421');
    await expect(answer).toContainText('DOCX_TEST_SECRET_9357');
    await screenshot('docs/screenshots/desktop-multimodal.png');
    return '视觉回答红色；安装包内解析器和模型正确读取两份文档验证码';
  });
  await check('安装后回复朗读及停止', async () => {
    await page.getByRole('button', { name: '朗读回复' }).last().click();
    await expect(page.getByRole('button', { name: '停止朗读' })).toContainText('正在朗读', { timeout: 60_000 });
    await page.getByRole('button', { name: '停止朗读' }).click();
    await expect(page.getByRole('button', { name: '停止朗读' })).toHaveCount(0);
    return '真实合成音频已进入播放状态，停止后恢复按钮';
  });
  await page.keyboard.press('Control+k');
  await check('安装后计算与本地资料工具闭环', async () => {
    const answer = await ask('必须调用 calculate 计算 13*17，再调用 search_knowledge 检索本地“流式输出”资料，简短汇总结果。');
    await expect(answer).toContainText('221');
    await expect(answer.locator('.tool-card.tool-success')).toHaveCount(2);
    await screenshot('docs/screenshots/desktop-tools.png');
    return '计算结果221，本地资料工具从打包数据读取原文并完成回答';
  });
  await check('安装后真实联网来源', async () => {
    await page.getByRole('button', { name: '联网搜索', exact: true }).click();
    await ask('请联网查找阿里云千问模型的官方文档入口，简短回答。');
    const sources = page.getByTestId('search-sources').last();
    await expect(sources).toBeVisible();
    await sources.locator('summary').click();
    const count = await sources.getByRole('link').count();
    if (!count) throw new Error('未收到真实网页来源');
    await screenshot('docs/screenshots/desktop-web-search.png');
    await page.getByRole('button', { name: '联网搜索', exact: true }).click();
    return `${count} 条供应商返回的来源已渲染`;
  });
  await check('安装后语音合成与转写接口', async () => {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Qianwen-Client': 'web' }, body: JSON.stringify({ text: '你好，这是语音识别测试。' }) });
      if (!response.ok) throw new Error(`语音合成HTTP ${response.status}`);
      const blob = await response.blob();
      const form = new FormData(); form.append('file', blob, 'roundtrip.wav');
      const asr = await fetch('/api/audio/transcriptions', { method: 'POST', headers: { 'X-Qianwen-Client': 'web' }, body: form });
      const data = await asr.json();
      if (!asr.ok) throw new Error(data.error || `转写HTTP ${asr.status}`);
      return { bytes: blob.size, text: data.text as string };
    });
    expect(result.text).toContain('语音识别测试');
    return `${result.bytes} 字节真实音频成功转写`;
  });
  await check('安装后生成中停止', async () => {
    await page.getByTestId('message-input').fill('请写至少三千字的文章，介绍计算机网络发展史。');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('assistant-message').last().locator('.markdown')).not.toBeEmpty({ timeout: 90_000 });
    await page.getByTestId('stop-button').click();
    await expect(page.getByTestId('stop-button')).toHaveCount(0);
    await expect(page.getByTestId('send-button')).toBeDisabled();
    return '生成文本到达后立即停止，已有文本保留';
  });
  expect(errors).toEqual([]);
} finally {
  await writeFile('.local/desktop-live.json', JSON.stringify({ checkedAt: new Date().toISOString(), executablePath, profile, report, rendererErrors: errors }, null, 2));
  await application.close();
}

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { configured: true, model: 'qwen-plus', tools: [] } }));
});

test('appearance follows system changes and explicit preferences survive refresh', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
  await page.getByLabel('阅读设置与快捷键').click();
  await page.getByRole('radio', { name: '深色', exact: true }).check();
  await page.getByRole('radio', { name: '大号字号' }).check();
  await expect(page.getByRole('region', { name: '键盘快捷键' })).toContainText('Shift + Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('reading-settings')).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('阅读设置与快捷键')).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await expect(page.getByTestId('message-input')).toHaveCSS('font-size', '18px');
});

test('both themes keep tool summaries, reasoning and errors readable at desktop sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('qianwen-workspace-v1', JSON.stringify({ version: 1, activeId: 'reading', useTools: true, thinking: false, conversations: [{ id: 'reading', title: '阅读体验检查', updatedAt: 1, messages: [
      { id: 'u1', role: 'user', content: '解释流式输出，给出资料与代码。', status: 'done', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '### 更舒适的阅读\n正文和工具结果使用一致的阅读设置。\n\n```typescript\nconst stream = await fetch("/api/chat");\n```', reasoning: '先检索资料，再整理结构化说明。', status: 'done', createdAt: 2, tools: [
        { id: 't1', name: 'search_knowledge', arguments: '{}', status: 'success', result: { type: 'knowledge', query: '流式输出', items: [{ id: 's1', title: '流式输出与取消', summary: '事件解析与取消传播需要分别处理。', content: '原文内容。', source: '本地演示资料' }] } },
        { id: 't2', name: 'calculate', arguments: '{}', status: 'error', error: '测试错误状态：请完善计算表达式。', result: { type: 'error', message: '请完善计算表达式。' } },
      ] },
    ] }] }));
  });
  await page.goto('/');
  await page.locator('.reasoning-panel summary').click();
  for (const theme of ['浅色', '深色']) {
    await page.getByLabel('阅读设置与快捷键').click();
    await page.getByRole('radio', { name: theme, exact: true }).check();
    await page.getByRole('radio', { name: '大号字号' }).check();
    await page.keyboard.press('Escape');
    await expect(page.locator('.knowledge-summary')).toHaveCSS('font-size', '16px');
    await expect(page.locator('.reasoning-panel > div')).toHaveCSS('font-size', '16px');
    const contrasts = await page.evaluate(() => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (v: number[]) => v.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
      return ['.knowledge-summary', '.tool-success .tool-status', '.reasoning-panel > div', '.tool-error-message', '.markdown pre code'].map(selector => {
        const el = document.querySelector(selector)!;
        let ancestor: Element | null = el;
        let bg = 'rgb(255, 255, 255)';
        while (ancestor) { const candidate = getComputedStyle(ancestor).backgroundColor; if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') { bg = candidate; break; } ancestor = ancestor.parentElement; }
        const a = lum(rgb(getComputedStyle(el).color)); const b = lum(rgb(bg));
        return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    for (const item of contrasts) expect(item.ratio, `${theme} ${item.selector}`).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    if (process.env.UPDATE_SCREENSHOTS === '1') await page.screenshot({ path: `docs/screenshots/round6-${theme === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
  }
});

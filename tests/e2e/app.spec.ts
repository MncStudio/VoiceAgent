import { test, expect } from '@playwright/test';
test('文字对话、设置与响应式界面', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: '点按唤醒' })).toBeVisible();
  await page.getByRole('button', { name: '打开设置' }).click();
  await expect(page.getByRole('dialog')).toContainText('你好超宝');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('请只回答：你好，我是超宝。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.assistant')).toContainText('超宝', { timeout: 30000 });
  await expect(page.locator('.message.user')).toHaveCount(1);
  await page.screenshot({ path: '.runtime/desktop.png', fullPage: true });
  // 收起右侧面板只剩数字人，再展开
  await page.getByRole('button', { name: '收起面板' }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeHidden();
  await page.getByRole('button', { name: '展开面板' }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.runtime/mobile.png', fullPage: true });
  await page.getByRole('button', { name: '清空对话' }).click();
  await expect(page.getByRole('heading', { name: '你好，我是超宝', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

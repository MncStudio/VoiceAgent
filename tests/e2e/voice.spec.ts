import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
test('浏览器本地 KWS + VAD + CAM++ 和 WebRTC 语音往返', async () => {
  test.skip(
    process.env.VOICE_INTEGRATION !== '1',
    '需要运行 doctor 生成合成语音，并启动 LiveKit。',
  );
  test.setTimeout(60000);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve('.runtime/microphone.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG_VOICE === '1')
    page.on('websocket', (ws) => {
      if (ws.url().includes('/control')) {
        ws.on('framesent', (e) => {
          try {
            const m = JSON.parse(String(e.payload));
            if (['vad', 'speaker', 'wake'].includes(m.type)) console.log('TX', m);
          } catch {}
        });
        ws.on('framereceived', (e) => {
          try {
            const m = JSON.parse(String(e.payload));
            if (['state', 'transcript', 'error', 'wake-confirmed'].includes(m.type))
              console.log('RX', m);
          } catch {}
        });
      }
    });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('Browser error:', msg.text().slice(0, 300));
  });
  try {
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('button', { name: '连接麦克风', exact: true }).click();
    await expect(page.getByText('语音已连接', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(page.getByRole('dialog')).toContainText('Silero VAD · 本地', { timeout: 20000 });
    await expect(page.getByRole('dialog')).toContainText('你好超宝 · 本地', { timeout: 20000 });
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('.message.user')).toContainText('介绍', { timeout: 25000 });
    await expect(page.locator('.message.assistant')).not.toBeEmpty({ timeout: 25000 });
    const receivedAudio = await page.evaluate(async () => {
      const element = document.querySelector('audio');
      if (!element || !(element.srcObject instanceof MediaStream)) return 0;
      const ctx = new AudioContext();
      await ctx.resume();
      const node = ctx.createMediaStreamSource(element.srcObject);
      const analyser = ctx.createAnalyser();
      node.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let i = 0; i < 80; i++) {
        analyser.getFloatTimeDomainData(data);
        peak = Math.max(peak, ...data.map(Math.abs));
        if (peak > 0.005) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      node.disconnect();
      await ctx.close();
      return peak;
    });
    expect(receivedAudio).toBeGreaterThan(0.005);
    console.log('WebRTC 下行音频峰值:', receivedAudio);
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(page.getByRole('dialog')).toContainText('目标说话人已锁定');
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.screenshot({ path: '.runtime/voice-connected.png', fullPage: true });
    await expect
      .poll(() =>
        page
          .locator('audio')
          .evaluateAll((elements) =>
            elements.some((e) => e instanceof HTMLAudioElement && !e.paused && e.readyState >= 2),
          ),
      )
      .toBe(true);
    console.log('实际语音转写:', await page.locator('.message.user').allTextContents());
    expect(errors).toEqual([]);
    const mute = await page.getByRole('button', { name: '停止回答' }).evaluate((button) => {
      const started = performance.now();
      (button as HTMLButtonElement).click();
      return {
        ms: performance.now() - started,
        muted: [...document.querySelectorAll('audio')].every((e) => e.volume === 0),
      };
    });
    expect(mute.muted).toBe(true);
    expect(mute.ms).toBeLessThan(150);
    console.log('点按打断本地静音耗时:', mute.ms, 'ms');
    await page.getByRole('button', { name: '断开麦克风', exact: true }).click();
    await expect(page.getByText('语音未连接', { exact: true })).toBeVisible();
  } finally {
    await browser.close();
  }
});

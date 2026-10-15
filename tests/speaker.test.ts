import { describe, expect, it } from 'vitest';
import { fbank, trimSilence } from '../web/src/speaker';
describe('声纹特征前处理', () => {
  it('移除唤醒前静音，避免静音改变声纹 embedding', () => {
    const voice = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 7) * 0.2);
    const padded = new Float32Array(48000);
    padded.set(voice, 32000);
    const trimmed = trimSilence(padded);
    expect(trimmed.length).toBeLessThan(17000);
    expect(trimmed.length).toBeGreaterThanOrEqual(16000);
    expect(trimmed.slice(-16000)).toEqual(voice);
  });
  it('静音不产生有效说话人片段', () => {
    expect(trimSilence(new Float32Array(16000))).toHaveLength(0);
  });
  it('声纹输入是均值归一化的 80 维有限特征', () => {
    const features = fbank(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 7) * 0.2));
    expect(features.data.length).toBe(features.frames * 80);
    expect([...features.data].every(Number.isFinite)).toBe(true);
    for (let b = 0; b < 80; b++) {
      let mean = 0;
      for (let t = 0; t < features.frames; t++) mean += features.data[t * 80 + b] / features.frames;
      expect(Math.abs(mean)).toBeLessThan(0.0001);
    }
  });
});

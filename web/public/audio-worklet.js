// 48kHz → 16kHz 采集。先用加窗 sinc 低通（截止 7kHz）滤掉 8kHz 以上成分再抽取，
// 避免简单平均抽取把高频噪声混叠进语音频段，影响唤醒与声纹。
function lowpass(rate, cutoff, taps) {
  const h = new Float32Array(taps),
    mid = (taps - 1) / 2,
    fc = cutoff / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.integer = Number.isInteger(this.ratio);
    this.taps = this.integer ? lowpass(sampleRate, 7000, 63) : undefined;
    this.history = new Float32Array(this.taps ? this.taps.length : 0);
    this.pos = 0;
    this.skip = 0;
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
    this.samples = [];
  }
  emit(value) {
    this.samples.push(value);
    if (this.samples.length === 512) {
      const pcm = Float32Array.from(this.samples);
      this.port.postMessage(pcm, [pcm.buffer]);
      this.samples = [];
    }
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (this.taps) {
      const n = this.taps.length;
      for (const value of channel) {
        this.history[this.pos] = value;
        this.pos = (this.pos + 1) % n;
        if (++this.skip < this.ratio) continue;
        this.skip = 0;
        let acc = 0;
        for (let i = 0; i < n; i++) acc += this.taps[i] * this.history[(this.pos + i) % n];
        this.emit(acc);
      }
      return true;
    }
    // 非整数倍采样率时退回区间平均。
    for (const value of channel) {
      this.sum += value;
      this.count++;
      this.phase++;
      if (this.phase >= this.ratio) {
        this.emit(this.sum / this.count);
        this.phase -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMProcessor);

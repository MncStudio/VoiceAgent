import * as ort from 'onnxruntime-web/wasm';
import FFT from 'fft.js';
// CAM++ expects 16 kHz, 80-bin log-mel fbank, mean normalization, [batch,time,80].
// This frontend is isolated here so alternate CAM++ exports can replace their feature contract.
export function fbank(audio: Float32Array) {
  const frame = 400,
    hop = 160,
    size = 512,
    bins = 80;
  const n = Math.max(1, Math.floor((audio.length - frame) / hop) + 1);
  const out = new Float32Array(n * bins),
    fft = new FFT(size),
    spectrum = fft.createComplexArray();
  const mel = (h: number) => 1127 * Math.log(1 + h / 700);
  // 与 Kaldi / torchaudio.compliance.kaldi.fbank 一致：low_freq=20，high_freq=奈奎斯特(8000)，
  // 三角滤波在 mel 域线性插值，FFT 取 0..N/2-1 个频点。特征不一致会系统性拉低相似度。
  const low = mel(20),
    high = mel(8000);
  const edges = Array.from({ length: bins + 2 }, (_, i) => low + ((high - low) * i) / (bins + 1));
  const weights = Array.from({ length: bins }, (_, b) =>
    Float64Array.from({ length: size / 2 }, (_, k) => {
      const m = mel((k * 16000) / size);
      if (m <= edges[b] || m >= edges[b + 2]) return 0;
      return m <= edges[b + 1]
        ? (m - edges[b]) / (edges[b + 1] - edges[b])
        : (edges[b + 2] - m) / (edges[b + 2] - edges[b + 1]);
    }),
  );
  for (let t = 0; t < n; t++) {
    const windowed = new Float64Array(size);
    let mean = 0;
    for (let i = 0; i < frame; i++) mean += ((audio[t * hop + i] ?? 0) * 32768) / frame;
    for (let i = 0; i < frame; i++) {
      const value = (audio[t * hop + i] ?? 0) * 32768 - mean;
      const previous = (audio[t * hop + Math.max(0, i - 1)] ?? 0) * 32768 - mean;
      windowed[i] =
        (value - 0.97 * previous) *
        Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1)), 0.85);
    }
    fft.realTransform(spectrum, windowed);
    for (let b = 0; b < bins; b++) {
      let energy = 0;
      const w = weights[b];
      for (let k = 0; k < size / 2; k++)
        if (w[k]) energy += w[k] * (spectrum[2 * k] ** 2 + spectrum[2 * k + 1] ** 2);
      out[t * bins + b] = Math.log(Math.max(energy, 1e-10));
    }
  }
  for (let b = 0; b < bins; b++) {
    let mean = 0;
    for (let t = 0; t < n; t++) mean += out[t * bins + b] / n;
    for (let t = 0; t < n; t++) out[t * bins + b] -= mean;
  }
  return { data: out, frames: n };
}
export function trimSilence(audio: Float32Array) {
  const hop = 320,
    energy: number[] = [];
  for (let at = 0; at < audio.length; at += hop) {
    let sum = 0;
    for (let i = at; i < Math.min(audio.length, at + hop); i++) sum += audio[i] ** 2;
    energy.push(Math.sqrt(sum / hop));
  }
  const threshold = Math.max(0.001, Math.max(...energy) * 0.06);
  const first = energy.findIndex((v) => v > threshold);
  let last = energy.length - 1;
  while (last > first && energy[last] <= threshold) last--;
  if (first < 0) return new Float32Array();
  return audio.slice(Math.max(0, (first - 2) * hop), Math.min(audio.length, (last + 3) * hop));
}
export class SpeakerEncoder {
  private constructor(private session: ort.InferenceSession) {}
  static async create() {
    ort.env.wasm.wasmPaths = '/vendor/ort/';
    ort.env.wasm.numThreads = 1;
    return new SpeakerEncoder(
      await ort.InferenceSession.create('/models/speaker/cam++.onnx', {
        executionProviders: ['wasm'],
      }),
    );
  }
  async encode(audio: Float32Array) {
    audio = trimSilence(audio);
    if (audio.length < 8000) throw new Error('声纹片段过短');
    const features = fbank(audio),
      input = new ort.Tensor('float32', features.data, [1, features.frames, 80]);
    const result = await this.session.run({ [this.session.inputNames[0]]: input });
    const embedding = Float32Array.from(result[this.session.outputNames[0]].data as Float32Array);
    const norm = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
    return embedding.map((x) => x / Math.max(norm, 1e-10));
  }
  async similarity(audio: Float32Array, locked: Float32Array) {
    const e = await this.encode(audio);
    return e.reduce((sum, x, i) => sum + x * locked[i], 0);
  }
  /** 阈值来自服务端 SPEAKER_THRESHOLD（默认 0.5），需用真实录音标定。 */
  async matches(audio: Float32Array, locked: Float32Array, threshold = 0.5) {
    return (await this.similarity(audio, locked)) >= threshold;
  }
  async close() {
    await this.session.release();
  }
}

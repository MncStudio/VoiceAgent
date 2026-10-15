import { MicVAD } from '@ricky0123/vad-web';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import type { ClientEvent } from '../../shared/protocol';
export type AudioStatus = {
  kws: string;
  vad: string;
  noise: string;
  speaker: string;
  level: number;
};
export class MicrophonePipeline {
  private context?: AudioContext;
  private vad?: Awaited<ReturnType<typeof MicVAD.new>>;
  private worker?: Worker;
  private noise?: RnnoiseWorkletNode;
  private nodes: AudioNode[] = [];
  private status: AudioStatus = {
    kws: '加载中',
    vad: '加载中',
    noise: '加载中',
    speaker: '未启用',
    level: 0,
  };
  private stopped = false;
  private lastWake = 0;
  private recent: Float32Array[] = [];
  private locked?: Float32Array;
  private pendingLock?: Promise<Float32Array>;
  private speaker?: import('./speaker').SpeakerEncoder;
  private voiceEpoch = 0;
  private speaking = false;
  constructor(
    private send: (event: ClientEvent) => void,
    private update: (s: AudioStatus) => void,
    private onWake: () => void,
    private onStop: () => void,
  ) {}
  private report(patch: Partial<AudioStatus>) {
    Object.assign(this.status, patch);
    if (!this.stopped) this.update({ ...this.status });
  }
  async start(stream: MediaStream, assets: { kws: boolean; vad: boolean; speaker: boolean }) {
    this.context = new AudioContext({ sampleRate: 48000 });
    await this.context.resume();
    const source = this.context.createMediaStreamSource(stream);
    this.nodes.push(source);
    let processed: AudioNode = source;
    try {
      const wasmBinary = await loadRnnoise({
        url: '/vendor/rnnoise/rnnoise.wasm',
        simdUrl: '/vendor/rnnoise/rnnoise_simd.wasm',
      });
      await this.context.audioWorklet.addModule('/vendor/rnnoise/rnnoise-worklet.js');
      this.noise = new RnnoiseWorkletNode(this.context, { wasmBinary, maxChannels: 1 });
      source.connect(this.noise);
      processed = this.noise;
      this.nodes.push(this.noise);
      this.report({ noise: 'RNNoise · 本地' });
    } catch {
      this.report({ noise: '浏览器降噪' });
    }
    await this.context.audioWorklet.addModule('/audio-worklet.js');
    const capture = new AudioWorkletNode(this.context, 'pcm-capture');
    this.nodes.push(capture);
    processed.connect(capture);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    capture.connect(silent).connect(this.context.destination);
    this.nodes.push(silent);
    capture.port.onmessage = ({ data: pcm }: MessageEvent<Float32Array>) => {
      let energy = 0;
      for (const s of pcm) energy += s * s;
      this.report({ level: Math.min(1, Math.sqrt(energy / pcm.length) * 8) });
      this.recent.push(pcm.slice());
      if (this.recent.length > 94) this.recent.shift();
      if (this.worker) this.worker.postMessage({ type: 'audio', pcm }, [pcm.buffer]);
    };
    if (assets.speaker) {
      try {
        const { SpeakerEncoder } = await import('./speaker');
        this.speaker = await SpeakerEncoder.create();
        this.report({ speaker: '等待声纹锁定' });
      } catch {
        this.report({ speaker: '模型加载失败' });
      }
    } else this.report({ speaker: '未安装声纹模型' });
    if (assets.kws) {
      this.worker = new Worker('/kws-worker.js');
      this.worker.onmessage = async ({ data }) => {
        if (data.type === 'ready') this.report({ kws: '你好超宝 · 本地' });
        if (data.type === 'error') this.report({ kws: '不可用 · 请点按唤醒' });
        if (data.type === 'keyword') {
          if (Date.now() - this.lastWake < 1600) return;
          if (data.keyword === '你好超宝') {
            this.lastWake = Date.now();
            this.onWake();
            this.send({ type: 'wake', source: 'kws', at: Date.now() });
            if (this.speaker)
              this.pendingLock = this.speaker.encode(this.window()).catch(() => new Float32Array());
          } else {
            this.onStop();
            this.send({ type: 'interrupt', reason: data.keyword === '下一个' ? 'next' : 'stop' });
          }
        }
      };
      this.worker.onerror = () => this.report({ kws: '加载失败 · 请点按唤醒' });
      this.worker.postMessage({
        type: 'init',
        keywords:
          'n ǐ h ǎo ch āo b ǎo @你好超宝\nb ié sh uō l e @别说了\nz àn t íng @暂停\nx ià y ī g è @下一个',
      });
    } else this.report({ kws: '未安装 · 请点按唤醒' });
    if (assets.vad) {
      try {
        this.vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: '/vendor/vad/',
          onnxWASMBasePath: '/vendor/ort/',
          getStream: async () => stream,
          pauseStream: async () => {},
          resumeStream: async () => stream,
          positiveSpeechThreshold: 0.65,
          negativeSpeechThreshold: 0.4,
          minSpeechMs: 160,
          redemptionMs: 250,
          preSpeechPadMs: 300,
          onSpeechStart: () => {
            this.speaking = true;
            this.voiceEpoch++;
            this.send({ type: 'vad', speaking: true, target: false });
          },
          onVADMisfire: () => {
            this.speaking = false;
            this.voiceEpoch++;
            this.send({ type: 'vad', speaking: false, target: false });
          },
          onSpeechEnd: (audio) => {
            this.speaking = false;
            const epoch = this.voiceEpoch;
            void (async () => {
              const target =
                this.speaker && this.locked
                  ? await this.speaker.matches(audio, this.locked)
                  : false;
              if (!this.stopped && epoch === this.voiceEpoch)
                this.send({ type: 'vad', speaking: false, target });
            })();
          },
          onFrameProcessed: (probability) => {
            // Compare a rolling segment while speech is active, not after the entire utterance.
            if (
              this.speaking &&
              this.speaker &&
              this.locked &&
              probability.isSpeech > 0.65 &&
              this.status.level > 0.08
            )
              void this.checkTarget();
          },
        });
        await this.vad.start();
        this.report({ vad: 'Silero VAD · 本地' });
      } catch {
        this.report({ vad: '加载失败 · 服务端断句' });
      }
    } else this.report({ vad: '未安装 · 服务端断句' });
  }
  private checking = false;
  private checkedAt = 0;
  private async checkTarget() {
    if (this.checking || Date.now() - this.checkedAt < 500 || !this.locked || !this.speaker) return;
    this.checking = true;
    this.checkedAt = Date.now();
    const epoch = this.voiceEpoch;
    try {
      const match = await this.speaker.matches(this.window(24000), this.locked);
      if (!this.stopped && this.speaking && epoch === this.voiceEpoch) {
        this.send({ type: 'speaker', locked: true, match });
        if (match) this.send({ type: 'vad', speaking: true, target: true });
      }
    } catch {
      this.send({ type: 'speaker', locked: true, match: false });
    } finally {
      this.checking = false;
    }
  }
  private window(max = 48000) {
    const data = new Float32Array(this.recent.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.recent) {
      data.set(p, at);
      at += p.length;
    }
    return data.slice(-max);
  }
  async confirmWake() {
    const embedding = await this.pendingLock;
    if (!this.stopped && embedding?.length) {
      this.locked = embedding;
      this.report({ speaker: '目标说话人已锁定' });
      this.send({ type: 'speaker', locked: true, match: true });
    }
    this.pendingLock = undefined;
  }
  async close() {
    this.stopped = true;
    this.worker?.terminate();
    await this.vad?.destroy();
    this.nodes.forEach((n) => n.disconnect());
    this.noise?.destroy();
    await this.context?.close();
    await this.speaker?.close();
    this.recent = [];
    this.locked = undefined;
  }
}

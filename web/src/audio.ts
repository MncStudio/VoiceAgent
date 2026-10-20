import { MicVAD } from '@ricky0123/vad-web';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import type { ClientEvent } from '../../shared/protocol';
import { createWorker, serviceUrl } from './endpoint';
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
  /** 本段语音已持续的采样数（16kHz），用于只取开口之后的音频做声纹比对。 */
  private speechSamples = 0;
  /** 本段语音最近一次滚动比对的结果，说话结束时立即随 VAD 事件发出。 */
  private lastMatch = false;
  constructor(
    private send: (event: ClientEvent) => void,
    private update: (s: AudioStatus) => void,
    private onWake: () => void,
    private onStop: () => void,
    private policy: {
      /** 命令词只在播报/思考时生效，且不能是正在播报内容的回声。 */
      allowCommand: (keyword: string) => boolean;
      allowWake: () => boolean;
      /** 唤醒词文字（服务端 WAKE_WORD），也用作本地唤醒模型的关键词标签。 */
      wakeWord?: string;
      speakerThreshold: number;
      kws?: { threshold: number; boost: number; denoise: boolean; tokens?: string[] };
    } = { allowCommand: () => true, allowWake: () => true, speakerThreshold: 0.5 },
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
    if (this.policy.kws?.denoise === false)
      this.report({ noise: '浏览器降噪（唤醒不叠加 RNNoise）' });
    else
      try {
        const wasmBinary = await loadRnnoise({
          url: serviceUrl('/vendor/rnnoise/rnnoise.wasm'),
          simdUrl: serviceUrl('/vendor/rnnoise/rnnoise_simd.wasm'),
        });
        await this.context.audioWorklet.addModule(serviceUrl('/vendor/rnnoise/rnnoise-worklet.js'));
        this.noise = new RnnoiseWorkletNode(this.context, { wasmBinary, maxChannels: 1 });
        source.connect(this.noise);
        processed = this.noise;
        this.nodes.push(this.noise);
        this.report({ noise: 'RNNoise · 本地' });
      } catch {
        this.report({ noise: '浏览器降噪' });
      }
    await this.context.audioWorklet.addModule(serviceUrl('/audio-worklet.js'));
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
      if (this.speaking) this.speechSamples += pcm.length;
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
    // 旧版服务端不下发 tokens 时沿用默认唤醒词“你好超宝”。
    const wakeLabel = (this.policy.wakeWord || '你好超宝').replace(/\s+/gu, '');
    const wakeTokens = this.policy.kws?.tokens ?? ['n ǐ h ǎo ch āo b ǎo', 'n í h ǎo ch āo b ǎo'];
    if (assets.kws && !wakeTokens.length) this.report({ kws: `不支持“${wakeLabel}” · 请点按唤醒` });
    else if (assets.kws) {
      this.worker = createWorker('/kws-worker.js');
      this.worker.onmessage = async ({ data }) => {
        if (data.type === 'ready') this.report({ kws: `${wakeLabel} · 本地` });
        if (data.type === 'error') this.report({ kws: '不可用 · 请点按唤醒' });
        if (data.type === 'keyword') {
          if (Date.now() - this.lastWake < 1600) return;
          if (data.keyword === wakeLabel) {
            if (!this.policy.allowWake()) return;
            this.lastWake = Date.now();
            this.onWake();
            this.send({ type: 'wake', source: 'kws', at: Date.now() });
            // 只用唤醒词本身（命中前约 1.5 秒）锁定声纹，避免混入旁人说话和播报回声。
            if (this.speaker)
              this.pendingLock = this.speaker
                .encode(this.window(24000))
                .catch(() => new Float32Array());
          } else {
            if (!this.policy.allowCommand(data.keyword)) return;
            this.lastWake = Date.now();
            this.onStop();
            this.send({ type: 'interrupt', reason: data.keyword === '下一个' ? 'next' : 'stop' });
          }
        }
      };
      this.worker.onerror = () => this.report({ kws: '加载失败 · 请点按唤醒' });
      const { threshold, boost } = this.policy.kws ?? { threshold: 0.15, boost: 2 };
      this.worker.postMessage({
        type: 'init',
        keywords:
          // 唤醒词：放低阈值、提高加权，保证一级“宁可多报”。拼音由服务端按 WAKE_WORD 生成，
          // 含三声连读变调读法（如“你好”读 ní hǎo）。
          wakeTokens.map((t) => `${t} :${boost} #${threshold} @${wakeLabel}\n`).join('') +
          // 命令词短、易误报：单独提高触发阈值、降低加权。
          'b ié sh uō l e :1.0 #0.35 @别说了\n' +
          'z àn t íng :1.0 #0.45 @暂停\n' +
          'x ià y ī g è :1.0 #0.4 @下一个',
      });
    } else this.report({ kws: '未安装 · 请点按唤醒' });
    if (assets.vad) {
      try {
        this.vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: serviceUrl('/vendor/vad/'),
          onnxWASMBasePath: serviceUrl('/vendor/ort/'),
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
            this.speechSamples = 4800; // 含 preSpeechPadMs 的 300ms
            this.lastMatch = false;
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
            // 立即上报说话结束，断句不再等待声纹推理；整段声纹结果随后单独更新。
            this.send({ type: 'vad', speaking: false, target: this.lastMatch });
            if (!this.speaker || !this.locked) return;
            const speechMs = Math.max(0, Math.round(audio.length / 16) - 300);
            void this.speaker
              .similarity(audio, this.locked)
              .then((score) => {
                if (this.stopped || epoch !== this.voiceEpoch) return;
                const match = score >= this.policy.speakerThreshold;
                this.send({ type: 'speaker', locked: true, match, final: true, score, speechMs });
              })
              .catch(() => {});
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
    if (
      this.checking ||
      Date.now() - this.checkedAt < 400 ||
      !this.locked ||
      !this.speaker ||
      this.speechSamples < 12000
    )
      return;
    this.checking = true;
    this.checkedAt = Date.now();
    const epoch = this.voiceEpoch;
    try {
      // 只取开口之后的音频，避免把开口前的播报回声算进声纹。
      const match = await this.speaker.matches(
        this.window(Math.min(32000, this.speechSamples)),
        this.locked,
        this.policy.speakerThreshold,
      );
      if (!this.stopped && this.speaking && epoch === this.voiceEpoch) {
        this.lastMatch = match;
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

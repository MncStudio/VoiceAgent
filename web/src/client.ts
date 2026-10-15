import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from 'livekit-client';
import type { ClientEvent, ServerEvent } from '../../shared/protocol';
import { MicrophonePipeline, type AudioStatus } from './audio';
export type AppConfig = {
  provider: 'demo' | 'dashscope' | 'local';
  wakeWord: string;
  followupMs: number;
  configured: boolean;
  llmModel: string;
  asrModel: string;
  ttsModel: string;
  turnModel: string;
  speculative: boolean;
  speakerThreshold?: number;
  assets: { kws: boolean; vad: boolean; speaker: boolean };
};
export class AssistantClient {
  private id?: string;
  private ws?: WebSocket;
  private room?: Room;
  private mic?: LocalAudioTrack;
  private pipeline?: MicrophonePipeline;
  private elements = new Set<HTMLMediaElement>();
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private volume = 1;
  private closed = false;
  private heard = 0;
  private activeTurn?: string;
  private state = 'IDLE';
  private utterances: {
    text: string;
    turnId: string;
    offset: number;
    length: number;
    start: number;
    duration: number;
  }[] = [];
  private ticker?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private onEvent: (e: ServerEvent) => void,
    private onAudio: (s: AudioStatus) => void,
    private onLevel: (level: number) => void,
    /** 控制连接或语音连接意外断开时回调，由界面负责自动重连。 */
    private onLost: () => void = () => {},
  ) {}
  /** 正在（或即将）播报的句子里是否包含该词，用于识别命令词 / 唤醒词的回声误触发。 */
  private echoing(word: string) {
    const now = performance.now();
    return this.utterances.some(
      (u) => now >= u.start - 300 && now <= u.start + u.duration + 800 && u.text.includes(word),
    );
  }
  async connect() {
    const response = await fetch('/api/sessions', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '无法建立会话');
    this.id = result.id;
    this.ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control?session=${this.id}`,
    );
    this.ws.onmessage = ({ data }) => {
      const event = JSON.parse(data) as ServerEvent;
      if (event.type === 'state') this.state = event.state;
      if (event.type === 'duck') this.setVolume(event.active ? 0.2 : 1);
      if (event.type === 'wake-confirmed') {
        void this.pipeline?.confirmWake();
        this.chime();
      }
      if (event.type === 'interrupted') {
        this.stopPlayback();
        this.utterances = [];
      }
      if (event.type === 'utterance') {
        if (this.activeTurn !== event.turnId) {
          this.utterances = [];
          this.heard = 0;
          this.activeTurn = event.turnId;
        }
        this.stopped = false;
        this.setVolume(1);
        const previous = this.utterances.at(-1);
        this.utterances.push({
          text: event.text,
          turnId: event.turnId,
          offset: event.offset,
          length: event.text.length,
          start: Math.max(
            performance.now() + 100,
            previous ? previous.start + previous.duration : 0,
          ),
          duration: event.durationMs,
        });
      }
      if (event.type === 'done') {
        this.utterances = [];
        this.activeTurn = undefined;
      }
      if (event.type === 'alignment') {
        const index = this.utterances.findIndex(
          (u) => u.turnId === event.turnId && u.offset === event.offset,
        );
        if (index >= 0) {
          this.utterances[index].duration = event.durationMs;
          for (let i = index + 1; i < this.utterances.length; i++)
            this.utterances[i].start =
              this.utterances[i - 1].start + this.utterances[i - 1].duration;
        }
      }
      this.onEvent(event);
    };
    this.ws.onclose = () => {
      if (!this.closed) this.onLost();
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('会话连接超时。')), 10000);
      this.ws!.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.ws!.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('会话连接失败。'));
      };
    });
    this.ticker = setInterval(() => {
      if (this.analyser) {
        const data = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(data);
        this.onLevel(Math.min(1, Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length) * 5));
      }
      if (this.activeTurn && !this.stopped) {
        let heard = 0;
        for (const u of this.utterances)
          heard = Math.max(
            heard,
            u.offset +
              Math.floor(
                Math.min(1, Math.max(0, (performance.now() - u.start) / u.duration)) * u.length,
              ),
          );
        if (heard > this.heard) {
          this.heard = heard;
          this.send({ type: 'playback', turnId: this.activeTurn, heardChars: heard });
        }
      }
    }, 100);
  }
  send(event: ClientEvent) {
    if (event.type === 'text' || event.type === 'reset') this.stopPlayback();
    if (event.type === 'interrupt') {
      event = { ...event, heardChars: this.heard };
      this.stopPlayback();
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }
  private setVolume(value: number) {
    this.volume = value;
    this.elements.forEach((e) => {
      e.volume = this.stopped ? 0 : value;
    });
  }
  private chime() {
    if (!this.context || this.context.state !== 'running') return;
    const oscillator = this.context.createOscillator(),
      gain = this.context.createGain();
    oscillator.frequency.setValueAtTime(660, this.context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(880, this.context.currentTime + 0.08);
    gain.gain.setValueAtTime(0.035, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.14);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.15);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
  stopPlayback() {
    this.stopped = true;
    this.elements.forEach((e) => {
      e.volume = 0;
    });
  }
  async enableVoice(config: AppConfig) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('麦克风需要 localhost 或 HTTPS，请使用 Chrome / Edge。');
    try {
      this.mic = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      });
      const response = await fetch(`/api/sessions/${this.id}/voice`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      this.room = new Room({ adaptiveStream: false, dynacast: false });
      this.context = new AudioContext();
      await this.context.resume();
      this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (participant.identity !== `agent-${this.id}` || track.kind !== Track.Kind.Audio) return;
        // Keep WebRTC audio on the native HTML audio path for browser AEC reference.
        const element = track.attach();
        element.autoplay = true;
        element.volume = this.volume;
        document.body.appendChild(element);
        this.elements.add(element);
        void element.play().catch(() =>
          this.onEvent({
            type: 'error',
            message: '浏览器阻止自动播放，请点击页面后重新连接语音。',
          }),
        );
        const source = this.context!.createMediaStreamSource(
          new MediaStream([track.mediaStreamTrack]),
        );
        this.analyser = this.context!.createAnalyser();
        this.analyser.fftSize = 512;
        source.connect(this.analyser);
      });
      this.room.on(RoomEvent.Disconnected, () => {
        if (!this.closed && !this.disabling) this.onLost();
      });
      await this.room.connect(data.url, data.token);
      await this.room.startAudio();
      await this.room.localParticipant.publishTrack(this.mic);
      this.pipeline = new MicrophonePipeline(
        (e) => this.send(e),
        this.onAudio,
        () => {
          this.onEvent({ type: 'state', state: 'CANDIDATE' });
          this.setVolume(0.2);
        },
        () => this.stopPlayback(),
        {
          allowCommand: (keyword) =>
            (this.state === 'SPEAKING' || this.state === 'THINKING') && !this.echoing(keyword),
          allowWake: () => !this.echoing(config.wakeWord),
          speakerThreshold: config.speakerThreshold ?? 0.5,
        },
      );
      await this.pipeline.start(new MediaStream([this.mic.mediaStreamTrack]), config.assets);
    } catch (error) {
      await this.disableVoice();
      throw error;
    }
  }
  private disabling = false;
  private async disableVoice() {
    this.disabling = true;
    await this.pipeline?.close();
    this.pipeline = undefined;
    this.mic?.stop();
    this.mic = undefined;
    await this.room?.disconnect();
    this.room = undefined;
    this.elements.forEach((e) => e.remove());
    this.elements.clear();
    await this.context?.close();
    this.context = undefined;
    this.analyser = undefined;
    this.disabling = false;
  }
  async close() {
    this.closed = true;
    clearInterval(this.ticker);
    this.ws?.close();
    await this.disableVoice();
    if (this.id)
      await fetch(`/api/sessions/${this.id}`, { method: 'DELETE', keepalive: true }).catch(
        () => {},
      );
  }
}

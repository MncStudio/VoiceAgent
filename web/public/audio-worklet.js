class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
    this.samples = [];
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const ratio = sampleRate / 16000;
    for (const value of channel) {
      this.sum += value;
      this.count++;
      this.phase++;
      if (this.phase >= ratio) {
        this.samples.push(this.sum / this.count);
        this.phase -= ratio;
        this.sum = 0;
        this.count = 0;
        if (this.samples.length === 512) {
          const pcm = Float32Array.from(this.samples);
          this.port.postMessage(pcm, [pcm.buffer]);
          this.samples = [];
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMProcessor);

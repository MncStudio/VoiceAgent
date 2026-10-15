export class AudioRing {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(readonly maxBytes = 16000 * 2 * 3) {}
  push(chunk: Buffer) {
    this.chunks.push(Buffer.from(chunk));
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length) {
      const over = this.size - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= over) {
        this.size -= first.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(over);
        this.size -= over;
      }
    }
  }
  snapshot() {
    return Buffer.concat(this.chunks, this.size);
  }
  clear() {
    this.chunks = [];
    this.size = 0;
  }
}
export function rms(pcm: Buffer) {
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length / 2));
}
export function estimatedMarks(text: string, durationMs: number) {
  return Array.from(text).map((char, i, chars) => ({
    char,
    startMs: (i * durationMs) / chars.length,
    endMs: ((i + 1) * durationMs) / chars.length,
    estimated: true,
  }));
}
export function stripWake(text: string, wakeWord: string) {
  const pattern = wakeWord.split('').join('[\\s，。！？、]*');
  const match = new RegExp(pattern, 'u').exec(text);
  return match ? text.slice(match.index + match[0].length).replace(/^[，。！？、\s]+/u, '') : text;
}
export function isBackchannel(text: string) {
  return /^[嗯啊哦噢好对是的呀恩唔哈\s，。！？]*$/u.test(text);
}
export function incomplete(text: string) {
  return /(?:一个|一下|帮我|我想|然后|如果|因为|但是|的|和|或者|把|给|到|从)[，、\s]*$/u.test(text);
}

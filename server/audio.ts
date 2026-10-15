import { pinyin } from 'pinyin-pro';
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
// 唤醒词按“去声调 + 近音归一”的拼音比对：ASR 常把“超宝”写成“潮宝/朝宝/超保”，
// 只比对汉字会把正确的唤醒误判为失败。近音只合并常见的平翘舌、n/l、h/f 与前后鼻音。
const nearSound: [RegExp, string][] = [
  [/^zh/u, 'z'],
  [/^ch/u, 'c'],
  [/^sh/u, 's'],
  [/^l/u, 'n'],
  [/^f/u, 'h'],
  [/ang$/u, 'an'],
  [/eng$/u, 'en'],
  [/ing$/u, 'in'],
];
function normalizeSyllable(value: string) {
  return nearSound.reduce((s, [pattern, to]) => s.replace(pattern, to), value.toLowerCase());
}
/** 汉字音节及其在原字符串中的起止位置（UTF-16 下标）。非汉字字符被跳过。 */
export function syllables(text: string) {
  const chars: { char: string; start: number; end: number }[] = [];
  let at = 0;
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) chars.push({ char, start: at, end: at + char.length });
    at += char.length;
  }
  const spoken = chars.length
    ? (pinyin(chars.map((c) => c.char).join(''), { toneType: 'none', type: 'array' }) as string[])
    : [];
  return chars.map((c, i) => ({ ...c, sound: normalizeSyllable(spoken[i] ?? c.char) }));
}
export function findWake(text: string, wakeWord: string) {
  const target = syllables(wakeWord).map((s) => s.sound);
  const heard = syllables(text);
  if (!target.length) return undefined;
  for (let i = 0; i + target.length <= heard.length; i++)
    if (target.every((sound, j) => heard[i + j].sound === sound))
      return { start: heard[i].start, end: heard[i + target.length - 1].end };
  return undefined;
}
export function hasWake(text: string, wakeWord: string) {
  return !!findWake(text, wakeWord);
}
export function stripWake(text: string, wakeWord: string) {
  const match = findWake(text, wakeWord);
  return match ? text.slice(match.end).replace(/^[，。！？、,.!?\s]+/u, '') : text;
}
const plain = (text: string) => text.replace(/[\s\p{P}]/gu, '');
/** 识别结果是否只是正在播报内容的残余回声（浏览器 AEC 消不干净时的兜底）。 */
export function isEcho(heard: string, reference: string) {
  const a = plain(heard),
    b = plain(reference);
  if (a.length < 2 || !b) return false;
  if (b.includes(a)) return true;
  let hit = 0;
  for (let i = 0; i + 1 < a.length; i++) if (b.includes(a.slice(i, i + 2))) hit++;
  return hit / (a.length - 1) >= 0.6;
}
/**
 * 从 LLM 增量文本里切出下一段送 TTS。首段遇到逗号且满 6 字就先切，尽早出声；
 * 之后按句末标点切；超长时在 60 字内最后一个逗号处切。
 */
export function nextSegment(buffer: string, first: boolean) {
  const sentence = /^([\s\S]*?[。！？；!?;\n])/u.exec(buffer)?.[1];
  const clause = first ? /^([\s\S]{6,}?[，,、：:])/u.exec(buffer)?.[1] : undefined;
  if (sentence && clause) return clause.length < sentence.length ? clause : sentence;
  if (sentence || clause) return sentence ?? clause;
  if (buffer.length < 60) return undefined;
  const comma = Math.max(...['，', ',', '、'].map((c) => buffer.lastIndexOf(c, 59)));
  return buffer.slice(0, comma >= 10 ? comma + 1 : 60);
}
export function isBackchannel(text: string) {
  return /^[嗯啊哦噢好对是的呀恩唔哈\s，。！？]*$/u.test(text);
}
export function incomplete(text: string) {
  return /(?:一个|一下|帮我|我想|然后|如果|因为|但是|的|和|或者|把|给|到|从)[，、\s]*$/u.test(text);
}

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
// 本地唤醒模型（sherpa-onnx wenetspeech KWS）的建模单元：声母 + 带调韵母，y/w 也按声母切，
// 如“你好小圆” → n ǐ h ǎo x iǎo y uán。
const initials = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])(.+)$/u;
const toThird = new Map([...'ǎǒěǐǔǚ'].map((c, i) => [c, 'áóéíúǘ'[i]]));
function syllableTokens(syllable: string) {
  const m = initials.exec(syllable);
  return m ? [m[1], m[2]] : [syllable];
}
/** 唤醒词配置 → 列表：WAKE_WORD / WAKE_WORD_ALIASES 可用逗号、顿号或 | 分隔多个。 */
export function wakeList(value: string | readonly string[] | undefined) {
  const items = typeof value === 'string' ? value.split(/[,，、|]/u) : (value ?? []);
  return [...new Set(items.map((w) => w.replace(/\s+/gu, '')).filter(Boolean))];
}
/**
 * 唤醒词 → 本地唤醒模型的拼音 token 序列（每个元素是一种读法）。
 * 除标准读音外，再加三声连读变调的读法（“你好”实际读 ní hǎo），覆盖口语发音。
 * 传多个唤醒词时逐个生成后去重。
 */
export function kwsTokens(word: string | readonly string[]): string[] {
  if (typeof word !== 'string' || wakeList(word).length > 1)
    return [...new Set(wakeList(word).flatMap((w) => kwsTokens(w)))];
  const han = Array.from(word)
    .filter((c) => /\p{Script=Han}/u.test(c))
    .join('');
  if (!han) return [];
  const spoken = pinyin(han, { toneType: 'symbol', type: 'array' }) as string[];
  const third = (s: string) => [...s].some((c) => toThird.has(c));
  const sandhi = (s: string) => [...s].map((c) => toThird.get(c) ?? c).join('');
  const pairs = spoken.flatMap((s, i) => (third(s) && third(spoken[i + 1] ?? '') ? [i] : []));
  const variants = [
    spoken,
    // 每处三声连读单独变调，以及全部变调
    ...pairs.map((p) => spoken.map((s, i) => (i === p ? sandhi(s) : s))),
    spoken.map((s, i) => (pairs.includes(i) ? sandhi(s) : s)),
  ];
  return [...new Set(variants.map((v) => v.flatMap(syllableTokens).join(' ')))].slice(0, 4);
}
/** 本地唤醒拼音 token 行（如“n ǐ h ǎo x iǎo y uán”）→ 去声调、近音归一后的音节。 */
function tokenSounds(line: string) {
  const out: string[] = [];
  const tokens = line.trim().split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i];
    const joined =
      /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])$/u.test(head) && tokens[i + 1]
        ? head + tokens[++i]
        : head;
    const plain = joined
      .normalize('NFD')
      .replace(/u\u0308/gu, 'v')
      .replace(/[\u0300-\u036f]/gu, '');
    out.push(normalizeSyllable(plain));
  }
  return out;
}
/** 在音节序列里找目标音节，返回 [起点, 长度]。规则见 findWake。 */
function matchSounds(heard: readonly string[], target: readonly string[], loose: boolean) {
  const n = target.length;
  if (!n) return undefined;
  for (let i = 0; i + n <= heard.length; i++)
    if (target.every((sound, j) => heard[i + j] === sound)) return [i, n] as const;
  if (!loose || n < 4) return undefined;
  // 替换：一个音节听错，例如“你号超宝”“我好超宝”
  for (let i = 0; i + n <= heard.length; i++) {
    const wrong = target.filter((sound, j) => heard[i + j] !== sound).length;
    const tailOk = target.slice(-2).every((sound, j) => heard[i + n - 2 + j] === sound);
    if (wrong <= 1 && tailOk) return [i, n] as const;
  }
  // 漏字：例如“好超宝”“你超宝”
  for (let skip = 0; skip < n - 2; skip++) {
    const short = target.filter((_, j) => j !== skip);
    for (let i = 0; i + short.length <= heard.length; i++)
      if (short.every((sound, j) => heard[i + j] === sound)) return [i, short.length] as const;
  }
  return undefined;
}
// pinyin-pro 无声调输出里 ü 写作 ü，统一成 v，与 token 行一致。
const soundOf = (text: string) => syllables(text).map((s) => s.sound.replace(/ü/gu, 'v'));
/**
 * 在识别文本中定位唤醒词（可传多个唤醒词 / 近音写法，命中任意一个即可）。
 * loose=true 时（本地唤醒已命中后的复核）再容忍一个音节的识别错误或漏字，
 * 但唤醒词的最后两个音节（如“超宝”）必须完全对上；四个音节以下不放宽。
 * 多个唤醒词时先按严格匹配找，都没有才放宽；同一档内取最靠前的一个。
 */
export function findWake(text: string, wakeWord: string | readonly string[], loose = false) {
  const words = wakeList(wakeWord);
  const heard = syllables(text);
  const sounds = heard.map((s) => s.sound.replace(/ü/gu, 'v'));
  for (const mode of loose ? [false, true] : [false]) {
    let best: readonly [number, number] | undefined;
    for (const word of words) {
      const m = matchSounds(sounds, soundOf(word), mode);
      if (m && (!best || m[0] < best[0] || (m[0] === best[0] && m[1] > best[1]))) best = m;
    }
    if (best) return { start: heard[best[0]].start, end: heard[best[0] + best[1] - 1].end };
  }
  return undefined;
}
/**
 * 手动指定的本地唤醒拼音（WAKE_WORD_PINYIN）里，服务端复核认不出来的读法：
 * 这些读法本地会触发、但复核按 WAKE_WORD / WAKE_WORD_ALIASES 对不上，只会白白打断回答。
 */
export function unmatchedPinyin(lines: readonly string[], wakeWord: string | readonly string[]) {
  // 多音字（嗨 hāi/hēi、乐 lè/yuè）按所有读音展开，手写拼音对上任意一种读音即可。
  const readings = (word: string) =>
    Array.from(word)
      .filter((c) => /\p{Script=Han}/u.test(c))
      .reduce<string[][]>(
        (acc, c) => {
          const all = pinyin(c, { toneType: 'none', type: 'array', multiple: true }) as string[];
          const sounds = [...new Set(all.map((x) => normalizeSyllable(x).replace(/ü/gu, 'v')))];
          return acc.flatMap((prefix) => sounds.map((x) => [...prefix, x])).slice(0, 256);
        },
        [[]],
      );
  const targets = wakeList(wakeWord).flatMap(readings);
  return lines.filter((line) => {
    const heard = tokenSounds(line);
    return !targets.some((t) => matchSounds(heard, t, true));
  });
}
export function hasWake(text: string, wakeWord: string | readonly string[], loose = false) {
  return !!findWake(text, wakeWord, loose);
}
export function stripWake(text: string, wakeWord: string | readonly string[]) {
  const match = findWake(text, wakeWord, true);
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
/** 句尾是没说完的连接词 / 请求词（“帮我订一个”“如果”“还有”）。 */
const DANGLING =
  /(?:一个|一下|一些|帮我|我想|我要|然后|还有|以及|还是|关于|比如|如果|因为|但是|所以|或者|把|被|给|对于)$/u;
/** 句尾“的 / 和 / 到”等也可能是完整句（“红色的”），只稍等一下。 */
const WEAK = /(?:的|和|跟|与|到|从)$/u;
/**
 * 只有“动词”、还没说要查什么 / 做什么（“帮我查询”“我想查一下”“打开”），用户多半在想下文。
 * 动词前只允许请求类前缀，“把灯打开”“帮我查询库存”这类已带宾语的不算。
 */
const BARE_VERB = new RegExp(
  '^(?:你|您|请|请你|麻烦|麻烦你|帮我|帮忙|帮|给我|替我|我要|我想|我想要|我需要|想|要|再|去|能不能|可不可以|可以|能)*' +
    '(?:查询|查找|查看|查一查|查查|查|搜索|搜一搜|搜|找找|找|看看|看|打开|关闭|显示|统计|导出|打印|' +
    '问问|问|告诉我|说说|讲讲|介绍|算算|计算|安排|预订|订|设置|播放|放)(?:一下|下)?$',
  'u',
);
/**
 * 这句话是否还没说完：2 = 明显没说完（句尾连接词或只有动词），断句要多等用户想一想；
 * 1 = 可能没说完（句尾“的 / 和”），稍等；0 = 正常断句。
 */
export function incompleteLevel(text: string): 0 | 1 | 2 {
  const t = text.replace(/[\s，,、。.！!~～…]+$/u, '');
  if (DANGLING.test(t) || BARE_VERB.test(t)) return 2;
  return WEAK.test(t) ? 1 : 0;
}
export function incomplete(text: string) {
  return incompleteLevel(text) > 0;
}

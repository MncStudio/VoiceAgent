import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { config } from '../server/config.js';
import { createProviders } from '../server/providers/index.js';
const p = createProviders(config);
console.log(
  `运行环境 Node ${process.version}；Provider=${config.PROVIDER}；唤醒词=${config.WAKE_WORD}`,
);
for (const [name, file] of Object.entries({
  KWS: 'web/public/models/kws/sherpa-onnx-wasm-web.wasm',
  VAD: 'web/public/vendor/vad/silero_vad_v5.onnx',
  CAM: 'web/public/models/speaker/cam++.onnx',
}))
  console.log(`${name}: ${existsSync(file) ? '已安装' : '未安装'}`);
const livekit = await new Promise<boolean>((resolve) => {
  const url = new URL(config.LIVEKIT_INTERNAL_URL);
  const s = createConnection({ host: url.hostname, port: Number(url.port || 7880) });
  s.setTimeout(1500);
  s.on('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.on('timeout', () => {
    s.destroy();
    resolve(false);
  });
});
console.log(`LiveKit: ${livekit ? '端口可连接' : '未启动'}`);
if (config.PROVIDER === 'demo') process.exit(0);
let failed = false;
for (const test of ['LLM', 'TTS', 'ASR']) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    if (test === 'LLM') {
      let count = 0;
      for await (const delta of p.llm.chat(
        [{ role: 'user', content: '请只回复：连接成功' }],
        abort.signal,
      ))
        count += delta.length;
      if (!count) throw new Error('没有文本');
      console.log('LLM: 实际流式调用成功');
    }
    if (test === 'TTS') {
      const chunks: Buffer[] = [];
      for await (const pcm of p.tts.synth('你好超宝，介绍一下你自己。', abort.signal))
        chunks.push(pcm);
      const pcm = Buffer.concat(chunks);
      if (!pcm.length) throw new Error('没有音频');
      mkdirSync('.runtime', { recursive: true });
      writeFileSync('.runtime/speech-24k.pcm', pcm);
      console.log(`TTS: 实际合成成功（${pcm.length} bytes）`);
    }
    if (test === 'ASR') {
      await new Promise<void>(async (resolve, reject) => {
        let stream: Awaited<ReturnType<typeof p.asr.open>> | undefined;
        const timer = setTimeout(() => {
          stream?.close();
          reject(new Error('启动或识别超时'));
        }, 10000);
        try {
          stream = await p.asr.open(
            (result) => {
              if (result.text) {
                clearTimeout(timer);
                stream?.close();
                resolve();
              }
            },
            reject,
            abort.signal,
          );
          // If a TTS fixture exists, resample it and exercise actual recognition.
          if (existsSync('.runtime/speech-24k.pcm')) {
            const { readFileSync } = await import('node:fs');
            const input = readFileSync('.runtime/speech-24k.pcm');
            const output = Buffer.alloc(Math.floor(input.length / 3) * 2);
            for (let i = 0; i < output.length / 2; i++)
              output.writeInt16LE(input.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
            for (let i = 0; i < output.length; i += 3200)
              stream.write(output.subarray(i, i + 3200));
            stream.finish();
          } else {
            stream.write(Buffer.alloc(3200));
            stream.finish();
            setTimeout(() => {
              clearTimeout(timer);
              stream?.close();
              resolve();
            }, 2500);
          }
        } catch (e) {
          clearTimeout(timer);
          stream?.close();
          reject(e);
        }
      });
      console.log('ASR: 实际语音接口检查成功');
    }
  } catch (error) {
    failed = true;
    console.log(`${test}: ${error instanceof Error ? error.message : '检查失败'}`);
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
process.exitCode = failed ? 1 : 0;

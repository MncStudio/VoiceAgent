import { mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { download } from './download.mjs';
await mkdir('web/public/vendor/vad', { recursive: true });
for (const name of await readdir('node_modules/@ricky0123/vad-web/dist'))
  if (name.endsWith('.onnx') || name === 'vad.worklet.bundle.min.js')
    await cp(`node_modules/@ricky0123/vad-web/dist/${name}`, `web/public/vendor/vad/${name}`);
await mkdir('web/public/vendor/ort', { recursive: true });
for (const name of await readdir('node_modules/onnxruntime-web/dist'))
  if (name.endsWith('.wasm') || name.endsWith('.mjs'))
    await cp(`node_modules/onnxruntime-web/dist/${name}`, `web/public/vendor/ort/${name}`);
await mkdir('web/public/vendor/rnnoise', { recursive: true });
for (const name of ['rnnoise.wasm', 'rnnoise_simd.wasm'])
  await cp(
    `node_modules/@sapphi-red/web-noise-suppressor/dist/${name}`,
    `web/public/vendor/rnnoise/${name}`,
  );
await cp(
  'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js',
  'web/public/vendor/rnnoise/rnnoise-worklet.js',
);
console.log('Silero VAD / ONNX Runtime / RNNoise 已复制到本地，不依赖 CDN。');
// Official browser WASM from the upstream web package; no Flutter runtime required.
try {
  await mkdir('.runtime/sherpa-web', { recursive: true });
  await mkdir('web/public/models/kws', { recursive: true });
  if (!existsSync('.runtime/sherpa-web.tar.gz'))
    await download(
      'https://pub.dev/api/archives/sherpa_onnx_web-1.13.8.tar.gz',
      '.runtime/sherpa-web.tar.gz',
    );
  execFileSync('tar', ['-xf', '.runtime/sherpa-web.tar.gz', '-C', '.runtime/sherpa-web']);
  for (const name of ['sherpa-onnx-kws.js', 'sherpa-onnx-wasm-web.js', 'sherpa-onnx-wasm-web.wasm'])
    await cp(`.runtime/sherpa-web/assets/${name}`, `web/public/models/kws/${name}`);
  if (!existsSync('.runtime/kws-model.tar.bz2'))
    await download(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
      '.runtime/kws-model.tar.bz2',
    );
  execFileSync('tar', ['-xf', '.runtime/kws-model.tar.bz2', '-C', '.runtime']);
  const model = '.runtime/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
  for (const name of [
    'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
    'tokens.txt',
  ])
    await cp(`${model}/${name}`, `web/public/models/kws/${name}`);
  console.log('sherpa-onnx 本地唤醒模型已就绪。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
if (process.argv.includes('--speaker') && !existsSync('web/public/models/speaker/cam++.onnx')) {
  try {
    await download(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
      'web/public/models/speaker/cam++.onnx',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

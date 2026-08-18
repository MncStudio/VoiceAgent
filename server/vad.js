'use strict';

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');

// Silero VAD 静音裁剪:在转码后的 16kHz mono wav 上逐帧推理,
// 找出语音区间,裁掉首尾静音,输出干净的 wav 给 ASR。
//
// 模型:silero_vad_v5(ricky0123/vad 分发版),有状态:
//   输入 input [1,512] float32 / state [2,1,128] float32 / sr int64 标量
//   输出 output [1,1] 概率 / stateN(下一帧 state)
// 注意:snakers4 官方 silero_vad.onnx 在此环境推理异常,故用 v5 版。

const MODEL_PATH = path.join(__dirname, 'models', 'silero_vad.onnx');
const SAMPLE_RATE = 16000;
const WINDOW = 512; // 每帧样本数(约 32ms)
const STATE_SIZE = 128; // GRU 隐藏层宽度
const THRESHOLD = 0.5; // 概率高于此判为语音
const PAD_MS = 100; // 语音段前后各保留的静音,防止掐头去尾

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  }
  return sessionPromise;
}

// 解析 wav(稳健定位 data chunk)→ Int16Array 样本
function readWavSamples(wavPath) {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 44) throw new Error('音频文件不完整');
  let off = 12;
  let dataOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const channels = buf.readUInt16LE(off + 8 + 2);
      const sampleRate = buf.readUInt32LE(off + 8 + 4);
      if (sampleRate !== SAMPLE_RATE || channels !== 1) {
        throw new Error(`VAD 需要 16kHz 单声道,实际 ${sampleRate}Hz/${channels}ch`);
      }
    } else if (id === 'data') {
      dataOff = off + 8;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('未找到音频数据');
  const n = Math.floor((buf.length - dataOff) / 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2);
  return samples;
}

// 逐帧推理,返回每帧语音概率
async function frameProbs(samples, session) {
  const sr = new ort.Tensor('int64', new BigInt64Array([BigInt(SAMPLE_RATE)]), []);
  let state = new Float32Array(2 * STATE_SIZE).fill(0);
  const probs = [];
  for (let i = 0; i + WINDOW <= samples.length; i += WINDOW) {
    const f32 = new Float32Array(WINDOW);
    for (let j = 0; j < WINDOW; j++) f32[j] = samples[i + j] / 32768;
    const r = await session.run({
      input: new ort.Tensor('float32', f32, [1, WINDOW]),
      state: new ort.Tensor('float32', state, [2, 1, STATE_SIZE]),
      sr,
    });
    state = r.stateN.data;
    probs.push(r.output.data[0]);
  }
  return probs;
}

// 流式 VAD:有状态逐帧推理。feed(int16 块)内部缓存残差、跨块对齐 512 窗口,
// 每推理一帧回调 onFrame(prob, samples)(samples 是该帧 512 个 float32 样本)。
// 供 wake.js 唤醒检测用;trimSilence 整段裁剪仍用原逻辑。
async function createVadStream(onFrame) {
  const session = await getSession();
  const sr = new ort.Tensor('int64', new BigInt64Array([BigInt(SAMPLE_RATE)]), []);
  let state = new Float32Array(2 * STATE_SIZE).fill(0);
  let pending = new Float32Array(0);
  return {
    async feed(int16) {
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      const combined = new Float32Array(pending.length + f32.length);
      combined.set(pending);
      combined.set(f32, pending.length);
      const usable = combined.length - (combined.length % WINDOW);
      for (let i = 0; i < usable; i += WINDOW) {
        const samples = new Float32Array(combined.subarray(i, i + WINDOW));
        const r = await session.run({
          input: new ort.Tensor('float32', samples, [1, WINDOW]),
          state: new ort.Tensor('float32', state, [2, 1, STATE_SIZE]),
          sr,
        });
        state = r.stateN.data;
        onFrame(r.output.data[0], samples);
      }
      pending = combined.slice(usable);
    },
  };
}

// int16 样本 → 16k mono s16le wav
function samplesToWav(samples) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32); // blockAlign
  buf.writeUInt16LE(16, 34); // bitsPerSample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

// 裁掉首尾静音。若本来就没有多余静音,返回原路径(避免生成冗余文件)。
async function trimSilence(wavPath) {
  const session = await getSession();
  const samples = readWavSamples(wavPath);
  const probs = await frameProbs(samples, session);

  const speech = [];
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > THRESHOLD) speech.push(i);
  }
  if (speech.length === 0) {
    throw new Error('未检测到有效语音');
  }

  const padSamples = Math.round((SAMPLE_RATE * PAD_MS) / 1000);
  const first = Math.max(0, speech[0] * WINDOW - padSamples);
  const last = Math.min(samples.length, (speech[speech.length - 1] + 1) * WINDOW + padSamples);

  if (first === 0 && last === samples.length) {
    return wavPath;
  }

  const outPath = wavPath.replace(/\.wav$/, '.vad.wav');
  fs.writeFileSync(outPath, samplesToWav(samples.slice(first, last)));
  return outPath;
}

module.exports = { trimSilence, samplesToWav, createVadStream };

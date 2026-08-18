'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(config.server.tmpDir, { recursive: true });

function tempPath(ext) {
  return path.join(config.server.tmpDir, `${crypto.randomUUID()}${ext}`);
}

// 把任意浏览器录音格式(webm/mp4/opus)转成 ASR 需要的 16k 单声道 wav。
// 用 execFile 数组参数,避免 shell 注入。
function transcodeToWav(inputPath) {
  return new Promise((resolve, reject) => {
    fs.stat(inputPath, (statErr, stat) => {
      if (statErr) {
        reject(new Error(`录音文件读取失败: ${statErr.message}`));
        return;
      }
      if (stat.size < 1000) {
        reject(new Error(`录音内容过短(${stat.size} 字节)，请重新录制`));
        return;
      }

      const outputPath = tempPath('.wav');
      execFile(
        'ffmpeg',
        [
          '-y', '-loglevel', 'error',
          '-err_detect', 'ignore_err', // 容错:轻微损坏的 webm 也尽量解
          '-i', inputPath,
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
          outputPath,
        ],
        { timeout: 30000 },
        (err) => {
          if (err) {
            reject(new Error(`ffmpeg 转码失败(录音可能太短或格式损坏): ${err.message}`));
          } else {
            resolve(outputPath);
          }
        }
      );
    });
  });
}

function cleanup(...paths) {
  for (const p of paths) {
    if (p) fs.rm(p, { force: true }, () => {});
  }
}

module.exports = { tempPath, transcodeToWav, cleanup };

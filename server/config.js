'use strict';

const fs = require('fs');
const path = require('path');

// 配置固定为 server/config/local.json —— 日常 npm start 直接加载它,不用管"配置名"。
// 内容(内网还是云、哪几个环节用什么 provider)由配置生成器按部署需要生成到这份文件即可。
// 想在一台机器上并存多套配置时,才用 VA_PROFILE=<名字> npm start 指向 server/config/{名字}.json(高级用法)。
// local.json 缺失 → 不崩:导出 __missing:true 兜底,index.js 进入"配置引导模式"
// (控制台报错 + 自动打开配置生成页,生成并下载 local.json 放进本目录后重启)。
const CONFIG_DIR = path.join(__dirname, 'config');

function listProfiles() {
  try {
    return fs.readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch { return []; }
}

const envProfile = process.env.VA_PROFILE ? String(process.env.VA_PROFILE).trim() : '';
const profile = envProfile || 'local';
const configPath = path.join(CONFIG_DIR, `${profile}.json`);

let config;
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.__missing = false;
} else {
  config = {
    profile,
    __missing: true,
    __candidates: listProfiles(),
    server: {
      // 引导模式没配置可读端口:默认 3000,可用 VA_PORT 覆盖
      port: Number(process.env.VA_PORT) || 3000,
      tmpDir: '/tmp/voiceagent',
    },
    wakeWords: [],
    wakeTimeout: 300,
  };
}
config.__profile = profile;
config.__profileSource = envProfile ? `VA_PROFILE=${envProfile}` : '默认 local.json';
module.exports = config;

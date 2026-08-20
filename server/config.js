'use strict';

const fs = require('fs');
const path = require('path');

// 按 profile 加载配置:server/config/{profile}.json
// profile 由环境变量 VA_PROFILE 指定,默认 local(本地 192 服务)
const profile = process.env.VA_PROFILE || 'local';
const configPath = path.join(__dirname, 'config', `${profile}.json`);

if (!fs.existsSync(configPath)) {
  throw new Error(`未找到配置 ${configPath},请参考 server/config/README.md 创建`);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
module.exports = config;

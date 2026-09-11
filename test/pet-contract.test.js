'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const petsDir = path.join(__dirname, '..', 'public', 'pets');
const metaPath = path.join(petsDir, 'demo.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const spritePath = path.join(petsDir, meta.sprite);

assert.ok(fs.existsSync(spritePath), 'demo.json 的 sprite 必须存在');
assert.strictEqual(path.parse(meta.sprite).name, path.parse(metaPath).name, 'PNG 与 JSON 必须同名');
assert.deepStrictEqual(meta.grid, { cols: 8, rows: 8 });

const png = fs.readFileSync(spritePath);
assert.strictEqual(png.toString('hex', 0, 8), '89504e470d0a1a0a', '标准样例必须是 PNG');
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
assert.strictEqual(width, height, '图集必须是正方形');
if (meta.safeCrop) {
  // 当前 demo 是待替换的旧素材；必须显式声明兼容裁边，不能静默伪装成标准素材。
  assert.ok(Object.values(meta.safeCrop).some((value) => value > 0), '旧素材必须声明有效 safeCrop');
} else {
  assert.strictEqual(width, 1024, '新标准样例宽度必须为 1024');
  assert.strictEqual(height, 1024, '新标准样例高度必须为 1024');
  assert.strictEqual(width % meta.grid.cols, 0);
  assert.strictEqual(height % meta.grid.rows, 0);
}

for (const name of ['idle', 'talk', 'wave', 'jump', 'failed', 'review', 'waiting', 'spare']) {
  const state = meta.states[name];
  assert.ok(state, `缺少状态 ${name}`);
  assert.ok(Number.isInteger(state.row) && state.row >= 0 && state.row < meta.grid.rows, `${name}.row 越界`);
  assert.ok(Number.isInteger(state.from) && Number.isInteger(state.to) && state.from >= 0 && state.from <= state.to && state.to < meta.grid.cols, `${name} 帧范围越界`);
}
assert.strictEqual(meta.states.talk.row, 1);
assert.strictEqual(meta.states.talk.from, 0);
assert.strictEqual(meta.states.talk.to, 7);

console.log('pet-contract.test.js 全部通过');

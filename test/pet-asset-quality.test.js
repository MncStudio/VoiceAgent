'use strict';

// 数字人精灵图集「质量验收」——纯静态图像分析,不需要浏览器、不依赖第三方库。
//
// 用法:
//   node test/pet-asset-quality.test.js            # 宽松(供 npm test 常驻):只报告,不判失败
//   node test/pet-asset-quality.test.js --strict   # 严格:任一质量项不达标即 exit 1
//   node test/pet-asset-quality.test.js --report   # 只打印实测数据
//
// 为什么有"宽松"模式:当前 public/pets/demo.png 是待替换的存量素材,已在 demo.json 里用
// safeCrop 显式声明兼容(与 pet-contract.test.js 的口径一致)。存量素材不该让 npm test 常红,
// 但问题必须**看得见** —— 所以宽松模式照样逐项打印不达标项。
// 替换成标准素材后应删除 safeCrop,此文件自动转为强制;也可随时用 --strict 看真实状态。
//
// ⚠️ 阈值来源:由 docs/pet-prompt.md 的标准 + 对存量素材的实测反推得到,**尚未**在一份
// 真正达标的素材上验证过。第一份合格素材到位后,若某项阈值过严,请按该素材的实际数值
// 微调阈值并把依据写进注释,不要盲目放宽。
// 相关文档:docs/pet-verification-handoff.md(浏览器验证清单 + 验收阈值 + 实测基线)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 判定常量 ----------
const CONTENT_ALPHA = 16; // alpha 大于此值算"有内容"
const EMPTY_ALPHA = 8;    // alpha 小于此值算"完全透明"
const DIFF_MIN = 40;      // RGB 差值和阈值,超过算"这一像素变了"
const EDGE_PAD = 2;       // 每格四周必须完全透明的像素宽度
const HEAD_BAND = 0.55;   // 头部 = 角色外接框上部的比例(用于跨帧比较,避开手/腿动作)
const FACE_BAND = 0.55;   // 面部下半区起点(张嘴只应发生在这里)

// ---------- 极简 PNG 解码(仅 8bit、非隔行、RGB/RGBA) ----------
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG(文件签名不符)');
  }
  let offset = 8;
  let header = null;
  const idats = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idats.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.interlace !== 0) throw new Error('不支持隔行(interlace)PNG');
  if (header.depth !== 8) throw new Error(`仅支持 8 位深,当前 ${header.depth} 位`);
  const channels = { 2: 3, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`仅支持 colorType 2(RGB)/6(RGBA),当前 ${header.colorType}`);
  if (!idats.length) throw new Error('PNG 没有 IDAT 数据');

  const stride = header.width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const expected = header.height * (stride + 1);
  if (raw.length < expected) throw new Error(`IDAT 解压后长度不足(${raw.length} < ${expected})`);

  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  const pixels = Buffer.alloc(header.height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    const line = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add;
      if (filter === 0) add = 0;
      else if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) add = paeth(a, b, c);
      else throw new Error(`未知的扫描线 filter:${filter}`);
      line[i] = (line[i] + add) & 0xff;
    }
    line.copy(pixels, y * stride);
    prev = line;
  }
  const alpha = (x, y) => (channels === 4 ? pixels[y * stride + x * 4 + 3] : 255);
  const rgb = (x, y) => { const o = y * stride + x * channels; return [pixels[o], pixels[o + 1], pixels[o + 2]]; };
  return { width: header.width, height: header.height, channels, alpha, rgb };
}

// ---------- 测量 ----------
function makeAnalyzer(img, grid) {
  const cellRect = (row, col) => {
    const x0 = Math.round(col * img.width / grid.cols), x1 = Math.round((col + 1) * img.width / grid.cols);
    const y0 = Math.round(row * img.height / grid.rows), y1 = Math.round((row + 1) * img.height / grid.rows);
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
  };
  // 矩形内(可限定纵向比例范围)内容的外接框
  const bboxIn = (rect, fromRatio = 0, toRatio = 1) => {
    const ya = rect.y0 + Math.floor(rect.h * fromRatio);
    const yb = rect.y0 + Math.ceil(rect.h * toRatio);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
    for (let y = ya; y < yb; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        if (img.alpha(x, y) > CONTENT_ALPHA) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (!count) return null;
    // 坐标统一返回"格内相对坐标",否则跨列比较时中心会差出整格宽度
    return {
      minX: minX - rect.x0, minY: minY - rect.y0, maxX: maxX - rect.x0, maxY: maxY - rect.y0,
      count, w: maxX - minX + 1, h: maxY - minY + 1,
      cx: (minX + maxX) / 2 - rect.x0, cy: (minY + maxY) / 2 - rect.y0,
    };
  };
  // 帧与帧之间"变了"的像素,可限定在某纵向区间内统计
  const diffCount = (rectA, rectB, fromRatio = 0, toRatio = 1) => {
    const n = Math.min(rectA.w, rectB.w), h = Math.min(rectA.h, rectB.h);
    const ya = Math.floor(h * fromRatio), yb = Math.ceil(h * toRatio);
    let count = 0;
    for (let y = ya; y < yb; y++) {
      for (let x = 0; x < n; x++) {
        const a = img.rgb(rectA.x0 + x, rectA.y0 + y);
        const b = img.rgb(rectB.x0 + x, rectB.y0 + y);
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > DIFF_MIN) count++;
      }
    }
    return count;
  };
  // 每格四周 EDGE_PAD 环内的不透明像素数(标准要求为 0)
  const edgePixels = (rect) => {
    let count = 0;
    for (let y = rect.y0; y < rect.y1; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        const nearEdge = (x - rect.x0) < EDGE_PAD || (rect.x1 - 1 - x) < EDGE_PAD
          || (y - rect.y0) < EDGE_PAD || (rect.y1 - 1 - y) < EDGE_PAD;
        if (nearEdge && img.alpha(x, y) > EMPTY_ALPHA) count++;
      }
    }
    return count;
  };
  return { cellRect, bboxIn, diffCount, edgePixels };
}

// 头部外接框(用角色外接框的上部 55% 再求框,避免手/腿动作污染"位置一致"的判定)
function headBBox(a, rect) {
  const full = a.bboxIn(rect, 0, 1);
  if (!full) return null;
  const from = full.minY / rect.h;
  const to = Math.min(1, (full.minY + full.h * HEAD_BAND) / rect.h);
  return a.bboxIn(rect, from, to);
}

const spread = (values) => (values.length ? Math.max(...values) - Math.min(...values) : 0);

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const REPORT_ONLY = args.includes('--report');

const petsDir = path.join(__dirname, '..', 'public', 'pets');
const metaPath = path.join(petsDir, 'demo.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const spritePath = path.join(petsDir, meta.sprite);
const img = decodePng(fs.readFileSync(spritePath));
const grid = meta.grid;
const analyzer = makeAnalyzer(img, grid);
const legacy = !!meta.safeCrop;

console.log(`分析 ${path.relative(process.cwd(), spritePath)} — ${img.width}×${img.height},网格 ${grid.cols}×${grid.rows},每格 ${(img.width / grid.cols).toFixed(2)}px`);

const results = [];
const advisors = [];
const record = (name, ok, detail, standard) => results.push({ name, ok, detail, standard });
const advisor = (name, detail) => advisors.push({ name, detail });

// 1. 尺寸:标准 1024×1024 且能被 8 整除
const sizeOk = img.width === 1024 && img.height === 1024
  && img.width % grid.cols === 0 && img.height % grid.rows === 0;
record('尺寸 1024×1024 且能被 8 整除', sizeOk,
  `${img.width}×${img.height}${img.width % grid.cols ? `(不能被 ${grid.cols} 整除,每格 ${(img.width / grid.cols).toFixed(2)}px)` : ''}`,
  '1024×1024,每格 128×128');

// 2. 不得越格:每格四周 EDGE_PAD 环必须完全透明
let worstEdge = -1, worstEdgeCell = '';
for (const [name, def] of Object.entries(meta.states)) {
  for (let col = def.from; col <= def.to; col++) {
    const n = analyzer.edgePixels(analyzer.cellRect(def.row, col));
    if (n > worstEdge) { worstEdge = n; worstEdgeCell = `${name} row${def.row} col${col}`; }
  }
}
record(`不得越格(每格四周 ${EDGE_PAD}px 全透明)`, worstEdge === 0,
  `最差格 ${worstEdgeCell} 环上有 ${worstEdge} 个不透明像素`, '每个状态行的每格均为 0');

// 3. 行内"角色尺度"必须一致 —— 只抓"某一帧被画大了"这个缺陷
//    不用"中心/高度必须一动不动"当硬判据:挥手抬臂、低头、张望都会合法地改变外接框
//    (存量素材上实测:wave 头部框宽变化 11px、failed 高度变化、waiting 中心 x 变化 14px 都是正常动作)。
//    所以硬判据取"行内头部框宽度的极差 ÷ 最小宽度",阈值 20%:
//    实测 jump 行是 60/120 = 50%(c3~c6 被画大了)→ 抓得住;wave 约 9%、failed 约 15% → 不误杀。
const SCALE_TOLERANCE = 0.20;
for (const [name, def] of Object.entries(meta.states)) {
  const heads = [];
  for (let col = def.from; col <= def.to; col++) {
    const head = headBBox(analyzer, analyzer.cellRect(def.row, col));
    if (head) heads.push(head);
  }
  if (heads.length < 2) { record(`行内尺度一致 · ${name} row${def.row}`, false, '有效帧不足'); continue; }
  const widths = heads.map((h) => h.w);
  const minW = Math.min(...widths);
  const ratio = (Math.max(...widths) - minW) / minW;
  record(`行内尺度一致 · ${name} row${def.row}`, ratio <= SCALE_TOLERANCE,
    `头部框宽 ${minW}~${Math.max(...widths)}px(极差 ${((ratio) * 100).toFixed(0)}%)`,
    `行内头部框宽度极差 ≤ ${SCALE_TOLERANCE * 100}%`);
  // 参考信息(不作判据):合法动作也会改变这些值
  advisor(`行内位置参考 · ${name} row${def.row}`,
    `头部中心 x 变化 ${spread(heads.map((h) => h.cx))}px、y 变化 ${spread(heads.map((h) => h.cy))}px、高度变化 ${spread(heads.map((h) => h.h))}px`);
}

// 4/5. 说话行:张口程度单调递增、且只有嘴在变
if (meta.states.talk) {
  const def = meta.states.talk;
  const baseRect = analyzer.cellRect(def.row, def.from);
  const baseFull = analyzer.bboxIn(baseRect, 0, 1);
  if (!baseFull) {
    record('说话行张口程度单调递增', false, '基准帧为空', 'col0 完全闭口');
  } else {
    const faceFrom = (baseFull.minY + baseFull.h * FACE_BAND) / baseRect.h;
    const openness = [];
    let outsideDiff = 0, pixelTotal = baseRect.w * baseRect.h;
    for (let col = def.from; col <= def.to; col++) {
      const rect = analyzer.cellRect(def.row, col);
      if (col === def.from) { openness.push(0); continue; }
      openness.push(analyzer.diffCount(baseRect, rect, faceFrom, 1));
      outsideDiff = Math.max(outsideDiff, analyzer.diffCount(baseRect, rect, 0, faceFrom));
    }
    const tol = Math.max(4, openness[openness.length - 1] * 0.02);
    const monotonic = openness.every((v, i) => i === 0 || v >= openness[i - 1] - tol);
    const rangeOk = openness[openness.length - 1] >= 3 * Math.max(openness[1] || 0, 50);
    record('说话行张口程度单调递增', monotonic && rangeOk,
      `张口像素 col0..col7 = ${openness.join(', ')}${monotonic ? '' : ' ← 有回落'}${rangeOk ? '' : ' ← 首末差距不足 3 倍'}`,
      '从 col0 到 col7 单调不减,且末帧 ≥ 3×(col1 或 50px)');
    const outsideRatio = outsideDiff / pixelTotal;
    record('说话行只有嘴在变', outsideRatio < 0.01,
      `面部之外的差异占比 ${(outsideRatio * 100).toFixed(2)}%(标准 <1%)`,
      '面部区域之外与 col0 的差异 < 该格总像素的 1%');
  }
}

// ---------- 输出 ----------
const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  console.log(`      ${r.detail}`);
  if (!r.ok && r.standard) console.log(`      标准:${r.standard}`);
}
console.log('');
console.log('  以下为参考信息(不作判据:挥臂/低头/张望等合法动作本来就会改变这些值):');
for (const a of advisors) console.log(`  · ${a.name}\n      ${a.detail}`);
console.log('');

if (REPORT_ONLY) process.exit(0);

if (!failed.length) {
  console.log('数字人图集质量验收:全部通过');
  process.exit(0);
}

if (legacy && !STRICT) {
  console.log(`[存量素材] demo.json 声明了 safeCrop ${JSON.stringify(meta.safeCrop)} → 视为待替换素材,`);
  console.log(`           ${failed.length} 项不达标(已在上方逐条列出),本模式不判失败。`);
  console.log('           替换标准素材并删除 safeCrop 后会自动转为强制;');
  console.log('           想立刻看真实结论:npm run check:asset(= --strict)');
  process.exit(0);
}

if (legacy) {
  console.log('[strict] demo.json 声明了 safeCrop(存量素材),但 --strict 下仍按新标准判定。');
}

console.error(`数字人图集质量验收不达标:${failed.length} 项`);
process.exit(1);

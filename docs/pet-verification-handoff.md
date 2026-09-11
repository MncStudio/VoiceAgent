# 数字人(pet)验证与素材验收 —— 交接与实测基线

> 给下一个要**在浏览器里验证数字人**、或要**替换形象素材**的人 / agent 用。
> 形象标准（唯一权威）在 [`pet-prompt.md`](pet-prompt.md)；本文**不重复标准内容**，只写「怎么验 / 判据 / 实测」。
>
> 基线：提交 `87aab42`；`public/pets/demo.png` md5 `5e51bfc19a91ef4930108835d40c471c`（**存量待替换素材**）。
> 本文所有数字都是在**这份文件**上实测的，不是估计。

## 1. 起服务与开日志

```bash
cd <repo> && npm start          # 端口见 server/config/local.json(当前 3000)
#   http://localhost:3000/pet.html   独立数字人页(「开始监听」「让 TA 说一句」按钮)
#   http://localhost:3000/           演示页,右下角同一个数字人
npm test                        # wake / voice-agent-audio / voicepet / pet-contract / pet-asset-quality / smoke
npm run check                   # 全量 node --check(含 HTML 内联 script)
npm run check:asset             # 素材质量严格验收(= pet-asset-quality.test.js --strict)
```

日志分级：控制台执行 `__voicePet.setLogLevel('frame')`，或 URL 加 `?petlog=frame`；`?petlog=off` 关闭。
`__voicePet` 是渲染器实例的全局句柄，`__voicePet.agent` 是 SDK 实例。

## 2. 浏览器验证清单

> **总原则：验「行为 / 数值」，不要验「接线」。**
> 之前有过教训：只断言了「`connect()` 被调用、`gain.value === 0`」就宣布通过，而真实行为是读到静音、嘴完全不动。
> 下面每条都给了可观测的数值判据。

### B1. 分析器是否真的读到音频（最高优先级）

`analyser` 只在**首次播放后**才存在 → 先点「让 TA 说一句」，再执行：

```js
const a = __voicePet.agent.analyser, buf = new Uint8Array(a.fftSize);
const t = setInterval(() => {
  a.getByteTimeDomainData(buf);
  let mn = 255, mx = 0, sum = 0;
  for (const v of buf) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
  console.log('analyser min', mn, 'max', mx, 'mean', +(sum / buf.length).toFixed(1));
}, 100);
// 说完 clearInterval(t)
```

- **通过**：说话期间 `max - min` 明显大于 5，且随语音起伏
- **失败**：恒为 `min 128 max 128 mean 128.0` → 分析器拿到静音（历史上嘴不动的元凶）
- 失败**不要**改回「gain=0 旁路」接法，那正是被否掉的错误实现；分析器必须串在 `_out → analyser → destination/_dest` 主通路里

### B2. `audioLevel`（PCM 通路）是否正常输出

```js
const lv = []; __voicePet.agent.on('audioLevel', v => lv.push(+v.toFixed(3)));
// 让 TA 说一句,播完后:
({ n: lv.length, max: Math.max(...lv), nonZero: lv.filter(v => v > 0).length, last: lv[lv.length - 1] })
```

- **通过**：`n > 0`、`max` 落在 0.05~1、`nonZero` 明显大于 0、`last === 0`（播完回静音）
- 这条**不依赖浏览器音频图实现**（SDK 按 PCM 被排入的播放时刻排程），所以它是口型的首选信号源

### B3. 口型帧号是否跟着音量走（代码层）

开着 `frame` 日志说一句话，看 `画帧:状态=talk row=1 col=N … 取第 N 帧`。

- **通过**：说话期间出现 **≥3 个不同帧号**，且大音量时帧号更大
- **关键区分**：帧号在变 = **代码通路正常**；画面上嘴是否真张开 = **取决于素材**。
  当前 `demo.png` 说话行 8 帧没有嘴型差异（见 §3），所以**帧号会变、嘴看不出动**——这属于素材问题，**不要当成代码 bug 去改算法**

### B4. 句间空窗不能提前结束 `speaking`

让它说一句**超过一句话**的回答。

- **通过**：播放期间 `speaking` 一直保持，只有音频真正播完才回 `idle`；不出现 `talk → idle` 之后又回 `talk` 的抖动
- **失败含义**：`_maybeFinish` 的结束条件被破坏（流式 TTS 句间有数秒合成空窗，此时 `_activeSources` 会暂时为空，**不能**据此判定结束）

### B5. 跳跃时长（真实时间轴，防 120Hz 双倍速）

`demo.json` 的 `jump` 是 `fps=10, from=0, to=7` → 8 帧 = **800ms**。点数字人后量两条日志的时间差：

```
状态 idle → jump …
状态 jump → idle ← 「jump」播放完成
```

- **通过**：间隔 **≈800ms（±20%）**，60Hz 与 120Hz 屏上一致
- 顺便记录 rAF 频率（用于解释结果）：
  ```js
  let c = 0, t0 = performance.now();
  (function f(){ c++; const e = performance.now() - t0;
    e < 1000 ? requestAnimationFrame(f) : console.log('rAF ≈', Math.round(c / (e / 1000)), 'Hz'); })();
  ```
- **失败**：120Hz 下约 400ms → 又退回了「每帧 += 常量」的计时（旧代码是 `_frameTime += 16.7`）

### B6. 交互不打断 + `review` 时序

- 说话**期间**点击数字人：**不应**跳到 jump（应被 `_isConversationBusy` 拦住），日志里不该出现 `→ jump`
- 回答时：**不应**在声音还在播时就切 review；顺序应为 `… talk → review ← 声音播放结束后轻点头`

### B7. 硬刷新后不应出现的告警

出现任何一条都要修（都来自渲染器的 `_warnOnce`）：

| 告警 | 含义 |
|---|---|
| `状态「x」未定义,已回退到待机帧` | JSON 的 states/mapping 缺状态 |
| `状态「x」帧范围越界,已夹到 …` | `from/to/row` 超出网格 |
| `口型分析器初始化失败:…` | 音频源不可用 |
| `形象列表加载失败:…` | `/api/pets` 或图片加载失败 |

## 3. 素材验收阈值 + 存量素材实测基线

### 3.1 存量素材（当前 demo.png）实测

| 项 | 实测 | 标准要求 |
|---|---|---|
| 尺寸 | **1254×1254**，每格 156.75px（非整数） | 1024×1024，每格 128×128 |
| 越格 · 行界 ±2px 内不透明像素 | **2276~3327 px / 条（每条行界都越）** | ≈0 |
| 越格 · 列界 ±2px | 0~118 px | ≈0 |
| jump 行角色框宽 | c0 122 → **c3/c4/c5 155~157（顶到左右格边）** | 行内宽高变化 ≤2px |
| jump 行中心 x | 92.5 → **77.0（漂移 15.5px）** | ≤2px（只允许垂直位移） |
| talk 行帧间差异 | 3670~5094px，**散布整格、集中度仅 0.097~0.125** | 差异须**集中在嘴部** |
| talk 行 vs 待机呼吸 | 集中度 0.091~0.101（**同量级 → 说明没有口型动画**） | 两者必须显著不同 |

因此 `demo.json` 里用 `safeCrop: { top: 6, left: 5 }` 遮住切格侵入，`pet-contract.test.js` 允许这种「显式声明兼容」的旧素材。

### 3.2 新素材的量化验收（**已实现**为 `test/pet-asset-quality.test.js`）

已串进 `npm test`，另有严格模式入口 `npm run check:asset`。零依赖（Node 内置 `zlib` 自己解 PNG）。
三种用法：默认宽松（存量素材不判失败，但逐条打印）、`--strict`（不达标即 exit 1）、`--report`（只打印数据）。

已实现的判据（**硬判据**：不达标即在 `--strict` 下失败）：

| 判据 | 阈值 |
|---|---|
| 尺寸 | 1024×1024，能被 8 整除 |
| 不得越格 | 每格四周 2px 环完全透明（alpha < 8） |
| 行内尺度一致 | 行内**头部框宽度极差 ÷ 最小宽度 ≤ 20%** |
| 说话行张口程度 | 从 col0 到 col7 单调不减，且末帧 ≥ 3×(col1 或 50px) |
| 说话行只有嘴变 | 面部（角色外接框下 45%）之外与 col0 的差异 < 该格像素的 1% |

**为什么"尺度"判据用 20% 极差、而不是"中心/高度必须一动不动"**：挥手抬臂、低头、张望都会合法地改变
外接框（存量素材实测：wave 头部框宽变化 9%、failed 中心 y 变化 27.5px、waiting 中心 x 变化 14px 都是正常动作）。
用"≤2px"会**误杀合法动作**。20% 极差能抓住真正的缺陷（存量 jump 行实测 **62%**，c3~c6 被画大），
同时不误杀上述合法动作。中心/高度变化降级为"参考信息"，只打印不判失败。

**当前状态（fail-first 证据齐全）**：对存量 `demo.png` 运行 `npm run check:asset` → **exit 1，5 项不达标**
（尺寸、越格、jump 行尺度 62%、说话行张口有回落、面部之外差异 8.73%）；
换新图并删除 `safeCrop` 后该命令变为强制通过。

> 阈值是从标准 + 实测反推的，**尚未在一份真正达标的素材上验证过**。第一份合格素材到位后，
> 若某项过严，请按该素材实际数值微调并把依据写进注释，不要盲目放宽。
> 实现提示：Node 里用内置 `zlib` 解 PNG 的 IDAT 并做反滤波即可，无第三方依赖。

## 4. 结论级事实：现在「说话嘴不动」到底怪谁

两个原因**叠加**，必须分开看，否则会改错地方：

1. **代码通路**：曾经读到静音（旁路被优化掉 + `speaking` 被句间空窗提前结束）→ **已修**，用 §2 的 B1~B4 验证。
2. **素材**：`demo.png` 的 talk 行 8 帧**没有嘴型差异**（差异散布整格，与待机呼吸同量级）→ **未解决，只能换图**（按 §3.2 验收）。

所以：**B3 显示帧号在变、但肉眼看不到嘴动 = 素材问题，不是代码问题。**

## 5. 已知坑（都踩过，别重踩）

1. **测行为，不测接线**。断言「调用了 connect」毫无意义，要断言数值 / 时序。
2. 分析器**不能挂在 gain=0 旁路**（Chromium 会优化掉该分支 → 恒读 128）；必须串在主通路。
3. `speaking` 的结束必须走 `_maybeFinish`，不能只看 `_activeSources.size === 0`。
4. 时间推进一律用真实 `delta` + 时间常数，**禁止「每帧 += 常量」**。
5. 发现问题要**同时管存量与未来**：运行时容忍旧素材 + 规范约束新素材，缺一不可。
6. **可测的确定性缺陷直接修并加断言**，不要只抛回给用户；只有手感 / 审美类才先问。
7. 验证必须**入库可重跑**（写在 /tmp 的一次性脚本，会话结束即失效，等于没验证）。
8. **不要新建平行文档**（曾出现 `docx/pet-sprite-skill.md` 与 `docs/pet-prompt.md` 并存，引出一堆引用改动与反复）。

## 6. 复现本文的测量

本文数字用 Pillow + numpy 在 PNG 上按 8×8 均分切格后统计得到，方法可复现：

- **越格**：统计每条格线 ±2px 内 `alpha > 16` 的像素数（标准应为 ≈0）
- **行内一致**：每格取角色 bbox（`alpha > 16` 的最小外接矩形），比较同行 8 帧的宽/高与中心坐标
- **talk 行单调/集中度**：以 col0 为基准求逐帧差异掩码（RGB 差值和 > 40），
  再看「最密的 28×28 窗口内差异数 ÷ 总差异数」——口型动画应集中度高（0.3+）且总面积小（几百 px；
  整体抖动则集中度 ~0.1 且散布整格）

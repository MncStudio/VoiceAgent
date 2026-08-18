'use strict';

// 链路耗时统计:打点记录每个步骤耗时,结束时统一打印,方便排查慢在哪一步。
// 用法:const t = new Timing('chat'); ... await x; t.mark('转码'); ...; t.log();
class Timing {
  constructor(label) {
    this.label = label;
    this.points = [];
    this.t0 = process.hrtime.bigint();
  }

  mark(name) {
    this.points.push({ name, ms: Number(process.hrtime.bigint() - this.t0) / 1e6 });
  }

  log() {
    let prev = 0;
    const parts = this.points.map((p) => {
      const step = p.ms - prev;
      prev = p.ms;
      return `${p.name}=${step.toFixed(0)}ms`;
    });
    console.log(`[timing] ${this.label}: ${parts.join(' | ')} | 总 ${prev.toFixed(0)}ms`);
  }
}

module.exports = { Timing };

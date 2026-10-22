import * as THREE from 'three';

export type Eyes = 'open' | 'happy' | 'sleep' | 'wide' | 'focus' | 'dizzy';
export type FaceState = {
  eyes: Eyes;
  /** 0 = 睁开，1 = 闭上 */
  blink: number;
  /** 0..1 说话张嘴幅度 */
  mouth: number;
  mouthKind: 'cat' | 'talk' | 'o';
  /** 视线偏移 -1..1 */
  lookX: number;
  lookY: number;
};

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const tex = (c: HTMLCanvasElement, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

/** 面罩上的发光表情：画在 Canvas 上，作为面罩的 emissiveMap。 */
export class FaceCanvas {
  readonly canvas = canvas(1024, 512);
  readonly texture = tex(this.canvas);
  private key = '';
  constructor(
    private glow: string,
    private accent: string,
  ) {}
  setColors(glow: string, accent: string) {
    this.glow = glow;
    this.accent = accent;
    this.key = '';
  }
  draw(f: FaceState) {
    const key = [
      f.eyes,
      f.blink.toFixed(2),
      f.mouth.toFixed(2),
      f.mouthKind,
      f.lookX.toFixed(2),
      f.lookY.toFixed(2),
    ].join();
    if (key === this.key) return;
    this.key = key;
    const ctx = this.canvas.getContext('2d')!;
    const W = 1024,
      H = 512;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const ex = f.lookX * 26,
      ey = f.lookY * 16;
    const eyeY = 225 + ey;
    ctx.save();
    ctx.shadowColor = this.glow;
    ctx.shadowBlur = 36;
    ctx.fillStyle = this.glow;
    ctx.strokeStyle = this.glow;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      const cx = 512 + side * 150 + ex;
      if (f.eyes === 'happy') {
        ctx.lineWidth = 26;
        ctx.beginPath();
        ctx.arc(cx, eyeY + 30, 50, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else if (f.eyes === 'sleep') {
        ctx.lineWidth = 20;
        ctx.beginPath();
        ctx.arc(cx, eyeY - 18, 48, Math.PI * 0.2, Math.PI * 0.8);
        ctx.stroke();
      } else if (f.eyes === 'dizzy') {
        ctx.lineWidth = 22;
        ctx.beginPath();
        const d = side < 0 ? 1 : -1;
        ctx.moveTo(cx - 34 * d, eyeY - 38);
        ctx.lineTo(cx + 34 * d, eyeY);
        ctx.lineTo(cx - 34 * d, eyeY + 38);
        ctx.stroke();
      } else {
        const wide = f.eyes === 'wide';
        const rx = f.eyes === 'focus' ? 58 : wide ? 54 : 46;
        const ry0 = f.eyes === 'focus' ? 22 : wide ? 74 : 62;
        const ry = Math.max(5, ry0 * (1 - f.blink));
        ctx.beginPath();
        ctx.ellipse(cx, eyeY, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        if (ry > 18) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.ellipse(cx - rx * 0.32, eyeY - ry * 0.38, rx * 0.26, ry * 0.22, -0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.arc(cx + rx * 0.3, eyeY + ry * 0.4, rx * 0.12, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = this.glow;
          ctx.shadowBlur = 36;
        }
      }
    }
    // 嘴巴
    ctx.shadowColor = this.accent;
    ctx.strokeStyle = this.accent;
    ctx.fillStyle = this.accent;
    const my = 352 + ey * 0.6,
      mx = 512 + ex * 0.6;
    if (f.mouthKind === 'talk' && f.mouth > 0.04) {
      ctx.beginPath();
      ctx.ellipse(mx, my, 20 + f.mouth * 10, 6 + f.mouth * 26, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.mouthKind === 'o') {
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.ellipse(mx, my, 15, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(mx - 38, my - 8);
      ctx.quadraticCurveTo(mx - 19, my + 18, mx, my - 6);
      ctx.quadraticCurveTo(mx + 19, my + 18, mx + 38, my - 8);
      ctx.stroke();
    }
    // 腮红
    ctx.lineWidth = 8;
    ctx.globalAlpha = 0.9;
    for (const side of [-1, 1]) {
      const bx = 512 + side * 248 + ex * 0.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(bx + (i - 1) * 20 + 7, 322);
        ctx.lineTo(bx + (i - 1) * 20 - 5, 344);
        ctx.stroke();
      }
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}

/** 浅色橡木桌面 */
export function woodTexture() {
  const c = canvas(2048, 1024),
    ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 1024);
  g.addColorStop(0, '#d8b892');
  g.addColorStop(1, '#cfae86');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2048, 1024);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 520; i++) {
    const y = rnd() * 1024,
      amp = 2 + rnd() * 10,
      freq = 0.002 + rnd() * 0.004,
      phase = rnd() * 6;
    ctx.strokeStyle = `rgba(${120 + rnd() * 40},${80 + rnd() * 30},${45 + rnd() * 20},${0.05 + rnd() * 0.12})`;
    ctx.lineWidth = 0.6 + rnd() * 2.4;
    ctx.beginPath();
    for (let x = 0; x <= 2048; x += 16) {
      const yy = y + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 3.1) * amp * 0.3;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  // 木节
  for (let i = 0; i < 6; i++) {
    const x = rnd() * 2048,
      y = rnd() * 1024;
    for (let r = 4; r < 34; r += 4) {
      ctx.strokeStyle = `rgba(110,70,40,${0.12 - r * 0.003})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 2.6, r * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 窗外天空（白天 / 夜晚） */
export function skyTexture(night: boolean) {
  const c = canvas(1024, 768),
    ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 768);
  if (night) {
    g.addColorStop(0, '#0d1230');
    g.addColorStop(0.7, '#27306a');
    g.addColorStop(1, '#4a3a6e');
  } else {
    g.addColorStop(0, '#7fbaf2');
    g.addColorStop(0.65, '#cfe6fb');
    g.addColorStop(1, '#f9eee8');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 768);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  if (night) {
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
      ctx.beginPath();
      ctx.arc(rnd() * 1024, rnd() * 420, 0.8 + rnd() * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowColor = '#fff4cf';
    ctx.shadowBlur = 60;
    ctx.fillStyle = '#fff6dc';
    ctx.beginPath();
    ctx.arc(760, 170, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.filter = 'blur(14px)';
    for (let i = 0; i < 7; i++) {
      const x = rnd() * 1024,
        y = 80 + rnd() * 260;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.ellipse(x + k * 34, y + Math.sin(k) * 10, 60, 30, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.filter = 'none';
  }
  // 远处城市（略虚化）
  ctx.filter = 'blur(3px)';
  for (let x = -20; x < 1044;) {
    const w = 50 + rnd() * 90,
      h = 120 + rnd() * 240;
    ctx.fillStyle = night ? '#1a1f45' : `rgba(150,175,215,${0.55 + rnd() * 0.3})`;
    ctx.fillRect(x, 768 - h, w, h);
    if (night)
      for (let wy = 768 - h + 14; wy < 760; wy += 22)
        for (let wx = x + 8; wx < x + w - 10; wx += 18)
          if (rnd() < 0.35) {
            ctx.fillStyle = `rgba(255,${200 + rnd() * 40},${120 + rnd() * 60},0.9)`;
            ctx.fillRect(wx, wy, 8, 10);
          }
    x += w + 6;
  }
  ctx.filter = 'none';
  return tex(c);
}

/** 显示器上的库存看板 */
export function screenTexture() {
  const c = canvas(1024, 600),
    ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 1024, 600);
  g.addColorStop(0, '#f6f7fb');
  g.addColorStop(1, '#eceffa');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 600);
  ctx.fillStyle = '#5b5bd6';
  ctx.fillRect(0, 0, 1024, 54);
  ctx.fillStyle = '#fff';
  ctx.font = '600 26px sans-serif';
  ctx.fillText('库存看板', 28, 36);
  const card = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 14);
    ctx.fill();
  };
  const stats = ['在库 12,486', '今日出库 1,032', '待上架 218'];
  stats.forEach((s, i) => {
    card(28 + i * 330, 80, 300, 110);
    ctx.fillStyle = '#8a8fa8';
    ctx.font = '22px sans-serif';
    ctx.fillText(s.split(' ')[0], 50 + i * 330, 122);
    ctx.fillStyle = '#23253a';
    ctx.font = '700 38px sans-serif';
    ctx.fillText(s.split(' ')[1], 50 + i * 330, 170);
  });
  card(28, 214, 620, 360);
  const bars = [0.5, 0.72, 0.6, 0.86, 0.66, 0.92, 0.78, 0.58];
  bars.forEach((b, i) => {
    ctx.fillStyle = i === 5 ? '#5b5bd6' : '#b9bcf2';
    ctx.fillRect(70 + i * 70, 540 - b * 280, 40, b * 280);
  });
  card(676, 214, 320, 360);
  ctx.lineWidth = 34;
  [
    ['#5b5bd6', 0, 1.3],
    ['#ff9bc4', 1.3, 2.3],
    ['#8fe0c8', 2.3, 2 * Math.PI],
  ].forEach(([color, a, b]) => {
    ctx.strokeStyle = color as string;
    ctx.beginPath();
    ctx.arc(836, 394, 90, a as number, b as number);
    ctx.stroke();
  });
  return tex(c);
}

/** 便利贴文字 */
export function noteTexture(text: string, color: string) {
  const c = canvas(512, 512),
    ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0.06)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = '#3d3550';
  ctx.font = '600 58px "Noto Sans SC", "PingFang SC", sans-serif';
  const chars = [...text];
  const lines: string[] = [];
  let line = '';
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > 420) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, 46, 150 + i * 82));
  return tex(c);
}

/** 柔和的圆形渐变（蒸汽、光斑） */
export function softDot() {
  const c = canvas(128, 128),
    ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return tex(c);
}

/** 胸前徽标（发光猫头线条） */
export function badgeTexture(glow: string) {
  const c = canvas(256, 192),
    ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 192);
  ctx.strokeStyle = glow;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 14;
  ctx.lineWidth = 9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(80, 132);
  ctx.lineTo(80, 64);
  ctx.lineTo(106, 88);
  ctx.lineTo(150, 88);
  ctx.lineTo(176, 64);
  ctx.lineTo(176, 132);
  ctx.closePath();
  ctx.stroke();
  return tex(c);
}

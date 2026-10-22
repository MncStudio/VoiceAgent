/** 桌宠形象（皮肤）：同一套骨骼动作，换耳朵 / 尾巴 / 配色。 */
export type SkinId = 'neko' | 'fox' | 'bunny';
export type Skin = {
  id: SkinId;
  name: string;
  intro: string;
  /** 外壳渐变（亮 → 暗） */
  shell: [string, string];
  /** 深色拼块（额头 / 身体侧边 / 尾巴环纹） */
  patch: string;
  /** 眼睛、面罩灯光 */
  glow: string;
  /** 耳内、肉垫、腮红 */
  accent: string;
  /** 耳内第二色（渐变终点） */
  accent2: string;
  /** 面罩 */
  visor: [string, string];
  ears: 'cat' | 'fox' | 'bunny';
  tail: 'cat' | 'fox' | 'bunny';
};
export const skins: Record<SkinId, Skin> = {
  neko: {
    id: 'neko',
    name: '喵宝',
    intro: '珍珠白机甲猫，粉蓝发光耳朵，最贴近参考图',
    shell: ['#ffffff', '#e6e3f3'],
    patch: '#33344d',
    glow: '#7beeff',
    accent: '#ff8cc6',
    accent2: '#9fd8ff',
    visor: ['#24263d', '#0c0d19'],
    ears: 'cat',
    tail: 'cat',
  },
  fox: {
    id: 'fox',
    name: '狐宝',
    intro: '暖橙小狐狸，大尖耳 + 蓬松尾巴，琥珀色眼睛',
    shell: ['#fffaf3', '#ffe0c2'],
    patch: '#ff8a3d',
    glow: '#ffd56b',
    accent: '#ff7a59',
    accent2: '#ffc38a',
    visor: ['#2b2230', '#120d16'],
    ears: 'fox',
    tail: 'fox',
  },
  bunny: {
    id: 'bunny',
    name: '兔宝',
    intro: '薄荷绿长耳兔，圆尾巴，清爽治愈',
    shell: ['#ffffff', '#e2f2ee'],
    patch: '#5c6f86',
    glow: '#8ff7d4',
    accent: '#ffadc6',
    accent2: '#8fe9d0',
    visor: ['#1f2b33', '#0a1116'],
    ears: 'bunny',
    tail: 'bunny',
  },
};

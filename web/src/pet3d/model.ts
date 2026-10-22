import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Skin } from '../pet/skins';
import { FaceCanvas, badgeTexture, softDot } from './textures';

/** 桌宠骨架：每个关节一个 Group，动画只改这些 Group 的旋转 / 位移。 */
export type PetRig = {
  root: THREE.Group;
  bob: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Group;
  earL: THREE.Group;
  earR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  tail: THREE.Group[];
  podRings: THREE.Mesh[];
  glowMats: THREE.MeshBasicMaterial[];
  face: FaceCanvas;
  laptop: THREE.Group;
  mug: THREE.Group;
  steam: THREE.Sprite[];
  pillow: THREE.Mesh;
  /** 用于点击 / 拖拽命中的网格 */
  hit: THREE.Object3D[];
  dispose: () => void;
};

const hdr = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

export function buildPet(skin: Skin): PetRig {
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
  // 珠光白外壳：带清漆的塑料
  const shell = keep(
    new THREE.MeshPhysicalMaterial({
      color: skin.shell[0],
      roughness: 0.34,
      metalness: 0,
      clearcoat: 0.9,
      clearcoatRoughness: 0.18,
      sheen: 0.25,
      sheenColor: new THREE.Color(skin.shell[1]),
    }),
  );
  const patch = keep(
    new THREE.MeshPhysicalMaterial({
      color: skin.patch,
      roughness: 0.42,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    }),
  );
  const pink = keep(
    new THREE.MeshPhysicalMaterial({ color: skin.accent, roughness: 0.55, sheen: 0.6 }),
  );
  const glowMat = (hex: string, k = 2.2) =>
    keep(new THREE.MeshBasicMaterial({ color: hdr(hex, k), toneMapped: false }));
  const glowMats: THREE.MeshBasicMaterial[] = [];
  const face = new FaceCanvas(skin.glow, skin.accent);
  keep(face.texture);
  const visorMat = keep(
    new THREE.MeshPhysicalMaterial({
      color: '#040408',
      envMapIntensity: 0.3,
      roughness: 0.06,
      metalness: 0.1,
      clearcoat: 0.7,
      clearcoatRoughness: 0.03,
      emissive: '#ffffff',
      emissiveMap: face.texture,
      emissiveIntensity: 2.4,
    }),
  );
  const g = <T extends THREE.BufferGeometry>(x: T) => keep(x);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const group = (parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
    const o = new THREE.Group();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  const root = new THREE.Group();
  const bob = group(root);
  const hit: THREE.Object3D[] = [];

  // 身体
  const torso = mesh(g(new THREE.SphereGeometry(0.2, 64, 48)), shell, bob);
  torso.position.y = 0.27;
  torso.scale.set(1, 1.1, 0.92);
  hit.push(torso);
  if (skin.id !== 'bunny') {
    // 身体两侧深色拼块
    for (const s of [-1, 1]) {
      const side = mesh(g(new THREE.SphereGeometry(0.12, 32, 24)), patch, bob);
      side.position.set(s * 0.115, 0.2, -0.02);
      side.scale.set(0.7, 1.05, 1.15);
    }
  }
  const plate = mesh(
    g(new RoundedBoxGeometry(0.13, 0.095, 0.03, 4, 0.018)),
    keep(
      new THREE.MeshPhysicalMaterial({
        color: '#0b0c15',
        roughness: 0.1,
        clearcoat: 1,
        emissive: '#ffffff',
        emissiveMap: keep(badgeTexture(skin.glow)),
        emissiveIntensity: 2,
      }),
    ),
    bob,
  );
  plate.position.set(0, 0.29, 0.176);
  plate.rotation.x = -0.18;
  const collar = mesh(g(new THREE.TorusGeometry(0.13, 0.022, 20, 64)), patch, bob);
  collar.position.y = 0.43;
  collar.rotation.x = Math.PI / 2 - 0.12;
  const bell = mesh(
    g(new THREE.SphereGeometry(0.032, 32, 24)),
    keep(new THREE.MeshPhysicalMaterial({ color: '#f0bb8f', metalness: 1, roughness: 0.22 })),
    bob,
  );
  bell.position.set(0, 0.405, 0.15);

  // 手臂（肩部为枢轴，向下伸）
  const arm = (s: -1 | 1) => {
    const a = group(bob, s * 0.165, 0.39, 0.03);
    const m = mesh(g(new THREE.CapsuleGeometry(0.052, 0.12, 8, 24)), shell, a);
    m.position.y = -0.1;
    const pad = mesh(g(new THREE.SphereGeometry(0.026, 20, 16)), pink, a);
    pad.position.set(0, -0.17, 0.035);
    pad.scale.set(1, 0.8, 0.5);
    hit.push(m);
    return a;
  };
  const armL = arm(-1),
    armR = arm(1);

  // 腿 / 脚掌（坐姿时脚掌朝前）
  const leg = (s: -1 | 1) => {
    const l = group(bob, s * 0.1, 0.09, 0.03);
    const foot = mesh(g(new THREE.CapsuleGeometry(0.066, 0.09, 8, 24)), shell, l);
    foot.rotation.x = Math.PI / 2;
    foot.position.set(0, -0.025, 0.07);
    const sole = mesh(g(new THREE.SphereGeometry(0.036, 24, 16)), pink, l);
    sole.position.set(0, -0.03, 0.184);
    sole.scale.set(1, 0.85, 0.35);
    for (let i = -1; i <= 1; i++) {
      const toe = mesh(g(new THREE.SphereGeometry(0.014, 16, 12)), pink, l);
      toe.position.set(i * 0.024, 0.012 - Math.abs(i) * 0.008, 0.172);
      toe.scale.set(1, 1, 0.5);
    }
    hit.push(foot);
    return l;
  };
  const legL = leg(-1),
    legR = leg(1);

  // 尾巴：一节节嵌套的关节，摆动时整条尾巴自然弯曲
  const tail: THREE.Group[] = [];
  {
    let parent = group(bob, 0.1, 0.1, -0.13);
    parent.rotation.set(-1.0, 0, -0.9);
    tail.push(parent);
    const n = skin.tail === 'bunny' ? 1 : 9;
    for (let i = 0; i < n; i++) {
      const seg = group(parent, 0, i === 0 ? 0 : skin.tail === 'fox' ? 0.06 : 0.055, 0);
      seg.rotation.x = i === 0 ? 0 : 0.2;
      let r = 0.04;
      let mat: THREE.Material = i % 2 ? patch : shell;
      if (skin.tail === 'fox') {
        r = 0.05 + Math.sin((i / (n - 1)) * Math.PI * 0.85) * 0.06;
        mat = i >= n - 2 ? shell : patch;
      }
      if (skin.tail === 'bunny') {
        r = 0.075;
        mat = shell;
      }
      const m = mesh(g(new THREE.SphereGeometry(r, 28, 20)), mat, seg);
      m.position.y = skin.tail === 'bunny' ? -0.02 : 0.03;
      m.scale.y = skin.tail === 'bunny' ? 1 : 1.35;
      if (skin.tail === 'cat' && i === n - 1) {
        const tip = glowMat(skin.accent2, 2.6);
        glowMats.push(tip);
        const t = mesh(g(new THREE.SphereGeometry(0.04, 24, 16)), tip, seg);
        t.position.y = 0.07;
        t.castShadow = false;
      }
      tail.push(seg);
      parent = seg;
    }
  }

  // 头
  const head = group(bob, 0, 0.47, 0);
  const skull = mesh(g(new THREE.SphereGeometry(0.36, 96, 64)), shell, head);
  skull.position.y = 0.3;
  skull.scale.set(1.17, 0.93, 1);
  hit.push(skull);
  if (skin.id === 'fox') {
    const cap = mesh(
      g(new THREE.SphereGeometry(0.364, 96, 64, 0, Math.PI * 2, 0, 0.9)),
      patch,
      head,
    );
    cap.position.y = 0.3;
    cap.scale.set(1.17, 0.93, 1);
    cap.rotation.x = 0.5;
  }
  if (skin.id === 'neko') {
    const spot = mesh(g(new THREE.SphereGeometry(0.1, 32, 20)), patch, head);
    spot.position.set(-0.13, 0.588, 0.12);
    spot.scale.set(1.25, 0.2, 0.85);
    spot.rotation.set(0.34, 0, 0.27);
  }
  const visor = mesh(
    g(new THREE.SphereGeometry(0.364, 96, 48, Math.PI / 2 - 1.02, 2.04, 0.95, 1.22)),
    visorMat,
    head,
  );
  visor.position.y = 0.3;
  visor.scale.set(1.17, 0.93, 1);
  visor.castShadow = false;
  // 面罩边缘一圈亮边
  // 耳朵
  const ear = (s: -1 | 1) => {
    const e = group(head, s * 0.24, 0.53, -0.02);
    e.rotation.z = -s * 0.36;
    const inner = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    keep(inner);
    const tint = (geo: THREE.BufferGeometry, h0: number, h1: number) => {
      const pos = geo.attributes.position,
        colors: number[] = [];
      const a = hdr(skin.accent, 1.9),
        b = hdr(skin.accent2, 1.9);
      for (let i = 0; i < pos.count; i++) {
        const t = THREE.MathUtils.clamp((pos.getY(i) - h0) / (h1 - h0), 0, 1);
        const c = a.clone().lerp(b, t);
        colors.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      return geo;
    };
    if (skin.ears === 'bunny') {
      const o = mesh(g(new THREE.CapsuleGeometry(0.065, 0.3, 8, 24)), shell, e);
      o.position.y = 0.2;
      o.scale.z = 0.5;
      const i = mesh(g(tint(new THREE.CapsuleGeometry(0.035, 0.24, 8, 16), -0.15, 0.15)), inner, e);
      i.position.set(0, 0.2, 0.026);
      i.scale.z = 0.3;
      i.castShadow = false;
      e.rotation.z = -s * 0.16;
    } else {
      const big = skin.ears === 'fox' ? 1.25 : 1;
      const o = mesh(
        g(new THREE.ConeGeometry(0.125 * big, 0.26 * big, 48)),
        skin.ears === 'fox' ? patch : shell,
        e,
      );
      o.position.y = 0.11 * big;
      o.scale.z = 0.55;
      const i = mesh(
        g(tint(new THREE.ConeGeometry(0.075 * big, 0.17 * big, 32), -0.08, 0.08)),
        inner,
        e,
      );
      i.position.set(0, 0.09 * big, 0.04);
      i.scale.z = 0.3;
      i.castShadow = false;
    }
    return e;
  };
  const earL = ear(-1),
    earR = ear(1);

  // 耳机
  const podRings: THREE.Mesh[] = [];
  for (const s of [-1, 1] as const) {
    const p = group(head, s * 0.405, 0.27, 0);
    p.rotation.z = (-s * Math.PI) / 2;
    mesh(g(new THREE.CylinderGeometry(0.105, 0.112, 0.08, 48)), patch, p);
    const cap = mesh(g(new THREE.CylinderGeometry(0.078, 0.078, 0.02, 48)), shell, p);
    cap.position.y = 0.045;
    const ringMat = glowMat(skin.glow, 2.4);
    glowMats.push(ringMat);
    const ring = mesh(g(new THREE.TorusGeometry(0.058, 0.01, 12, 48)), ringMat, p);
    ring.position.y = 0.057;
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = false;
    podRings.push(ring);
    const dot = mesh(g(new THREE.SphereGeometry(0.018, 16, 12)), s < 0 ? pink : ringMat, p);
    dot.position.y = 0.058;
    dot.scale.y = 0.4;
  }

  // 道具：笔记本电脑
  const laptop = group(root, 0, 0, 0.42);
  {
    const metal = keep(
      new THREE.MeshPhysicalMaterial({ color: '#d9dce4', metalness: 0.85, roughness: 0.32 }),
    );
    const base = mesh(g(new RoundedBoxGeometry(0.52, 0.022, 0.34, 3, 0.01)), metal, laptop);
    base.position.y = 0.011;
    const keys = mesh(
      g(new THREE.PlaneGeometry(0.44, 0.17)),
      keep(new THREE.MeshStandardMaterial({ color: '#2b2d36', roughness: 0.7 })),
      laptop,
    );
    keys.rotation.x = -Math.PI / 2;
    keys.position.set(0, 0.0225, -0.05);
    const hinge = group(laptop, 0, 0.022, -0.165);
    hinge.rotation.x = 0.28;
    const lid = mesh(g(new RoundedBoxGeometry(0.52, 0.34, 0.016, 3, 0.008)), metal, hinge);
    lid.position.set(0, 0.17, 0);
    const logo = glowMat(skin.glow, 1.4);
    const l = mesh(g(new THREE.CircleGeometry(0.025, 32)), logo, hinge);
    l.position.set(0, 0.18, 0.0085);
    const light = new THREE.PointLight(skin.glow, 0.5, 1.2, 2);
    light.position.set(0, 0.25, -0.12);
    hinge.add(light);
  }
  laptop.visible = false;

  // 道具：咖啡杯（挂在右手上）
  const mug = group(armR, 0, -0.2, 0.07);
  const steam: THREE.Sprite[] = [];
  {
    const ceramic = keep(
      new THREE.MeshPhysicalMaterial({ color: '#f2a65a', roughness: 0.22, clearcoat: 1 }),
    );
    mug.scale.setScalar(1.35);
    const cup = mesh(g(new THREE.CylinderGeometry(0.05, 0.044, 0.11, 40, 1, true)), ceramic, mug);
    (cup.material as THREE.Material).side = THREE.DoubleSide;
    const bottom = mesh(g(new THREE.CircleGeometry(0.044, 32)), ceramic, mug);
    bottom.rotation.x = Math.PI / 2;
    bottom.position.y = -0.055;
    const coffee = mesh(
      g(new THREE.CircleGeometry(0.047, 32)),
      keep(new THREE.MeshPhysicalMaterial({ color: '#5a3522', roughness: 0.1, clearcoat: 1 })),
      mug,
    );
    coffee.rotation.x = -Math.PI / 2;
    coffee.position.y = 0.04;
    const handle = mesh(g(new THREE.TorusGeometry(0.028, 0.008, 12, 32, Math.PI)), ceramic, mug);
    handle.position.set(0.05, 0, 0);
    handle.rotation.z = -Math.PI / 2;
    const dot = keep(softDot());
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(
        keep(
          new THREE.SpriteMaterial({
            map: dot,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
          }),
        ),
      );
      s.scale.setScalar(0.06);
      s.position.y = 0.08;
      mug.add(s);
      steam.push(s);
    }
  }
  mug.visible = false;

  // 道具：抱枕（打盹时）
  const pillow = mesh(
    g(new RoundedBoxGeometry(0.95, 0.09, 0.62, 6, 0.045)),
    keep(
      new THREE.MeshPhysicalMaterial({
        color: '#e5defa',
        roughness: 0.9,
        sheen: 1,
        sheenColor: new THREE.Color('#ffffff'),
      }),
    ),
    root,
  );
  pillow.position.set(0, 0.045, 0.02);
  pillow.visible = false;

  root.traverse((o) => (o.userData.pet = true));
  return {
    root,
    bob,
    torso,
    head,
    earL,
    earR,
    armL,
    armR,
    legL,
    legR,
    tail,
    podRings,
    glowMats,
    face,
    laptop,
    mug,
    steam,
    pillow,
    hit,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

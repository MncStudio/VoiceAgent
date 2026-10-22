import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { noteTexture, screenTexture, skyTexture, woodTexture } from './textures';

export type Room = {
  group: THREE.Group;
  notes: THREE.Mesh[];
  setNight: (night: boolean) => void;
  setNotes: (texts: string[]) => void;
  dispose: () => void;
};

/** 书桌场景：墙、窗、显示器、台灯、绿植、书。桌面顶面 y = 0，桌宠在 z = 0 一线活动。 */
export function buildRoom(scene: THREE.Scene): Room {
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
  const group = new THREE.Group();
  scene.add(group);
  const mesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    parent: THREE.Object3D = group,
    shadow = true,
  ) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const std = (o: THREE.MeshPhysicalMaterialParameters) => keep(new THREE.MeshPhysicalMaterial(o));

  // 桌面
  const wood = keep(woodTexture());
  wood.repeat.set(3, 1.2);
  const desk = mesh(
    new RoundedBoxGeometry(18, 0.14, 5.6, 4, 0.03),
    std({ map: wood, roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  );
  desk.position.set(0, -0.07, -0.3);
  // 桌垫（让白色桌宠更立体）
  const mat = mesh(
    new RoundedBoxGeometry(3.0, 0.012, 1.3, 4, 0.006),
    std({ color: '#3d4152', roughness: 0.92, sheen: 0.5, sheenColor: new THREE.Color('#9aa0c0') }),
  );
  mat.position.set(0, 0.006, 0.15);
  mat.castShadow = false;

  // 墙
  const wallMat = std({ color: '#e9e2da', roughness: 0.95 });
  const wall = mesh(new THREE.PlaneGeometry(40, 14), wallMat, group, false);
  wall.position.set(0, 6.5, -3.0);
  const skirting = mesh(
    new THREE.BoxGeometry(40, 0.18, 0.04),
    std({ color: '#f7f4f0', roughness: 0.6 }),
  );
  skirting.position.set(0, 0.09, -2.98);

  // 窗户
  const win = new THREE.Group();
  win.position.set(-2.9, 2.05, -2.97);
  group.add(win);
  const skyMat = keep(new THREE.MeshBasicMaterial({ toneMapped: true }));
  let skyTex = keep(skyTexture(false));
  skyMat.map = skyTex;
  const glass = mesh(new THREE.PlaneGeometry(2.3, 1.7), skyMat, win, false);
  glass.position.z = 0.005;
  const frameMat = std({ color: '#fbfaf8', roughness: 0.4, clearcoat: 0.4 });
  for (const [w, h, x, y] of [
    [2.46, 0.08, 0, 0.89],
    [2.46, 0.08, 0, -0.89],
    [0.08, 1.86, -1.19, 0],
    [0.08, 1.86, 1.19, 0],
    [0.05, 1.7, 0, 0],
    [2.3, 0.05, 0, 0.1],
  ])
    mesh(new RoundedBoxGeometry(w, h, 0.08, 2, 0.015), frameMat, win).position.set(x, y, 0.04);
  const sill = mesh(new RoundedBoxGeometry(2.7, 0.06, 0.26, 2, 0.02), frameMat, win);
  sill.position.set(0, -0.95, 0.12);
  // 窗台小多肉
  const succulent = new THREE.Group();
  succulent.position.set(0.8, -0.92, 0.14);
  win.add(succulent);
  mesh(
    new THREE.CylinderGeometry(0.09, 0.07, 0.12, 24),
    std({ color: '#d98c6a', roughness: 0.8 }),
    succulent,
  ).position.y = 0.06;
  const leafMat = std({ color: '#7dbb8a', roughness: 0.5, sheen: 0.5 });
  for (let i = 0; i < 7; i++) {
    const l = mesh(new THREE.SphereGeometry(0.05, 16, 12), leafMat, succulent);
    const a = (i / 7) * Math.PI * 2;
    l.position.set(Math.cos(a) * 0.05, 0.15, Math.sin(a) * 0.05);
    l.scale.set(0.6, 1.4, 0.6);
    l.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
  }

  // 显示器（库存看板）
  const monitor = new THREE.Group();
  monitor.position.set(2.35, 0, -2.25);
  monitor.rotation.y = -0.32;
  monitor.scale.setScalar(0.85);
  group.add(monitor);
  const alu = std({ color: '#c9ccd4', metalness: 0.9, roughness: 0.3 });
  mesh(new RoundedBoxGeometry(0.6, 0.03, 0.4, 2, 0.012), alu, monitor).position.y = 0.015;
  mesh(new RoundedBoxGeometry(0.12, 0.7, 0.05, 2, 0.02), alu, monitor).position.set(0, 0.38, -0.08);
  const bezel = mesh(
    new RoundedBoxGeometry(1.9, 1.12, 0.06, 4, 0.03),
    std({ color: '#1b1c22', roughness: 0.3, clearcoat: 0.6 }),
    monitor,
  );
  bezel.position.set(0, 0.98, -0.03);
  const screenMat = keep(new THREE.MeshBasicMaterial({ map: keep(screenTexture()) }));
  const screen = mesh(new THREE.PlaneGeometry(1.8, 1.02), screenMat, monitor, false);
  screen.position.set(0, 0.98, 0.002);
  const screenLight = new THREE.PointLight('#cfd8ff', 0, 4, 2);
  screenLight.position.set(0, 0.9, 0.6);
  monitor.add(screenLight);

  // 台灯
  const lamp = new THREE.Group();
  lamp.position.set(-2.75, 0, -1.5);
  lamp.rotation.y = 0.5;
  group.add(lamp);
  const lampMat = std({ color: '#f3efe9', roughness: 0.35, clearcoat: 0.6 });
  mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 40), lampMat, lamp).position.y = 0.03;
  const arm1 = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 16), alu, lamp);
  arm1.position.set(0.12, 0.58, 0);
  arm1.rotation.z = -0.22;
  const arm2 = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.8, 16), alu, lamp);
  arm2.position.set(0.5, 1.22, 0);
  arm2.rotation.z = -1.15;
  const shade = mesh(
    new THREE.ConeGeometry(0.24, 0.32, 40, 1, true),
    std({ color: '#f3efe9', roughness: 0.4, side: THREE.DoubleSide }),
    lamp,
  );
  shade.position.set(0.86, 1.28, 0);
  shade.rotation.z = -0.5;
  const bulbMat = keep(new THREE.MeshBasicMaterial({ color: '#fff3d6', toneMapped: false }));
  const bulb = mesh(new THREE.SphereGeometry(0.07, 20, 16), bulbMat, lamp, false);
  bulb.position.set(0.92, 1.18, 0);
  const lampLight = new THREE.PointLight('#ffc27a', 0, 7, 1.6);
  lampLight.position.set(0.95, 1.05, 0);
  lamp.add(lampLight);

  // 绿植
  const plant = new THREE.Group();
  plant.position.set(3.4, 0, -1.1);
  group.add(plant);
  const pot = mesh(
    new THREE.CylinderGeometry(0.3, 0.24, 0.5, 48),
    std({ color: '#f4f1ec', roughness: 0.25, clearcoat: 0.8 }),
    plant,
  );
  pot.position.y = 0.25;
  mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 0.02, 32),
    std({ color: '#4b3427', roughness: 1 }),
    plant,
  ).position.y = 0.48;
  const green = [
    std({ color: '#3f8f5a', roughness: 0.55, sheen: 0.4, side: THREE.DoubleSide }),
    std({ color: '#5aa96f', roughness: 0.55, sheen: 0.4, side: THREE.DoubleSide }),
  ];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + (i % 2) * 0.3;
    const stem = new THREE.Group();
    stem.position.y = 0.48;
    stem.rotation.set(Math.sin(a) * 0.55, a, 0);
    stem.rotation.order = 'YXZ';
    plant.add(stem);
    const leaf = mesh(new THREE.SphereGeometry(0.16, 24, 16), green[i % 2], stem);
    leaf.scale.set(0.42, 1.6, 0.08);
    leaf.position.set(0, 0.32, 0);
    stem.rotation.x = 0.35 + (i % 3) * 0.18;
  }

  // 书
  const books = new THREE.Group();
  books.position.set(-1.7, 0, -1.9);
  books.rotation.y = 0.2;
  group.add(books);
  [
    ['#e9a3b5', 0.9, 0.12],
    ['#8fb3e3', 0.84, 0.1],
    ['#f2d18b', 0.88, 0.09],
  ].forEach(([c, w, h], i, all) => {
    const y = all.slice(0, i).reduce((s, b) => s + (b[2] as number), 0);
    const b = mesh(
      new RoundedBoxGeometry(w as number, h as number, 0.6, 2, 0.012),
      std({ color: c as string, roughness: 0.6 }),
      books,
    );
    b.position.y = y + (h as number) / 2;
    b.rotation.y = i * 0.12;
  });

  // 便利贴（贴在墙上，可点击）
  const notes: THREE.Mesh[] = [];
  const colors = ['#fff1a8', '#ffd3e2', '#cdeeff'];
  const noteGeo = keep(new THREE.PlaneGeometry(0.62, 0.62));
  const setNotes = (texts: string[]) => {
    for (const n of notes.splice(0)) {
      group.remove(n);
      const m = n.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
    }
    texts.forEach((text, i) => {
      const m = new THREE.MeshStandardMaterial({
        map: noteTexture(text, colors[i % 3]),
        roughness: 0.85,
      });
      const n = new THREE.Mesh(noteGeo, m);
      n.position.set(0.15 + i * 0.78, 2.35 - (i % 2) * 0.12, -2.95);
      n.rotation.z = [0.05, -0.04, 0.03][i % 3];
      n.castShadow = true;
      n.userData.note = text;
      group.add(n);
      notes.push(n);
    });
  };

  // 灯光
  const hemi = new THREE.HemisphereLight('#e6efff', '#b89a7c', 0.4);
  group.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1de', 2.0);
  sun.position.set(-5, 7, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -3;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 20;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 6;
  group.add(sun);
  // 窗边洒在墙上的一片暖光，让墙面有明暗
  const wash = new THREE.SpotLight('#fff0dc', 18, 14, 0.75, 1, 1.4);
  wash.position.set(-3.5, 5.5, 1.5);
  wash.target.position.set(-0.5, 1.6, -3);
  group.add(wash, wash.target);
  const fill = new THREE.DirectionalLight('#dfe6ff', 0.7);
  fill.position.set(4, 3, 6);
  group.add(fill);
  const rim = new THREE.DirectionalLight('#ffffff', 0.9);
  rim.position.set(2, 4, -4);
  group.add(rim);

  const setNight = (night: boolean) => {
    skyTex.dispose();
    skyTex = skyTexture(night);
    skyMat.map = skyTex;
    skyMat.needsUpdate = true;
    hemi.intensity = night ? 0.12 : 0.4;
    hemi.color.set(night ? '#8090d0' : '#e6efff');
    sun.intensity = night ? 0.35 : 2.0;
    sun.color.set(night ? '#9fb0ff' : '#fff4e6');
    fill.intensity = night ? 0.12 : 0.7;
    rim.intensity = night ? 0.25 : 0.9;
    lampLight.intensity = night ? 7 : 0;
    bulbMat.color.set(night ? '#fff0cc' : '#f3efe9');
    bulbMat.toneMapped = !night;
    screenLight.intensity = night ? 1.6 : 0;
    wallMat.color.set(night ? '#b9b2c8' : '#e9e2da');
    scene.environmentIntensity = night ? 0.15 : 0.4;
    wash.intensity = night ? 0 : 18;
  };

  return {
    group,
    notes,
    setNight,
    setNotes,
    dispose: () => {
      setNotes([]);
      skyTex.dispose();
      disposables.forEach((d) => d.dispose());
      scene.remove(group);
    },
  };
}

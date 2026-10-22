import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import type { Pose } from '../pet/PetSprite';
import type { Skin } from '../pet/skins';
import { buildPet, type PetRig } from './model';
import { buildRoom, type Room } from './room';
import type { Eyes } from './textures';

export type Anchor = { head: { x: number; y: number }; foot: { x: number; y: number } };
export type WorldEvents = {
  onArrive?: () => void;
  onClick?: () => void;
  onDragStart?: () => void;
  onLand?: () => void;
  onNote?: (text: string) => void;
  onFrame?: (a: Anchor) => void;
};
type Joints = {
  bobY: number;
  bobRz: number;
  scaleY: number;
  headRx: number;
  headRy: number;
  headRz: number;
  armLx: number;
  armLz: number;
  armRx: number;
  armRz: number;
  legLx: number;
  legRx: number;
  ear: number;
  tailAmp: number;
};
const eyesFor: Record<Pose, Eyes> = {
  sit: 'open',
  walk: 'open',
  look: 'open',
  work: 'focus',
  drink: 'happy',
  stretch: 'happy',
  sleep: 'sleep',
  wave: 'happy',
  happy: 'happy',
  drag: 'dizzy',
  fall: 'dizzy',
  alert: 'wide',
  listen: 'wide',
  talk: 'open',
};
const damp = (a: number, b: number, k: number) => a + (b - a) * k;

/** 3D 桌宠世界：渲染、动作、走路、拖拽与点击。业务“想做什么”由外部（Pet3D）决定。 */
export class PetWorld {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private bokeh?: BokehPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private rig: PetRig;
  private room?: Room;
  private pose: Pose = 'sit';
  private poseAt = 0;
  private mouth = 0;
  private level = 0;
  private side = 0;
  private target?: number;
  private yaw = 0;
  private x = 0;
  private y = 0;
  private vy = 0;
  private drag: 'none' | 'hold' | 'fall' = 'none';
  private grab = new THREE.Vector3();
  private pointer = new THREE.Vector2(-9, -9);
  private press?: { x: number; y: number; moved: boolean; pet: boolean; note?: string };
  private range = { min: -2, max: 2 };
  private joints: Joints;
  private blinkAt = 0;
  private raf = 0;
  private clock = new THREE.Clock();
  private size = { w: 1, h: 1 };
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private disposed = false;

  constructor(
    private host: HTMLElement,
    private skin: Skin,
    night: boolean,
    private events: WorldEvents = {},
    private studio = false,
  ) {
    const r = (this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: studio,
      preserveDrawingBuffer: studio,
      powerPreference: 'high-performance',
    }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.92;
    r.domElement.className = 'pet-canvas';
    host.appendChild(r.domElement);
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.55;
    if (studio) this.buildStudio();
    else {
      this.room = buildRoom(this.scene);
      this.room.setNight(night);
    }
    this.rig = buildPet(skin);
    this.scene.add(this.rig.root);
    this.joints = this.target0();

    // 后期链路自带 4x MSAA，避免边缘锯齿
    this.composer = new EffectComposer(
      r,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.45, 1.6);
    this.composer.addPass(this.bloom);
    // 浅景深：对焦桌宠，背景微微虚化，更像实拍
    if (!studio) {
      this.bokeh = new BokehPass(this.scene, this.camera, {
        focus: 6.2,
        aperture: 0.0016,
        maxblur: 0.0045,
      });
      this.composer.addPass(this.bokeh);
    }
    this.composer.addPass(new OutputPass());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const el = r.domElement;
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    addEventListener('pointermove', this.track);
    if (!studio) this.raf = requestAnimationFrame(this.frame);
  }

  private buildStudio() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.ShadowMaterial({ opacity: 0.18 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.scene.add(new THREE.HemisphereLight('#eef2ff', '#c9b8a8', 0.8));
    const key = new THREE.DirectionalLight('#fff6ec', 2.4);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#ffffff', 1.2);
    rim.position.set(3, 3, -3);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight('#e3e8ff', 0.6);
    fill.position.set(3, 2, 5);
    this.scene.add(fill);
  }

  /* ---------- 对外 API ---------- */
  setSkin(skin: Skin) {
    if (skin.id === this.skin.id) return;
    this.skin = skin;
    const { position, rotation } = this.rig.root;
    this.scene.remove(this.rig.root);
    this.rig.dispose();
    this.rig = buildPet(skin);
    this.rig.root.position.copy(position);
    this.rig.root.rotation.copy(rotation);
    this.scene.add(this.rig.root);
  }
  setNight(night: boolean) {
    this.room?.setNight(night);
  }
  setNotes(texts: string[]) {
    this.room?.setNotes(texts);
  }
  setPose(pose: Pose) {
    if (pose === this.pose) return;
    this.pose = pose;
    this.poseAt = this.clock.elapsedTime;
  }
  setMouth(v: number) {
    this.mouth = v;
  }
  setLevel(v: number) {
    this.level = v;
  }
  /** 右侧被面板遮住的像素宽度：镜头整体左移，让桌宠留在可见区域中间。 */
  setSide(px: number) {
    this.side = px;
    this.resize();
  }
  /** 走到可见桌面的某个位置（0 = 最左，1 = 最右）。 */
  walkTo(frac: number) {
    this.target = THREE.MathUtils.lerp(this.range.min, this.range.max, frac);
  }
  stop() {
    this.target = undefined;
  }
  get position() {
    return (this.x - this.range.min) / Math.max(0.001, this.range.max - this.range.min);
  }
  get dragging() {
    return this.drag !== 'none';
  }
  /** 定格渲染一帧（形象一览 / 缩略图）。 */
  renderStill(pose: Pose, time = 1.3) {
    this.pose = pose;
    this.poseAt = 0;
    this.pointer.set(-9, -9);
    for (let i = 0; i < 40; i++) this.animate(1 / 30, time);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    removeEventListener('pointermove', this.track);
    this.rig.dispose();
    this.room?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ---------- 内部 ---------- */
  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    const cam = this.camera;
    cam.aspect = w / h;
    // 窄屏拉远一点，保证桌宠和桌面都在画面里
    const narrow = w / h < 0.9;
    cam.fov = narrow ? 42 : 30;
    if (this.studio) {
      cam.fov = 26;
      cam.position.set(0, 1.0, 4.2);
      cam.lookAt(0, 0.62, 0);
    } else {
      cam.position.set(0, narrow ? 1.5 : 1.25, narrow ? 6.2 : 6.0);
      cam.lookAt(0, narrow ? 0.95 : 0.74, 0);
    }
    if (this.side > 0 && this.side < w) cam.setViewOffset(w + this.side, h, this.side, 0, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    // 计算可走范围（桌宠中心线 z = 0 上，左右各留出边距）
    const footY = new THREE.Vector3(0, 0, 0).project(cam).y;
    const atX = (px: number) => {
      this.raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, footY), cam);
      const hit = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit);
      return hit.x;
    };
    const margin = Math.min(140, w * 0.16);
    this.range = { min: atX(margin), max: atX(w - this.side - margin) };
    this.x = THREE.MathUtils.clamp(this.x, this.range.min, this.range.max);
  }
  private ndc(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }
  private pick(e: PointerEvent) {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const targets: THREE.Object3D[] = [...this.rig.hit, ...(this.room?.notes ?? [])];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return (
      hit && {
        pet: !!hit.object.userData.pet,
        note: hit.object.userData.note as string,
        point: hit.point,
      }
    );
  }
  private track = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
  };
  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = this.pick(e);
    if (!hit) return;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.press = { x: e.clientX, y: e.clientY, moved: false, pet: hit.pet, note: hit.note };
    if (hit.pet) this.grab.set(hit.point.x - this.x, hit.point.y - this.y, 0);
  };
  private move = (e: PointerEvent) => {
    const p = this.press;
    if (!p) {
      const hit = this.pick(e);
      this.renderer.domElement.style.cursor = hit ? (hit.pet ? 'grab' : 'pointer') : '';
      return;
    }
    if (!p.pet) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
    if (!p.moved) {
      p.moved = true;
      this.drag = 'hold';
      this.target = undefined;
      this.renderer.domElement.style.cursor = 'grabbing';
      this.events.onDragStart?.();
    }
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit)) {
      this.dragTo = {
        x: THREE.MathUtils.clamp(hit.x - this.grab.x, this.range.min, this.range.max),
        y: THREE.MathUtils.clamp(hit.y - this.grab.y, 0, 1.6),
      };
    }
  };
  private dragTo = { x: 0, y: 0 };
  private up = () => {
    const p = this.press;
    this.press = undefined;
    if (!p) return;
    this.renderer.domElement.style.cursor = '';
    if (p.moved) {
      this.drag = 'fall';
      return;
    }
    if (p.pet) this.events.onClick?.();
    else if (p.note) this.events.onNote?.(p.note);
  };

  private target0(): Joints {
    return {
      bobY: 0,
      bobRz: 0,
      scaleY: 1,
      headRx: 0,
      headRy: 0,
      headRz: 0,
      armLx: 0,
      armLz: -0.12,
      armRx: 0,
      armRz: 0.12,
      legLx: 0,
      legRx: 0,
      ear: 0,
      tailAmp: 0.2,
    };
  }
  private targets(pose: Pose, t: number, since: number): Joints & { lookX: number; lookY: number } {
    const j = { ...this.target0(), lookX: 0, lookY: 0 };
    const breathe = Math.sin(t * 2) * 0.006;
    j.bobY = breathe;
    j.headRz = Math.sin(t * 0.7) * 0.035;
    // 视线跟随鼠标
    const pet = new THREE.Vector3(this.x, this.y + 0.8, 0).project(this.camera);
    const lx = THREE.MathUtils.clamp((this.pointer.x - pet.x) * 1.4, -1, 1),
      ly = THREE.MathUtils.clamp(-(this.pointer.y - pet.y) * 1.4, -1, 1);
    const follow = this.pointer.x > -5;
    if (follow) {
      j.lookX = lx;
      j.lookY = ly;
      j.headRy = lx * 0.28;
      j.headRx = ly * 0.12;
    }
    switch (pose) {
      case 'look':
        j.headRy = Math.sin(t * 0.9) * 0.55;
        j.headRz = Math.sin(t * 0.9) * 0.08;
        j.lookX = Math.sin(t * 0.9);
        j.lookY = 0;
        break;
      case 'walk': {
        const s = Math.sin(t * 9);
        j.bobY = Math.abs(s) * 0.03;
        j.bobRz = s * 0.05;
        j.legLx = s * 0.55;
        j.legRx = -s * 0.55;
        j.armLx = -s * 0.5;
        j.armRx = s * 0.5;
        j.headRy = 0;
        j.headRx = 0.04;
        j.lookX = 0;
        j.lookY = 0;
        break;
      }
      case 'work': {
        const k = Math.sin(t * 22);
        j.headRx = 0.24;
        j.headRy = Math.sin(t * 0.5) * 0.08;
        j.armLx = -0.95 + k * 0.07;
        j.armRx = -0.95 - k * 0.07;
        j.armLz = 0.08;
        j.armRz = -0.08;
        j.lookX = Math.sin(t * 0.5) * 0.3;
        j.lookY = 0.7;
        break;
      }
      case 'drink': {
        const phase = (t % 4.4) / 4.4,
          sip = phase > 0.55 && phase < 0.88;
        j.armRx = sip ? -1.85 : -1.05;
        j.armRz = sip ? -0.55 : -0.35;
        j.headRx = sip ? -0.1 : 0.06;
        j.lookY = sip ? -0.3 : 0.2;
        break;
      }
      case 'stretch': {
        const up = Math.min(1, Math.max(0, Math.sin(((t - since) / 2.6) * Math.PI) * 1.6));
        j.armLz = -0.12 - up * 2.55;
        j.armRz = 0.12 + up * 2.55;
        j.scaleY = 1 + up * 0.05;
        j.bobY = up * 0.03;
        j.headRx = -up * 0.18;
        j.headRy = 0;
        break;
      }
      case 'wave':
        j.armRz = 2.35 + Math.sin(t * 9) * 0.35;
        j.armRx = -0.25;
        j.headRz = -0.12;
        break;
      case 'sleep':
        j.bobY = 0.085;
        j.headRx = 0.36;
        j.headRy = 0;
        j.headRz = 0.16;
        j.scaleY = 0.97 + Math.sin(t * 1.6) * 0.015;
        j.armLx = j.armRx = -0.35;
        j.armLz = 0.18;
        j.armRz = -0.18;
        j.ear = 0.28;
        j.tailAmp = 0.04;
        j.lookX = j.lookY = 0;
        break;
      case 'happy': {
        const s = Math.sin(t * 7);
        j.bobY = Math.abs(s) * 0.11;
        j.armLz = -2.2;
        j.armRz = 2.2;
        j.headRz = s * 0.08;
        j.tailAmp = 0.45;
        break;
      }
      case 'drag': {
        j.bobRz = Math.sin(t * 4) * 0.16;
        j.armLz = -2.75;
        j.armRz = 2.75;
        j.legLx = Math.sin(t * 10) * 0.5;
        j.legRx = -Math.sin(t * 10) * 0.5;
        j.tailAmp = 0.5;
        j.headRy = 0;
        break;
      }
      case 'fall':
        j.armLz = -2.4;
        j.armRz = 2.4;
        break;
      case 'alert': {
        const k = Math.min(1, (t - since) / 0.35);
        j.bobY = Math.sin(k * Math.PI) * 0.07;
        j.headRz = 0.18;
        j.ear = -0.16;
        j.armLz = -0.55;
        j.armRz = 0.55;
        break;
      }
      case 'listen':
        j.headRz = -0.15;
        j.headRx = -0.04;
        j.armLz = -2.5;
        j.armLx = -0.35;
        j.ear = -0.1;
        break;
      case 'talk':
        j.headRx = Math.sin(t * 5) * 0.04 + (follow ? ly * 0.08 : 0);
        j.headRz = Math.sin(t * 2.3) * 0.06;
        j.armRz = 0.45 + Math.max(0, Math.sin(t * 2.2)) * 0.9;
        j.armRx = -0.55;
        break;
    }
    return j;
  }

  private animate(dt: number, t: number) {
    const rig = this.rig;
    // 走路 / 朝向
    let yawTarget = 0;
    if (this.drag === 'none' && this.target !== undefined) {
      const d = this.target - this.x;
      yawTarget = Math.sign(d) * 1.2;
      const turned = Math.abs(this.yaw - yawTarget) < 0.5;
      const step = 0.6 * dt * (turned ? 1 : 0.25);
      if (Math.abs(d) <= step) {
        this.x = this.target;
        this.target = undefined;
        this.events.onArrive?.();
      } else this.x += Math.sign(d) * step;
    }
    if (this.drag === 'hold') {
      this.x = damp(this.x, this.dragTo.x, 1 - Math.exp(-dt * 14));
      this.y = damp(this.y, this.dragTo.y, 1 - Math.exp(-dt * 14));
    }
    if (this.drag === 'fall') {
      this.vy -= 11 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        if (this.vy < -1.6) this.vy = -this.vy * 0.34;
        else {
          this.vy = 0;
          this.drag = 'none';
          this.events.onLand?.();
        }
      }
    }
    const pose: Pose = this.drag === 'hold' ? 'drag' : this.drag === 'fall' ? 'fall' : this.pose;
    const walking = this.target !== undefined && this.drag === 'none';
    const p = walking ? 'walk' : pose;
    const j = this.targets(p, t, this.poseAt);
    const k = 1 - Math.exp(-dt * 9);
    const c = this.joints;
    (Object.keys(c) as (keyof Joints)[]).forEach((key) => (c[key] = damp(c[key], j[key], k)));
    this.yaw = damp(this.yaw, yawTarget, 1 - Math.exp(-dt * 6));
    rig.root.position.set(this.x, this.y, 0);
    rig.root.rotation.y = this.yaw;
    rig.bob.position.y = c.bobY;
    rig.bob.rotation.z = c.bobRz;
    rig.bob.scale.set(1 + (1 - c.scaleY) * 0.5, c.scaleY, 1);
    rig.head.rotation.set(c.headRx, c.headRy, c.headRz);
    rig.armL.rotation.set(c.armLx, 0, c.armLz);
    rig.armR.rotation.set(c.armRx, 0, c.armRz);
    rig.legL.rotation.x = c.legLx;
    rig.legR.rotation.x = c.legRx;
    const twitch = Math.max(0, Math.sin(t * 0.9) - 0.96) * 6;
    rig.earL.rotation.z = 0.36 + c.ear + twitch * 0.2;
    rig.earR.rotation.z = -0.36 - c.ear;
    rig.tail.forEach((seg, i) => {
      if (i === 0) return;
      seg.rotation.z = Math.sin(t * 2.4 - i * 0.55) * c.tailAmp * 0.5;
    });
    rig.laptop.visible = p === 'work';
    rig.mug.visible = p === 'drink';
    rig.pillow.visible = p === 'sleep';
    rig.steam.forEach((s, i) => {
      const ph = (t * 0.5 + i / 3) % 1;
      s.position.set(Math.sin(ph * 6 + i) * 0.015, 0.07 + ph * 0.16, 0);
      s.scale.setScalar(0.04 + ph * 0.06);
      (s.material as THREE.SpriteMaterial).opacity = Math.sin(ph * Math.PI) * 0.35;
    });
    // 耳机灯：聆听时随音量变亮
    const glow =
      p === 'listen'
        ? 1.4 + this.level * 4
        : p === 'talk'
          ? 1.8 + this.mouth * 2
          : 1.6 + Math.sin(t * 2.4) * 0.5;
    const base = new THREE.Color(this.skin.glow);
    rig.glowMats.forEach((m, i) => {
      if (i === 0 && this.skin.tail === 'cat')
        m.color.set(this.skin.accent2).multiplyScalar(2.2 + Math.sin(t * 2) * 0.4);
      else m.color.copy(base).multiplyScalar(glow);
    });
    // 眨眼
    if (t > this.blinkAt + 0.16 && Math.random() < dt / 3.5) this.blinkAt = t;
    const b = t - this.blinkAt < 0.16 ? Math.sin(((t - this.blinkAt) / 0.16) * Math.PI) : 0;
    rig.face.draw({
      eyes: eyesFor[p],
      blink: b,
      mouth: p === 'talk' ? Math.round(this.mouth * 12) / 12 : 0,
      mouthKind: p === 'talk' ? 'talk' : p === 'alert' ? 'o' : 'cat',
      lookX: Math.round(j.lookX * 10) / 10,
      lookY: Math.round(j.lookY * 10) / 10,
    });
  }

  private frame = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    this.animate(dt, this.clock.elapsedTime);
    if (this.bokeh)
      (this.bokeh.uniforms as Record<string, { value: number }>).focus.value =
        this.camera.position.distanceTo(this.rig.root.position) - 0.1;
    this.composer.render();
    if (this.events.onFrame) {
      const { w, h } = this.size;
      const toPx = (v: THREE.Vector3) => {
        v.project(this.camera);
        return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
      };
      this.events.onFrame({
        head: toPx(new THREE.Vector3(this.x, this.y + 1.28, 0)),
        foot: toPx(new THREE.Vector3(this.x, this.y, 0.25)),
      });
    }
  };
}

/** 离屏渲染若干张定格图（形象缩略图 / 动作一览），共用一个 WebGL 上下文。 */
export function snapshots(skin: Skin, poses: Pose[], w = 360, h = 420) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px`;
  document.body.appendChild(host);
  const world = new PetWorld(host, skin, false, {}, true);
  try {
    return poses.map((p) => world.renderStill(p));
  } finally {
    world.dispose();
    host.remove();
  }
}

/** 是否支持 WebGL（不支持时退回 SVG 桌宠）。 */
/**
 * 是否适合跑 3D 桌宠。没有 WebGL，或只有软件渲染（SwiftShader / llvmpipe 等，
 * 常见于无显卡的虚拟机、远程桌面和 CI）时返回 false，由调用方退回 2D 版。
 * `?3d` 强制开启，`?flat` 强制关闭。
 */
export function hasWebGL(allowSoftware = false) {
  const q = new URLSearchParams(location.search);
  if (q.has('flat')) return false;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    if (allowSoftware || q.has('3d')) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { AssistantState } from '../../shared/protocol';
export function Avatar({
  state,
  level,
  vrmUrl,
}: {
  state: AssistantState;
  level: number;
  vrmUrl?: string;
}) {
  const mount = useRef<HTMLDivElement>(null),
    values = useRef({ state, level });
  values.current = { state, level };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!vrmUrl || !mount.current) return;
    let stopped = false,
      raf = 0,
      vrm: VRM | undefined;
    const host = mount.current,
      scene = new THREE.Scene();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    camera.position.set(0, 1.35, 2.8);
    camera.lookAt(0, 1.25, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8492b8, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(1, 3, 2);
    scene.add(light);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      vrmUrl,
      (gltf) => {
        if (stopped) {
          VRMUtils.deepDispose(gltf.scene);
          return;
        }
        vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          setFailed(true);
          return;
        }
        VRMUtils.rotateVRM0(vrm);
        scene.add(vrm.scene);
        vrm.humanoid?.getNormalizedBoneNode('leftUpperArm')?.rotation.set(0, 0, -1.2);
        vrm.humanoid?.getNormalizedBoneNode('rightUpperArm')?.rotation.set(0, 0, 1.2);
      },
      undefined,
      () => {
        if (!stopped) setFailed(true);
      },
    );
    const resize = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
    });
    resize.observe(host);
    const clock = new THREE.Clock();
    const frame = () => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      const delta = clock.getDelta(),
        time = clock.elapsedTime;
      if (vrm) {
        vrm.expressionManager?.setValue(
          'aa',
          values.current.state === 'SPEAKING' ? Math.min(1, values.current.level * 3) : 0,
        );
        vrm.expressionManager?.setValue('blink', Math.pow(Math.max(0, Math.cos(time * 1.7)), 50));
        const head = vrm.humanoid?.getNormalizedBoneNode('head');
        if (head) {
          head.rotation.x =
            Math.sin(time * 1.2) * 0.025 + (values.current.state === 'LISTENING' ? 0.08 : 0);
          head.rotation.y = Math.sin(time * 0.4) * 0.04;
        }
        vrm.update(delta);
      }
      renderer.render(scene, camera);
    };
    frame();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [vrmUrl]);
  const talking = state === 'SPEAKING';
  return (
    <div className={`avatar-scene avatar-${state.toLowerCase()}`}>
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="avatar-floor" />
      {vrmUrl && !failed ? (
        <div className="vrm-host" ref={mount} />
      ) : (
        <div className="robot" aria-label="超宝默认数字形象">
          <div className="antenna">
            <i />
          </div>
          <div className="robot-head">
            <div className="visor">
              <span className="eye" />
              <span className="eye" />
              <div
                className={`mouth ${talking ? 'talking' : ''}`}
                style={talking ? { height: `${5 + level * 25}px` } : {}}
              />
            </div>
            <i className="cheek left" />
            <i className="cheek right" />
          </div>
          <div className="robot-neck" />
          <div className="robot-body">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M12 2q1.8 6.6 8.4 8.4-6.6 1.8-8.4 8.4-1.8-6.6-8.4-8.4Q10.2 8.6 12 2Z" />
            </svg>
            <i />
          </div>
          <div className="robot-hand hand-left" />
          <div className="robot-hand hand-right" />
        </div>
      )}
      {failed && <span className="avatar-warning">VRM 加载失败，已使用默认形象</span>}
    </div>
  );
}

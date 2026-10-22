import { useEffect, useState } from 'react';
import { PetSprite, type Pose } from './PetSprite';
import { skins, type SkinId } from './skins';
import { hasWebGL, snapshots } from '../pet3d/world';
import './pet.css';

const poses: [Pose, string][] = [
  ['sit', '待命'],
  ['walk', '散步'],
  ['look', '东张西望'],
  ['work', '敲电脑 / 思考'],
  ['drink', '喝咖啡'],
  ['stretch', '伸懒腰'],
  ['wave', '打招呼'],
  ['sleep', '打盹'],
  ['happy', '开心'],
  ['drag', '被拎起来'],
  ['alert', '听到呼唤'],
  ['listen', '聆听'],
  ['talk', '回答'],
];
const hero: Pose[] = ['sit', 'work', 'wave'];
/** 形象 / 动作总览页（?gallery、?gallery=poses&skin=fox，加 &flat 看 2D 版），用于挑选形象和设计验收。 */
export function Gallery() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('gallery');
  const skin = skins[(params.get('skin') ?? 'neko') as SkinId] ?? skins.neko;
  const flat = params.has('flat') || !hasWebGL(true);
  const [shots, setShots] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (flat) return;
    // 逐个渲染，避免一次占用多个 WebGL 上下文
    const next: Record<string, string[]> = {};
    if (mode === 'poses')
      next[skin.id] = snapshots(
        skin,
        poses.map((p) => p[0]),
        360,
        420,
      );
    else if (mode === 'hero')
      next[skin.id] = snapshots(skin, [(params.get('pose') ?? 'sit') as Pose], 720, 840);
    else for (const s of Object.values(skins)) next[s.id] = snapshots(s, hero, 360, 420);
    setShots(next);
  }, []);
  const view = (id: SkinId, pose: Pose, i: number) =>
    flat ? (
      <PetSprite key={pose} skin={skins[id]} pose={pose} mouth={0.7} />
    ) : shots[id]?.[i] ? (
      <img key={pose} src={shots[id][i]} alt="" />
    ) : (
      <div key={pose} className="gallery-loading" />
    );
  return (
    <div className="gallery" data-ready={flat || Object.keys(shots).length > 0}>
      {mode === 'hero' ? (
        <div className="gallery-hero">
          {view(skin.id, (params.get('pose') ?? 'sit') as Pose, 0)}
        </div>
      ) : mode === 'poses' ? (
        <>
          <h1>{skin.name} · 动作一览</h1>
          <div className="gallery-grid poses">
            {poses.map(([pose, name], i) => (
              <figure key={pose}>
                {view(skin.id, pose, i)}
                <figcaption>{name}</figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : (
        <>
          <h1>超宝桌宠 · 形象方案</h1>
          <div className="gallery-grid skins">
            {Object.values(skins).map((s, k) => (
              <figure key={s.id}>
                <div className="gallery-row">{hero.map((pose, i) => view(s.id, pose, i))}</div>
                <figcaption>
                  <b>
                    {'ABC'[k]} · {s.name}
                  </b>
                  <span>{s.intro}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

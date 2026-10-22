import { PetSprite, type Pose } from './PetSprite';
import { skins, type SkinId } from './skins';
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
/** 形象 / 动作总览页（?gallery、?gallery=poses&skin=fox），用于挑选形象和设计验收。 */
export function Gallery() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('gallery');
  const skinId = (params.get('skin') ?? 'neko') as SkinId;
  const skin = skins[skinId] ?? skins.neko;
  return (
    <div className="gallery">
      {mode === 'poses' ? (
        <>
          <h1>{skin.name} · 动作一览</h1>
          <div className="gallery-grid poses">
            {poses.map(([pose, name]) => (
              <figure key={pose} className="pet" style={{ position: 'relative', width: 'auto' }}>
                <PetSprite skin={skin} pose={pose} mouth={0.7} />
                <figcaption>{name}</figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : (
        <>
          <h1>超宝桌宠 · 形象方案</h1>
          <div className="gallery-grid skins">
            {Object.values(skins).map((s) => (
              <figure key={s.id} className="pet" style={{ position: 'relative', width: 'auto' }}>
                <div className="gallery-row">
                  <PetSprite skin={s} pose="sit" mouth={0} />
                  <PetSprite skin={s} pose="work" mouth={0} />
                  <PetSprite skin={s} pose="wave" mouth={0} />
                </div>
                <figcaption>
                  <b>
                    {s.id === 'neko' ? 'A' : s.id === 'fox' ? 'B' : 'C'} · {s.name}
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

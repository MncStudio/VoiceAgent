import { useId } from 'react';
import type { Skin } from './skins';
export type Pose =
  | 'sit'
  | 'walk'
  | 'look'
  | 'work'
  | 'drink'
  | 'stretch'
  | 'sleep'
  | 'wave'
  | 'happy'
  | 'drag'
  | 'fall'
  | 'alert'
  | 'listen'
  | 'talk';
export type Eyes = 'open' | 'happy' | 'sleep' | 'wide' | 'focus' | 'dizzy';
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
function Eye({ kind, side, glow }: { kind: Eyes; side: -1 | 1; glow: string }) {
  if (kind === 'happy')
    return (
      <path
        d="M-11 4 Q0 -11 11 4"
        stroke={glow}
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />
    );
  if (kind === 'sleep')
    return (
      <path
        d="M-10 -1 Q0 7 10 -1"
        stroke={glow}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
    );
  if (kind === 'dizzy')
    return (
      <path
        d={side < 0 ? 'M-7 -8 L7 0 L-7 8' : 'M7 -8 L-7 0 L7 8'}
        stroke={glow}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    );
  if (kind === 'focus')
    return (
      <g className="eye-blink">
        <rect x="-11" y="-5" width="22" height="10" rx="5" fill={glow} />
        <circle cx="-4" cy="-2" r="2" fill="#fff" opacity="0.9" />
      </g>
    );
  const big = kind === 'wide';
  return (
    <g className="eye-blink">
      <ellipse rx={big ? 12 : 10} ry={big ? 15 : 13} fill={glow} />
      <circle cx="-4" cy={big ? -6 : -5} r={big ? 4 : 3.2} fill="#fff" opacity="0.95" />
      <circle cx="4" cy="5" r="1.6" fill="#fff" opacity="0.6" />
    </g>
  );
}
function Ear({ skin, id }: { skin: Skin; id: string }) {
  const outer = skin.ears === 'fox' ? skin.patch : skin.shell[0];
  if (skin.ears === 'bunny')
    return (
      <g className="ear">
        <path
          d="M80 44 C64 0 66 -38 84 -42 C102 -46 110 -8 104 40 Z"
          fill={outer}
          stroke={skin.shell[1]}
          strokeWidth="2"
        />
        <path
          d="M86 36 C76 4 78 -26 88 -30 C98 -32 101 -4 98 34 Z"
          fill={`url(#${id}-ear)`}
          className="ear-glow"
        />
      </g>
    );
  if (skin.ears === 'fox')
    return (
      <g className="ear">
        <path
          d="M50 74 L56 4 Q58 -3 65 1 L118 36 Z"
          fill={outer}
          stroke={outer}
          strokeWidth="9"
          strokeLinejoin="round"
        />
        <path
          d="M63 58 L65 16 L104 40 Z"
          fill={`url(#${id}-ear)`}
          stroke="none"
          className="ear-glow"
        />
        <path d="M56 6 L65 1 L76 9 L58 18 Z" fill="#3b2a2a" opacity="0.75" />
      </g>
    );
  return (
    <g className="ear">
      <path
        d="M56 66 L64 14 Q66 7 73 10 L114 36 Z"
        fill={outer}
        stroke={outer}
        strokeWidth="9"
        strokeLinejoin="round"
      />
      <path d="M67 54 L71 22 L101 39 Z" fill={`url(#${id}-ear)`} className="ear-glow" />
    </g>
  );
}
function Tail({ skin, id }: { skin: Skin; id: string }) {
  if (skin.tail === 'fox')
    return (
      <g className="tail">
        <path
          d="M148 214 C192 226 232 196 224 152 C220 128 196 122 188 136 C204 160 190 196 148 200 Z"
          fill={skin.patch}
        />
        <path d="M224 152 C220 128 196 122 188 136 C198 144 206 150 224 152 Z" fill="#fffaf3" />
      </g>
    );
  if (skin.tail === 'bunny')
    return (
      <g className="tail">
        <circle
          cx="164"
          cy="212"
          r="15"
          fill={skin.shell[0]}
          stroke={skin.shell[1]}
          strokeWidth="3"
        />
        <circle cx="160" cy="207" r="5" fill="#fff" opacity="0.8" />
      </g>
    );
  return (
    <g className="tail">
      <path
        d="M152 214 C196 218 214 188 200 162 C192 148 206 136 216 146"
        stroke={skin.shell[1]}
        strokeWidth="16"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M152 214 C196 218 214 188 200 162 C192 148 206 136 216 146"
        stroke={skin.patch}
        strokeWidth="16"
        strokeDasharray="0 22 9 14"
        fill="none"
      />
      <circle
        cx="216"
        cy="146"
        r="9"
        fill={skin.accent2}
        filter={`url(#${id}-glow)`}
        className="tail-tip"
      />
    </g>
  );
}
function Paw({ skin, x, y, r = 1 }: { skin: Skin; x: number; y: number; r?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${r})`}>
      <ellipse cy="3" rx="6.5" ry="5" fill={skin.accent} />
      <circle cx="-6.5" cy="-4.5" r="2.4" fill={skin.accent} />
      <circle cx="0" cy="-7" r="2.4" fill={skin.accent} />
      <circle cx="6.5" cy="-4.5" r="2.4" fill={skin.accent} />
    </g>
  );
}
/**
 * 桌宠本体（SVG 分层：尾巴 / 身体 / 脚 / 手 / 头 / 道具），各部位用 CSS 动画驱动。
 * 正面造型左右对称，走路方向由外层 scaleX 翻转，尾巴与视线提示朝向。
 */
export function PetSprite({ skin, pose, mouth }: { skin: Skin; pose: Pose; mouth: number }) {
  const id = useId().replace(/:/g, '');
  const eyes = eyesFor[pose];
  const talking = pose === 'talk';
  return (
    <svg
      className={`pet-sprite pose-${pose}`}
      viewBox="0 -52 240 300"
      role="img"
      aria-label={`${skin.name}桌宠`}
    >
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={skin.shell[0]} />
          <stop offset="1" stopColor={skin.shell[1]} />
        </linearGradient>
        <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skin.visor[0]} />
          <stop offset="1" stopColor={skin.visor[1]} />
        </linearGradient>
        <linearGradient id={`${id}-ear`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={skin.accent} />
          <stop offset="1" stopColor={skin.accent2} />
        </linearGradient>
        <radialGradient id={`${id}-pod`}>
          <stop offset="0.55" stopColor={skin.shell[0]} />
          <stop offset="1" stopColor={skin.shell[1]} />
        </radialGradient>
        <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <ellipse className="pet-shadow" cx="120" cy="240" rx="66" ry="8" />
      {pose === 'sleep' && (
        <ellipse
          cx="120"
          cy="234"
          rx="84"
          ry="15"
          fill="#ece6ff"
          stroke="#ddd3fb"
          strokeWidth="2"
        />
      )}
      <g className="pet-bob">
        <Tail skin={skin} id={id} />
        <g className="pet-body">
          <path
            d="M80 196 C80 164 98 146 120 146 C142 146 160 164 160 196 C160 222 144 234 120 234 C96 234 80 222 80 196Z"
            fill={`url(#${id}-shell)`}
          />
          {skin.id !== 'bunny' && (
            <>
              <path
                d="M82 202 C84 218 94 229 108 233 C97 222 91 210 91 196 Z"
                fill={skin.patch}
                opacity="0.85"
              />
              <path
                d="M158 202 C156 218 146 229 132 233 C143 222 149 210 149 196 Z"
                fill={skin.patch}
                opacity="0.85"
              />
            </>
          )}
          <rect x="106" y="180" width="28" height="22" rx="8" fill={`url(#${id}-visor)`} />
          <path
            className="badge"
            d="M113 196 L113 186 L117 190 L123 190 L127 186 L127 196 Z"
            fill="none"
            stroke={skin.glow}
            strokeWidth="1.8"
            strokeLinejoin="round"
            filter={`url(#${id}-glow)`}
          />
          <path
            d="M92 156 Q120 172 148 156"
            stroke={skin.patch}
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="120" cy="167" r="6.5" fill="#f4b894" stroke="#d98b66" strokeWidth="1.5" />
          <circle cx="118" cy="165" r="1.8" fill="#fff" opacity="0.8" />
        </g>
        <g className="feet-sit">
          <g className="foot foot-l">
            <ellipse
              cx="94"
              cy="226"
              rx="18"
              ry="14"
              fill={`url(#${id}-shell)`}
              stroke={skin.patch}
              strokeOpacity="0.22"
              strokeWidth="1.5"
            />
            <Paw skin={skin} x={94} y={226} />
          </g>
          <g className="foot foot-r">
            <ellipse
              cx="146"
              cy="226"
              rx="18"
              ry="14"
              fill={`url(#${id}-shell)`}
              stroke={skin.patch}
              strokeOpacity="0.22"
              strokeWidth="1.5"
            />
            <Paw skin={skin} x={146} y={226} />
          </g>
        </g>
        <g className="feet-stand">
          <g className="step step-l">
            <rect
              x="84"
              y="222"
              width="26"
              height="16"
              rx="8"
              fill={`url(#${id}-shell)`}
              stroke={skin.patch}
              strokeOpacity="0.25"
              strokeWidth="1.5"
            />
            <rect x="86" y="233" width="22" height="5" rx="2.5" fill={skin.patch} opacity="0.8" />
          </g>
          <g className="step step-r">
            <rect
              x="130"
              y="222"
              width="26"
              height="16"
              rx="8"
              fill={`url(#${id}-shell)`}
              stroke={skin.patch}
              strokeOpacity="0.25"
              strokeWidth="1.5"
            />
            <rect x="132" y="233" width="22" height="5" rx="2.5" fill={skin.patch} opacity="0.8" />
          </g>
        </g>
        <g className="pet-head">
          <Ear skin={skin} id={id} />
          <g transform="translate(240 0) scale(-1 1)">
            <Ear skin={skin} id={id} />
          </g>
          <path
            d="M120 22 C178 22 204 56 204 96 C204 134 174 152 120 152 C66 152 36 134 36 96 C36 56 62 22 120 22Z"
            fill={`url(#${id}-shell)`}
            stroke={skin.shell[1]}
            strokeWidth="1.5"
          />
          {skin.id === 'fox' && (
            <path
              d="M38 90 C40 48 74 22 120 22 C166 22 200 48 202 90 C178 66 152 58 120 58 C88 58 62 66 38 90Z"
              fill={skin.patch}
            />
          )}
          {skin.id === 'neko' && (
            <ellipse
              cx="94"
              cy="32"
              rx="15"
              ry="6"
              fill={skin.patch}
              transform="rotate(-14 94 32)"
            />
          )}
          <path
            d="M70 40 C86 30 104 27 118 27"
            stroke="#fff"
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.9"
            fill="none"
          />
          <g className="pod pod-l">
            <circle cx="38" cy="102" r="22" fill={skin.patch} />
            <circle cx="38" cy="102" r="16" fill={`url(#${id}-pod)`} />
            <circle
              className="pod-ring"
              cx="38"
              cy="102"
              r="11"
              fill="none"
              stroke={skin.glow}
              strokeWidth="2.6"
              filter={`url(#${id}-glow)`}
            />
            <path d="M38 107 l-5 -5 a3 3 0 0 1 5 -4 a3 3 0 0 1 5 4 Z" fill={skin.accent} />
          </g>
          <g className="pod pod-r">
            <circle cx="202" cy="102" r="22" fill={skin.patch} />
            <circle cx="202" cy="102" r="16" fill={`url(#${id}-pod)`} />
            <circle
              className="pod-ring"
              cx="202"
              cy="102"
              r="11"
              fill="none"
              stroke={skin.glow}
              strokeWidth="2.6"
              filter={`url(#${id}-glow)`}
            />
            <circle cx="202" cy="102" r="3.5" fill={skin.glow} />
          </g>
          <path
            className="pet-visor"
            d="M120 46 C163 46 184 68 184 98 C184 124 164 138 120 138 C76 138 56 124 56 98 C56 68 77 46 120 46Z"
            fill={`url(#${id}-visor)`}
          />
          <path
            d="M74 66 C84 56 98 52 112 51"
            stroke="#fff"
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.22"
            fill="none"
          />
          <g className="face" filter={`url(#${id}-glow)`}>
            <g className="eyes">
              <g transform="translate(96 96)">
                <Eye kind={eyes} side={-1} glow={skin.glow} />
              </g>
              <g transform="translate(144 96)">
                <Eye kind={eyes} side={1} glow={skin.glow} />
              </g>
            </g>
            {talking && mouth > 0.04 ? (
              <ellipse
                cx="120"
                cy="120"
                rx={5 + mouth * 3}
                ry={1.6 + mouth * 7}
                fill={skin.accent}
              />
            ) : pose === 'alert' ? (
              <ellipse
                cx="120"
                cy="121"
                rx="4"
                ry="4.5"
                fill="none"
                stroke={skin.accent}
                strokeWidth="2.4"
              />
            ) : (
              <path
                d="M110 117 Q115 123 120 117 Q125 123 130 117"
                stroke={skin.accent}
                strokeWidth="2.6"
                strokeLinecap="round"
                fill="none"
              />
            )}
            <g stroke={skin.accent} strokeWidth="2.2" strokeLinecap="round" className="blush">
              <path d="M70 114 l-3 6 M76 114 l-3 6 M82 114 l-3 6" />
              <path d="M161 114 l-3 6 M167 114 l-3 6 M173 114 l-3 6" />
            </g>
          </g>
          <g stroke={skin.accent} strokeWidth="2" strokeLinecap="round" opacity="0.7">
            <path d="M42 120 L56 118 M43 128 L57 124" />
            <path d="M198 120 L184 118 M197 128 L183 124" />
          </g>
        </g>
        <g className="arm arm-l">
          <rect
            x="75"
            y="160"
            width="22"
            height="40"
            rx="11"
            fill={`url(#${id}-shell)`}
            stroke={skin.patch}
            strokeOpacity="0.25"
            strokeWidth="1.6"
          />
          <Paw skin={skin} x={86} y={192} r={0.62} />
        </g>
        <g className="arm arm-r">
          <rect
            x="143"
            y="160"
            width="22"
            height="40"
            rx="11"
            fill={`url(#${id}-shell)`}
            stroke={skin.patch}
            strokeOpacity="0.25"
            strokeWidth="1.6"
          />
          <Paw skin={skin} x={154} y={192} r={0.62} />
        </g>
        {pose === 'work' && (
          <g className="prop-laptop">
            <path
              d="M52 240 L188 240 L176 226 L64 226 Z"
              fill="#dfe3f2"
              stroke="#c7cde3"
              strokeWidth="1.5"
            />
            <rect
              x="70"
              y="176"
              width="100"
              height="52"
              rx="7"
              fill="#cdd3ea"
              stroke="#b9c0dc"
              strokeWidth="1.5"
            />
            <path
              d="M114 198 l6 6 l6 -6 a3.4 3.4 0 0 0 -6 -3 a3.4 3.4 0 0 0 -6 3Z"
              fill={skin.glow}
              filter={`url(#${id}-glow)`}
            />
          </g>
        )}
        {pose === 'drink' && (
          <g className="prop-mug">
            <path
              d="M132 170 q-4 -8 0 -14 M140 170 q-4 -8 0 -14"
              stroke="#c9bfe6"
              strokeWidth="2.4"
              strokeLinecap="round"
              fill="none"
              className="steam"
            />
            <rect
              x="124"
              y="174"
              width="24"
              height="26"
              rx="5"
              fill="#fff"
              stroke="#e1d6f0"
              strokeWidth="2"
            />
            <path d="M148 180 q9 2 0 13" stroke="#e1d6f0" strokeWidth="4" fill="none" />
            <rect x="124" y="174" width="24" height="6" rx="3" fill="#b88a6b" />
          </g>
        )}
      </g>
    </svg>
  );
}

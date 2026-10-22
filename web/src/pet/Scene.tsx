import type { ReactNode } from 'react';
/** 桌面场景：墙、窗、便利贴、书桌与小摆件。桌宠在桌面上活动。 */
export function Scene({
  night,
  notes,
  onNote,
  children,
}: {
  night: boolean;
  notes: string[];
  onNote: (text: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`scene ${night ? 'night' : 'day'}`}>
      <div className="wall" aria-hidden="true">
        <div className="window">
          <div className="sky">
            <i className="sun" />
            <i className="cloud c1" />
            <i className="cloud c2" />
            <i className="star s1" />
            <i className="star s2" />
            <i className="star s3" />
            <i className="city" />
          </div>
          <i className="mullion v" />
          <i className="mullion h" />
          <i className="sill" />
        </div>
        <div className="wall-clock">
          <i className="hand hour" />
          <i className="hand minute" />
        </div>
      </div>
      <div className="notes" aria-label="可以这样问我">
        {notes.map((text, i) => (
          <button key={text} className={`note n${i}`} onClick={() => onNote(text)}>
            <i className="pin" aria-hidden="true" />
            {text}
          </button>
        ))}
      </div>
      <div className="desk" aria-hidden="true">
        <i className="desk-top" />
        <div className="lamp">
          <i className="lamp-light" />
          <i className="lamp-head" />
          <i className="lamp-arm" />
          <i className="lamp-base" />
        </div>
        <div className="books">
          <i />
          <i />
          <i />
        </div>
        <div className="plant">
          <i className="leaf l1" />
          <i className="leaf l2" />
          <i className="leaf l3" />
          <i className="pot" />
        </div>
      </div>
      <div className="pet-zone">{children}</div>
    </div>
  );
}

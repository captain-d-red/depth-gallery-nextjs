'use client';

import { useImperativeHandle, useRef, type Ref } from 'react';
import { catalogue, type Film } from '@/data/catalogue';
import type { EngineFrame } from '@/engine/Engine';
import { formatOklch, hexToLinear, linearSrgbToOklab, oklabToOklch } from '@/lib/color';
import styles from './Hud.module.css';

export interface HudHandle {
  update(frame: EngineFrame): void;
}

interface HudProps {
  ref: Ref<HudHandle>;
  film: Film;
  index: number;
  onJump: (index: number) => void;
}

const { films } = catalogue;
const COUNT = films.length;
const FPS = 24;

/** Minutes of footage before each film, so the take's running time is a lookup. */
const START_MINUTES = films.reduce<number[]>((acc, f, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1]! + films[i - 1]!.minutes);
  return acc;
}, []);

/**
 * The timeline is a time axis, so every year gets an equal slot whatever its film count,
 * and the playhead moves through a year's slot as the take moves through its films.
 */
const YEARS = [...new Set(films.map((f) => f.year))];
const YEAR_SPANS = YEARS.map((year) => {
  const first = films.findIndex((f) => f.year === year);
  return { year, first, count: films.filter((f) => f.year === year).length };
});

function railPosition(position: number): number {
  const slot = YEAR_SPANS.findLastIndex((span) => span.first <= position + 1e-6);
  const span = YEAR_SPANS[Math.max(0, slot)]!;
  const within = Math.min(1, Math.max(0, (position - span.first) / span.count));
  return (Math.max(0, slot) + within) / YEAR_SPANS.length;
}

function timecode(position: number): string {
  const i = Math.min(COUNT - 1, Math.max(0, Math.floor(position)));
  const minutes = START_MINUTES[i]! + (position - i) * films[i]!.minutes;
  const totalFrames = Math.floor(minutes * 60 * FPS);
  const f = totalFrames % FPS;
  const s = Math.floor(totalFrames / FPS) % 60;
  const m = Math.floor(totalFrames / (FPS * 60)) % 60;
  const h = Math.floor(totalFrames / (FPS * 3600));
  return [h, m, s, f].map((v) => String(v).padStart(2, '0')).join(':');
}

const GRADE = [
  ['Key', 'key'],
  ['Fill', 'fill'],
  ['Shade', 'shade'],
] as const;

/**
 * The interface is a camera viewfinder, since the site is one camera move. Values that change
 * every frame are written through refs by the frame loop, and the rest re-renders only when
 * the framed film changes.
 */
export function Hud({ ref, film, index, onJump }: HudProps) {
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const focusRef = useRef<HTMLSpanElement>(null);
  const playheadRef = useRef<HTMLSpanElement>(null);
  const last = useRef({ timecode: '', focus: '' });

  useImperativeHandle(ref, () => ({
    update(frame) {
      const tc = timecode(frame.position);
      if (tc !== last.current.timecode && timecodeRef.current) {
        timecodeRef.current.textContent = tc;
        last.current.timecode = tc;
      }
      const focus = frame.focusDistance.toFixed(2);
      if (focus !== last.current.focus && focusRef.current) {
        focusRef.current.textContent = focus;
        last.current.focus = focus;
      }
      playheadRef.current?.style.setProperty('--t', railPosition(frame.position).toFixed(4));
    },
  }));

  return (
    <div className={styles.hud}>
      <div className={styles.frame} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>

      <header className={styles.top}>
        <p className={styles.brand}>Long Take</p>
        <p className={styles.tagline}>One continuous shot through seventy-two films</p>
        <p className={styles.rec} aria-hidden="true">
          <span className={styles.dot} />
          <span>Rec</span>
          <span ref={timecodeRef} className={styles.num}>
            00:00:00:00
          </span>
        </p>
      </header>

      <nav className={styles.rail} aria-label="Years">
        <span className={styles.spine} aria-hidden="true">
          <span ref={playheadRef} className={styles.playhead} />
        </span>
        <ol>
          {YEAR_SPANS.map(({ year, first }, slot) => (
            <li key={year} style={{ '--t': slot / YEAR_SPANS.length }}>
              <button type="button" onClick={() => onJump(first)} aria-current={film.year === year ? 'true' : undefined}>
                {year}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <footer className={styles.bottom}>
        <p className={styles.slate} aria-live="polite">
          <span className={styles.label}>Roll</span>
          <span key={`y${film.year}`} className={`${styles.year} ${styles.num}`}>
            {film.year}
          </span>
          <span className={styles.label}>Take</span>
          <span key={film.slug} className={`${styles.take} ${styles.num}`}>
            {String(index + 1).padStart(2, '0')}
            <span className={styles.of}>/{COUNT}</span>
          </span>
          <span className="sr-only">{`${film.title}, ${film.year}, directed by ${film.director}`}</span>
        </p>

        <dl className={styles.grade} aria-label="Grade">
          {GRADE.map(([label, key]) => {
            const hex = film.palette[key];
            return (
              <div key={key} className={styles.swatch}>
                <dt>{label}</dt>
                <dd>
                  <span className={styles.chip} style={{ background: hex }} />
                  <span key={hex} className={styles.hex}>
                    {hex.toUpperCase()}
                  </span>
                  <span key={`${hex}o`} className={styles.oklch}>
                    {formatOklch(oklabToOklch(linearSrgbToOklab(hexToLinear(hex))))}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>

        <p className={styles.focus} aria-hidden="true">
          <span className={styles.label}>Focus</span>
          <span ref={focusRef} className={styles.num}>
            3.30
          </span>
          <span className={styles.unit}>m</span>
        </p>
      </footer>
    </div>
  );
}

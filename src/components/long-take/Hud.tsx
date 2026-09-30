'use client';

import { useImperativeHandle, useRef, useState, type MouseEvent, type Ref } from 'react';
import { catalogue, type Film } from '@/data/catalogue';
import type { EngineFrame } from '@/engine/Engine';
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

/** Minutes of footage before each film, so the catalogue's running time is a lookup. */
const START_MINUTES = films.reduce<number[]>((acc, _, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1]! + films[i - 1]!.minutes);
  return acc;
}, []);

/**
 * The timeline is a time axis, so every year gets an equal slot whatever its film count,
 * and each film sits evenly inside its year's slot.
 */
const YEARS = [...new Set(films.map((f) => f.year))];
const YEAR_SPANS = YEARS.map((year) => {
  const first = films.findIndex((f) => f.year === year);
  return { year, first, count: films.filter((f) => f.year === year).length };
});
const FILM_T = films.map((film, i) => {
  const slot = YEARS.indexOf(film.year);
  const span = YEAR_SPANS[slot]!;
  return (slot + (i - span.first + 0.5) / span.count) / YEARS.length;
});

/** Rail position of a continuous film position, interpolated between neighbouring ticks. */
function railPosition(position: number): number {
  const i = Math.min(COUNT - 1, Math.max(0, Math.floor(position)));
  const next = Math.min(COUNT - 1, i + 1);
  return FILM_T[i]! + (FILM_T[next]! - FILM_T[i]!) * (position - i);
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

/**
 * The interface is a camera viewfinder over a streaming catalogue. Values that change every
 * frame are written through refs by the frame loop, and the rest re-renders only when the
 * framed film changes.
 */
export function Hud({ ref, film, index, onJump }: HudProps) {
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const focusRef = useRef<HTMLSpanElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<(HTMLSpanElement | null)[]>([]);
  const last = useRef({ timecode: '', focus: '', rail: -1 });
  const [preview, setPreview] = useState<number | null>(null);
  const [moved, setMoved] = useState(false);

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
      if (Math.abs(frame.position - last.current.rail) > 0.002) {
        last.current.rail = frame.position;
        railRef.current?.style.setProperty('--t', railPosition(frame.position).toFixed(4));
        // Ticks swell as the playhead nears them, like a loupe sliding along the rail.
        ticksRef.current.forEach((tick, i) => {
          const d = i - frame.position;
          tick?.style.setProperty('--m', Math.exp(-d * d * 0.35).toFixed(3));
        });
        if (!moved && frame.position > 0.15) setMoved(true);
      }
    },
  }));

  const nearestFilm = (e: MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = (e.clientY - box.top) / box.height;
    let best = 0;
    FILM_T.forEach((ft, i) => {
      if (Math.abs(ft - t) < Math.abs(FILM_T[best]! - t)) best = i;
    });
    return best;
  };

  const previewFilm = preview === null ? null : films[preview];

  return (
    <div className={styles.hud} style={{ '--key': film.palette.key }}>
      <div className={styles.frame} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>

      <header className={styles.top}>
        <p className={styles.brand}>
          AK47<span className={styles.section}>Through the Years</span>
        </p>
        <p className={styles.rec} aria-hidden="true">
          <span className={styles.dot} />
          <span>Rec</span>
          <span ref={timecodeRef} className={styles.num}>
            00:00:00:00
          </span>
        </p>
      </header>

      <div
        ref={railRef}
        className={styles.rail}
        onPointerMove={(e) => setPreview(nearestFilm(e))}
        onPointerLeave={() => setPreview(null)}
        onClick={(e) => onJump(nearestFilm(e))}
      >
        <span className={styles.spine} aria-hidden="true" />
        <span className={styles.ticks} aria-hidden="true">
          {films.map((f, i) => (
            <span
              key={f.slug}
              ref={(el) => {
                ticksRef.current[i] = el;
              }}
              className={styles.tick}
              data-year-start={i === 0 || films[i - 1]!.year !== f.year ? '' : undefined}
              style={{ '--y': FILM_T[i]! }}
            />
          ))}
        </span>
        <span className={styles.playhead} aria-hidden="true" />
        <nav aria-label="Years">
          <ol className={styles.years}>
            {YEAR_SPANS.map(({ year, first }, slot) => (
              <li key={year} style={{ '--y': slot / YEARS.length }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onJump(first);
                  }}
                  aria-current={film.year === year ? 'true' : undefined}
                >
                  {year}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {previewFilm && preview !== null && (
          <span className={styles.preview} style={{ '--y': FILM_T[preview]! }} aria-hidden="true">
            <span className={styles.previewTitle}>{previewFilm.title}</span>
            <span className={styles.previewYear}>{previewFilm.year}</span>
          </span>
        )}
      </div>

      <footer className={styles.bottom}>
        <p className={styles.slate} aria-live="polite">
          <span className={styles.label}>Year</span>
          <span key={`y${film.year}`} className={`${styles.year} ${styles.num}`}>
            {film.year}
          </span>
          <span className={styles.label}>Film</span>
          <span key={film.slug} className={`${styles.take} ${styles.num}`}>
            {String(index + 1).padStart(2, '0')}
            <span className={styles.of}>/{COUNT}</span>
          </span>
          <span className="sr-only">{`${film.title}, ${film.year}, directed by ${film.director}`}</span>
        </p>

        <p className={styles.hint} data-quiet={moved ? '' : undefined}>
          <span className={styles.wheel} aria-hidden="true">
            <i />
          </span>
          <span>Scroll to travel through time</span>
          <span className={styles.keys} aria-hidden="true">
            <kbd>←</kbd>
            <kbd>→</kbd>
          </span>
          <span>to step between films</span>
        </p>

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

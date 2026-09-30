'use client';

import Link from 'next/link';
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

/**
 * Ruler divisions per year. The rail is a true scale, so every division is the same size,
 * with a long mark on each year and a half mark between, like a steel rule.
 */
const DIVISIONS = 10;
const RULER = Array.from({ length: YEARS.length * DIVISIONS + 1 }, (_, k) => ({
  t: k / (YEARS.length * DIVISIONS),
  mark: k % DIVISIONS === 0 ? 'major' : k % (DIVISIONS / 2) === 0 ? 'half' : 'minor',
}));

/** Scroll speed, in films per second, at which the rail's crest reaches its widest. */
const FULL_SPEED = 3;

/** The streaming site's sections. This build ships the films view, so each link returns home. */
const SECTIONS = ['Home', 'Films', 'Series', 'New and Popular', 'My List'] as const;

/** Rail position of a continuous film position, interpolated between neighbouring films. */
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
  const last = useRef({ timecode: '', focus: '', rail: -1, speed: '' });
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
      // The rail's crest is drawn in CSS from these two values, the playhead and the speed.
      if (Math.abs(frame.position - last.current.rail) > 0.002) {
        last.current.rail = frame.position;
        railRef.current?.style.setProperty('--t', railPosition(frame.position).toFixed(5));
        if (!moved && frame.position > 0.15) setMoved(true);
      }
      const speed = Math.min(Math.abs(frame.scrollSpeed) / FULL_SPEED, 1).toFixed(2);
      if (speed !== last.current.speed) {
        railRef.current?.style.setProperty('--v', speed);
        last.current.speed = speed;
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
        <Link className={styles.brand} href="/" aria-label="AK47, Depth Gallery Experience">
          <svg className={styles.mark} viewBox="0 0 40 40" aria-hidden="true">
            <path d="M20 4 L36 35 H29.5 L20 16.5 L10.5 35 H4 Z" fill="currentColor" />
            <circle cx="20" cy="27.5" r="3.2" fill="var(--rec)" />
          </svg>
          <span className={styles.word}>AK47</span>
          <span className={styles.section}>Depth Gallery Experience</span>
        </Link>
        <nav className={styles.links} aria-label="Sections">
          {SECTIONS.map((section) => (
            <Link key={section} href="/" aria-current={section === 'Films' ? 'page' : undefined}>
              {section}
            </Link>
          ))}
        </nav>
        <Link className={styles.login} href="/">
          Log in
        </Link>
      </header>

      <div
        ref={railRef}
        className={styles.rail}
        style={{ '--divisions': YEARS.length * DIVISIONS }}
        onPointerMove={(e) => setPreview(nearestFilm(e))}
        onPointerLeave={() => setPreview(null)}
        onClick={(e) => onJump(nearestFilm(e))}
      >
        <span className={styles.spine} aria-hidden="true" />
        <span className={styles.ticks} aria-hidden="true">
          {RULER.map(({ t, mark }) => (
            <span key={t} className={styles.tick} data-mark={mark} style={{ '--y': t }} />
          ))}
        </span>
        <span className={styles.bead} aria-hidden="true" />
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
          <span className={styles.rec}>
            <span className={styles.dot} />
            <span>Rec</span>
            <span ref={timecodeRef} className={styles.num}>
              00:00:00:00
            </span>
          </span>
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

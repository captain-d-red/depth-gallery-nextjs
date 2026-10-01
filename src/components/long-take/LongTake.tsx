'use client';

import Lenis from 'lenis';
import { useEffect, useRef, useState } from 'react';
import { catalogue } from '@/data/catalogue';
import { Engine } from '@/engine/Engine';
import { SCROLL_PER_FILM } from '@/engine/layout';
import { QUALITY, pickQuality, type Quality } from '@/engine/quality';
import { uiFont } from '@/lib/fonts';
import { clamp } from '@/lib/math';
import { Hud, type HudHandle } from './Hud';
import styles from './LongTake.module.css';

type Status = 'starting' | 'running' | 'unsupported';

const COUNT = catalogue.films.length;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The quality profile for this device. `?quality=full` or `?quality=handheld` overrides the
 * choice, so the two can be compared on the same phone.
 */
function chooseQuality(): Quality {
  const forced = new URLSearchParams(window.location.search).get('quality');
  if (forced === 'full' || forced === 'handheld') return QUALITY[forced];
  return pickQuality({
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    shortSide: Math.min(window.screen.width, window.screen.height),
  });
}

/**
 * The page's one moving part. React owns the structure and the current film, while the
 * frame loop drives the engine and writes per-frame readouts straight into the HUD, so
 * nothing re-renders at sixty frames a second.
 */
export function LongTake() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HudHandle>(null);
  const meterRef = useRef<HTMLOutputElement>(null);
  const jumpRef = useRef<(index: number) => void>(() => {});
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<Status>('starting');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const quality = chooseQuality();
    document.documentElement.dataset.quality = quality.name;
    const meter = new URLSearchParams(window.location.search).has('fps') ? meterRef.current : null;
    let meterFrames = 0;
    let meterSince = 0;
    const lenis = new Lenis({ autoRaf: false, lerp: reducedMotion ? 1 : 0.075, wheelMultiplier: 0.85 });
    const pointer = { x: 0, y: 0, active: false };
    let engine: Engine | null = null;
    let raf = 0;
    let shownIndex = -1;
    let disposed = false;

    jumpRef.current = (target) => {
      const i = clamp(Math.round(target), 0, COUNT - 1);
      const distance = Math.abs(i - lenis.progress * (COUNT - 1));
      lenis.scrollTo((i / (COUNT - 1)) * lenis.limit, {
        duration: reducedMotion ? 0 : clamp(0.9 + distance * 0.09, 0.9, 2.8),
        easing: easeInOutCubic,
      });
    };

    // The pointer is measured against the canvas, which need not fill the window.
    const onPointerMove = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = ((e.clientX - box.left) / box.width) * 2 - 1;
      pointer.y = 1 - ((e.clientY - box.top) / box.height) * 2;
      pointer.active = e.pointerType === 'mouse' || e.pointerType === 'pen';
    };
    const onPointerLeave = () => {
      pointer.active = false;
    };
    const onClick = () => {
      const hovered = engine?.hoveredIndex;
      if (hovered !== null && hovered !== undefined && hovered !== shownIndex) jumpRef.current(hovered);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const step = e.key === 'ArrowRight' || e.key === 'j' ? 1 : e.key === 'ArrowLeft' || e.key === 'k' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      jumpRef.current(shownIndex + step);
    };

    const resize = () => engine?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
    const observer = new ResizeObserver(resize);

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (!engine) return;
      lenis.raf(time);
      const frame = engine.frame(time, {
        position: lenis.progress * (COUNT - 1),
        pointerX: pointer.x,
        pointerY: pointer.y,
        pointerActive: pointer.active,
      });
      hudRef.current?.update(frame);
      if (meter) {
        meterFrames += 1;
        if (time - meterSince >= 500) {
          const fps = (meterFrames * 1000) / (time - meterSince);
          meter.textContent = `${fps.toFixed(0)} fps · ${quality.name} · ${engine.renderRatio.toFixed(2)}×`;
          meterFrames = 0;
          meterSince = time;
        }
      }
      canvas.style.cursor = frame.hovered !== null && frame.hovered !== frame.index ? 'pointer' : '';
      if (frame.index !== shownIndex) {
        shownIndex = frame.index;
        setIndex(frame.index);
      }
    };

    const start = () => {
      if (disposed) return;
      try {
        engine = new Engine({
          canvas,
          catalogue,
          fontFamily: uiFont.style.fontFamily,
          reducedMotion,
          quality,
          onError: (error) => console.error(error),
        });
      } catch (error) {
        console.error(error);
        setStatus('unsupported');
        return;
      }
      resize();
      observer.observe(canvas);
      setStatus('running');
      raf = requestAnimationFrame(tick);
    };

    // Titles are drawn into canvases, so the face has to be ready before the first one is set.
    document.fonts
      .load(`720 100px ${uiFont.style.fontFamily}`)
      .catch(() => [])
      .then(start);

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      lenis.destroy();
      engine?.dispose();
      engine = null;
    };
  }, []);

  const film = catalogue.films[index] ?? catalogue.films[0]!;

  return (
    <div className={styles.root} data-status={status}>
      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <Hud ref={hudRef} film={film} index={index} onJump={(i) => jumpRef.current(i)} />
        {/* Frame meter, shown with ?fps in the address, for checking the rate on a real phone. */}
        <output ref={meterRef} className={styles.meter} aria-hidden="true" />
      </div>
      {status === 'unsupported' && (
        <p className={styles.unsupported} role="status">
          This take needs WebGL 2, which this browser has turned off. The full list of films is below.
        </p>
      )}
      <div className={styles.track} style={{ height: `calc(100lvh + ${(COUNT - 1) * SCROLL_PER_FILM * 100}lvh)` }} />
    </div>
  );
}

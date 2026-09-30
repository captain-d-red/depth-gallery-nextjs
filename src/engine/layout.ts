/**
 * World layout for the long take. Films sit along the negative Z axis in release order,
 * and the camera travels toward them, so depth in the scene is time in the catalogue.
 *
 *      camera                 film 0            film 1            film 2
 *   z = FOCUS ─────────────────► 0 ─── GAP ─────► -GAP ─── GAP ───► -2·GAP ...
 *
 * All functions here are pure, so the mapping from scroll to camera is unit tested.
 */

/** World distance between neighbouring films. */
export const GAP = 2.7;
/** Distance from the camera to a film when that film is framed. */
export const FOCUS = 3.3;
/** Poster height in world units. */
export const POSTER_HEIGHT = 1.46;
/** Scroll distance per film, as a fraction of the viewport height. */
export const SCROLL_PER_FILM = 0.78;
/**
 * How strongly the camera slows as it reaches a framed film. Zero is a constant speed,
 * and values near one make the camera linger at each poster and hurry between them.
 */
export const DWELL = 0.62;

const GOLDEN_ANGLE = 2.399963229728653;

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Yaw toward the camera path, in radians. */
  readonly yaw: number;
  /** A slight hand-hung roll, in radians. */
  readonly roll: number;
}

/**
 * Posters wander left and right on a golden-angle sequence, so neighbours never line up
 * and the next poster always peeks out from behind the current one.
 */
export function placeFilm(index: number): Placement {
  const x = 0.44 * Math.sin(index * GOLDEN_ANGLE) + 0.08 * Math.sin(index * 0.61);
  const y = 0.05 * Math.sin(index * 1.71 + 0.4);
  return {
    x,
    y,
    z: -index * GAP,
    yaw: -x * 0.16,
    roll: 0.014 * Math.sin(index * 3.13 + 1.1),
  };
}

/**
 * Remaps a continuous film position so the camera slows near each whole film and speeds
 * up between them. The map is monotonic for any dwell below one, and it fixes integers.
 */
export function dwell(position: number, amount: number = DWELL): number {
  return position - (amount * Math.sin(2 * Math.PI * position)) / (2 * Math.PI);
}

/** Camera Z for a continuous film position, where 0 frames the first film. */
export function cameraZForPosition(position: number): number {
  return FOCUS - position * GAP;
}

/** The inverse of {@link cameraZForPosition}. */
export function positionForCameraZ(z: number): number {
  return (FOCUS - z) / GAP;
}

/** Total scroll length in pixels for a catalogue of `count` films. */
export function scrollLength(count: number, viewportHeight: number): number {
  return Math.max(0, count - 1) * SCROLL_PER_FILM * viewportHeight;
}

/** Converts a scroll offset into a continuous film position, before the dwell is applied. */
export function positionForScroll(scroll: number, count: number, viewportHeight: number): number {
  const length = scrollLength(count, viewportHeight);
  if (length <= 0) return 0;
  const t = Math.min(1, Math.max(0, scroll / length));
  return t * (count - 1);
}

/** The scroll offset that frames film `index`. */
export function scrollForIndex(index: number, count: number, viewportHeight: number): number {
  const clamped = Math.min(count - 1, Math.max(0, index));
  return clamped * SCROLL_PER_FILM * viewportHeight;
}

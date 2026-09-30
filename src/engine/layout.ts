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

export interface Placement {
  /** Which side of the camera path the poster hangs on, with its type on the other side. */
  readonly side: 1 | -1;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Yaw toward the camera path, in radians. */
  readonly yaw: number;
  /** A slight hand-hung roll, in radians. */
  readonly roll: number;
}

/**
 * Posters alternate sides of the camera path, so the take zigzags through depth. Each
 * poster's type is set on the opposite side, and the next poster peeks out behind it.
 *
 *        type │ poster              film 0
 *    poster │ type                  film 1
 *        type │ poster              film 2
 */
export function placeFilm(index: number): Placement {
  const side = index % 2 === 0 ? 1 : -1;
  const x = side * (0.4 + 0.05 * Math.sin(index * 1.37));
  return {
    side,
    x,
    y: 0.04 * Math.sin(index * 1.71 + 0.4),
    z: -index * GAP,
    yaw: -x * 0.2,
    roll: 0.012 * Math.sin(index * 3.13 + 1.1),
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

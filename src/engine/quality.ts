/**
 * How much work a frame is allowed. A desktop GPU draws the take at full quality with room
 * to spare, while a phone GPU has a sixth to a tenth of that throughput, so phones and
 * tablets get a profile that keeps the look and spends far less on the parts the eye does
 * not resolve at arm's length: the haze and the floor reflection are soft by nature and lose
 * nothing at a lower resolution, and the dust is too fine to count.
 */
export interface Quality {
  readonly name: 'full' | 'handheld';
  /** Highest device pixel ratio the drawing buffer is rendered at. */
  readonly maxPixelRatio: number;
  /** Multisample count of the scene target. */
  readonly samples: number;
  /** Haze and floor reflection resolution, as a share of the drawing buffer on each axis. */
  readonly hazeScale: number;
  readonly mirrorScale: number;
  /** Poster light samples the haze and the floor sum per pixel, six per poster. */
  readonly lights: number;
  /** Half height, in taps, of the floor's vertical reflection blur. */
  readonly reflectionRows: number;
  /** Taps of the travel smear in the final pass. */
  readonly smearTaps: number;
  /** Grain cells across and down a poster's ash. */
  readonly dust: { readonly columns: number; readonly rows: number };
}

export const QUALITY: Readonly<Record<Quality['name'], Quality>> = {
  full: {
    name: 'full',
    maxPixelRatio: 2,
    samples: 4,
    hazeScale: 1 / 2,
    mirrorScale: 1 / 2,
    lights: 42,
    reflectionRows: 4,
    smearTaps: 12,
    dust: { columns: 150, rows: 225 },
  },
  handheld: {
    name: 'handheld',
    maxPixelRatio: 1.5,
    samples: 2,
    hazeScale: 1 / 4,
    mirrorScale: 1 / 3,
    lights: 18,
    reflectionRows: 2,
    smearTaps: 5,
    dust: { columns: 96, rows: 144 },
  },
};

export interface Device {
  /** Whether the primary pointer is a finger, from `(pointer: coarse)`. */
  readonly coarsePointer: boolean;
  /** Shorter side of the screen in CSS pixels. */
  readonly shortSide: number;
}

/** Touch-first devices and small screens take the handheld profile. */
export function pickQuality({ coarsePointer, shortSide }: Device): Quality {
  return coarsePointer || shortSide < 600 ? QUALITY.handheld : QUALITY.full;
}

/**
 * Watches how long frames take and lowers the pixel ratio when a device cannot keep up, so an
 * older phone settles at a density it can hold instead of stuttering. It only ever steps
 * down, and waits between steps so one slow moment does not cost the whole session its
 * sharpness.
 *
 *   frames ─► median of the last 90 ─► above 20 ms? ─► pixel ratio − 0.25, then wait 2 s
 */
export const GOVERNOR = {
  window: 90,
  /** Median frame interval above which the device is falling short of sixty frames a second. */
  budgetMs: 20,
  step: 0.25,
  floor: 1,
  cooldownMs: 2000,
} as const;

export class FrameGovernor {
  private readonly intervals: number[] = [];
  private lastStep = -Infinity;

  constructor(private ratio: number) {}

  get pixelRatio(): number {
    return this.ratio;
  }

  /**
   * Records one frame interval and returns a lower pixel ratio when the device has been
   * falling behind, or null when nothing should change.
   */
  sample(intervalMs: number, nowMs: number): number | null {
    this.intervals.push(intervalMs);
    if (this.intervals.length > GOVERNOR.window) this.intervals.shift();
    if (this.intervals.length < GOVERNOR.window || nowMs - this.lastStep < GOVERNOR.cooldownMs) return null;
    if (this.ratio <= GOVERNOR.floor) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median <= GOVERNOR.budgetMs) return null;
    this.ratio = Math.max(GOVERNOR.floor, this.ratio - GOVERNOR.step);
    this.lastStep = nowMs;
    this.intervals.length = 0;
    return this.ratio;
  }
}

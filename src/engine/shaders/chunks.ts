/**
 * GLSL shared by every pass. Shaders are TypeScript template strings so chunks compose with
 * plain interpolation and every constant stays in one typed place.
 */

/** Identity tag that lets editor tooling highlight GLSL inside template strings. */
export const glsl = (strings: TemplateStringsArray, ...values: (string | number)[]): string =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '');

/** Seven posters around the camera, six light samples each. */
export const MAX_LIGHTS = 42;

/** Bins over a poster's release sweep, each stamped with the moment the front passed it. */
export const RELEASE_BINS = 64;

/**
 * Seconds a poster mote drifts before it settles. A normal flick lands on the next film in
 * about six tenths of a second, so a mote outlives the move by well under a second.
 */
export const MOTE_SECONDS = 1.3;

/** Seconds the fine ash lasts, long enough to read as a puff and gone before the camera lands. */
export const FINE_SECONDS = 0.45;

/** Three adds `#version 300 es` itself for materials created with `glslVersion: GLSL3`. */
export const header = glsl`
precision highp float;
precision highp int;
`;

export const noise = glsl`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * valueNoise3(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}

float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm2(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise2(p);
    p = p * 2.02 + vec2(5.3, 1.9);
    amp *= 0.5;
  }
  return sum;
}
`;

/**
 * Single scattering in a uniform haze, lit by the light samples on nearby posters.
 *
 * For a point light at p and a view ray o + t·d, the in-scattered radiance up to distance T is
 * the integral of 1 / (h² + (t - b)²), where b is the distance along the ray to the point of
 * closest approach and h is the miss distance. That integral has a closed form in atan, so
 * every light costs a handful of instructions and no ray marching is needed:
 *
 *              p (light)
 *              |\
 *            h | \
 *              |  \
 *   o ─────────+───────────────► d
 *        b     closest approach
 *
 *   L(T) = (atan((T - b) / h) + atan(b / h)) / h
 *
 * A poster is a lightbox that shines toward the viewer, so each light only fills the half-space
 * in front of its own plane, and the segment behind the plane is cut off. Light samples are
 * softened so a ray that grazes a sample never blows out, and a slowly moving noise field
 * modulates the density so the air visibly drifts.
 *
 * Past the framed distance a second, denser fog term takes over, so deeper posters sink
 * into the dark the way far objects do in a smoky room.
 */
export const haze = glsl`
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;
uniform float uScatter;
uniform float uExtinction;
uniform float uSoft;
uniform float uFalloff;
uniform float uDepthFog;
uniform float uTime;

vec2 hazeNoise(vec3 ro, vec3 rd) {
  vec3 drift = vec3(0.021, 0.034, -0.012) * uTime;
  float a = fbm3((ro + rd * 2.4) * 0.62 + drift);
  float b = fbm3((ro + rd * 7.0) * 0.38 + drift * 0.7 + 11.0);
  return vec2(0.35 + 1.3 * a, 0.35 + 1.3 * b);
}

float depthFog(float dist) {
  return exp(-uExtinction * dist - uDepthFog * max(dist - 3.9, 0.0));
}

vec3 inscatter(vec3 ro, vec3 rd, float tMax, vec2 density) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    float tEnd = tMax;
    if (rd.z < -1e-4) {
      tEnd = min(tEnd, max((lp.w - ro.z) / rd.z, 0.0));
    } else if (ro.z < lp.w) {
      continue;
    }
    if (tEnd <= 0.0) continue;
    vec3 op = lp.xyz - ro;
    float b = dot(op, rd);
    float h = sqrt(max(dot(op, op) - b * b, 0.0) + uSoft);
    float line = (atan((tEnd - b) / h) + atan(b / h)) / h;
    // Light also dims on its way out from the poster, which keeps each glow close to its frame.
    float fog = exp(-uExtinction * max(b, 0.0) - uFalloff * h);
    float d = mix(density.x, density.y, smoothstep(1.5, 7.5, b));
    sum += uLightCol[i].rgb * (line * fog * d);
  }
  return sum * uScatter;
}
`;

/**
 * Where the release front stands at a point of a surface, as a signed distance: negative
 * before the front arrives, zero at the front, one when a released particle ends its flight.
 * The front sweeps across the surface and broad noise breaks it into drifts. The surface
 * fades smoothly on this front, and each particle adds its own jitter to the timing, so the
 * grain lives in the particles and never shows as blocks in the print.
 */
export const release = glsl`
/** How far ahead of the front a particle appears in place while the surface fades under it. */
const float HANDOFF = 0.1;

/** Release progress over which the front crosses one point of a surface. */
const float FRONT_WIDTH = 0.42;

/** Each particle leaves a little early or late, which scatters the front into grain. */
float releaseJitter(float seed) {
  return (seed - 0.5) * 0.16;
}

float releaseFront(vec2 uv, float seed, float direction, float progress) {
  float sweep = direction > 0.0 ? uv.x : 1.0 - uv.x;
  float drifts = 0.66 * valueNoise2(uv * vec2(4.0, 2.6) + seed * 13.7) + 0.34 * valueNoise2(uv * vec2(11.0, 7.0) + seed * 5.3);
  float threshold = 0.5 * sweep + 0.5 * drifts;
  return (progress * (1.0 + FRONT_WIDTH) - threshold) / FRONT_WIDTH;
}

/** Zero before the front arrives, rising to one as the grain finishes its flight. */
float releaseAmount(vec2 uv, float seed, float direction, float progress) {
  return clamp(releaseFront(uv, seed, direction, progress), 0.0, 1.0);
}
`;

/**
 * A thin lens focused at `uFocus`. The blur circle grows with how far a surface sits from the
 * focal plane, measured as a ratio, so a poster twice the focus distance away is blurred half
 * as much as one at infinity. `uAperture` is that infinite-distance radius in device pixels.
 *
 *   coc(d) = aperture * max(| 1 - focus / d | - zone, 0)
 *
 * The zone is the depth of field, so a title set a little behind its poster stays as sharp.
 * `uPxToView` converts a pixel radius to a view-space size at unit depth, which lets sprites
 * grow into bokeh discs of the right size.
 */
export const lens = glsl`
uniform float uFocus;
uniform float uAperture;
uniform float uPxToView;

/** Depth that still reads as sharp, as a share of the focus distance on either side. */
const float FOCUS_ZONE = 0.07;

float circleOfConfusion(float depth) {
  float miss = max(abs(1.0 - uFocus / max(depth, 1e-3)) - FOCUS_ZONE, 0.0);
  return min(uAperture * miss, uAperture * 1.8);
}
`;

/** Full-screen triangle, so every screen pass shades each pixel once without a diagonal seam. */
export const fullscreenVertex = glsl`${header}
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Rebuilds a world-space view ray from the camera basis, shared by screen passes. */
export const viewRay = glsl`
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;

vec3 viewRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCamForward + ndc.x * uTanHalf.x * uCamRight + ndc.y * uTanHalf.y * uCamUp);
}
`;

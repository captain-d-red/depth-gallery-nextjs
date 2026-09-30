/**
 * GLSL shared by every pass. Shaders are TypeScript template strings so chunks compose with
 * plain interpolation and every constant stays in one typed place.
 */

/** Identity tag that lets editor tooling highlight GLSL inside template strings. */
export const glsl = (strings: TemplateStringsArray, ...values: (string | number)[]): string =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '');

/** Seven posters around the camera, six light samples each. */
export const MAX_LIGHTS = 42;

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
 */
export const haze = glsl`
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;
uniform float uScatter;
uniform float uExtinction;
uniform float uSoft;
uniform float uTime;

vec2 hazeNoise(vec3 ro, vec3 rd) {
  vec3 drift = vec3(0.021, 0.034, -0.012) * uTime;
  float a = fbm3((ro + rd * 2.4) * 0.62 + drift);
  float b = fbm3((ro + rd * 7.0) * 0.38 + drift * 0.7 + 11.0);
  return vec2(0.35 + 1.3 * a, 0.35 + 1.3 * b);
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
    float fog = exp(-uExtinction * max(b, 0.0));
    float d = mix(density.x, density.y, smoothstep(1.5, 7.5, b));
    sum += uLightCol[i].rgb * (line * fog * d);
  }
  return sum * uScatter;
}
`;

/**
 * How far text has broken into dust at a given progress. Titles and their particles call the
 * same function, so a glyph fragment disappears at exactly the moment its particle leaves.
 * The front sweeps away from the poster and is broken up by noise, like breath on cold glass.
 */
export const release = glsl`
float releaseAmount(vec2 uv, float seed, float direction, float progress) {
  float sweep = direction > 0.0 ? uv.x : 1.0 - uv.x;
  float threshold = 0.58 * sweep + 0.42 * valueNoise2(uv * vec2(13.0, 6.5) + seed * 13.7);
  return clamp((progress * 1.42 - threshold) / 0.42, 0.0, 1.0);
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

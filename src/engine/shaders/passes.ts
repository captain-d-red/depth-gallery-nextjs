import { MAX_LIGHTS, fullscreenVertex, glsl, haze, header, noise, release, viewRay } from './chunks';

export { fullscreenVertex };

/** The haze itself, rendered at half resolution because scattered light has no fine detail. */
export const hazeFragment = glsl`${header}
${noise}
${haze}
${viewRay}
uniform vec3 uAmbient;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 rd = viewRay(vUv);
  vec2 density = hazeNoise(uCamPos, rd);
  vec3 col = inscatter(uCamPos, rd, 80.0, density);
  col += uAmbient * (0.55 + 0.45 * density.y);
  fragColor = vec4(col, 1.0);
}
`;

/** Lays the half-resolution haze behind the scene and writes the far plane. */
export const backdropFragment = glsl`${header}
uniform sampler2D uHaze;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uHaze, vUv).rgb, 1.0);
}
`;

export const posterVertex = glsl`${header}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * A poster is a backlit lightbox. It streams from a low resolution atlas cell to the full
 * image and sits inside the same haze as everything else, so deeper posters sink into the
 * dark. As the camera walks through it, the release front hands each fragment over to its
 * particle, and the poster breaks into dust.
 */
export const posterFragment = glsl`${header}
${noise}
${haze}
${release}
uniform vec3 cameraPosition;
uniform sampler2D uAtlas;
uniform vec4 uAtlasRect;
uniform sampler2D uMap;
uniform float uMapMix;
uniform float uFar;
uniform float uRelease;
uniform float uDirection;
uniform float uGlow;
uniform float uHover;
uniform float uSeed;
in vec2 vUv;
in vec3 vWorld;
out vec4 fragColor;

void main() {
  if (uRelease > 0.0 && releaseAmount(vUv, uSeed, uDirection, uRelease) > 0.0) discard;
  vec3 lo = texture(uAtlas, uAtlasRect.xy + vUv * uAtlasRect.zw).rgb;
  vec3 hi = texture(uMap, vUv).rgb;
  vec3 col = mix(lo, hi, uMapMix) * uGlow * (1.0 + 0.12 * uHover);

  // A hairline where the light leaks around the frame.
  vec2 e = min(vUv, 1.0 - vUv) * vec2(1.0, 1.5);
  float rim = 1.0 - smoothstep(0.0, 0.008, min(e.x, e.y));
  col += rim * 0.1 * uGlow;

  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;
  col = col * depthFog(dist) * uFar + inscatter(cameraPosition, rd, dist, hazeNoise(cameraPosition, rd));
  fragColor = vec4(col, 1.0);
}
`;

/**
 * The poster's own dust. One particle per cell of a grid over the poster, coloured from the
 * same image, so the frame stays whole until the release front reaches a cell. Released
 * particles part around the camera path and drift, the way smoke parts for someone walking
 * through it, and they glow a little as they go.
 */
export const posterDustVertex = glsl`${header}
${noise}
${release}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform sampler2D uAtlas;
uniform vec4 uAtlasRect;
uniform sampler2D uMap;
uniform float uMapMix;
uniform vec2 uPlane;
uniform vec2 uGrid;
uniform float uRelease;
uniform float uDirection;
uniform float uSeed;
in vec3 position;
in vec3 aCell;
out vec3 vColor;
out vec2 vLocal;
out float vAlpha;

void main() {
  vec2 uv = aCell.xy;
  float r = releaseAmount(uv, uSeed, uDirection, uRelease);
  vec3 color = mix(
    textureLod(uAtlas, uAtlasRect.xy + uv * uAtlasRect.zw, 0.0).rgb,
    textureLod(uMap, uv, 2.0).rgb,
    uMapMix
  );

  vec4 world = modelMatrix * vec4((uv.x - 0.5) * uPlane.x, (uv.y - 0.5) * uPlane.y, 0.0, 1.0);
  vec3 q = vec3(uv * vec2(5.0, 7.5), aCell.z * 7.0 + uSeed * 3.0);
  vec3 swirl = vec3(valueNoise3(q), valueNoise3(q + 23.4), valueNoise3(q + 51.9)) - 0.5;
  vec2 away = world.xy - cameraPosition.xy;
  away = normalize(away + vec2(1e-4)) * (0.35 + 0.65 * smoothstep(0.0, 0.9, length(away)));
  float travel = 1.0 - exp(-r * 2.2);
  world.xyz += vec3(away * 0.9 + swirl.xy * 1.1, 0.35 + swirl.z * 0.9) * travel;
  world.y += r * r * 0.18;

  vec4 view = viewMatrix * world;
  float cell = uPlane.x / uGrid.x;
  view.xy += position.xy * cell * (0.62 + r * 0.9);
  gl_Position = projectionMatrix * view;

  vColor = color * (1.0 + r * 1.6);
  vLocal = position.xy;
  vAlpha = r > 0.0 && r < 1.0 ? pow(1.0 - r, 1.3) * smoothstep(0.0, 0.05, r) * smoothstep(0.05, 0.5, -view.z) : 0.0;
}
`;

export const posterDustFragment = glsl`${header}
in vec3 vColor;
in vec2 vLocal;
in float vAlpha;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  float a = exp(-dot(vLocal, vLocal) * 2.2) * vAlpha;
  fragColor = vec4(vColor * a, 1.0);
}
`;

/**
 * Type is set in the scene beside its poster, so it sits in the same air. Wherever the
 * release front has passed, the glyph is gone and its particle has taken over.
 */
export const titleFragment = glsl`${header}
${noise}
${release}
uniform vec3 cameraPosition;
uniform sampler2D uMap;
uniform vec3 uInk;
uniform float uOpacity;
uniform float uExtinction;
uniform float uProgress;
uniform float uSeed;
uniform float uDirection;
in vec2 vUv;
in vec3 vWorld;
out vec4 fragColor;
void main() {
  float coverage = texture(uMap, vUv).r;
  if (coverage < 0.004) discard;
  float released = releaseAmount(vUv, uSeed, uDirection, uProgress);
  if (released > 0.0) discard;
  float dist = length(vWorld - cameraPosition);
  fragColor = vec4(uInk * exp(-uExtinction * dist), coverage * uOpacity);
}
`;

/**
 * One particle per sampled glyph pixel. It waits invisibly until the release front reaches
 * it, then puffs away from the page, rising and spreading like breath in cold air.
 */
export const titleDustVertex = glsl`${header}
${noise}
${release}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uPlane;
uniform float uProgress;
uniform float uSeed;
uniform float uDirection;
uniform float uPixel;
uniform vec2 uResolution;
in vec3 position;
in vec4 aPoint;
out vec2 vLocal;
out float vAlpha;

void main() {
  float r = releaseAmount(aPoint.xy, uSeed, uDirection, uProgress);
  vec3 local = vec3((aPoint.x - 0.5) * uPlane.x, (aPoint.y - 0.5) * uPlane.y, 0.0);
  vec3 q = vec3(aPoint.xy * vec2(7.0, 3.5), aPoint.z * 9.0 + uSeed);
  vec3 swirl = vec3(valueNoise3(q), valueNoise3(q + 19.1), valueNoise3(q + 41.7)) - 0.5;
  float travel = 1.0 - exp(-r * 2.4);
  vec3 drift = vec3(-uDirection * 0.28 + swirl.x * 0.75, 0.22 + swirl.y * 0.55, 0.3 + swirl.z * 0.9);
  local += drift * travel * 0.85 + vec3(0.0, r * r * 0.22, 0.0);
  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
  float size = uPixel * aPoint.w * (1.0 + r * 2.4);
  clip.xy += position.xy * size / uResolution * 2.0 * clip.w;
  gl_Position = clip;
  vLocal = position.xy;
  vAlpha = r > 0.0 && r < 1.0 ? pow(1.0 - r, 1.6) * smoothstep(0.0, 0.06, r) : 0.0;
}
`;

export const titleDustFragment = glsl`${header}
uniform vec3 uInk;
uniform float uOpacity;
in vec2 vLocal;
in float vAlpha;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  float a = exp(-dot(vLocal, vLocal) * 3.0) * vAlpha * uOpacity;
  fragColor = vec4(uInk * a, 1.0);
}
`;

/**
 * Dust hangs in the haze and only shows where poster light reaches it. Each mote is a quad
 * that stretches along its own screen motion when the camera moves fast.
 */
export const dustVertex = glsl`${header}
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;
uniform vec3 uBox;
uniform float uTime;
uniform float uVelocity;
uniform float uPixel;
uniform vec2 uResolution;
uniform float uBrightness;
in vec3 position;
in vec4 aSeed;
out vec3 vColor;
out vec2 vLocal;
out float vStretch;

void main() {
  // Motes wrap inside a box that travels with the camera, so the volume never runs out.
  vec3 cell = fract(aSeed.xyz + vec3(sin(uTime * 0.05 + aSeed.w * 6.28) * 0.01, uTime * 0.0035 * (0.5 + aSeed.w), 0.0));
  vec3 p;
  p.x = cameraPosition.x + (cell.x - 0.5) * uBox.x;
  p.y = cameraPosition.y + (cell.y - 0.5) * uBox.y;
  float zs = fract(cell.z - cameraPosition.z / uBox.z);
  p.z = cameraPosition.z + 0.6 - zs * uBox.z;

  vec3 light = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    if (p.z < lp.w) continue;
    vec3 d = lp.xyz - p;
    light += uLightCol[i].rgb / (dot(d, d) + 0.35);
  }

  vec4 viewPos = viewMatrix * vec4(p, 1.0);
  float depth = -viewPos.z;
  vec4 clip = projectionMatrix * viewPos;
  // The same mote a moment earlier, which gives the direction of its streak on screen.
  vec4 prevClip = projectionMatrix * viewMatrix * vec4(p + vec3(0.0, 0.0, uVelocity * 0.9), 1.0);
  vec2 ndc = clip.xy / clip.w;
  vec2 prevNdc = prevClip.xy / prevClip.w;
  vec2 motion = (ndc - prevNdc) * uResolution * 0.5;
  float len = length(motion);
  vec2 dir = len > 1e-3 ? motion / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  float size = uPixel * (0.9 + 1.6 * aSeed.w) * clamp(2.2 / depth, 0.35, 2.4);
  float stretch = min(len, 60.0 * uPixel);
  vec2 offset = nrm * position.x * size + dir * position.y * (size + stretch);
  clip.xy += offset / uResolution * 2.0 * clip.w;
  gl_Position = clip;

  float nearFade = smoothstep(0.25, 1.1, depth);
  float farFade = 1.0 - smoothstep(uBox.z * 0.55, uBox.z * 0.95, depth);
  vColor = light * uBrightness * nearFade * farFade * (0.35 + 0.65 * aSeed.w) * (size / (size + stretch));
  vLocal = position.xy;
  vStretch = stretch / (size + stretch);
}
`;

export const dustFragment = glsl`${header}
in vec3 vColor;
in vec2 vLocal;
in float vStretch;
out vec4 fragColor;
void main() {
  vec2 q = vec2(vLocal.x, vLocal.y * mix(1.0, 0.35, vStretch));
  float r = dot(q, q);
  float a = exp(-r * 3.2);
  fragColor = vec4(vColor * a, 1.0);
}
`;

/**
 * Final pass. Fast travel smears the frame toward the vanishing point with a slight split
 * of the three primaries, then highlights roll off, grain is laid in and the image is
 * dithered and encoded for the display.
 */
export const postFragment = glsl`${header}
${noise}
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec2 uVanish;
uniform float uSmear;
uniform float uTime;
uniform float uExposure;
uniform float uGrain;
uniform float uFade;
in vec2 vUv;
out vec4 fragColor;

vec3 shoulder(vec3 c) {
  float m = max(max(c.r, c.g), c.b);
  const float knee = 0.78;
  if (m <= knee) return c;
  float over = m - knee;
  float mapped = knee + (1.0 - knee) * over / (over + (1.0 - knee));
  return c * (mapped / m);
}

vec3 encodeSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 toCentre = vUv - uVanish;
  vec3 col = vec3(0.0);
  if (uSmear > 0.0005) {
    const int TAPS = 12;
    float weight = 0.0;
    float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 91.0);
    for (int i = 0; i < TAPS; i++) {
      float t = (float(i) + jitter) / float(TAPS);
      float s = 1.0 - uSmear * t;
      float w = 1.0 - t * 0.7;
      float split = uSmear * 0.16 * t;
      col.r += texture(uScene, uVanish + toCentre * (s + split)).r * w;
      col.g += texture(uScene, uVanish + toCentre * s).g * w;
      col.b += texture(uScene, uVanish + toCentre * (s - split)).b * w;
      weight += w;
    }
    col /= weight;
  } else {
    col = texture(uScene, vUv).rgb;
  }

  col *= uExposure;
  float vignette = 1.0 - 0.34 * smoothstep(0.35, 1.05, length(toCentre * vec2(uResolution.x / uResolution.y, 1.0)));
  col *= vignette;
  col = shoulder(col) * uFade;
  vec3 srgb = encodeSrgb(col);

  float luma = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
  float grain = hash12(gl_FragCoord.xy * 0.73 + vec2(fract(uTime * 13.1) * 311.0, fract(uTime * 7.7) * 173.0)) - 0.5;
  srgb += grain * uGrain * (1.0 - 0.65 * luma);
  float dither = hash12(gl_FragCoord.xy + 17.0) + hash12(gl_FragCoord.yx + 41.0) - 1.0;
  srgb += dither / 255.0;
  fragColor = vec4(srgb, 1.0);
}
`;

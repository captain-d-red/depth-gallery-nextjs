import { MAX_LIGHTS, fullscreenVertex, glsl, haze, header, lens, noise, release, viewRay } from './chunks';

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

/** Lays the half-resolution haze behind the scene. */
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
 * A poster is a backlit print in a dark, hazy room, seen through a real lens.
 *
 * - The quad is padded beyond the print, so an out-of-focus edge spreads past the frame the
 *   way a defocused rectangle does, instead of staying razor sharp.
 * - Blur is read from the mip chain at the radius the lens asks for, through a ring of taps,
 *   so the mip levels never show as blocks.
 * - A hairline rim runs round the frame in a gradient between the film's two colours.
 * - Under the pointer, a clear-coat highlight slides across the print.
 * - As the camera walks through, the release front hands each fragment to its particle.
 *
 * Output is premultiplied, so the rim can glow outside the print while the print covers.
 */
export const posterFragment = glsl`${header}
${noise}
${haze}
${release}
${lens}
uniform vec3 cameraPosition;
uniform sampler2D uAtlas;
uniform vec4 uAtlasRect;
uniform sampler2D uMap;
uniform float uMapMix;
uniform vec2 uMapSize;
uniform vec2 uPad;
uniform float uFar;
uniform float uRelease;
uniform float uDirection;
uniform float uHover;
uniform float uSeed;
uniform vec3 uKey;
uniform vec3 uAccent;
uniform vec2 uSheen;
in vec2 vUv;
in vec3 vWorld;
out vec4 fragColor;

const vec2 RING[8] = vec2[8](
  vec2(1.0, 0.0), vec2(0.7071, 0.7071), vec2(0.0, 1.0), vec2(-0.7071, 0.7071),
  vec2(-1.0, 0.0), vec2(-0.7071, -0.7071), vec2(0.0, -1.0), vec2(0.7071, -0.7071)
);

vec3 print(vec2 uv, float lod) {
  vec3 lo = textureLod(uAtlas, uAtlasRect.xy + uv * uAtlasRect.zw, 0.0).rgb;
  vec3 hi = textureLod(uMap, uv, lod).rgb;
  return mix(lo, hi, uMapMix);
}

void main() {
  vec2 puv = (vUv - uPad) / (1.0 - 2.0 * uPad);
  vec2 cuv = clamp(puv, 0.0, 1.0);
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;

  float coc = circleOfConfusion(dist);
  vec2 uvPerPx = max(fwidth(puv), vec2(1e-6));
  vec2 inside2 = (0.5 - abs(puv - 0.5)) / uvPerPx;
  float inside = min(inside2.x, inside2.y);
  float spread = max(coc, 0.6);
  float coverage = smoothstep(-spread, spread, inside);

  // The rim sits just outside the print and blurs with it.
  float rimWidth = max(0.85, coc * 0.8);
  float rim = exp(-pow((inside + 0.9) / rimWidth, 2.0)) / (1.0 + coc * 0.22);
  if (coverage < 0.002 && rim < 0.004) discard;
  // Just ahead of the release front the print smoulders in its key colour, so the image
  // turns to ash along a glowing seam instead of a hard cut.
  float front = uRelease > 0.0 ? releaseFront(cuv, uSeed, uDirection, uRelease) : -1.0;
  if (front > 0.0) discard;
  float seam = smoothstep(-0.09, 0.0, front);

  vec3 col;
  if (coc < 0.9) {
    col = mix(textureLod(uAtlas, uAtlasRect.xy + cuv * uAtlasRect.zw, 0.0).rgb, texture(uMap, cuv).rgb, uMapMix);
  } else {
    float lod = log2(max(coc * uMapSize.y * uvPerPx.y * 0.45, 1.0));
    vec2 r = coc * uvPerPx * 0.6;
    col = print(cuv, lod) * 2.0;
    for (int i = 0; i < 8; i++) col += print(clamp(cuv + RING[i] * r, 0.0, 1.0), lod);
    col /= 10.0;
  }

  // Clear coat. A broad soft sheen and a tighter core, stretched like a studio softbox.
  vec2 d = (cuv - uSheen) * vec2(1.0, 0.58);
  float spec = exp(-dot(d, d) * 6.0) * 0.16 + exp(-dot(d, d) * 55.0) * 0.14;
  col += spec * uHover * vec3(1.0, 0.98, 0.95);

  col = mix(col, uKey * 2.4 + 0.25, seam * seam) + uKey * seam * 0.8;

  float along = clamp(0.5 + (puv.x - puv.y) * 0.5, 0.0, 1.0);
  vec3 rimColour = mix(uKey, uAccent, along) * 1.35;

  float fog = depthFog(dist) * uFar;
  // The print's own glow is left out of the air in front of it, or it would veil its face.
  vec3 air = inscatter(cameraPosition, rd, max(dist - 0.5, 0.0), hazeNoise(cameraPosition, rd));
  vec3 lit = col * fog * coverage + rimColour * rim * fog * 0.9 + air * coverage;
  fragColor = vec4(lit, coverage);
}
`;

/**
 * Type set in the scene beside its poster, blurred by the same lens. Wherever the release
 * front has passed, the glyph is gone and its particle has taken over.
 */
export const titleFragment = glsl`${header}
${noise}
${release}
${lens}
uniform vec3 cameraPosition;
uniform sampler2D uMap;
uniform vec2 uMapSize;
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
  float dist = length(vWorld - cameraPosition);
  float coc = circleOfConfusion(dist);
  float lod = log2(max(coc * uMapSize.y * fwidth(vUv.y) * 0.6, 1.0));
  float coverage = textureLod(uMap, vUv, lod).r;
  // A soft dark halo, read from a far mip, keeps the type legible over whatever glows behind it.
  float halo = textureLod(uMap, vUv, lod + 4.0).r;
  if (coverage < 0.004 && halo < 0.01) discard;
  if (releaseAmount(vUv, uSeed, uDirection, uProgress) > 0.0) discard;
  float a = coverage * uOpacity;
  float shade = min(halo * 1.6, 1.0) * 0.5 * uOpacity;
  fragColor = vec4(uInk * exp(-uExtinction * dist) * a, max(a, shade));
}
`;

/**
 * Motion shared by every released particle. A grain leaves its surface, is caught in the
 * wake of the passing camera and swirls round the view axis, spreading outward, while a
 * noise field breaks the swirl into eddies. Travel eases out, so grains slow as they drift.
 */
const wake = glsl`
vec3 wakeOffset(vec3 world, vec3 camera, float r, vec3 swirl, float seed, float direction, float strength) {
  float travel = 1.0 - exp(-r * 1.9);
  vec2 rel = world.xy - camera.xy;
  float radius = length(rel) + 1e-3;
  float spin = travel * (0.6 + 0.5 * swirl.x) * 1.25 / (radius + 0.45) * direction * strength;
  float c = cos(spin);
  float s = sin(spin);
  rel = mat2(c, s, -s, c) * rel * (1.0 + travel * (0.3 + 0.35 * seed) * strength);
  vec3 moved = vec3(camera.xy + rel, world.z);
  moved += swirl * 0.42 * travel * strength;
  moved.z += travel * (0.1 + 0.3 * seed) * strength;
  moved.y += r * r * 0.1;
  return moved;
}
`;

/** A grain is a soft gaussian speck, and a defocused one is a disc with a faint bright rim. */
const bokehSprite = glsl`
float spriteShape(vec2 p, float bokeh) {
  float r2 = dot(p, p);
  float grain = exp(-r2 * 4.2);
  float rr = sqrt(r2);
  float disc = (1.0 - smoothstep(0.82, 1.0, rr)) * (0.72 + 0.28 * smoothstep(0.45, 0.9, rr));
  return mix(grain, disc, bokeh);
}
`;

/**
 * The poster's own ash. One grain per cell of a grid over the print, coloured from the same
 * image, so the frame stays whole until the release front reaches a cell. A grain near the
 * focal plane stays a crisp speck, and a grain that drifts toward the lens opens into a soft
 * bokeh disc whose light spreads over its whole area, as it would through a real lens.
 */
export const posterDustVertex = glsl`${header}
${noise}
${release}
${lens}
${wake}
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
uniform float uTime;
uniform vec3 uKey;
in vec3 position;
in vec3 aCell;
out vec3 vColor;
out vec2 vLocal;
out float vAlpha;
out float vBokeh;

void main() {
  vec2 uv = aCell.xy;
  float r = releaseAmount(uv, uSeed, uDirection, uRelease);
  vLocal = position.xy;
  if (r <= 0.0 || r >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vBokeh = 0.0;
    return;
  }
  vec3 image = mix(
    textureLod(uAtlas, uAtlasRect.xy + uv * uAtlasRect.zw, 0.0).rgb,
    textureLod(uMap, uv, 2.0).rgb,
    uMapMix
  );

  vec4 world = modelMatrix * vec4((uv.x - 0.5) * uPlane.x, (uv.y - 0.5) * uPlane.y, 0.0, 1.0);
  vec3 q = vec3(uv * vec2(4.0, 6.0), aCell.z * 5.0 + uSeed * 3.0 + uTime * 0.05);
  vec3 swirl = vec3(valueNoise3(q), valueNoise3(q + 23.4), valueNoise3(q + 51.9)) - 0.5;
  // Grains peel away slowly, then the wake takes them.
  world.xyz = wakeOffset(world.xyz, cameraPosition, pow(r, 1.45), swirl, aCell.z, uDirection, 1.0);

  vec4 view = viewMatrix * world;
  float depth = max(-view.z, 0.05);
  float grainPx = (uPlane.x / uGrid.x) / (depth * uPxToView) * (0.62 - r * 0.3);
  float coc = circleOfConfusion(depth);
  float radiusPx = max(grainPx, coc);
  view.xy += position.xy * radiusPx * uPxToView * depth;
  gl_Position = projectionMatrix * view;

  // A grain leaves the seam still glowing in the key colour, then cools into ash.
  float ember = 1.0 - smoothstep(0.0, 0.22, r);
  vec3 colour = image * (1.0 - 0.45 * r) + uKey * ember * 1.6;
  float glint = step(0.975, aCell.z) * pow(max(sin(uTime * 5.0 + aCell.z * 91.0), 0.0), 24.0) * 3.0;
  float energy = clamp((grainPx * grainPx) / (radiusPx * radiusPx), 0.02, 1.0);
  vColor = colour * (1.0 + glint);
  vBokeh = smoothstep(2.0, 5.0, coc / max(grainPx, 0.5));
  float nearFade = smoothstep(0.35, 1.2, depth);
  vAlpha = pow(1.0 - r, 1.8) * smoothstep(0.0, 0.04, r) * nearFade * energy;
}
`;

export const posterDustFragment = glsl`${header}
${bokehSprite}
in vec3 vColor;
in vec2 vLocal;
in float vAlpha;
in float vBokeh;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  float a = spriteShape(vLocal, vBokeh) * vAlpha;
  if (a < 0.002) discard;
  fragColor = vec4(vColor * a, a);
}
`;

/**
 * One particle per sampled glyph pixel. It waits invisibly until the release front reaches
 * it, then puffs away in the same wake as the poster ash, lighter and quicker.
 */
export const titleDustVertex = glsl`${header}
${noise}
${release}
${lens}
${wake}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform vec2 uPlane;
uniform float uProgress;
uniform float uSeed;
uniform float uDirection;
uniform float uPixel;
uniform float uTime;
in vec3 position;
in vec4 aPoint;
out vec2 vLocal;
out float vAlpha;
out float vBokeh;

void main() {
  float r = releaseAmount(aPoint.xy, uSeed, uDirection, uProgress);
  vLocal = position.xy;
  if (r <= 0.0 || r >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vBokeh = 0.0;
    return;
  }
  vec4 world = modelMatrix * vec4((aPoint.x - 0.5) * uPlane.x, (aPoint.y - 0.5) * uPlane.y, 0.0, 1.0);
  vec3 q = vec3(aPoint.xy * vec2(7.0, 3.5), aPoint.z * 9.0 + uSeed + uTime * 0.06);
  vec3 swirl = vec3(valueNoise3(q), valueNoise3(q + 19.1), valueNoise3(q + 41.7)) - 0.5;
  world.xyz = wakeOffset(world.xyz, cameraPosition, r, swirl, aPoint.z, -uDirection, 0.75);

  vec4 view = viewMatrix * world;
  float depth = max(-view.z, 0.05);
  float grainPx = uPixel * aPoint.w * (1.0 + r * 1.6);
  float coc = circleOfConfusion(depth);
  float radiusPx = max(grainPx, coc);
  view.xy += position.xy * radiusPx * uPxToView * depth;
  gl_Position = projectionMatrix * view;
  vBokeh = smoothstep(1.6, 4.0, coc / max(grainPx, 0.5));
  float energy = clamp((grainPx * grainPx) / (radiusPx * radiusPx), 0.05, 1.0);
  vAlpha = pow(1.0 - r, 1.6) * smoothstep(0.0, 0.06, r) * energy;
}
`;

export const titleDustFragment = glsl`${header}
${bokehSprite}
uniform vec3 uInk;
uniform float uOpacity;
in vec2 vLocal;
in float vAlpha;
in float vBokeh;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  float a = spriteShape(vLocal, vBokeh) * vAlpha * uOpacity;
  if (a < 0.002) discard;
  fragColor = vec4(uInk * a, 1.0);
}
`;

export const floorVertex = glsl`${header}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * A dark polished floor that grounds the room.
 *
 * - Reflections come from a mirrored render of the posters, read in screen space and smeared
 *   mostly vertically, the way polished stone stretches a reflection toward the viewer.
 * - A Schlick Fresnel term makes the floor mirror-like at grazing angles and matte underfoot.
 * - Each poster light casts a Lambertian pool of its colour onto the floor in front of it.
 * - Slow low-frequency noise varies the roughness, so the sheen is never uniform plastic.
 *
 * Output is premultiplied, because the far floor fades into the haze behind it.
 */
export const floorFragment = glsl`${header}
${noise}
${haze}
uniform vec3 cameraPosition;
uniform sampler2D uReflection;
uniform vec2 uResolution;
uniform float uReflect;
uniform float uAlbedo;
in vec3 vWorld;
out vec4 fragColor;

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;
  vec2 suv = gl_FragCoord.xy / uResolution;

  float rough = 0.45 + 0.55 * valueNoise2(vWorld.xz * vec2(0.7, 0.45) + 3.1);
  vec2 wobble = (vec2(valueNoise2(vWorld.xz * 11.0), valueNoise2(vWorld.xz * 11.0 + 5.7)) - 0.5) * 0.004;
  vec3 reflection = vec3(0.0);
  float weight = 0.0;
  for (int i = -5; i <= 5; i++) {
    float t = float(i) / 5.0;
    float w = exp(-t * t * 2.2);
    reflection += texture(uReflection, suv + wobble + vec2(t * 0.003, t * 0.034) * rough).rgb * w;
    weight += w;
  }
  reflection /= weight;
  float cosView = clamp(-rd.y, 0.0, 1.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - cosView, 5.0);

  vec3 irradiance = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    vec3 l = lp.xyz - vWorld;
    float d2 = dot(l, l);
    float front = smoothstep(-0.08, 0.4, vWorld.z - lp.w);
    irradiance += uLightCol[i].rgb * front * max(l.y, 0.0) / (sqrt(d2) * (d2 + 0.3));
  }

  vec3 col = irradiance * uAlbedo + reflection * fresnel * uReflect;
  col = col * depthFog(dist) + inscatter(cameraPosition, rd, dist, hazeNoise(cameraPosition, rd));
  // Far away the floor gives way to the haze behind it, so the horizon dissolves into the air
  // instead of cutting a line across the frame.
  float solid = 1.0 - smoothstep(5.0, 17.0, dist);
  fragColor = vec4(col * solid, solid);
}
`;

/**
 * Halation, first step. Keeps only what is brighter than the knee, with a soft shoulder so
 * the glow grows smoothly out of the highlights instead of switching on at a threshold.
 */
export const bloomExtractFragment = glsl`${header}
uniform sampler2D uSource;
uniform float uKnee;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(uSource, vUv).rgb;
  float peak = max(max(c.r, c.g), c.b);
  float soft = clamp(peak - uKnee + 0.25, 0.0, 0.5);
  float weight = max(soft * soft / 0.5, peak - uKnee) / max(peak, 1e-4);
  fragColor = vec4(c * weight, 1.0);
}
`;

/** A separable gaussian over nine taps with linear-sampling offsets, one axis per pass. */
export const blurFragment = glsl`${header}
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(uSource, vUv).rgb * 0.2270270270;
  c += texture(uSource, vUv + uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSource, vUv - uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSource, vUv + uStep * 3.2307692308).rgb * 0.0702702703;
  c += texture(uSource, vUv - uStep * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}
`;

/**
 * Final pass. Fast travel smears the frame toward the vanishing point with a slight split
 * of the three primaries. Halation is laid back over the highlights with the warm fringe of
 * film stock, then highlights roll off, a fine grain is laid in and the image is dithered
 * and encoded for the display.
 */
export const postFragment = glsl`${header}
${noise}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uHalation;
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

  vec3 glow = texture(uBloom, vUv).rgb;
  col += glow * uHalation * vec3(1.0, 0.72, 0.55);
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

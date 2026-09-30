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
 * - A hairline rim runs round the frame, graded from the colour at the top of the print to
 *   the colour at its foot, so it continues the image rather than boxing it in.
 * - The backlight falls off toward the frame and the paper has a fine tooth up close.
 * - As the camera walks through, the print dissolves. Just ahead of the release front it
 *   thins out while its particles, already in place and wearing the same colours, fade in
 *   over it, so the image turns to grain with no visible line.
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
uniform float uSeed;
uniform vec3 uRimTop;
uniform vec3 uRimBottom;
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
  float front = uRelease > 0.0 ? releaseFront(cuv, uSeed, uDirection, uRelease) : -1.0;
  if (front > 0.0) discard;

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

  // A lightbox is brightest at its centre, and the print has a paper tooth that only shows
  // once the texture is magnified.
  float edge = min(min(cuv.x, 1.0 - cuv.x), min(cuv.y, 1.0 - cuv.y));
  col *= 0.9 + 0.1 * smoothstep(0.0, 0.32, edge);
  float magnified = clamp(1.4 - uvPerPx.y * uMapSize.y, 0.0, 1.0) * (1.0 - smoothstep(1.0, 3.0, coc));
  col *= 1.0 + (valueNoise2(cuv * uMapSize * 0.7) - 0.5) * 0.05 * magnified;

  // The handoff to the particles, which fade in over the print as it fades out.
  coverage *= 1.0 - smoothstep(-HANDOFF, 0.0, front);

  float rise = smoothstep(0.08, 0.92, puv.y);
  vec3 rimColour = mix(uRimBottom, uRimTop, rise) * 1.35;

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
  float front = releaseFront(vUv, uSeed, uDirection, uProgress);
  if (front > 0.0) discard;
  float a = coverage * uOpacity * (1.0 - smoothstep(-HANDOFF, 0.0, front));
  float shade = min(halo * 1.6, 1.0) * 0.5 * uOpacity;
  fragColor = vec4(uInk * exp(-uExtinction * dist) * a, max(a, shade));
}
`;

/**
 * Motion shared by every particle, poster or title.
 *
 * 1. The camera's wake pushes a particle gently outward and spins it round the view axis.
 * 2. A flow field carries it along streamlines. The field comes from a stream function, the
 *    sum of three travelling waves, and its velocity is the curl of that function:
 *
 *        psi = sum of a * sin(k . p + w t + phase)
 *        v   = ( d psi / dy , -d psi / dx )
 *
 *    A curl has no divergence, so particles swirl and stream but never bunch up or thin out,
 *    which is what makes the motion read as a fluid rather than as scattered noise. The path
 *    is integrated in four steps, so it curves.
 * 3. It lifts a little, as warm air would, and drifts in depth.
 *
 * Every term scales with travel, which eases in, so a particle leaves its surface slowly.
 */
const drift = glsl`
vec2 streamFlow(vec2 p, float t) {
  const vec2 k1 = vec2(1.9, 2.6);
  const vec2 k2 = vec2(-3.4, 1.4);
  const vec2 k3 = vec2(2.6, -5.1);
  float c1 = 0.5 * cos(dot(k1, p) + t * 0.31 + 1.3);
  float c2 = 0.28 * cos(dot(k2, p) - t * 0.23 + 4.1);
  float c3 = 0.14 * cos(dot(k3, p) + t * 0.19 + 2.7);
  return c1 * vec2(k1.y, -k1.x) + c2 * vec2(k2.y, -k2.x) + c3 * vec2(k3.y, -k3.x);
}

vec3 particlePath(vec3 rest, vec3 camera, float r, float seed, float direction, float strength, float time) {
  float travel = pow(r, 1.35) * strength;
  vec2 rel = rest.xy - camera.xy;
  float spin = travel * 0.9 / (length(rel) + 0.5) * direction;
  float c = cos(spin);
  float s = sin(spin);
  rel = mat2(c, s, -s, c) * rel * (1.0 + travel * (0.22 + 0.3 * seed));
  vec3 p = vec3(camera.xy + rel, rest.z);
  float stride = travel * 0.075;
  for (int i = 0; i < 4; i++) p.xy += streamFlow(p.xy * 1.3 + seed * 0.35, time + float(i) * 0.4) * stride;
  p.y += travel * travel * 0.12;
  p.z += travel * (0.08 + 0.26 * seed);
  return p;
}

/**
 * Places a particle's sprite in view space. It grows into a bokeh disc when defocused, and
 * stretches along its own path when it moves fast, the way a shutter records motion.
 */
struct Sprite {
  vec4 view;
  float bokeh;
  float stretch;
  float energy;
};

Sprite placeSprite(vec3 p, vec3 before, float grainPx, vec2 corner) {
  Sprite sp;
  vec4 view = viewMatrix * vec4(p, 1.0);
  vec4 prev = viewMatrix * vec4(before, 1.0);
  float depth = max(-view.z, 0.05);
  float coc = circleOfConfusion(depth);
  float radiusPx = max(grainPx, coc);
  float size = radiusPx * uPxToView * depth;
  vec2 motion = view.xy - prev.xy;
  float len = length(motion);
  vec2 dir = len > 1e-6 ? motion / len : vec2(0.0, 1.0);
  float streak = min(len * 0.5, size * 5.0);
  // A right-handed basis, so the quad keeps its winding whichever way the particle moves.
  vec2 nrm = vec2(dir.y, -dir.x);
  view.xy += nrm * corner.x * size + dir * corner.y * (size + streak) - motion * 0.5;
  sp.view = view;
  sp.bokeh = smoothstep(2.0, 5.0, coc / max(grainPx, 0.5));
  sp.stretch = streak / (size + streak);
  sp.energy = clamp((grainPx * grainPx) / (radiusPx * radiusPx), 0.02, 1.0);
  return sp;
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
 * The poster's particles. One per cell of a grid over the print, coloured from the same image.
 *
 * - A particle appears in place just ahead of the release front, while the print fades out
 *   under it, so the handoff is invisible.
 * - Once released it travels the shared path: the camera's wake, then the flow field.
 * - It keeps the print's colour and slowly takes on the film's key as it fades, so the image
 *   dissolves into the colour of the air it lit.
 * - Near the lens it opens into a soft bokeh disc, and at speed it streaks along its path.
 */
export const posterDustVertex = glsl`${header}
${noise}
${release}
${lens}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
${drift}
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
uniform float uSpeed;
uniform vec3 uKey;
in vec3 position;
in vec3 aCell;
out vec3 vColor;
out vec2 vLocal;
out float vAlpha;
out float vBokeh;
out float vStretch;

void main() {
  // Each particle sits at a random spot inside its cell, so the rest pattern is never a grid.
  vec2 jitter = vec2(fract(aCell.z * 12.9898), fract(aCell.z * 78.233)) - 0.5;
  vec2 uv = clamp(aCell.xy + jitter / uGrid, 0.0, 1.0);
  float front = releaseFront(uv, uSeed, uDirection, uRelease) + releaseJitter(aCell.z);
  vLocal = position.xy;
  vBokeh = 0.0;
  vStretch = 0.0;
  if (front <= -HANDOFF || front >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }
  float r = clamp(front, 0.0, 1.0);
  vec3 image = mix(
    textureLod(uAtlas, uAtlasRect.xy + uv * uAtlasRect.zw, 0.0).rgb,
    textureLod(uMap, uv, 2.0).rgb,
    uMapMix
  );

  vec3 rest = (modelMatrix * vec4((uv.x - 0.5) * uPlane.x, (uv.y - 0.5) * uPlane.y, 0.0, 1.0)).xyz;
  float t = uTime * 0.5;
  vec3 p = particlePath(rest, cameraPosition, r, aCell.z, uDirection, 1.0, t);
  vec3 before = particlePath(rest, cameraPosition, max(r - min(uSpeed * 0.05, 0.1), 0.0), aCell.z, uDirection, 1.0, t);
  float depth = max(-(viewMatrix * vec4(p, 1.0)).z, 0.05);
  float grainPx = (uPlane.x / uGrid.x) / (depth * uPxToView) * (0.4 + 0.45 * fract(aCell.z * 5.31)) * (1.0 - r * 0.35);
  Sprite sp = placeSprite(p, before, grainPx, position.xy);
  gl_Position = projectionMatrix * sp.view;

  float lift = 1.0 + 0.3 * sin(r * 3.14159);
  vColor = mix(image, uKey, smoothstep(0.2, 0.95, r) * 0.55) * (1.0 - 0.3 * r) * lift;
  vBokeh = sp.bokeh;
  vStretch = sp.stretch;
  float appear = smoothstep(-HANDOFF, 0.0, front);
  float nearFade = smoothstep(0.35, 1.2, depth);
  vAlpha = appear * pow(1.0 - r, 1.6) * nearFade * sp.energy * (1.0 - 0.5 * sp.stretch);
}
`;

/**
 * A particle is a soft gaussian speck, stretched along its motion when it moves fast, and a
 * defocused one is a disc with a faint bright rim. It is half laid over and half added to
 * the scene, so it glows like the print it came from without ever blowing out.
 */
export const posterDustFragment = glsl`${header}
${bokehSprite}
in vec3 vColor;
in vec2 vLocal;
in float vAlpha;
in float vBokeh;
in float vStretch;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  vec2 p = vec2(vLocal.x, vLocal.y * mix(1.0, 0.6, vStretch));
  float a = spriteShape(p, vBokeh) * vAlpha;
  if (a < 0.002) discard;
  fragColor = vec4(vColor * a, a * 0.5);
}
`;

/**
 * One particle per sampled glyph pixel. It appears in place as its glyph fades, then travels
 * the same path as the poster particles, lighter and quicker.
 */
export const titleDustVertex = glsl`${header}
${noise}
${release}
${lens}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
${drift}
uniform vec3 cameraPosition;
uniform vec2 uPlane;
uniform float uProgress;
uniform float uSeed;
uniform float uDirection;
uniform float uPixel;
uniform float uTime;
uniform float uSpeed;
in vec3 position;
in vec4 aPoint;
out vec2 vLocal;
out float vAlpha;
out float vBokeh;
out float vStretch;

void main() {
  float front = releaseFront(aPoint.xy, uSeed, uDirection, uProgress) + releaseJitter(aPoint.z);
  vLocal = position.xy;
  vBokeh = 0.0;
  vStretch = 0.0;
  if (front <= -HANDOFF || front >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  float r = clamp(front, 0.0, 1.0);
  vec3 rest = (modelMatrix * vec4((aPoint.x - 0.5) * uPlane.x, (aPoint.y - 0.5) * uPlane.y, 0.0, 1.0)).xyz;
  float t = uTime * 0.5 + uSeed * 10.0;
  vec3 p = particlePath(rest, cameraPosition, r, aPoint.z, -uDirection, 0.75, t);
  vec3 before = particlePath(rest, cameraPosition, max(r - min(uSpeed * 0.05, 0.1), 0.0), aPoint.z, -uDirection, 0.75, t);
  Sprite sp = placeSprite(p, before, uPixel * aPoint.w * (1.0 + r * 1.4), position.xy);
  gl_Position = projectionMatrix * sp.view;
  vBokeh = sp.bokeh;
  vStretch = sp.stretch;
  vAlpha = smoothstep(-HANDOFF, 0.0, front) * pow(1.0 - r, 1.6) * sp.energy * (1.0 - 0.5 * sp.stretch);
}
`;

export const titleDustFragment = glsl`${header}
${bokehSprite}
uniform vec3 uInk;
uniform float uOpacity;
in vec2 vLocal;
in float vAlpha;
in float vBokeh;
in float vStretch;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.0) discard;
  vec2 p = vec2(vLocal.x, vLocal.y * mix(1.0, 0.6, vStretch));
  float a = spriteShape(p, vBokeh) * vAlpha * uOpacity;
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
 * - Reflections come from a mirrored render of the posters, read in screen space. The floor
 *   is polished, so the image stays a true mirror, softened by a small glossy lobe that is
 *   taller than it is wide, because a lobe seen at a grazing angle stretches toward the eye.
 * - A Schlick Fresnel term makes the floor mirror-like at grazing angles and matte underfoot.
 * - Each poster light casts a Lambertian pool of its colour onto the floor in front of it.
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

  vec3 reflection = vec3(0.0);
  float weight = 0.0;
  for (int j = -4; j <= 4; j++) {
    for (int i = -1; i <= 1; i++) {
      float w = exp(-float(j * j) * 0.2 - float(i * i) * 0.9);
      reflection += texture(uReflection, suv + vec2(float(i) * 0.0014, float(j) * 0.0036)).rgb * w;
      weight += w;
    }
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

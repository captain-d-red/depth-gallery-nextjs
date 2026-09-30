import {
  AdditiveBlending,
  CustomBlending,
  DataTexture,
  DoubleSide,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { LIGHT_COLUMNS, LIGHT_ROWS, type Catalogue, type Film } from '@/data/catalogue';
import { hexToLinear, type Vec3 } from '@/lib/color';
import { clamp, damp, lerp, smoothstep } from '@/lib/math';
import { createQuadGeometry } from './gl';
import { POSTER_HEIGHT, placeFilm, type Placement } from './layout';
import {
  posterDustFragment,
  posterDustVertex,
  posterFragment,
  posterVertex,
  titleDustFragment,
  titleDustVertex,
  titleFragment,
} from './shaders/passes';
import { TITLE_PLANE, drawTitleArt, type TitleAlign } from './TitleArt';

/** Uniform objects shared by reference between the haze pass, the floor and every poster. */
export interface HazeUniforms {
  readonly uLightPos: IUniform<Float32Array>;
  readonly uLightCol: IUniform<Float32Array>;
  readonly uLightCount: IUniform<number>;
  readonly uScatter: IUniform<number>;
  readonly uExtinction: IUniform<number>;
  readonly uSoft: IUniform<number>;
  readonly uFalloff: IUniform<number>;
  readonly uDepthFog: IUniform<number>;
  readonly uTime: IUniform<number>;
}

/** The lens every surface is seen through, shared by reference like the haze. */
export interface LensUniforms {
  readonly uFocus: IUniform<number>;
  readonly uAperture: IUniform<number>;
  readonly uPxToView: IUniform<number>;
}

export type LayoutMode = 'spread' | 'stack';

/** A pointer hit on a poster, in the poster's own print coordinates from zero to one. */
export interface PosterHit {
  readonly index: number;
  readonly u: number;
  readonly v: number;
}

export interface FilmsFrame {
  /** Continuous film position after the dwell, where 0 frames the first film. */
  readonly position: number;
  readonly cameraZ: number;
  readonly time: number;
  readonly dt: number;
  /** Signed travel speed in films per second. */
  readonly velocity: number;
  /** Smoothed scroll direction, from -1 to 1, which lets posters trail a little. */
  readonly drift: number;
  readonly mode: LayoutMode;
  readonly lightLevel: number;
  readonly pixel: number;
  readonly hovered: PosterHit | null;
  readonly reducedMotion: boolean;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

interface FilmNode {
  readonly film: Film;
  readonly index: number;
  readonly placement: Placement;
  readonly poster: Mesh<PlaneGeometry, RawShaderMaterial>;
  readonly posterUniforms: Record<string, IUniform>;
  readonly width: number;
  readonly key: Vec3;
  readonly ink: Vec3;
  readonly sheen: Vector2;
  map: Texture | null;
  bitmap: ImageBitmap | null;
  mapState: LoadState;
  hover: number;
  tilt: Vector2;
  sway: number;
  swayVelocity: number;
  /** How formed the poster is, one when framed or approaching and zero once it is ash. */
  visible: number;
  /** How far the poster has broken into ash as the camera walks through it. */
  release: number;
  title: { mesh: Mesh; dust: Mesh; texture: DataTexture; align: TitleAlign } | null;
}

/** Hi-resolution posters are fetched this far ahead of the camera and dropped after it. */
const STREAM_AHEAD = 7;
const STREAM_BEHIND = 1;
const KEEP_AHEAD = 10;
const KEEP_BEHIND = 3;
const MAX_LOADS = 4;

/** World padding round each print, room for a defocused edge to spread. */
const PAD = 0.1;
/** Particles laid over a poster, roughly one per six and a half world millimetres. */
const DUST_GRID = { columns: 150, rows: 225 } as const;
/** Two posters at most are ever breaking up at once, so two particle systems are pooled. */
const DUST_POOL = 2;
/** Draw order steps per film. Deeper films draw first, so the scene paints back to front. */
const ORDER_STEP = 10;

const PAPER: Vec3 = hexToLinear('#efe8dc');
const tmp = new Vector3();

/** The floor sits just under the prints, lower in the stacked phone layout. */
export function floorHeight(mode: LayoutMode): number {
  return mode === 'spread' ? -POSTER_HEIGHT / 2 - 0.15 : -1.12;
}

/**
 * The rim is graded from the colour the top of the print glows with to the colour at its
 * foot, read from the light samples, so a night sky over a field of marigolds runs from blue
 * down to orange. A poster with one colour gets a gentle lift toward the top instead.
 */
function rimGradient(film: Film): { uRimTop: IUniform<Vec3>; uRimBottom: IUniform<Vec3> } {
  const row = (r: number): Vec3 => {
    const a = film.light[r * LIGHT_COLUMNS]!;
    const b = film.light[r * LIGHT_COLUMNS + 1]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  };
  const top = row(0);
  const bottom = row(LIGHT_ROWS - 1);
  const apart = Math.hypot(top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2]);
  if (apart > 0.08) return { uRimTop: { value: top }, uRimBottom: { value: bottom } };
  return { uRimTop: { value: mixVec(top, [1, 1, 1], 0.25) }, uRimBottom: { value: mixVec(bottom, [0, 0, 0], 0.3) } };
}

function mixVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

async function loadBitmap(src: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`Poster request failed with ${response.status}: ${src}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
}

/** Premultiplied alpha, so a print covers what is behind it while its rim adds light. */
const premultiplied = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
} as const;

export class Films {
  readonly group = new Group();
  private readonly nodes: FilmNode[];
  private readonly titleGeometry = new PlaneGeometry(TITLE_PLANE.width, TITLE_PLANE.height);
  private readonly dustQuad = createQuadGeometry();
  private readonly posterDust: Mesh<InstancedBufferGeometry, RawShaderMaterial>[];
  private readonly abort = new AbortController();
  private loads = 0;
  private titleBudget = 1;
  private mode: LayoutMode = 'spread';

  constructor(
    catalogue: Catalogue,
    private readonly renderer: WebGLRenderer,
    private readonly haze: HazeUniforms,
    private readonly lens: LensUniforms,
    private readonly atlas: IUniform<Texture | null>,
    private readonly fontFamily: string,
    private readonly onError: (error: unknown) => void,
  ) {
    const { atlas: a } = catalogue;
    const rows = Math.ceil(catalogue.films.length / a.columns);
    const count = catalogue.films.length;

    this.nodes = catalogue.films.map((film, index) => {
      const placement = placeFilm(index);
      const width = POSTER_HEIGHT * (film.image.width / film.image.height);
      const col = index % a.columns;
      const row = Math.floor(index / a.columns);
      const key = hexToLinear(film.palette.key);
      const sheen = new Vector2(0.5, 0.6);
      const uniforms: Record<string, IUniform> = {
        ...haze,
        ...lens,
        uAtlas: atlas,
        uAtlasRect: { value: [col / a.columns, 1 - (row + 1) / rows, 1 / a.columns, 1 / rows] },
        uMap: { value: null },
        uMapMix: { value: 0 },
        uMapSize: { value: [film.image.width, film.image.height] },
        uPad: { value: [PAD / (width + 2 * PAD), PAD / (POSTER_HEIGHT + 2 * PAD)] },
        uFar: { value: 1 },
        uRelease: { value: 0 },
        uDirection: { value: placement.side },
        uHover: { value: 0 },
        uSeed: { value: (index * 0.618) % 1 },
        ...rimGradient(film),
        uSheen: { value: sheen },
      };
      const poster = new Mesh(
        new PlaneGeometry(width + 2 * PAD, POSTER_HEIGHT + 2 * PAD),
        new RawShaderMaterial({
          glslVersion: GLSL3,
          vertexShader: posterVertex,
          fragmentShader: posterFragment,
          uniforms,
          side: DoubleSide,
          ...premultiplied,
        }),
      );
      poster.userData.index = index;
      poster.renderOrder = (count - index) * ORDER_STEP;
      // Layer one is what the floor's mirror camera sees.
      poster.layers.enable(1);
      this.group.add(poster);
      return {
        film,
        index,
        placement,
        poster,
        posterUniforms: uniforms,
        width,
        key,
        ink: mixVec(PAPER, key, 0.12),
        sheen,
        map: null,
        bitmap: null,
        mapState: 'idle' as LoadState,
        hover: 0,
        tilt: new Vector2(),
        sway: 0,
        swayVelocity: 0,
        visible: 0,
        release: 0,
        title: null,
      };
    });
    this.posterDust = this.createPosterDust();
  }

  get count(): number {
    return this.nodes.length;
  }

  /** Posters that can be hovered or clicked right now, fully formed in front of the camera. */
  pickables(): Mesh[] {
    return this.nodes.filter((n) => n.poster.visible && n.visible > 0.92).map((n) => n.poster);
  }

  /** Converts a raycast uv on the padded quad into print coordinates. */
  printCoordinates(index: number, uv: Vector2): { u: number; v: number } {
    const node = this.nodes[index];
    if (!node) return { u: 0.5, v: 0.5 };
    const [pu, pv] = node.posterUniforms.uPad!.value as number[];
    return {
      u: clamp((uv.x - pu!) / (1 - 2 * pu!), 0, 1),
      v: clamp((uv.y - pv!) / (1 - 2 * pv!), 0, 1),
    };
  }

  /**
   * Where the lens should focus. It holds on the framed film and racks to the next one once
   * the camera is on its way, so the approaching poster sharpens as the last one turns to ash.
   */
  focusDistance(position: number, camera: Vector3): number {
    const next = this.nodes[clamp(Math.ceil(position - 0.42), 0, this.nodes.length - 1)];
    return next ? camera.distanceTo(next.poster.position) : 3.3;
  }

  update(frame: FilmsFrame): void {
    if (frame.mode !== this.mode) {
      this.mode = frame.mode;
      for (const node of this.nodes) this.dropTitle(node);
    }
    this.titleBudget = 1;
    // Titles nearest the camera are set first, so the one being approached is never late.
    const order = [...this.nodes].sort(
      (a, b) => Math.abs(a.index - frame.position) - Math.abs(b.index - frame.position),
    );
    for (const node of order) this.updateNode(node, frame);
    this.assignPosterDust(frame);
  }

  private updateNode(node: FilmNode, frame: FilmsFrame): void {
    const { placement, poster, posterUniforms: u, index } = node;
    const stack = frame.mode === 'stack';
    const zDist = frame.cameraZ - placement.z;
    const far = 1 - smoothstep(22, 30, zDist);
    node.release = 1 - smoothstep(1.15, 3.15, zDist);
    node.visible = far * (1 - node.release);
    poster.visible = far > 0.001 && node.release < 0.999;

    // Hanging prints swing on a soft spring when the camera rushes past them.
    const still = frame.reducedMotion;
    const proximity = smoothstep(9, 2.4, zDist);
    const swayTarget = still ? 0 : clamp(frame.velocity * 0.06 * proximity, -0.1, 0.1);
    node.swayVelocity += ((swayTarget - node.sway) * 18 - node.swayVelocity * 2.4) * frame.dt;
    node.sway += node.swayVelocity * frame.dt;

    // The pointer leans the print toward it and slides a highlight across its coat.
    const hit = frame.hovered?.index === index ? frame.hovered : null;
    node.hover = damp(node.hover, hit ? 1 : 0, 9, frame.dt);
    if (hit) {
      node.tilt.set(damp(node.tilt.x, hit.u - 0.5, 8, frame.dt), damp(node.tilt.y, hit.v - 0.5, 8, frame.dt));
      node.sheen.set(
        damp(node.sheen.x, 0.2 + (1 - hit.u) * 0.6, 7, frame.dt),
        damp(node.sheen.y, 0.25 + (1 - hit.v) * 0.6, 7, frame.dt),
      );
    } else {
      node.tilt.set(damp(node.tilt.x, 0, 5, frame.dt), damp(node.tilt.y, 0, 5, frame.dt));
    }
    const lean = still ? 0 : node.hover;

    const scale = stack ? 0.78 : 1;
    const x = stack ? 0 : placement.x;
    const y = (stack ? 0.36 : placement.y) + (still ? 0 : frame.drift * 0.05 * smoothstep(1, 6, zDist));
    poster.position.set(x, y, placement.z + lean * 0.06);
    poster.rotation.set(
      node.sway - node.tilt.y * 0.14 * lean,
      (stack ? 0 : placement.yaw) + node.tilt.x * 0.18 * lean,
      placement.roll + node.sway * 0.35 * placement.side,
    );
    poster.scale.setScalar(scale);

    u.uFar!.value = far;
    u.uRelease!.value = node.release;
    u.uHover!.value = node.hover;

    // Stream the full poster near the camera, and let go of it once it is well behind.
    const rel = index - frame.position;
    if (rel >= -STREAM_BEHIND && rel <= STREAM_AHEAD && node.mapState === 'idle') this.requestMap(node);
    if ((rel < -KEEP_BEHIND || rel > KEEP_AHEAD) && node.mapState === 'ready') this.releaseMap(node);
    u.uMapMix!.value = damp(u.uMapMix!.value as number, node.mapState === 'ready' ? 1 : 0, 6, frame.dt);

    this.updateTitle(node, frame, x, y, scale, stack);
  }

  /**
   * Titles form out of dust as their film arrives and puff away as the camera leaves.
   * Both directions are a pure function of position, so scrolling back rebuilds the text.
   */
  private updateTitle(node: FilmNode, frame: FilmsFrame, x: number, y: number, scale: number, stack: boolean): void {
    const i = node.index;
    const arrive = 1 - smoothstep(i - 0.85, i - 0.12, frame.position);
    const leave = smoothstep(i + 0.1, i + 0.7, frame.position);
    const progress = Math.max(arrive, leave);

    if (progress >= 1) {
      if (Math.abs(i - frame.position) > 3) this.dropTitle(node);
      if (node.title) node.title.mesh.visible = node.title.dust.visible = false;
      return;
    }
    if (!node.title && this.titleBudget > 0) {
      this.titleBudget--;
      this.buildTitle(node, stack ? 'left' : node.placement.side > 0 ? 'right' : 'left');
    }
    const title = node.title;
    if (!title) return;

    const posterHalfW = (node.width * scale) / 2;
    const posterTop = y + (POSTER_HEIGHT * scale) / 2;
    const titleScale = stack ? 0.8 : 1;
    const tw = TITLE_PLANE.width * titleScale;
    const th = TITLE_PLANE.height * titleScale;
    let tx: number;
    let ty: number;
    if (stack) {
      tx = x - posterHalfW + tw / 2;
      ty = y - (POSTER_HEIGHT * scale) / 2 - 0.07 - th / 2;
    } else {
      const gap = 0.16;
      tx = node.placement.side > 0 ? x - posterHalfW - gap - tw / 2 : x + posterHalfW + gap + tw / 2;
      ty = posterTop - th / 2;
    }
    const z = node.placement.z - (stack ? 0.02 : 0.22);
    for (const mesh of [title.mesh, title.dust]) {
      mesh.visible = true;
      mesh.position.set(tx, ty, z);
      mesh.scale.setScalar(titleScale);
    }
    const direction = title.align === 'right' ? -1 : 1;
    const fade = smoothstep(0.5, 1.6, frame.cameraZ - z);
    for (const mesh of [title.mesh, title.dust]) {
      const uniforms = (mesh.material as RawShaderMaterial).uniforms;
      uniforms.uProgress!.value = progress;
      uniforms.uDirection!.value = direction;
      uniforms.uOpacity!.value = fade;
    }
    const dust = (title.dust.material as RawShaderMaterial).uniforms;
    dust.uPixel!.value = frame.pixel;
    dust.uTime!.value = frame.time;
    dust.uSpeed!.value = Math.abs(frame.velocity);
  }

  private buildTitle(node: FilmNode, align: TitleAlign): void {
    const art = drawTitleArt(node.film, this.fontFamily, align);
    const texture = new DataTexture(art.coverage, art.width, art.height, RedFormat, UnsignedByteType);
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;

    const shared = {
      ...this.lens,
      uProgress: { value: 1 },
      uSeed: { value: (node.index * 0.371) % 1 },
      uDirection: { value: 1 },
      uOpacity: { value: 1 },
      uInk: { value: node.ink },
    };
    const order = (this.nodes.length - node.index) * ORDER_STEP;
    const mesh = new Mesh(
      this.titleGeometry,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: posterVertex,
        fragmentShader: titleFragment,
        uniforms: {
          ...shared,
          uMap: { value: texture },
          uMapSize: { value: [art.width, art.height] },
          uExtinction: this.haze.uExtinction,
        },
        ...premultiplied,
      }),
    );

    const geometry = new InstancedBufferGeometry();
    geometry.index = this.dustQuad.index;
    geometry.setAttribute('position', this.dustQuad.getAttribute('position'));
    geometry.setAttribute('aPoint', new InstancedBufferAttribute(art.points, 4));
    geometry.instanceCount = art.count;
    const dust = new Mesh(
      geometry,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: titleDustVertex,
        fragmentShader: titleDustFragment,
        uniforms: {
          ...shared,
          uPlane: { value: [TITLE_PLANE.width, TITLE_PLANE.height] },
          uPixel: { value: 1 },
          uTime: { value: 0 },
          uSpeed: { value: 0 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    dust.frustumCulled = false;
    mesh.renderOrder = order + 1;
    dust.renderOrder = order + 2;
    this.group.add(mesh, dust);
    node.title = { mesh, dust, texture, align };
  }

  private dropTitle(node: FilmNode): void {
    const title = node.title;
    if (!title) return;
    this.group.remove(title.mesh, title.dust);
    (title.mesh.material as RawShaderMaterial).dispose();
    (title.dust.material as RawShaderMaterial).dispose();
    title.dust.geometry.dispose();
    title.texture.dispose();
    node.title = null;
  }

  /** One grid of grain cells, shared by every pooled ash system. */
  private createPosterDust(): Mesh<InstancedBufferGeometry, RawShaderMaterial>[] {
    const { columns, rows } = DUST_GRID;
    const cells = new Float32Array(columns * rows * 3);
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++, i += 3) {
        cells[i] = (c + 0.5) / columns;
        cells[i + 1] = (r + 0.5) / rows;
        cells[i + 2] = Math.random();
      }
    }
    const geometry = new InstancedBufferGeometry();
    geometry.index = this.dustQuad.index;
    geometry.setAttribute('position', this.dustQuad.getAttribute('position'));
    geometry.setAttribute('aCell', new InstancedBufferAttribute(cells, 3));
    geometry.instanceCount = columns * rows;

    return Array.from({ length: DUST_POOL }, () => {
      const mesh = new Mesh(
        geometry,
        new RawShaderMaterial({
          glslVersion: GLSL3,
          vertexShader: posterDustVertex,
          fragmentShader: posterDustFragment,
          uniforms: {
            ...this.lens,
            uAtlas: this.atlas,
            uAtlasRect: { value: [0, 0, 1, 1] },
            uMap: { value: null },
            uMapMix: { value: 0 },
            uPlane: { value: [1, 1] },
            uGrid: { value: [columns, rows] },
            uRelease: { value: 0 },
            uDirection: { value: 1 },
            uSeed: { value: 0 },
            uTime: { value: 0 },
            uSpeed: { value: 0 },
            uKey: { value: [1, 1, 1] },
          },
          // Ash is laid over the scene rather than added to it, so dense drifts never blow out.
          ...premultiplied,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    });
  }

  /** Hands the pooled ash systems to the posters that are breaking up this frame. */
  private assignPosterDust(frame: FilmsFrame): void {
    const breaking = this.nodes
      .filter((n) => n.release > 0.001 && n.release < 0.999 && n.poster.visible)
      .slice(0, DUST_POOL);
    this.posterDust.forEach((mesh, i) => {
      const node = breaking[i];
      mesh.visible = node !== undefined;
      if (!node) return;
      mesh.position.copy(node.poster.position);
      mesh.rotation.copy(node.poster.rotation);
      mesh.scale.copy(node.poster.scale);
      mesh.renderOrder = node.poster.renderOrder + 3;
      const u = mesh.material.uniforms;
      const p = node.posterUniforms;
      u.uAtlasRect!.value = p.uAtlasRect!.value;
      u.uMap!.value = p.uMap!.value;
      u.uMapMix!.value = p.uMapMix!.value;
      u.uRelease!.value = node.release;
      u.uDirection!.value = p.uDirection!.value;
      u.uSeed!.value = p.uSeed!.value;
      u.uTime!.value = frame.time;
      u.uSpeed!.value = Math.abs(frame.velocity);
      u.uKey!.value = node.key;
      (u.uPlane!.value as number[])[0] = node.width;
      (u.uPlane!.value as number[])[1] = POSTER_HEIGHT;
    });
  }

  private requestMap(node: FilmNode): void {
    if (this.loads >= MAX_LOADS) return;
    this.loads++;
    node.mapState = 'loading';
    loadBitmap(node.film.image.src, this.abort.signal)
      .then((bitmap) => {
        if (node.mapState !== 'loading') {
          bitmap.close();
          return;
        }
        const texture = new Texture(bitmap);
        texture.colorSpace = SRGBColorSpace;
        texture.flipY = false;
        texture.generateMipmaps = true;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.magFilter = LinearFilter;
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        texture.needsUpdate = true;
        this.renderer.initTexture(texture);
        node.map = texture;
        node.bitmap = bitmap;
        node.mapState = 'ready';
        node.posterUniforms.uMap!.value = texture;
      })
      .catch((error: unknown) => {
        if (this.abort.signal.aborted) return;
        node.mapState = 'failed';
        this.onError(error);
      })
      .finally(() => {
        this.loads--;
      });
  }

  private releaseMap(node: FilmNode): void {
    node.posterUniforms.uMap!.value = null;
    node.posterUniforms.uMapMix!.value = 0;
    node.map?.dispose();
    node.bitmap?.close();
    node.map = null;
    node.bitmap = null;
    node.mapState = 'idle';
  }

  /**
   * Writes the light samples of the posters nearest the camera into the shared arrays.
   * A poster lights the air only while it is formed, so a dissolving poster fades its glow.
   */
  writeLights(frame: FilmsFrame, positions: Float32Array, colors: Float32Array, max: number): number {
    const first = Math.max(0, Math.floor(frame.position - 0.2));
    let n = 0;
    for (let i = first; i < this.nodes.length && n + LIGHT_COLUMNS * LIGHT_ROWS <= max; i++) {
      const node = this.nodes[i]!;
      if (node.visible <= 0.001) continue;
      const { poster } = node;
      poster.updateMatrixWorld();
      const w = node.width;
      for (let r = 0; r < LIGHT_ROWS; r++) {
        for (let c = 0; c < LIGHT_COLUMNS; c++) {
          const sample = node.film.light[r * LIGHT_COLUMNS + c]!;
          tmp.set((c - 0.5) * w * 0.52, (1 - r) * (POSTER_HEIGHT / 3.1), 0.05).applyMatrix4(poster.matrixWorld);
          positions.set([tmp.x, tmp.y, tmp.z, poster.position.z], n * 4);
          const k = sample[3] * node.visible * frame.lightLevel * (1 + 0.35 * node.hover);
          colors.set([sample[0] * k, sample[1] * k, sample[2] * k, 0], n * 4);
          n++;
        }
      }
    }
    return n;
  }

  dispose(): void {
    this.abort.abort();
    for (const node of this.nodes) {
      this.releaseMap(node);
      this.dropTitle(node);
      node.poster.geometry.dispose();
      node.poster.material.dispose();
    }
    this.titleGeometry.dispose();
    this.posterDust[0]?.geometry.dispose();
    for (const mesh of this.posterDust) mesh.material.dispose();
    this.dustQuad.dispose();
  }
}

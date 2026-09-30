import {
  DataTexture,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NormalBlending,
  AdditiveBlending,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector3,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { LIGHT_COLUMNS, LIGHT_ROWS, type Catalogue, type Film } from '@/data/catalogue';
import { hexToLinear, type Vec3 } from '@/lib/color';
import { clamp, damp, lerp, smoothstep } from '@/lib/math';
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
import { createQuadGeometry } from './gl';

/** Uniform objects shared by reference between the haze pass and every poster. */
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

export type LayoutMode = 'spread' | 'stack';

export interface FilmsFrame {
  /** Continuous film position after the dwell, where 0 frames the first film. */
  readonly position: number;
  readonly cameraZ: number;
  readonly dt: number;
  /** Signed travel speed in films per second. */
  readonly velocity: number;
  /** Smoothed scroll direction, from -1 to 1, which lets posters trail a little. */
  readonly drift: number;
  readonly mode: LayoutMode;
  readonly lightLevel: number;
  readonly pixel: number;
  readonly width: number;
  readonly height: number;
  readonly hovered: number | null;
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
  readonly ink: Vec3;
  map: Texture | null;
  bitmap: ImageBitmap | null;
  mapState: LoadState;
  hover: number;
  /** How formed the poster is, one when framed or approaching and zero once it is dust. */
  visible: number;
  /** How far the poster has broken into dust as the camera walks through it. */
  release: number;
  title: { mesh: Mesh; dust: Mesh; texture: DataTexture; align: TitleAlign } | null;
  titleWanted: boolean;
}

/** Hi-resolution posters are fetched this far ahead of the camera and dropped after it. */
const STREAM_AHEAD = 7;
const STREAM_BEHIND = 1;
const KEEP_AHEAD = 10;
const KEEP_BEHIND = 3;
const MAX_LOADS = 4;

/** Particles laid over a poster, roughly one per 11 world millimetres. */
const DUST_GRID = { columns: 88, rows: 132 } as const;
/** Two posters at most are ever breaking up at once, so two particle systems are pooled. */
const DUST_POOL = 2;

const PAPER: Vec3 = hexToLinear('#efe8dc');
const tmp = new Vector3();

function mixVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

async function loadBitmap(src: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`Poster request failed with ${response.status}: ${src}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
}

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
    private readonly atlas: IUniform<Texture | null>,
    private readonly fontFamily: string,
    private readonly onError: (error: unknown) => void,
  ) {
    const { atlas: a } = catalogue;
    const rows = Math.ceil(catalogue.films.length / a.columns);
    const blank = new Texture();

    this.nodes = catalogue.films.map((film, index) => {
      const placement = placeFilm(index);
      const aspect = film.image.width / film.image.height;
      const width = POSTER_HEIGHT * aspect;
      const col = index % a.columns;
      const row = Math.floor(index / a.columns);
      const key = hexToLinear(film.palette.key);
      const uniforms: Record<string, IUniform> = {
        ...haze,
        uAtlas: atlas,
        uAtlasRect: { value: [col / a.columns, 1 - (row + 1) / rows, 1 / a.columns, 1 / rows] },
        uMap: { value: blank },
        uMapMix: { value: 0 },
        uFar: { value: 1 },
        uRelease: { value: 0 },
        uDirection: { value: placement.side },
        uGlow: { value: 1 },
        uHover: { value: 0 },
        uSeed: { value: (index * 0.618) % 1 },
      };
      const material = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: posterVertex,
        fragmentShader: posterFragment,
        uniforms,
      });
      const poster = new Mesh(new PlaneGeometry(width, POSTER_HEIGHT), material);
      poster.userData.index = index;
      poster.matrixAutoUpdate = true;
      this.group.add(poster);
      return {
        film,
        index,
        placement,
        poster,
        posterUniforms: uniforms,
        width,
        ink: mixVec(PAPER, key, 0.14),
        map: null,
        bitmap: null,
        mapState: 'idle' as LoadState,
        hover: 0,
        visible: 0,
        release: 0,
        title: null,
        titleWanted: false,
      };
    });
    this.posterDust = this.createPosterDust();
  }

  /** One grid of particle cells, shared by every pooled dust system. */
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
            uAtlas: this.atlas,
            uAtlasRect: { value: [0, 0, 1, 1] },
            uMap: { value: null },
            uMapMix: { value: 0 },
            uPlane: { value: [1, 1] },
            uGrid: { value: [columns, rows] },
            uRelease: { value: 0 },
            uDirection: { value: 1 },
            uSeed: { value: 0 },
          },
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      return mesh;
    });
  }

  /** Hands the pooled particle systems to the posters that are breaking up this frame. */
  private assignPosterDust(): void {
    const breaking = this.nodes.filter((n) => n.release > 0.001 && n.release < 0.999 && n.poster.visible).slice(0, DUST_POOL);
    this.posterDust.forEach((mesh, i) => {
      const node = breaking[i];
      mesh.visible = node !== undefined;
      if (!node) return;
      mesh.position.copy(node.poster.position);
      mesh.rotation.copy(node.poster.rotation);
      mesh.scale.copy(node.poster.scale);
      const u = mesh.material.uniforms;
      const p = node.posterUniforms;
      u.uAtlasRect!.value = p.uAtlasRect!.value;
      u.uMap!.value = p.uMap!.value;
      u.uMapMix!.value = p.uMapMix!.value;
      u.uRelease!.value = node.release;
      u.uDirection!.value = p.uDirection!.value;
      u.uSeed!.value = p.uSeed!.value;
      (u.uPlane!.value as number[])[0] = node.width;
      (u.uPlane!.value as number[])[1] = POSTER_HEIGHT;
    });
  }

  get count(): number {
    return this.nodes.length;
  }

  /** Posters that can be clicked right now, in front of the camera and fully formed. */
  pickables(): Mesh[] {
    return this.nodes.filter((n) => n.poster.visible && n.visible > 0.92).map((n) => n.poster);
  }

  update(frame: FilmsFrame): void {
    if (frame.mode !== this.mode) {
      this.mode = frame.mode;
      for (const node of this.nodes) this.dropTitle(node);
    }
    this.titleBudget = 1;
    const tilt = frame.reducedMotion ? 0 : clamp(frame.velocity * 0.03, -0.12, 0.12);
    const stack = frame.mode === 'stack';

    // Titles nearest the camera are set first, so the one being approached is never late.
    const order = [...this.nodes].sort((a, b) => Math.abs(a.index - frame.position) - Math.abs(b.index - frame.position));
    for (const node of order) this.updateNode(node, frame, tilt, stack);
    this.assignPosterDust();
  }

  private updateNode(node: FilmNode, frame: FilmsFrame, tilt: number, stack: boolean): void {
    const { placement, poster, posterUniforms: u, index } = node;
    const zDist = frame.cameraZ - placement.z;
    const far = 1 - smoothstep(22, 30, zDist);
    node.release = 1 - smoothstep(0.85, 2.95, zDist);
    node.visible = far * (1 - node.release);
    poster.visible = far > 0.001 && node.release < 0.999;

    const scale = stack ? 0.78 : 1;
    const x = stack ? 0 : placement.x;
    const y = (stack ? 0.36 : placement.y) + (frame.reducedMotion ? 0 : frame.drift * 0.06 * smoothstep(1, 6, zDist));
    poster.position.set(x, y, placement.z);
    poster.rotation.set(tilt, stack ? 0 : placement.yaw, placement.roll);
    poster.scale.setScalar(scale);

    node.hover = damp(node.hover, frame.hovered === index ? 1 : 0, 10, frame.dt);
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
    node.titleWanted = progress < 1;

    if (!node.titleWanted) {
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
    const titleScale = stack ? clamp((frame.width / frame.height) * 1.9, 0.62, 0.86) : 1;
    const tw = TITLE_PLANE.width * titleScale;
    const th = TITLE_PLANE.height * titleScale;
    let tx: number;
    let ty: number;
    if (stack) {
      tx = x - posterHalfW + tw / 2;
      ty = y - (POSTER_HEIGHT * scale) / 2 - 0.07 - th / 2;
    } else {
      const gap = 0.14;
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
    const zDist = frame.cameraZ - z;
    const fade = smoothstep(0.5, 1.6, zDist);
    for (const mat of [title.mesh.material, title.dust.material] as RawShaderMaterial[]) {
      mat.uniforms.uProgress!.value = progress;
      mat.uniforms.uDirection!.value = direction;
      mat.uniforms.uOpacity!.value = fade;
    }
    const dustMat = title.dust.material as RawShaderMaterial;
    dustMat.uniforms.uPixel!.value = frame.pixel;
    (dustMat.uniforms.uResolution!.value as number[])[0] = frame.width;
    (dustMat.uniforms.uResolution!.value as number[])[1] = frame.height;
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
      uProgress: { value: 1 },
      uSeed: { value: (node.index * 0.371) % 1 },
      uDirection: { value: 1 },
      uOpacity: { value: 1 },
      uInk: { value: node.ink },
    };
    const mesh = new Mesh(
      this.titleGeometry,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: posterVertex,
        fragmentShader: titleFragment,
        uniforms: { ...shared, uMap: { value: texture }, uExtinction: this.haze.uExtinction },
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
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
          uResolution: { value: [1, 1] },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    dust.frustumCulled = false;
    mesh.renderOrder = 2;
    dust.renderOrder = 3;
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
          const k = sample[3] * node.visible * frame.lightLevel;
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

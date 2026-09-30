import {
  BufferGeometry,
  Color,
  LinearSRGBColorSpace,
  Matrix4,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type IUniform,
  type WebGLRenderTarget,
} from 'three';
import type { Catalogue } from '@/data/catalogue';
import { hexToLinear, type Vec3 } from '@/lib/color';
import { clamp, damp, lerp, smoothstep } from '@/lib/math';
import { Films, floorHeight, type HazeUniforms, type LayoutMode, type LensUniforms, type PosterHit } from './Films';
import { Floor } from './Floor';
import { createFullscreenGeometry, createHdrTarget, createScreenPass } from './gl';
import { FOCUS, cameraZForPosition, dwell } from './layout';
import { MAX_LIGHTS } from './shaders/chunks';
import { backdropFragment, bloomExtractFragment, blurFragment, hazeFragment, postFragment } from './shaders/passes';

export interface EngineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly catalogue: Catalogue;
  readonly fontFamily: string;
  readonly reducedMotion: boolean;
  readonly onError: (error: unknown) => void;
}

export interface EngineInput {
  /** Continuous film position from the scroll, before the dwell is applied. */
  readonly position: number;
  /** Pointer in normalised device coordinates, from -1 to 1 on both axes. */
  readonly pointerX: number;
  readonly pointerY: number;
  readonly pointerActive: boolean;
}

export interface EngineFrame {
  readonly position: number;
  readonly index: number;
  readonly velocity: number;
  /** Distance the lens is focused at, for the viewfinder readout. */
  readonly focusDistance: number;
  readonly hovered: number | null;
}

/** Keeps the drawing buffer near 4K worth of pixels however dense the display is. */
const PIXEL_BUDGET = 9_000_000;
const INTRO_SECONDS = 3.2;
/** Blur radius of a surface at infinity, as a share of the drawing buffer height. */
const APERTURE = 0.017;
/** How far the camera tracks sideways toward each film's type, in world units. */
const WEAVE = 0.14;

export class Engine {
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera(40, 1, 0.05, 90);
  private readonly mirrorCamera = new PerspectiveCamera();
  private readonly mirror = new Matrix4();
  private readonly screenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly hazeScene = new Scene();
  private readonly mainScene = new Scene();
  private readonly postScene = new Scene();
  private readonly hazeTarget: WebGLRenderTarget;
  private readonly mirrorTarget: WebGLRenderTarget;
  private readonly sceneTarget: WebGLRenderTarget;
  private readonly bloomTargets: readonly [WebGLRenderTarget, WebGLRenderTarget];
  private readonly bloomScenes: { extract: Scene; blurX: Scene; blurY: Scene };
  private readonly blurX: Record<string, IUniform>;
  private readonly blurY: Record<string, IUniform>;
  private readonly screenGeometry: BufferGeometry;
  private readonly films: Films;
  private readonly floor: Floor;
  private readonly haze: HazeUniforms;
  private readonly lens: LensUniforms;
  private readonly hazePass: Record<string, IUniform>;
  private readonly postPass: Record<string, IUniform>;
  private readonly atlas: IUniform<Texture | null> = { value: null };
  private readonly keys: Vec3[];
  private readonly raycaster = new Raycaster();
  private readonly rayPointer = new Vector2();
  private readonly camPointer = new Vector2();
  private readonly lookTarget = new Vector3();
  private readonly basis = { right: new Vector3(), up: new Vector3(), forward: new Vector3() };
  private readonly abort = new AbortController();
  private readonly reducedMotion: boolean;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private mode: LayoutMode = 'spread';
  private startTime: number | null = null;
  private lastTime = 0;
  private lastPosition: number | null = null;
  private velocity = 0;
  private drift = 0;
  private focus = FOCUS;
  private hovered: PosterHit | null = null;

  constructor({ canvas, catalogue, fontFamily, reducedMotion, onError }: EngineOptions) {
    this.reducedMotion = reducedMotion;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setClearColor(new Color(0, 0, 0), 1);

    this.hazeTarget = createHdrTarget(0, false);
    this.mirrorTarget = createHdrTarget(0, false);
    this.sceneTarget = createHdrTarget(4, false);
    this.bloomTargets = [createHdrTarget(0, false), createHdrTarget(0, false)];
    this.screenGeometry = createFullscreenGeometry();

    // Halation runs at quarter resolution: extract the highlights, then blur them twice.
    this.blurX = { uSource: { value: this.bloomTargets[0].texture }, uStep: { value: new Vector2() } };
    this.blurY = { uSource: { value: this.bloomTargets[1].texture }, uStep: { value: new Vector2() } };
    this.bloomScenes = { extract: new Scene(), blurX: new Scene(), blurY: new Scene() };
    this.bloomScenes.extract.add(
      createScreenPass(this.screenGeometry, bloomExtractFragment, {
        uSource: { value: this.sceneTarget.texture },
        uKnee: { value: 0.72 },
      }),
    );
    this.bloomScenes.blurX.add(createScreenPass(this.screenGeometry, blurFragment, this.blurX));
    this.bloomScenes.blurY.add(createScreenPass(this.screenGeometry, blurFragment, this.blurY));

    this.haze = {
      uLightPos: { value: new Float32Array(MAX_LIGHTS * 4) },
      uLightCol: { value: new Float32Array(MAX_LIGHTS * 4) },
      uLightCount: { value: 0 },
      uScatter: { value: 0.034 },
      uExtinction: { value: 0.03 },
      uSoft: { value: 0.05 },
      uFalloff: { value: 1.3 },
      uDepthFog: { value: 0.42 },
      uTime: { value: 0 },
    };
    this.lens = {
      uFocus: { value: FOCUS },
      uAperture: { value: 20 },
      uPxToView: { value: 0.001 },
    };
    const cameraUniforms = {
      uCamPos: { value: new Vector3() },
      uCamRight: { value: new Vector3() },
      uCamUp: { value: new Vector3() },
      uCamForward: { value: new Vector3() },
      uTanHalf: { value: new Vector2(1, 1) },
    };
    this.hazePass = { ...this.haze, ...cameraUniforms, uAmbient: { value: new Vector3() } };
    this.hazeScene.add(createScreenPass(this.screenGeometry, hazeFragment, this.hazePass));

    const backdrop = createScreenPass(this.screenGeometry, backdropFragment, {
      uHaze: { value: this.hazeTarget.texture },
    });
    backdrop.renderOrder = -10;
    this.mainScene.add(backdrop);

    this.floor = new Floor(this.haze, this.mirrorTarget.texture);
    this.mainScene.add(this.floor.mesh);

    this.films = new Films(catalogue, this.renderer, this.haze, this.lens, this.atlas, fontFamily, onError);
    this.mainScene.add(this.films.group);

    // The mirror camera sees only the posters, reflected in the floor plane.
    this.mirrorCamera.layers.set(1);
    this.mirrorCamera.matrixAutoUpdate = false;
    this.mirrorCamera.matrixWorldAutoUpdate = false;

    this.postPass = {
      uScene: { value: this.sceneTarget.texture },
      uBloom: { value: this.bloomTargets[0].texture },
      uHalation: { value: 0.32 },
      uResolution: { value: new Vector2(1, 1) },
      uVanish: { value: new Vector2(0.5, 0.5) },
      uSmear: { value: 0 },
      uTime: { value: 0 },
      uExposure: { value: 1 },
      uGrain: { value: 0.018 },
      uFade: { value: 0 },
    };
    this.postScene.add(createScreenPass(this.screenGeometry, postFragment, this.postPass));

    this.keys = catalogue.films.map((f) => hexToLinear(f.palette.key));
    this.loadAtlas(catalogue.atlas.src, onError);
  }

  private loadAtlas(src: string, onError: (error: unknown) => void): void {
    fetch(src, { signal: this.abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Atlas request failed with ${r.status}`);
        return r.blob();
      })
      .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' }))
      .then((bitmap) => {
        const texture = new Texture(bitmap);
        texture.colorSpace = SRGBColorSpace;
        texture.flipY = false;
        // Mip levels would blend neighbouring cells, so the atlas is sampled at full size only.
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        this.atlas.value = texture;
      })
      .catch((error: unknown) => {
        if (!this.abort.signal.aborted) onError(error);
      });
  }

  /** Sizes the drawing buffer to the canvas, trading pixel ratio for a fixed pixel budget. */
  resize(width: number, height: number, devicePixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    let dpr = Math.min(devicePixelRatio, 2);
    while (dpr > 1 && this.width * this.height * dpr * dpr > PIXEL_BUDGET) dpr -= 0.125;
    this.pixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    this.sceneTarget.setSize(w, h);
    this.hazeTarget.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.mirrorTarget.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    const bw = Math.ceil(w / 4);
    const bh = Math.ceil(h / 4);
    for (const target of this.bloomTargets) target.setSize(bw, bh);
    (this.blurX.uStep!.value as Vector2).set(1.6 / bw, 0);
    (this.blurY.uStep!.value as Vector2).set(0, 1.6 / bh);
    (this.postPass.uResolution!.value as Vector2).set(w, h);

    const aspect = this.width / this.height;
    this.mode = aspect < 0.9 ? 'stack' : 'spread';
    // The lens widens until the poster and its type both fit, so no aspect ratio clips them.
    const tanHalf =
      this.mode === 'spread'
        ? Math.max(1.12 / FOCUS, 1.95 / (FOCUS * aspect))
        : Math.max(1.16 / FOCUS, 0.66 / (FOCUS * aspect));
    this.camera.fov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.lens.uAperture.value = APERTURE * h;
    this.lens.uPxToView.value = (2 * tanHalf) / h;
  }

  frame(timeMs: number, input: EngineInput): EngineFrame {
    const time = timeMs / 1000;
    this.startTime ??= time;
    const dt = clamp(time - (this.lastTime || time), 1 / 240, 1 / 20);
    this.lastTime = time;
    const intro = this.reducedMotion ? 1 : clamp((time - this.startTime) / INTRO_SECONDS, 0, 1);

    const position = dwell(clamp(input.position, 0, this.films.count - 1));
    const raw = this.lastPosition === null ? 0 : (position - this.lastPosition) / dt;
    this.lastPosition = position;
    this.velocity = damp(this.velocity, raw, 9, dt);
    this.drift = damp(this.drift, clamp(this.velocity * 0.6, -1, 1), 2.6, dt);

    this.placeCamera(position, intro, input, dt);
    this.resolveHover(input);

    const lightLevel = smoothstep(0.08, 0.85, intro);
    const filmsFrame = {
      position,
      cameraZ: this.camera.position.z,
      time,
      dt,
      velocity: this.velocity,
      drift: this.drift,
      mode: this.mode,
      lightLevel,
      pixel: this.pixelRatio,
      hovered: this.hovered,
      reducedMotion: this.reducedMotion,
    };
    this.films.update(filmsFrame);
    this.haze.uLightCount.value = this.films.writeLights(
      filmsFrame,
      this.haze.uLightPos.value,
      this.haze.uLightCol.value,
      MAX_LIGHTS,
    );
    this.haze.uTime.value = time;

    // Rack focus. The lens pulls toward the next film as the camera sets off for it.
    this.focus = damp(this.focus, this.films.focusDistance(position, this.camera.position), 4.5, dt);
    this.lens.uFocus.value = this.focus;

    // The air takes a faint cast of the colours in frame.
    const i0 = Math.floor(position);
    const a = this.keys[i0] ?? this.keys[0]!;
    const b = this.keys[Math.min(i0 + 1, this.keys.length - 1)] ?? a;
    const f = position - i0;
    (this.hazePass.uAmbient!.value as Vector3)
      .set(lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f))
      .multiplyScalar(0.012 * lightLevel + 0.002);

    const floorY = floorHeight(this.mode);
    const w = Math.round(this.width * this.pixelRatio);
    const h = Math.round(this.height * this.pixelRatio);
    this.floor.update({ cameraZ: this.camera.position.z, y: floorY, width: w, height: h });
    this.writeCameraUniforms();
    this.placeMirrorCamera(floorY);

    this.postPass.uSmear!.value = this.reducedMotion ? 0 : clamp(Math.abs(this.velocity) * 0.012, 0, 0.065);
    this.postPass.uTime!.value = time;
    this.postPass.uFade!.value = smoothstep(0, 0.45, intro);

    const r = this.renderer;
    r.setRenderTarget(this.hazeTarget);
    r.render(this.hazeScene, this.screenCamera);
    r.setRenderTarget(this.mirrorTarget);
    r.render(this.mainScene, this.mirrorCamera);
    r.setRenderTarget(this.sceneTarget);
    r.render(this.mainScene, this.camera);
    const [bloomA, bloomB] = this.bloomTargets;
    r.setRenderTarget(bloomA);
    r.render(this.bloomScenes.extract, this.screenCamera);
    r.setRenderTarget(bloomB);
    r.render(this.bloomScenes.blurX, this.screenCamera);
    r.setRenderTarget(bloomA);
    r.render(this.bloomScenes.blurY, this.screenCamera);
    r.setRenderTarget(null);
    r.render(this.postScene, this.screenCamera);

    return {
      position,
      index: clamp(Math.round(position), 0, this.films.count - 1),
      velocity: this.velocity,
      focusDistance: this.focus,
      hovered: this.hovered?.index ?? null,
    };
  }

  /**
   * The camera glides in from darkness during the intro, then follows the scroll. It tracks
   * a little toward each film's type so the spread sits centred, banks gently into the move,
   * and drifts toward the pointer.
   */
  private placeCamera(position: number, intro: number, input: EngineInput, dt: number): void {
    const still = this.reducedMotion;
    const introEase = 1 - (1 - intro) ** 3;
    const z = cameraZForPosition(position) + (1 - introEase) * 3.4;
    const follow = still || !input.pointerActive ? 0 : 1;
    this.camPointer.set(
      damp(this.camPointer.x, input.pointerX * follow, 3.2, dt),
      damp(this.camPointer.y, input.pointerY * follow, 3.2, dt),
    );
    const weave = this.mode === 'spread' ? -WEAVE * Math.cos(Math.PI * position) : 0;
    const x = weave + this.camPointer.x * 0.1;
    this.camera.position.set(x, this.camPointer.y * 0.06, z);
    this.lookTarget.set(weave * 0.6 + this.camPointer.x * 0.03, this.camPointer.y * 0.02, z - 8);
    this.camera.lookAt(this.lookTarget);
    const bank = still ? 0 : -0.016 * Math.sin(Math.PI * position) * clamp(this.velocity, -1.5, 1.5);
    this.camera.rotateZ(bank);
    this.camera.updateMatrixWorld();
  }

  /** Hover is resolved against the formed posters only, in their own print coordinates. */
  private resolveHover(input: EngineInput): void {
    if (!input.pointerActive) {
      this.hovered = null;
      return;
    }
    this.rayPointer.set(input.pointerX, input.pointerY);
    this.raycaster.setFromCamera(this.rayPointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.films.pickables(), false)[0];
    if (!hit?.uv) {
      this.hovered = null;
      return;
    }
    const index = hit.object.userData.index as number;
    this.hovered = { index, ...this.films.printCoordinates(index, hit.uv) };
  }

  /** Mirrors the camera in the floor plane, so the floor can show the posters upside down. */
  private placeMirrorCamera(floorY: number): void {
    this.mirror.set(1, 0, 0, 0, 0, -1, 0, 2 * floorY, 0, 0, 1, 0, 0, 0, 0, 1);
    this.mirrorCamera.projectionMatrix.copy(this.camera.projectionMatrix);
    this.mirrorCamera.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
    this.mirrorCamera.matrixWorld.multiplyMatrices(this.mirror, this.camera.matrixWorld);
    this.mirrorCamera.matrixWorldInverse.copy(this.mirrorCamera.matrixWorld).invert();
  }

  /** The poster under the pointer on the last frame, or null. */
  get hoveredIndex(): number | null {
    return this.hovered?.index ?? null;
  }

  private writeCameraUniforms(): void {
    const { right, up, forward } = this.basis;
    this.camera.matrixWorld.extractBasis(right, up, forward);
    forward.negate();
    const p = this.hazePass;
    (p.uCamPos!.value as Vector3).copy(this.camera.position);
    (p.uCamRight!.value as Vector3).copy(right);
    (p.uCamUp!.value as Vector3).copy(up);
    (p.uCamForward!.value as Vector3).copy(forward);
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    (p.uTanHalf!.value as Vector2).set(tan * this.camera.aspect, tan);
  }

  dispose(): void {
    this.abort.abort();
    this.films.dispose();
    this.floor.dispose();
    this.atlas.value?.dispose();
    this.hazeTarget.dispose();
    this.mirrorTarget.dispose();
    this.sceneTarget.dispose();
    for (const target of this.bloomTargets) target.dispose();
    this.screenGeometry.dispose();
    const { extract, blurX, blurY } = this.bloomScenes;
    for (const scene of [this.hazeScene, this.mainScene, this.postScene, extract, blurX, blurY]) {
      scene.traverse((o) => {
        const material = (o as { material?: { dispose(): void } }).material;
        material?.dispose();
      });
    }
    this.renderer.dispose();
  }
}

import {
  BufferGeometry,
  Color,
  LinearSRGBColorSpace,
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
import { Dust } from './Dust';
import { Films, type HazeUniforms, type LayoutMode } from './Films';
import { createFullscreenGeometry, createHdrTarget, createScreenPass } from './gl';
import { FOCUS, GAP, cameraZForPosition, dwell } from './layout';
import { MAX_LIGHTS } from './shaders/chunks';
import { backdropFragment, hazeFragment, postFragment } from './shaders/passes';

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
  /** Distance from the lens to the framed poster, for the viewfinder readout. */
  readonly focusDistance: number;
  readonly hovered: number | null;
}

/** Keeps the drawing buffer near 4K worth of pixels however dense the display is. */
const PIXEL_BUDGET = 9_000_000;
const INTRO_SECONDS = 3.2;

export class Engine {
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera(40, 1, 0.05, 90);
  private readonly screenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly hazeScene = new Scene();
  private readonly mainScene = new Scene();
  private readonly postScene = new Scene();
  private readonly hazeTarget: WebGLRenderTarget;
  private readonly sceneTarget: WebGLRenderTarget;
  private readonly screenGeometry: BufferGeometry;
  private readonly films: Films;
  private readonly dust: Dust;
  private readonly haze: HazeUniforms;
  private readonly hazePass: Record<string, IUniform>;
  private readonly postPass: Record<string, IUniform>;
  private readonly atlas: IUniform<Texture | null> = { value: null };
  private readonly shades: Vec3[];
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
  private hovered: number | null = null;

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
    this.sceneTarget = createHdrTarget(4, true);
    this.screenGeometry = createFullscreenGeometry();

    this.haze = {
      uLightPos: { value: new Float32Array(MAX_LIGHTS * 4) },
      uLightCol: { value: new Float32Array(MAX_LIGHTS * 4) },
      uLightCount: { value: 0 },
      uScatter: { value: 0.03 },
      uExtinction: { value: 0.03 },
      uSoft: { value: 0.05 },
      uFalloff: { value: 0.85 },
      uDepthFog: { value: 0.46 },
      uTime: { value: 0 },
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

    const backdrop = createScreenPass(this.screenGeometry, backdropFragment, { uHaze: { value: this.hazeTarget.texture } });
    backdrop.renderOrder = -10;
    this.mainScene.add(backdrop);

    this.films = new Films(catalogue, this.renderer, this.haze, this.atlas, fontFamily, onError);
    this.mainScene.add(this.films.group);
    this.dust = new Dust(this.haze, reducedMotion ? 900 : 2400);
    this.mainScene.add(this.dust.mesh);

    this.postPass = {
      uScene: { value: this.sceneTarget.texture },
      uResolution: { value: new Vector2(1, 1) },
      uVanish: { value: new Vector2(0.5, 0.5) },
      uSmear: { value: 0 },
      uTime: { value: 0 },
      uExposure: { value: 1 },
      uGrain: { value: 0.045 },
      uFade: { value: 0 },
    };
    this.postScene.add(createScreenPass(this.screenGeometry, postFragment, this.postPass));

    this.shades = catalogue.films.map((f) => hexToLinear(f.palette.shade));
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

    // Camera. It glides in from darkness during the intro, then follows the scroll.
    const introEase = 1 - (1 - intro) ** 3;
    const cameraZ = cameraZForPosition(position) + (1 - introEase) * 3.4;
    const follow = this.reducedMotion ? 0 : input.pointerActive ? 1 : 0;
    this.camPointer.set(
      damp(this.camPointer.x, input.pointerX * follow, 3.2, dt),
      damp(this.camPointer.y, input.pointerY * follow, 3.2, dt),
    );
    this.camera.position.set(this.camPointer.x * 0.12, this.camPointer.y * 0.07, cameraZ);
    this.lookTarget.set(this.camPointer.x * 0.035, this.camPointer.y * 0.02, cameraZ - 8);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();

    // Hover is resolved against the formed posters only.
    if (input.pointerActive) {
      this.rayPointer.set(input.pointerX, input.pointerY);
      this.raycaster.setFromCamera(this.rayPointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.films.pickables(), false)[0];
      this.hovered = hit ? (hit.object.userData.index as number) : null;
    } else {
      this.hovered = null;
    }

    const lightLevel = smoothstep(0.08, 0.85, intro);
    const filmsFrame = {
      position,
      cameraZ,
      dt,
      velocity: this.velocity,
      drift: this.drift,
      mode: this.mode,
      lightLevel,
      pixel: this.pixelRatio,
      width: this.width * this.pixelRatio,
      height: this.height * this.pixelRatio,
      hovered: this.hovered,
      reducedMotion: this.reducedMotion,
    };
    this.films.update(filmsFrame);
    this.haze.uLightCount.value = this.films.writeLights(filmsFrame, this.haze.uLightPos.value, this.haze.uLightCol.value, MAX_LIGHTS);
    this.haze.uTime.value = time;

    // The ambient floor of the haze follows the shadow tone of the films in frame.
    const i0 = Math.floor(position);
    const a = this.shades[i0] ?? this.shades[0]!;
    const b = this.shades[Math.min(i0 + 1, this.shades.length - 1)] ?? a;
    const f = position - i0;
    (this.hazePass.uAmbient!.value as Vector3).set(lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)).multiplyScalar(0.3 * lightLevel + 0.04);

    this.writeCameraUniforms();
    this.dust.update({
      time,
      velocity: this.velocity * GAP,
      pixel: this.pixelRatio,
      width: this.width * this.pixelRatio,
      height: this.height * this.pixelRatio,
      brightness: 0.011 * lightLevel,
    });

    this.postPass.uSmear!.value = this.reducedMotion ? 0 : clamp(Math.abs(this.velocity) * 0.012, 0, 0.065);
    this.postPass.uTime!.value = time;
    this.postPass.uFade!.value = smoothstep(0, 0.45, intro);

    const r = this.renderer;
    r.setRenderTarget(this.hazeTarget);
    r.render(this.hazeScene, this.screenCamera);
    r.setRenderTarget(this.sceneTarget);
    r.render(this.mainScene, this.camera);
    r.setRenderTarget(null);
    r.render(this.postScene, this.screenCamera);

    const index = clamp(Math.round(position), 0, this.films.count - 1);
    return {
      position,
      index,
      velocity: this.velocity,
      focusDistance: FOCUS + (index - position) * GAP + (1 - introEase) * 3.4,
      hovered: this.hovered,
    };
  }

  /** The poster under the pointer on the last frame, or null. */
  get hoveredIndex(): number | null {
    return this.hovered;
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
    this.dust.dispose();
    this.atlas.value?.dispose();
    this.hazeTarget.dispose();
    this.sceneTarget.dispose();
    this.screenGeometry.dispose();
    for (const scene of [this.hazeScene, this.mainScene, this.postScene]) {
      scene.traverse((o) => {
        const material = (o as { material?: { dispose(): void } }).material;
        material?.dispose();
      });
    }
    this.renderer.dispose();
  }
}

import {
  AdditiveBlending,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  RawShaderMaterial,
  type IUniform,
} from 'three';
import { createQuadGeometry } from './gl';
import type { HazeUniforms } from './Films';
import { dustFragment, dustVertex } from './shaders/passes';

export interface DustFrame {
  readonly time: number;
  /** Camera travel in world units per second, signed along the view axis. */
  readonly velocity: number;
  readonly pixel: number;
  readonly width: number;
  readonly height: number;
  readonly brightness: number;
}

/**
 * Dust that hangs in the haze. The motes fill a box that travels with the camera and wraps
 * along the view axis, so the volume is endless, and they only glow where poster light
 * reaches them.
 */
export class Dust {
  readonly mesh: Mesh<InstancedBufferGeometry, RawShaderMaterial>;
  private readonly quad = createQuadGeometry();
  private readonly uniforms: Record<string, IUniform>;

  constructor(haze: HazeUniforms, count: number) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geometry = new InstancedBufferGeometry();
    geometry.index = this.quad.index;
    geometry.setAttribute('position', this.quad.getAttribute('position'));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = count;
    this.uniforms = {
      uLightPos: haze.uLightPos,
      uLightCol: haze.uLightCol,
      uLightCount: haze.uLightCount,
      uBox: { value: [5.2, 3.4, 16] },
      uTime: { value: 0 },
      uVelocity: { value: 0 },
      uPixel: { value: 1 },
      uResolution: { value: [1, 1] },
      uBrightness: { value: 1 },
    };
    this.mesh = new Mesh(
      geometry,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: dustVertex,
        fragmentShader: dustFragment,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(frame: DustFrame): void {
    const u = this.uniforms;
    u.uTime!.value = frame.time;
    u.uVelocity!.value = frame.velocity / 60;
    u.uPixel!.value = frame.pixel;
    const res = u.uResolution!.value as number[];
    res[0] = frame.width;
    res[1] = frame.height;
    u.uBrightness!.value = frame.brightness;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.quad.dispose();
  }
}

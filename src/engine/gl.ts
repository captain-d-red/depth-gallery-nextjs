import {
  BufferAttribute,
  BufferGeometry,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  RawShaderMaterial,
  WebGLRenderTarget,
  type IUniform,
} from 'three';
import { fullscreenVertex } from './shaders/passes';

/** One triangle that covers the screen, the standard for screen passes. */
export function createFullscreenGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return geometry;
}

/** A unit quad from -1 to 1, the base shape for instanced particles. */
export function createQuadGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

export function createScreenPass(
  geometry: BufferGeometry,
  fragmentShader: string,
  uniforms: Record<string, IUniform>,
): Mesh<BufferGeometry, RawShaderMaterial> {
  const mesh = new Mesh(
    geometry,
    new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/** A linear, half-float target, so light can exceed one before the final roll-off. */
export function createHdrTarget(samples: number, depthBuffer: boolean): WebGLRenderTarget {
  return new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer,
    stencilBuffer: false,
    samples,
  });
}

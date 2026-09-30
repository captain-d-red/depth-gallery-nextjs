import { GLSL3, Mesh, PlaneGeometry, RawShaderMaterial, type IUniform, type Texture } from 'three';
import type { HazeUniforms } from './Films';
import { floorFragment, floorVertex } from './shaders/passes';

export interface FloorFrame {
  readonly cameraZ: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How far the floor reaches ahead of the camera, well past where the fog swallows it. */
const DEPTH = 80;

/**
 * A polished floor under the posters. It travels with the camera, so it never ends, and it
 * reads the mirrored render of the posters for its reflections.
 */
export class Floor {
  readonly mesh: Mesh<PlaneGeometry, RawShaderMaterial>;
  private readonly uniforms: Record<string, IUniform>;

  constructor(haze: HazeUniforms, reflection: Texture) {
    this.uniforms = {
      ...haze,
      uReflection: { value: reflection },
      uResolution: { value: [1, 1] },
      uReflect: { value: 0.95 },
      uAlbedo: { value: 0.1 },
    };
    const geometry = new PlaneGeometry(48, DEPTH);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(
      geometry,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
        uniforms: this.uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
  }

  update({ cameraZ, y, width, height }: FloorFrame): void {
    this.mesh.position.set(0, y, cameraZ + 4 - DEPTH / 2);
    const resolution = this.uniforms.uResolution!.value as number[];
    resolution[0] = width;
    resolution[1] = height;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

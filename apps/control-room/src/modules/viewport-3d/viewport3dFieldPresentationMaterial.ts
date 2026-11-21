import { MeshStandardMaterial, type BufferGeometry, type ShaderMaterial, type ShaderMaterialParameters } from "three";

export interface Viewport3DFieldPresentation {
  roughness: number;
  metalness: number;
}

/** Normals are derived once on the existing topology, only for an explicitly lit pass. */
export function prepareViewport3DFieldPresentationNormals(geometry: BufferGeometry | null, enabled: boolean): boolean {
  if (!geometry || !enabled || geometry.getAttribute("normal")) return false;
  geometry.computeVertexNormals();
  return true;
}

/** Keeps field interpolation/palettes while Three.js owns lighting, HDRI and shadows. */
export class Viewport3DFieldPresentationMaterial extends MeshStandardMaterial {
  uniforms: ShaderMaterial["uniforms"];
  vertexShader: string;
  fragmentShader: string;

  constructor(parameters: ShaderMaterialParameters, appearance: Viewport3DFieldPresentation) {
    super({
      depthTest: parameters.depthTest,
      depthWrite: parameters.depthWrite,
      name: "FullmagFieldPresentationMaterial",
      polygonOffset: parameters.polygonOffset,
      polygonOffsetFactor: parameters.polygonOffsetFactor,
      polygonOffsetUnits: parameters.polygonOffsetUnits,
      side: parameters.side,
      transparent: parameters.transparent,
      clipShadows: true,
      roughness: appearance.roughness,
      metalness: appearance.metalness,
    });
    this.uniforms = parameters.uniforms ?? {};
    this.vertexShader = parameters.vertexShader ?? "";
    this.fragmentShader = parameters.fragmentShader ?? "";
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      const vertex = fieldShaderParts(this.vertexShader);
      const fragment = fieldShaderParts(this.fragmentShader);
      // The production field shaders place color projection before their normal/
      // position work. StandardMaterial supplies those transforms and all light passes.
      const projection = vertex.body.slice(0, vertex.body.indexOf("  vNormalView ="));
      const color = fragment.body.slice(0, fragment.body.indexOf("  vec3 shaded = base;"))
        .replace("#include <clipping_planes_fragment>", "");
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${vertex.declarations}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${projection}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${fragment.declarations}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n{\n${color}\n  diffuseColor.rgb *= srgbToLinearVec3(base);\n}`);
    };
  }

  override customProgramCacheKey(): string {
    // Phase, palette, opacity and material sliders are uniforms, never program keys.
    return `fullmag-field-pbr-v1:${this.vertexShader}:${this.fragmentShader}`;
  }
}

function fieldShaderParts(source: string): { declarations: string; body: string } {
  const main = "void main() {";
  const start = source.indexOf(main);
  if (start < 0) throw new Error("Field presentation shader has no main function.");
  return {
    declarations: source.slice(0, start)
      .replace(/#include <clipping_planes_pars_(?:vertex|fragment)>/g, "")
      .replace("varying vec3 vNormalView;", ""),
    body: source.slice(start + main.length),
  };
}

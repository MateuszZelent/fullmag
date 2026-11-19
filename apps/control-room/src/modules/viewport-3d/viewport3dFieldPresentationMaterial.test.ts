import { BackSide, BufferGeometry, DoubleSide, Float32BufferAttribute, MeshStandardMaterial, ShaderLib, ShaderMaterial, UniformsUtils } from "three";
import { describe, expect, it } from "vitest";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import { applyScalarSurfaceMaterialPolicy, createScalarSurfaceShaderMaterial, updateScalarSurfaceShaderMaterial } from "./viewport3dScalarSurfaceShader";
import { prepareViewport3DFieldPresentationNormals } from "./viewport3dFieldPresentationMaterial";

const options = {
  depthTest: true, depthWrite: true, opacity: 1, polygonOffset: false,
  polygonOffsetFactor: 0, polygonOffsetUnits: 0, side: DoubleSide, transparent: false,
};
const orientation: ScalarColorBuffer = {
  colors: new Float32Array(0), colorMode: "orientation", range: { min: 0, max: 1 },
  vectorValues: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
};

function compile(material: MeshStandardMaterial) {
  const shader = {
    ...ShaderLib.standard,
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms),
  };
  material.onBeforeCompile(shader, {} as Parameters<typeof material.onBeforeCompile>[1]);
  return shader;
}

describe("field presentation material", () => {
  it("recompiles opacity/side transitions while keeping ordinary opacity updates in place", () => {
    const material = createScalarSurfaceShaderMaterial(orientation, { ...options, presentation: { roughness: 0.4, metalness: 0 } });
    const initialVersion = material.version;
    applyScalarSurfaceMaterialPolicy(material, { ...options, transparent: true, side: BackSide });
    expect(material.version).toBe(initialVersion + 1);
    const transparentVersion = material.version;
    updateScalarSurfaceShaderMaterial(material, orientation, 0.4);
    applyScalarSurfaceMaterialPolicy(material, { ...options, transparent: true, side: BackSide });
    updateScalarSurfaceShaderMaterial(material, orientation, 0.3);
    expect(material.version).toBe(transparentVersion);
    expect(material.opacity).toBe(0.3);
    applyScalarSurfaceMaterialPolicy(material, options);
    expect(material.version).toBe(transparentVersion + 1);
    expect(material.side).toBe(DoubleSide);
    expect(material.transparent).toBe(false);
    material.dispose();
  });
  it("adds SI-scale normals only for presentation and preserves topology and existing normals", () => {
    const geometry = new BufferGeometry();
    const positions = new Float32BufferAttribute([0, 0, 0, 1e-8, 0, 0, 0, 1e-8, 0], 3);
    geometry.setAttribute("position", positions);
    expect(prepareViewport3DFieldPresentationNormals(geometry, false)).toBe(false);
    expect(geometry.getAttribute("normal")).toBeUndefined();
    expect(prepareViewport3DFieldPresentationNormals(geometry, true)).toBe(true);
    const normals = geometry.getAttribute("normal");
    expect(normals.getZ(0)).toBe(1);
    expect(prepareViewport3DFieldPresentationNormals(geometry, true)).toBe(false);
    expect(geometry.getAttribute("position")).toBe(positions);
    expect(geometry.getAttribute("normal")).toBe(normals);
    geometry.dispose();
  });
  it("uses the exact unlit field shader when presentation is not requested", () => {
    const material = createScalarSurfaceShaderMaterial(orientation, options);
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.toneMapped).toBe(false);
    expect(material.uniforms.fmShadeStrength.value).toBe(0);
    material.dispose();
  });

  it("lights interpolated orientation colors with the standard PBR/shadow pipeline", () => {
    const material = createScalarSurfaceShaderMaterial(orientation, {
      ...options, presentation: { roughness: 0.45, metalness: 0.1 },
    });
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    if (!(material instanceof MeshStandardMaterial)) throw new Error("Expected a lit field material");
    expect(material.roughness).toBe(0.45);
    expect(material.metalness).toBe(0.1);
    const shader = compile(material);
    expect(shader.vertexShader).toContain("vVectorValue = fmVectorValue;");
    expect(shader.fragmentShader).toContain("vec3 base = orientationColor(vVectorValue);");
    expect(shader.fragmentShader).toContain("diffuseColor.rgb *= srgbToLinearVec3(base);");
    expect(shader.fragmentShader).toContain("#include <lights_physical_fragment>");
    expect(shader.fragmentShader).toContain("#include <shadowmap_pars_fragment>");
    expect(shader.fragmentShader).not.toContain("fmShadeStrength > 0.0");
    expect(shader.uniforms.fmPhaseRad).toBe(material.uniforms.fmPhaseRad);
    material.dispose();
  });

  it("updates phase, palette and opacity without recreating the PBR material", () => {
    const complex: ScalarColorBuffer = { ...orientation, complexRealValues: orientation.vectorValues,
      complexImagValues: new Float32Array(9), complexPhaseRad: 0, complexRepresentation: "phase_rotated_real" };
    const material = createScalarSurfaceShaderMaterial(complex, {
      ...options, presentation: { roughness: 0.4, metalness: 0 },
    });
    if (!(material instanceof MeshStandardMaterial)) throw new Error("Expected a lit field material");
    const shader = compile(material);
    const key = material.customProgramCacheKey();
    const version = material.version;
    updateScalarSurfaceShaderMaterial(material, { ...complex, complexPhaseRad: 1.2, colorPalette: "inferno" }, 0.6);
    expect(shader.uniforms.fmPhaseRad.value).toBe(1.2);
    expect(material.opacity).toBe(0.6);
    expect(material.customProgramCacheKey()).toBe(key);
    expect(material.version).toBe(version);
    expect(shader.vertexShader).toContain("projectComplex(complexReal, complexImag, theta)");
    material.dispose();
  });

  it("compiles scalar and tensor field mapping into the same lit pipeline", () => {
    const scalar: ScalarColorBuffer = { colors: new Float32Array(0), scalarValues: new Float32Array([0, 0.5, 1]),
      colorPalette: "viridis", range: { min: 0, max: 1 } };
    const tensor: ScalarColorBuffer = { ...scalar, tensorRows: [new Float32Array(9), new Float32Array(9), new Float32Array(9)], tensorScale: 1 };
    for (const buffer of [scalar, tensor]) {
      const material = createScalarSurfaceShaderMaterial(buffer, { ...options, presentation: { roughness: 0.4, metalness: 0 } });
      if (!(material instanceof MeshStandardMaterial)) throw new Error("Expected a lit field material");
      const shader = compile(material);
      expect(shader.fragmentShader).toContain("paletteColor(t)");
      expect(shader.fragmentShader).toContain("diffuseColor.rgb *= srgbToLinearVec3(base);");
      expect(shader.fragmentShader).not.toContain("vNormalView");
      if (buffer === tensor) expect(shader.vertexShader).toContain("vTensorRow0 = fmTensorRow0;");
      material.dispose();
    }
  });
});

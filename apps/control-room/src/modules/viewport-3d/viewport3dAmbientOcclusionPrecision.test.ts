import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { Pass } from "postprocessing";
import { PerspectiveCamera, Scene, type ShaderMaterial } from "three";
import { prepareViewport3DAmbientOcclusion } from "./viewport3dAmbientOcclusionPrecision";

// Exercise the actual transitive implementation used by the React wrapper.
const localRequire = createRequire(import.meta.url);
const effectRequire = createRequire(localRequire.resolve("@react-three/postprocessing"));
type AmbientPass = Pass & {
  configuration: { halfRes: boolean; gammaCorrection: boolean };
  effectShaderQuad: { material: ShaderMaterial };
  effectCompositerQuad: { material: ShaderMaterial };
  depthDownsampleQuad: { material: ShaderMaterial };
  setQualityMode(mode: string): void;
};
const { N8AOPostPass } = effectRequire("n8ao") as {
  N8AOPostPass: new (scene: Scene, camera: PerspectiveCamera, width: number, height: number) => AmbientPass;
};
const passes: AmbientPass[] = [];
afterEach(() => { for (const pass of passes.splice(0)) pass.dispose(); });
function createPass() {
  const pass = new N8AOPostPass(new Scene(), new PerspectiveCamera(), 16, 16);
  passes.push(pass);
  return pass;
}

describe("N8AO SI normal precision compatibility", () => {
  it.each([false, true])("prepares the installed full/half resolution shaders once (halfRes=%s)", (halfRes) => {
    const pass = createPass();
    pass.configuration.halfRes = halfRes;
    pass.renderToScreen = false;
    prepareViewport3DAmbientOcclusion([pass]);
    const materials = [pass.effectShaderQuad.material, pass.effectCompositerQuad.material,
      ...(halfRes ? [pass.depthDownsampleQuad.material] : [])];
    const versions = materials.map((material) => material.version);
    for (const material of materials) {
      expect(material.fragmentShader).not.toContain("normalize(cross(dpdx, dpdy))");
      expect(material.fragmentShader).toContain("fullmagStableCrossNormal(dpdx, dpdy)");
    }
    prepareViewport3DAmbientOcclusion([pass]);
    expect(materials.map((material) => material.version)).toEqual(versions);
    expect(pass.configuration.gammaCorrection).toBe(false);
  });

  it("prepares shaders recreated by quality and screen-output changes", () => {
    const pass = createPass();
    prepareViewport3DAmbientOcclusion([pass]);
    const original = pass.effectShaderQuad.material;
    pass.setQualityMode("High");
    pass.renderToScreen = true;
    prepareViewport3DAmbientOcclusion([pass]);
    expect(pass.effectShaderQuad.material).not.toBe(original);
    expect(pass.effectShaderQuad.material.fragmentShader).toContain("fullmagStableCrossNormal(dpdx, dpdy)");
    expect(pass.effectCompositerQuad.material.fragmentShader).toContain("fullmagStableCrossNormal(dpdx, dpdy)");
    expect(pass.configuration.gammaCorrection).toBe(true);
  });
});

import type { Pass } from "postprocessing";
import type { ShaderMaterial } from "three";

const preparedMaterials = new WeakSet<ShaderMaterial>();
const normalExpression = "normalize(cross(dpdx, dpdy))";
const stableNormal = `
vec3 fullmagStableCrossNormal(vec3 a, vec3 b) {
  float aScale = max(max(abs(a.x), abs(a.y)), abs(a.z));
  float bScale = max(max(abs(b.x), abs(b.y)), abs(b.z));
  if (aScale == 0.0 || bScale == 0.0) return vec3(0.0, 0.0, 1.0);
  vec3 n = cross(a / aScale, b / bScale);
  float nScale = max(max(abs(n.x), abs(n.y)), abs(n.z));
  return nScale > 0.0 ? normalize(n / nScale) : vec3(0.0, 0.0, 1.0);
}
`;

function unsupportedShader(): never {
  throw new Error("Ambient occlusion is unavailable with this renderer build. Turn it off in View Settings.");
}

function prepareMaterial(holder: unknown): void {
  if (!holder || typeof holder !== "object" || !("material" in holder)) unsupportedShader();
  const candidate = holder.material;
  if (!candidate || typeof candidate !== "object" || !("isShaderMaterial" in candidate) || candidate.isShaderMaterial !== true) unsupportedShader();
  const material = candidate as ShaderMaterial;
  if (preparedMaterials.has(material)) return;
  if (!material.fragmentShader.includes(normalExpression)) unsupportedShader();
  material.fragmentShader = stableNormal + material.fragmentShader.replaceAll(normalExpression, "fullmagStableCrossNormal(dpdx, dpdy)");
  material.needsUpdate = true;
  preparedMaterials.add(material);
}

/** N8AO 2.0.1 reconstructs SI normals by squaring tiny cross products.
 * Normalize operands first to keep the direction invariant at nanometre scales.
 * This adapter's three shader holders are checked against the installed pass
 * in the compatibility tests; no geometry, camera or field data are rescaled.
 */
export function prepareViewport3DAmbientOcclusion(passes: readonly Pass[]): void {
  for (const pass of passes) {
    if (!pass.enabled || !("configuration" in pass) || !("effectShaderQuad" in pass)) continue;
    const configuration = pass.configuration;
    if (!configuration || typeof configuration !== "object" || !("gammaCorrection" in configuration)) unsupportedShader();
    // Set the same gamma policy as N8AO's auto-detection before preparing its
    // shaders: changing gamma recreates the composition material synchronously.
    if (configuration.gammaCorrection !== pass.renderToScreen) configuration.gammaCorrection = pass.renderToScreen;
    prepareMaterial(pass.effectShaderQuad);
    if (!("effectCompositerQuad" in pass)) unsupportedShader();
    prepareMaterial(pass.effectCompositerQuad);
    if ("halfRes" in configuration && configuration.halfRes === true) {
      if (!("depthDownsampleQuad" in pass)) unsupportedShader();
      prepareMaterial(pass.depthDownsampleQuad);
    }
  }
}

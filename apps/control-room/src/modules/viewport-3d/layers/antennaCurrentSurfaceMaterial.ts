import { Color, DataTexture, DoubleSide, LinearFilter, RGBAFormat, ShaderMaterial, SRGBColorSpace, UnsignedByteType } from "three";
import { antennaSurfaceColorRange, resolveAntennaColorRange, type AntennaColorRange } from "@/kernel/visualization/antennaColorRange";
import { scalarColorSrgb } from "@/shared/visualization/scalarColorPalette";
import { VIEWPORT_3D_ORIENTATION_COLOR_GLSL } from "../viewport3dScalarSurfaceShader";
import type { AntennaFieldOverlayModel } from "../model/antennaFieldOverlayModel";

/** Interpolate the owned vector trace, then project its component/norm in the fragment. */
export function createAntennaCurrentSurfaceMaterial() {
  const bytes = new Uint8Array(256 * 4);
  const palette = new DataTexture(bytes, 256, 1, RGBAFormat, UnsignedByteType);
  palette.colorSpace = SRGBColorSpace;
  palette.minFilter = LinearFilter; palette.magFilter = LinearFilter;
  palette.generateMipmaps = false; palette.needsUpdate = true;
  const material = new ShaderMaterial({
    name: "FullmagAntennaOwnedCurrentSurface", side: DoubleSide,
    clipping: true,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    uniforms: {
      fmAntennaPalette: { value: palette },
      fmAntennaComponent: { value: 0 },
      fmAntennaColorMode: { value: 0 },
      fmAntennaMonoColor: { value: new Color("white") },
      fmAntennaOpacity: { value: 1 },
      fmAntennaMinimum: { value: 0 },
      fmAntennaMaximum: { value: 1 },
    },
    vertexShader: `
      #include <clipping_planes_pars_vertex>
      attribute vec3 fmAntennaCurrentVector;
      varying vec3 vAntennaCurrent;
      void main() {
        vAntennaCurrent = fmAntennaCurrentVector;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `
      precision highp float;
      #include <clipping_planes_pars_fragment>
      uniform sampler2D fmAntennaPalette;
      uniform int fmAntennaComponent;
      uniform int fmAntennaColorMode;
      uniform vec3 fmAntennaMonoColor;
      uniform float fmAntennaOpacity;
      uniform float fmAntennaMinimum;
      uniform float fmAntennaMaximum;
      varying vec3 vAntennaCurrent;
      ${VIEWPORT_3D_ORIENTATION_COLOR_GLSL}
      void main() {
        #include <clipping_planes_fragment>
        float value = fmAntennaComponent == 1 ? vAntennaCurrent.x :
          fmAntennaComponent == 2 ? vAntennaCurrent.y :
          fmAntennaComponent == 3 ? vAntennaCurrent.z : length(vAntennaCurrent);
        float range = fmAntennaMaximum - fmAntennaMinimum;
        float t = range > 0.0 ? clamp((value - fmAntennaMinimum) / range, 0.0, 1.0) : 0.5;
        vec4 color = texture2D(fmAntennaPalette, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
        if (fmAntennaColorMode == 1) color = vec4(srgbToLinearVec3(orientationColor(vAntennaCurrent)), 1.0);
        if (fmAntennaColorMode == 2) color = vec4(fmAntennaMonoColor, 1.0);
        gl_FragColor = vec4(color.rgb, color.a * fmAntennaOpacity);
        #include <colorspace_fragment>
      }`,
  });
  material.toneMapped = false;
  return { material, palette };
}

export function updateAntennaCurrentSurfaceMaterial(material: ShaderMaterial, palette: DataTexture, model: Pick<AntennaFieldOverlayModel, "minimum" | "maximum" | "surfaceVectorScale"> & { intent: { component: AntennaFieldOverlayModel["intent"]["component"]; palette: string; colorRange?: AntennaColorRange } }, presentation: { colorMode?: string; monoColor?: string; opacity?: number } = {}): void {
  const opacity = presentation.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Invalid surface opacity.");
  material.uniforms.fmAntennaOpacity.value = opacity;
  material.transparent = opacity < 1;
  material.depthWrite = opacity === 1;
  material.uniforms.fmAntennaColorMode.value = presentation.colorMode === "orientation" || presentation.colorMode === "hsl_sphere" ? 1 : presentation.colorMode === "monochrome" ? 2 : 0;
  material.uniforms.fmAntennaMonoColor.value.set(presentation.monoColor ?? "white");
  const scale = model.surfaceVectorScale ?? 1;
  material.uniforms.fmAntennaComponent.value = model.intent.component === "x" ? 1 : model.intent.component === "y" ? 2 : model.intent.component === "z" ? 3 : 0;
  const range = antennaSurfaceColorRange(resolveAntennaColorRange(model, model.intent.colorRange), scale);
  material.uniforms.fmAntennaMinimum.value = range.minimum;
  material.uniforms.fmAntennaMaximum.value = range.maximum;
  if (palette.userData.antennaPalette === model.intent.palette) return;
  const bytes = palette.image.data;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 1024) throw new Error("Invalid antenna palette storage.");
  for (let index = 0; index < 256; index++) {
    const rgb = scalarColorSrgb(index / 255, model.intent.palette);
    for (let channel = 0; channel < 3; channel++) bytes[index * 4 + channel] = Math.round(rgb[channel] * 255);
    bytes[index * 4 + 3] = 255;
  }
  palette.userData.antennaPalette = model.intent.palette;
  palette.needsUpdate = true;
}

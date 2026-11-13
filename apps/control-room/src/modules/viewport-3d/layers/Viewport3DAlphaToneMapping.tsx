"use client";

import { wrapEffect } from "@react-three/postprocessing";
import { BlendFunction, Effect } from "postprocessing";
import { ShaderChunk, Uniform } from "three";

/** Map straight linear light, then restore coverage before the output sRGB conversion. */
class Viewport3DAlphaToneMappingEffect extends Effect {
  constructor() {
    // Expand before effect namespacing so the pass owns its exposure uniform.
    super("Viewport3DAlphaToneMapping", `
      ${ShaderChunk.tonemapping_pars_fragment.replace(/\btoneMappingExposure\b/g, "viewportExposure")}
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        float coverage = inputColor.a;
        // Additive bloom can carry radiance outside geometry, with zero coverage.
        vec3 straightColor = coverage > 0.0 ? inputColor.rgb / coverage : inputColor.rgb;
        vec3 mapped = ACESFilmicToneMapping(straightColor);
        outputColor = vec4(coverage > 0.0 ? mapped * coverage : mapped, coverage);
      }
    `, { blendFunction: BlendFunction.SRC, uniforms: new Map([["viewportExposure", new Uniform(1)]]) });
  }
}

export const Viewport3DAlphaToneMapping = wrapEffect(Viewport3DAlphaToneMappingEffect);

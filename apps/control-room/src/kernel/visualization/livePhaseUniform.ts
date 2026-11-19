/**
 * A stable shader-uniform cell for a display phase that changes every frame.
 *
 * The object identity never changes, so three.js materials can bind it once
 * (`material.uniforms.fmPhaseRad = uniform`) and read the current value on
 * each draw. Phase animation then updates `value` without a React render, a
 * render-model rebuild or a GPU attribute upload.
 */
export interface LivePhaseUniform {
  value: number;
}

const livePhaseUniforms = new WeakSet<object>();

export function createLivePhaseUniform(initialPhaseRad = 0): LivePhaseUniform {
  const uniform: LivePhaseUniform = {
    value: Number.isFinite(initialPhaseRad) ? initialPhaseRad : 0,
  };
  livePhaseUniforms.add(uniform);
  return uniform;
}

export function isLivePhaseUniform(value: unknown): value is LivePhaseUniform {
  return typeof value === "object" && value !== null && livePhaseUniforms.has(value);
}

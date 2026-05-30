export interface Viewport2DInteractionState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export const DEFAULT_VIEWPORT_2D_INTERACTION: Viewport2DInteractionState = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
};

const MIN_VIEWPORT_2D_SCALE = 0.25;
const MAX_VIEWPORT_2D_SCALE = 16;

export function resetViewport2DInteraction(): Viewport2DInteractionState {
  return DEFAULT_VIEWPORT_2D_INTERACTION;
}

export function zoomViewport2DInteraction(
  state: Viewport2DInteractionState,
  wheelDeltaY: number,
): Viewport2DInteractionState {
  const factor = Math.exp(-wheelDeltaY * 0.001);
  return {
    ...state,
    scale: clamp(
      state.scale * factor,
      MIN_VIEWPORT_2D_SCALE,
      MAX_VIEWPORT_2D_SCALE,
    ),
  };
}

export function panViewport2DInteraction(
  state: Viewport2DInteractionState,
  movementX: number,
  movementY: number,
  viewportHeightPixels: number,
): Viewport2DInteractionState {
  const unitsPerPixel = 2 / Math.max(1, viewportHeightPixels);
  return {
    ...state,
    offsetX: state.offsetX + movementX * unitsPerPixel,
    offsetY: state.offsetY - movementY * unitsPerPixel,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

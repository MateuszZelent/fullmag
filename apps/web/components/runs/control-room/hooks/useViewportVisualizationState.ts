import { useCallback, useReducer } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { ViewportVisualizationState } from "../visualizationStateSync";

function resolveSetStateAction<T>(previous: T, update: SetStateAction<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

function viewportVisualizationReducer(
  state: ViewportVisualizationState,
  update: SetStateAction<ViewportVisualizationState>,
): ViewportVisualizationState {
  const next = resolveSetStateAction(state, update);
  return viewportVisualizationStatesEqual(state, next) ? state : next;
}

function viewportVisualizationStatesEqual(
  left: ViewportVisualizationState,
  right: ViewportVisualizationState,
): boolean {
  return left.meshRenderMode === right.meshRenderMode &&
    left.meshOpacity === right.meshOpacity &&
    left.meshClipEnabled === right.meshClipEnabled &&
    left.meshClipAxis === right.meshClipAxis &&
    left.meshClipPos === right.meshClipPos &&
    left.meshClipFlip === right.meshClipFlip &&
    left.meshShowArrows === right.meshShowArrows &&
    left.femVectorGlyphBudget === right.femVectorGlyphBudget &&
    left.femArrowColorMode === right.femArrowColorMode &&
    left.femArrowMonoColor === right.femArrowMonoColor &&
    left.femArrowAlpha === right.femArrowAlpha &&
    left.femArrowLengthScale === right.femArrowLengthScale &&
    left.femArrowThickness === right.femArrowThickness &&
    left.femVectorDomainFilter === right.femVectorDomainFilter &&
    left.femFerromagnetVisibilityMode === right.femFerromagnetVisibilityMode &&
    left.airMeshVisible === right.airMeshVisible &&
    left.airMeshOpacity === right.airMeshOpacity &&
    left.femViewportLayers.showPrimitives === right.femViewportLayers.showPrimitives &&
    left.femViewportLayers.showMesh === right.femViewportLayers.showMesh &&
    left.femViewportLayers.showMagneticTexture === right.femViewportLayers.showMagneticTexture &&
    left.femViewportLayers.showQuantity === right.femViewportLayers.showQuantity;
}

export function useViewportVisualizationState(
  initialState: ViewportVisualizationState,
): [
  ViewportVisualizationState,
  Dispatch<SetStateAction<ViewportVisualizationState>>,
] {
  const [state, dispatch] = useReducer(viewportVisualizationReducer, initialState);

  const setViewportVisualizationState = useCallback<
    Dispatch<SetStateAction<ViewportVisualizationState>>
  >((update) => {
    dispatch(update);
  }, []);

  return [state, setViewportVisualizationState];
}

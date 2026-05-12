import { useShallow } from "zustand/react/shallow";
import { useVisualizationStore, selectEffectiveViewportVizState } from "../store/useVisualizationStore";

export function useRenderMode() {
  return useVisualizationStore((s) => s.meshRenderMode);
}

export function useViewportRenderState() {
  return useVisualizationStore(useShallow((s) => ({
    meshRenderMode: s.meshRenderMode,
    meshOpacity: s.meshOpacity,
    meshTrim: s.meshTrim,
    meshClipEnabled: s.meshClipEnabled,
    meshClipAxis: s.meshClipAxis,
    meshClipPos: s.meshClipPos,
    meshClipFlip: s.meshClipFlip,
    meshShowArrows: s.meshShowArrows,
    femViewportLayers: s.femViewportLayers,
    airMeshVisible: s.airMeshVisible,
    airMeshOpacity: s.airMeshOpacity,
    femTextureDownsampleCells: s.femTextureDownsampleCells,
    viewportLegendVisible: s.viewportLegendVisible,
    viewportAxesScope: s.viewportAxesScope,
    universeWireframeVisible: s.universeWireframeVisible,
  })));
}

export function useMagneticTextureDensity() {
  return useVisualizationStore((s) => s.femTextureDownsampleCells);
}

export function useFdmVisualizationSettings() {
  return useVisualizationStore((s) => s.fdmVisualizationSettings);
}

export function useClipState() {
  return useVisualizationStore(useShallow((s) => ({
    enabled: s.meshClipEnabled,
    axis: s.meshClipAxis,
    pos: s.meshClipPos,
    flip: s.meshClipFlip,
  })));
}

export function useVectorState() {
  return useVisualizationStore(useShallow((s) => ({
    showArrows: s.meshShowArrows,
    glyphBudget: s.femVectorGlyphBudget,
    colorMode: s.femArrowColorMode,
    monoColor: s.femArrowMonoColor,
    alpha: s.femArrowAlpha,
    lengthScale: s.femArrowLengthScale,
    thickness: s.femArrowThickness,
    domainFilter: s.femVectorDomainFilter,
    ferromagnetVisibilityMode: s.femFerromagnetVisibilityMode,
  })));
}

/**
 * Read the effective viewport visualization state from the store.
 *
 * This is the render-plan-projected state — equivalent to the old
 * CRC `effectiveViewportVisualizationState` useMemo, but reading from
 * the store directly so hooks don't need prop drilling.
 */
export function useEffectiveVizState() {
  return useVisualizationStore(useShallow(
    (s) => selectEffectiveViewportVizState(s),
  ));
}

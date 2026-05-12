export { buildPartRenderDataCache, collectPartBoundaryFaceIndices, collectPartElementIndices, collectPartNodeMask, collectSegmentBoundaryFaceIndicesByIds, collectSegmentElementIndicesByIds, collectSegmentNodeMask, markersForPart } from "./model/femTopologyCache";
export type { PartRenderData } from "./model/femTopologyCache";
export { buildVisibleLayers } from "./model/femRenderModel";
export type { RenderLayer, BuildVisibleLayersInput } from "./model/femRenderModel";
export { buildMagneticArrowNodeMask } from "./model/femSelectionMap";
export { resolveViewportSelectionScope, scopeTargetPartIds, scopeLabel } from "./model/femViewportSelection";
export type { ViewportSelectionScope, ViewportSelectionState, ResolveSelectionScopeInput } from "./model/femViewportSelection";

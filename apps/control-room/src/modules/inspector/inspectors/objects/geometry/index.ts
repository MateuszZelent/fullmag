export {
  buildBaselineFromScene,
  resolveMeshStatusFromObject,
  resolvePreviewOverlayDraft,
  serializeGeometryPayload,
  serializeTransformPayload,
} from "./geometrySerialization";
export {
  applyUniformScaleChange,
  bakeScaleIntoDraft,
  canBakeScaleIntoDraft,
  createPolygonVertexRow,
  isUniformPositiveScale,
  normalizeScaleForUniformLock,
  validateArchWaveguide,
  validateSimplePolygon,
  validateTorusRadii,
  validateTubeRadii,
  type ArchProfileMode,
  type ArchWaveguideValidationInput,
  type CanonicalPrimitiveKind,
  type CsgOperationMode,
  type ObjectGeometrySpecDraft,
  type PolygonVertexRow,
} from "./geometryShared";
export {
  BuilderPrimitiveInspectorPanel,
  GeometryObjectInspectorPanel,
} from "./ObjectGeometrySpec";

/**
 * Geometry Builder feature — public API.
 *
 * Re-exports types, store, defaults, and validation.
 */

// ── Domain types ──────────────────────────────────────────────
export type {
  LengthMeters,
  Vec3m,
  Vec3,
  Quat,
  PrimitiveKind,
  PrimitiveSupport,
  PrimitiveCapability,
  PrimitiveParams,
  BoxParams,
  CylinderParams,
  SphereParams,
  DiskParams,
  TriangularPrismParams,
  Transform3D,
  UniverseNode,
  PrimitiveNode,
  BooleanNode,
  GroupNode,
  WorkPlaneNode,
  GeometryNode,
  GeometryGraphDocument,
  GeometryGraphMetadata,
  GeometryBuildPolicy,
  RealizedBody,
  GeometryRealizationSnapshot,
  MeshQualitySummary,
  MeshSnapshot,
  DirtyState,
  RevisionChain,
  GeometryDiagnostic,
  GeometrySuggestedAction,
  PlacementValidation,
  UniverseConstraintPolicy,
  GeometryBuilderSubmode,
  GeometryBuilderMode,
  BuilderSelectionTarget,
  GeometryViewportTool,
  GeometrySnapSettings,
} from "./model/types";

export { IDENTITY_TRANSFORM, CLEAN_STATE, PRIMITIVE_CAPABILITIES } from "./model/types";

// ── Defaults ──────────────────────────────────────────────────
export {
  defaultPrimitiveParams,
  defaultBoxParams,
  defaultCylinderParams,
  defaultSphereParams,
  defaultDiskParams,
  defaultTriangularPrismParams,
  createDefaultPrimitive,
  defaultTargetSize,
  MIN_DEFAULT_SIZE_M,
  MAX_DEFAULT_SIZE_M,
} from "./model/defaults";
export type { DefaultPrimitiveContext } from "./model/defaults";

// ── Store ─────────────────────────────────────────────────────
export { useGeometryBuilderStore } from "./store/useGeometryBuilderStore";
export type { GeometryBuilderState } from "./store/useGeometryBuilderStore";

// ── Validation ────────────────────────────────────────────────
export { validatePlacement, clampToUniverse } from "./validation/placementValidation";

// ── Tree ──────────────────────────────────────────────────────
export { buildGeometryBuilderTreeNodes } from "./tree/builderTreeNodes";

// ── Viewport ──────────────────────────────────────────────────
export { BuilderViewportLayer } from "./viewport/BuilderViewportLayer";
export { useBuilderKeyboardShortcuts } from "./viewport/useBuilderKeyboardShortcuts";

// ── Inspector ─────────────────────────────────────────────────
export { default as BuilderPrimitiveInspector } from "./inspector/BuilderPrimitiveInspector";
export { default as BuilderUniverseInspector } from "./inspector/BuilderUniverseInspector";
export { default as BuilderOverviewInspector } from "./inspector/BuilderOverviewInspector";
export { default as GeometryInspectorRouter } from "./inspector/GeometryInspectorRouter";

// ── Hooks ─────────────────────────────────────────────────────
export { useBuilderRunGate } from "./hooks/useBuilderRunGate";
export { useBuilderContextMenu } from "./hooks/useBuilderContextMenu";
export type { BuilderContextMenuItem } from "./hooks/useBuilderContextMenu";

// ── Components ────────────────────────────────────────────────
export { BuilderStatusBadge } from "./components/BuilderStatusBadge";
export { GeometryToolbar } from "./components/GeometryToolbar";

/**
 * Geometry Builder feature — public API.
 *
 * Re-exports types, store, defaults, and validation.
 */

// ── Domain types ──────────────────────────────────────────────
export type {
  Vec3,
  Quat,
  PrimitiveKind,
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
  RealizedBody,
  GeometryRealizationSnapshot,
  MeshQualitySummary,
  MeshSnapshot,
  DirtyState,
  RevisionChain,
  GeometryDiagnostic,
  PlacementValidation,
  UniverseConstraintPolicy,
  GeometryBuilderSubmode,
  GeometryBuilderMode,
  BuilderSelectionTarget,
} from "./model/types";

export { IDENTITY_TRANSFORM, CLEAN_STATE } from "./model/types";

// ── Defaults ──────────────────────────────────────────────────
export {
  defaultPrimitiveParams,
  defaultBoxParams,
  defaultCylinderParams,
  defaultSphereParams,
  defaultDiskParams,
  defaultTriangularPrismParams,
} from "./model/defaults";

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

// ── Hooks ─────────────────────────────────────────────────────
export { useBuilderRunGate } from "./hooks/useBuilderRunGate";
export { useBuilderContextMenu } from "./hooks/useBuilderContextMenu";
export type { BuilderContextMenuItem } from "./hooks/useBuilderContextMenu";

// ── Components ────────────────────────────────────────────────
export { BuilderStatusBadge } from "./components/BuilderStatusBadge";


/**
 * P1 — Geometry Builder Domain Types
 *
 * Canonical model for parametric geometry authoring.
 * Separates authoring geometry from realized (solver) geometry and mesh.
 *
 * ADR: Primitives are parametric definitions, not direct solver mesh.
 * Transform is a separate component, enabling re-realization and clean DSL round-trip.
 */

// ── Vec helpers ───────────────────────────────────────────────

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// ── Primitive kinds ───────────────────────────────────────────

export type PrimitiveKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "disk"
  | "triangular_prism";

// ── Primitive parameters (per kind) ───────────────────────────

export interface BoxParams {
  size: Vec3;
}

export interface CylinderParams {
  radius: number;
  height: number;
  axis: "x" | "y" | "z";
}

export interface SphereParams {
  radius: number;
}

export interface DiskParams {
  radius: number;
  thickness: number;
  axis: "x" | "y" | "z";
}

export interface TriangularPrismParams {
  base: number;
  triangleHeight: number;
  depth: number;
  axis: "x" | "y" | "z";
}

export type PrimitiveParams =
  | { kind: "box"; data: BoxParams }
  | { kind: "cylinder"; data: CylinderParams }
  | { kind: "sphere"; data: SphereParams }
  | { kind: "disk"; data: DiskParams }
  | { kind: "triangular_prism"; data: TriangularPrismParams };

// ── Transform ─────────────────────────────────────────────────

export interface Transform3D {
  translation: Vec3;
  rotationQuat: Quat;
  scale: Vec3;
}

export const IDENTITY_TRANSFORM: Transform3D = {
  translation: [0, 0, 0],
  rotationQuat: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

// ── Graph nodes ───────────────────────────────────────────────

export interface UniverseNode {
  id: string;
  kind: "universe";
  boundsMode: "box";
  size: Vec3;
  origin: Vec3;
  visibility: boolean;
  lockTransforms: true;
}

export interface PrimitiveNode {
  id: string;
  kind: "primitive";
  primitiveKind: PrimitiveKind;
  name: string;
  enabled: boolean;
  visible: boolean;
  locked: boolean;
  transform: Transform3D;
  params: PrimitiveParams;
  materialBindingId: string | null;
  tags: string[];
}

export type BooleanOp = "union" | "subtract" | "intersect";

export interface BooleanNode {
  id: string;
  kind: "boolean";
  name: string;
  op: BooleanOp;
  inputs: string[];
  enabled: boolean;
}

export interface GroupNode {
  id: string;
  kind: "group";
  name: string;
  children: string[];
}

export interface WorkPlaneNode {
  id: string;
  kind: "work_plane";
  name: string;
  origin: Vec3;
  normal: Vec3;
  visible: boolean;
}

export type GeometryNode =
  | PrimitiveNode
  | BooleanNode
  | GroupNode
  | WorkPlaneNode;

// ── Geometry graph document ───────────────────────────────────

export interface GeometryGraphDocument {
  version: "geometry_graph.v1";
  universe: UniverseNode;
  nodes: GeometryNode[];
}

// ── Realized geometry ─────────────────────────────────────────

export interface RealizedBody {
  sourceNodeId: string;
  name: string;
  boundsMin: Vec3;
  boundsMax: Vec3;
}

export interface GeometryRealizationSnapshot {
  revision: number;
  sourceGraphRevision: number;
  bodies: RealizedBody[];
  boundsMin: Vec3;
  boundsMax: Vec3;
  createdAt: string;
}

// ── Mesh snapshot ─────────────────────────────────────────────

export interface MeshQualitySummary {
  minQuality: number;
  avgQuality: number;
  elementCount: number;
  nodeCount: number;
}

export interface MeshSnapshot {
  revision: number;
  sourceGeometryRevision: number;
  meshState: "ready" | "failed";
  qualitySummary: MeshQualitySummary | null;
  createdAt: string;
}

// ── Dirty state ───────────────────────────────────────────────

export interface DirtyState {
  geometryDraftDirty: boolean;
  geometryRealizationDirty: boolean;
  meshDirty: boolean;
  initialStateDirty: boolean;
  resultsDirty: boolean;
}

export const CLEAN_STATE: DirtyState = {
  geometryDraftDirty: false,
  geometryRealizationDirty: false,
  meshDirty: false,
  initialStateDirty: false,
  resultsDirty: false,
};

// ── Revision chain ────────────────────────────────────────────

export interface RevisionChain {
  geometryGraphRevision: number;
  geometryRealizationRevision: number | null;
  meshRevision: number | null;
}

// ── Placement validation ──────────────────────────────────────

export interface GeometryDiagnostic {
  nodeId: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface PlacementValidation {
  withinUniverse: boolean;
  intersectsUniverseBoundary: boolean;
  exceedsUniverse: boolean;
  selfInvalid: boolean;
  diagnostics: GeometryDiagnostic[];
}

// ── Universe constraint policy ────────────────────────────────

export type UniverseConstraintPolicy =
  | "block_commit"
  | "clamp_on_release"
  | "preview_only_block_commit";

// ── Geometry builder mode ─────────────────────────────────────

export type GeometryBuilderSubmode =
  | "select"
  | "create"
  | "transform"
  | "validate";

export interface GeometryBuilderMode {
  enabled: boolean;
  submode: GeometryBuilderSubmode;
}

// ── Selection target extension for builder ────────────────────

export type BuilderSelectionTarget =
  | { type: "none" }
  | { type: "universe"; id: string }
  | { type: "primitive"; id: string }
  | { type: "boolean"; id: string }
  | { type: "work_plane"; id: string }
  | { type: "group"; id: string };

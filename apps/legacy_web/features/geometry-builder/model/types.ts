/**
 * P1 — Geometry Builder Domain Types
 *
 * Canonical model for parametric geometry authoring.
 * Separates authoring geometry from realized (solver) geometry and mesh.
 *
 * ADR: Primitives are parametric definitions, not direct solver mesh.
 * Transform is a separate component, enabling re-realization and clean DSL round-trip.
 * Units: all lengths in the model are in metres (SI). UI may display nm/μm/mm.
 */

// ── SI unit helpers (documentation types, not runtime validators) ─────────

/** A length value in SI metres. */
export type LengthMeters = number;

/** A 3-component vector of SI metre values [x, y, z]. */
export type Vec3m = [LengthMeters, LengthMeters, LengthMeters];

// ── Vec helpers ───────────────────────────────────────────────

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// ── Primitive kinds ───────────────────────────────────────────

export type PrimitiveKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "ellipsoid"
  | "disk"
  | "thin_film"
  | "pillar"
  | "nanowire"
  | "ring"
  | "triangular_prism"
  | "cone"
  | "capsule"
  | "tube"
  | "wedge"
  | "polygon_prism";

// ── Primitive capability matrix ───────────────────────────────

export type PrimitiveSupport = "production" | "preview" | "experimental";

export interface PrimitiveCapability {
  fdm: boolean;
  fem: boolean;
  dsl: boolean;
  boolean: boolean;
  status: PrimitiveSupport;
  category: "core" | "mumax" | "dcc";
  label: string;
}

export const PRIMITIVE_CAPABILITIES: Record<PrimitiveKind, PrimitiveCapability> = {
  box: { fdm: true, fem: true, dsl: true, boolean: true, status: "production", category: "core", label: "Box" },
  cylinder: { fdm: true, fem: true, dsl: true, boolean: true, status: "production", category: "core", label: "Cylinder" },
  sphere: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "mumax", label: "Sphere" },
  ellipsoid: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "mumax", label: "Ellipsoid" },
  disk: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "core", label: "Disk" },
  thin_film: { fdm: true, fem: true, dsl: true, boolean: true, status: "production", category: "mumax", label: "Thin Film" },
  pillar: { fdm: true, fem: true, dsl: true, boolean: true, status: "production", category: "mumax", label: "Pillar" },
  nanowire: { fdm: true, fem: true, dsl: true, boolean: true, status: "production", category: "mumax", label: "Nanowire" },
  ring: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "mumax", label: "Ring" },
  triangular_prism: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "core", label: "Triangular Prism" },
  cone: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "dcc", label: "Cone" },
  capsule: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "dcc", label: "Capsule" },
  tube: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "dcc", label: "Tube" },
  wedge: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "dcc", label: "Wedge" },
  polygon_prism: { fdm: false, fem: false, dsl: false, boolean: true, status: "preview", category: "dcc", label: "Polygon Prism" },
} as const;

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

export interface EllipsoidParams {
  radii: Vec3;
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

export interface ConeParams {
  radiusTop: number;
  radiusBottom: number;
  height: number;
  axis: "x" | "y" | "z";
}

export interface CapsuleParams {
  radius: number;
  height: number;
  axis: "x" | "y" | "z";
}

export interface TubeParams {
  outerRadius: number;
  innerRadius: number;
  height: number;
  axis: "x" | "y" | "z";
}

export interface WedgeParams {
  size: Vec3;
  slope: number;
}

export interface PolygonPrismParams {
  radius: number;
  sides: number;
  depth: number;
  axis: "x" | "y" | "z";
}

export type PrimitiveParams =
  | { kind: "box"; data: BoxParams }
  | { kind: "cylinder"; data: CylinderParams }
  | { kind: "sphere"; data: SphereParams }
  | { kind: "ellipsoid"; data: EllipsoidParams }
  | { kind: "disk"; data: DiskParams }
  | { kind: "thin_film"; data: BoxParams }
  | { kind: "pillar"; data: CylinderParams }
  | { kind: "nanowire"; data: BoxParams }
  | { kind: "ring"; data: TubeParams }
  | { kind: "triangular_prism"; data: TriangularPrismParams }
  | { kind: "cone"; data: ConeParams }
  | { kind: "capsule"; data: CapsuleParams }
  | { kind: "tube"; data: TubeParams }
  | { kind: "wedge"; data: WedgeParams }
  | { kind: "polygon_prism"; data: PolygonPrismParams };

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
  /** Universe constraint policy applied during Build Geometry. */
  policy: UniverseConstraintPolicy;
  /** Optional padding added around objects during auto-fit. SI metres. */
  padding?: Vec3;
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
  /**
   * Determines how this primitive is treated when it crosses the Universe boundary.
   * `null` inherits from UniverseNode.policy.
   */
  realizationPolicy?: "normal" | "clip_to_universe_explicit" | null;
  /** Reference to a mesh intent config (P2+). */
  meshIntentId?: string | null;
  /** Editor-only display metadata, not physics-relevant. */
  editor?: {
    color?: string;
    expanded?: boolean;
    lastSelectedAt?: string;
  };
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

export interface GeometryGraphMetadata {
  createdAt: string;
  updatedAt: string;
  unitSystem: "si";
  authoringVersion: "geometry_graph.v1";
}

export interface GeometryGraphDocument {
  version: "geometry_graph.v1";
  universe: UniverseNode;
  nodes: GeometryNode[];
  metadata?: GeometryGraphMetadata;
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

/**
 * Suggested corrective action when a primitive has placement issues.
 * Never applied silently — the user must confirm.
 */
export type GeometrySuggestedAction =
  | { kind: "expand_universe"; requiredSize: Vec3; requiredOrigin: Vec3 }
  | { kind: "move_inside"; suggestedTranslation: Vec3 }
  | { kind: "clip_with_ack"; clippedVolumeEstimate?: number };

export interface PlacementValidation {
  withinUniverse: boolean;
  intersectsUniverseBoundary: boolean;
  exceedsUniverse: boolean;
  selfInvalid: boolean;
  diagnostics: GeometryDiagnostic[];
  suggestedActions: GeometrySuggestedAction[];
}

// ── Universe constraint policy ────────────────────────────────

/**
 * Policy applied when a primitive crosses the Universe boundary during Build Geometry.
 * Explicit values ensure user intent is never silently erased.
 *
 * - `block_build`: hard block; user must fix manually.
 * - `auto_fit_universe`: expand Universe to contain all primitives (with padding).
 * - `preview_only_block_build`: allow authoring preview but block Build Geometry.
 * - `clip_with_explicit_ack`: clip to Universe only after the user explicitly acknowledges.
 */
export type UniverseConstraintPolicy =
  | "block_build"
  | "auto_fit_universe"
  | "preview_only_block_build"
  | "clip_with_explicit_ack";

// ── Geometry build policy ─────────────────────────────────────

export interface GeometryBuildPolicy {
  universeConstraint: UniverseConstraintPolicy;
  allowPreviewOutsideUniverse: boolean;
  requireExplicitClipAck: boolean;
  autoFitPadding: Vec3;
}

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

// ── Viewport tool ─────────────────────────────────────────────

/**
 * Active tool mode in the geometry viewport.
 * Default is `camera`. Transform tools activate gizmos for the selected primitive.
 */
export type GeometryViewportTool =
  | "camera"
  | "select"
  | "move"
  | "rotate"
  | "scale";

export interface GeometrySnapSettings {
  enabled: boolean;
  /** Translation snap step in metres. */
  translateStepMeters: number;
  /** Rotation snap step in degrees. */
  rotateStepDeg: number;
  /** Scale snap step around 1.0 (e.g. 0.05 = 5%). */
  scaleStep: number;
}

// ── Selection target extension for builder ────────────────────

export type BuilderSelectionTarget =
  | { type: "none" }
  | { type: "universe"; id: string }
  | { type: "primitive"; id: string }
  | { type: "boolean"; id: string }
  | { type: "work_plane"; id: string }
  | { type: "group"; id: string };

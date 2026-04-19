/**
 * @module lib/fieldFrame/types
 *
 * Canonical field-frame envelope types for the FEM data-plane.
 *
 * Every consumer (viewport 3D, viewport 2D/slice, charts) must use
 * `FieldFrameEnvelope` as the single identity of a field payload.
 *
 * See: docs/reports/19.04.2026/femvieport/fullmag-fem-regression-p2-data-plane.mdx
 */

// ── Field stats ──────────────────────────────────────────────────

export interface FieldFrameStats {
  min: number;
  max: number;
  /** Component-wise min (length = nComp). */
  compMin: number[] | null;
  /** Component-wise max (length = nComp). */
  compMax: number[] | null;
}

// ── Envelope ─────────────────────────────────────────────────────

export interface FieldFrameEnvelope {
  /** Session that produced this frame. */
  sessionId: string;
  /** Run within the session. */
  runId: string;
  /** Monotonic backend epoch — bumped on restart / re-run. */
  backendEpoch: number;
  /** Mesh generation id when available (FEM). Null for FDM grids. */
  meshGenerationId: string | null;
  /** Content hash of topology arrays (fallback when generation_id is absent). */
  topologyHash: string | null;
  /** Monotonically increasing field revision counter from the backend. */
  fieldRevision: number;
  /** Solver step that produced this field. */
  sourceStep: number;
  /** Physical time of the source step. */
  sourceTime: number;
  /** Quantity identifier, e.g. "m", "H_eff", "H_demag". */
  quantityId: string;
  /** Active component / display. */
  component: "x" | "y" | "z" | "magnitude" | "3D";
  /** Number of components per point. */
  nComp: 1 | 3 | 6 | 9;
  /** Domain coverage. */
  domain: "magnetic_only" | "full_domain" | "surface_only";
  /** Value location on the mesh. */
  location: "node" | "element" | "face" | "grid_cell";
  /** Payload data type. */
  dtype: "f32" | "f64";
  /** Payload delivery mode. */
  payloadKind: "inline-json" | "inline-small" | "binary-ref" | "shared-buffer";
  /** Opaque payload id from the backend. */
  payloadId: string | null;
  /** Active-mask artifact id (if mask is needed). */
  activeMaskId: string | null;
  /** Precomputed statistics. */
  stats: FieldFrameStats | null;
}

// ── Topology frame ───────────────────────────────────────────────

/**
 * Identifies the mesh topology independently from field values.
 * Viewport geometry caches key on this.
 */
export interface FemTopologySignature {
  /** Primary key: backend-assigned generation id. */
  meshGenerationId: string | null;
  /** Fallback: hash of node/element/face counts + sample coords. */
  topologyHash: string;
}

// ── Field frame (for viewport) ───────────────────────────────────

/**
 * Lightweight reference passed to viewport components. Separates
 * identity (envelope) from heavy payload (typed arrays).
 */
export interface FemFieldFrameRef {
  envelope: FieldFrameEnvelope;
  /** The actual vector field values — may be null while loading. */
  values: Float64Array | Float32Array | null;
  /** Per-node/element active mask. */
  activeMask: Uint8Array | boolean[] | null;
}

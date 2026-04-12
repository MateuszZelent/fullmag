/**
 * Python Projection Types — §1I
 *
 * Typed interfaces describing how a study pipeline (stages + configuration)
 * projects to the canonical Python DSL emit that the backend consumes.
 *
 * These types are consumed by:
 * - The Python code-preview panel (read-only DSL render)
 * - The transport layer when sending a "run study" command
 * - The Python script export feature
 */

// ── Stage projection ─────────────────────────────────────────

/** A single stage projected to its Python DSL representation. */
export interface StagePythonProjection {
  /** Stage id from the pipeline model. */
  stageId: string;
  /** Stage kind key (e.g. "relax", "run", "hysteresis_loop"). */
  stageKind: string;
  /**
   * Canonical Python call expression.
   * E.g. `problem.relax()` or `problem.run_until(t=5e-9)`.
   */
  pythonExpr: string;
  /** Named arguments to the Python call as key-value pairs. */
  args: Record<string, PythonArgValue>;
  /** Whether this stage is enabled in the pipeline. */
  enabled: boolean;
  /** Line number hint for code preview alignment. */
  lineHint: number | null;
}

/** Python argument value — typed for serialization fidelity. */
export type PythonArgValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "vector"; value: [number, number, number] }
  | { type: "expr"; value: string }
  | { type: "none" };

// ── Study projection ─────────────────────────────────────────

/** Full study pipeline projected to Python DSL. */
export interface StudyPythonProjection {
  /** Study id */
  studyId: string;
  /** Study label for comments in the generated code. */
  studyLabel: string;
  /** Ordered stage projections. */
  stages: StagePythonProjection[];
  /** Preamble lines emitted before the stages (imports, problem setup). */
  preamble: string[];
  /** Postamble lines emitted after the stages (e.g. save_data). */
  postamble: string[];
}

// ── Workspace projection ─────────────────────────────────────

/**
 * Full workspace → Python DSL projection.
 * Contains the universe setup (geometry, materials, mesh, physics)
 * plus all study pipelines.
 */
export interface WorkspacePythonProjection {
  /** Generated Python script header comment. */
  header: string;
  /** Import block (e.g. `from fullmag import *`). */
  imports: string[];
  /** Universe setup block (world, objects, materials, mesh). */
  universeSetup: UniverseSetupProjection;
  /** Ordered study projections. */
  studies: StudyPythonProjection[];
}

// ── Universe setup sub-projection ────────────────────────────

export interface UniverseSetupProjection {
  /** World / simulation domain definition lines. */
  worldLines: string[];
  /** Geometry object definitions. */
  objectLines: string[];
  /** Material assignment lines. */
  materialLines: string[];
  /** Physics interaction definitions (exchange, DMI, anisotropy, etc.). */
  physicsLines: string[];
  /** Mesh configuration lines. */
  meshLines: string[];
  /** External field / current excitation lines. */
  excitationLines: string[];
}

import type {
  MeshBuildDiagnosticsResource,
  MeshConfigRecord,
  MeshObjectConfigEntry,
  MeshSemanticsResource,
  MeshSolverMeshResource,
} from "../../api/types";
import type {
  MeshBuildDiagnosticsView,
  MeshWorkspaceSemanticsView,
  ObjectMeshConfigView,
  SolverMeshView,
  UniverseMeshConfigView,
} from "./types";

function normalizeVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

function numericOrNull(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function adaptUniverse(config: MeshConfigRecord | null | undefined): UniverseMeshConfigView | null {
  if (!config) {
    return null;
  }
  const raw = config as Record<string, unknown>;
  return {
    mode: typeof raw.mode === "string" ? raw.mode : null,
    size: normalizeVec3(raw.size),
    center: normalizeVec3(raw.center),
    padding: normalizeVec3(raw.padding),
    airbox_hmax: numericOrNull(raw.airbox_hmax),
    raw: config,
  };
}

function adaptObjectConfig(entry: MeshObjectConfigEntry): ObjectMeshConfigView {
  const raw = (entry.config ?? null) as Record<string, unknown> | null;
  return {
    object_id: entry.object_id,
    object_name: entry.object_name,
    mode: raw && typeof raw.mode === "string" ? raw.mode : null,
    hmax: raw ? numericOrNull(raw.hmax) : null,
    hmin: raw ? numericOrNull(raw.hmin) : null,
    raw: entry.config ?? null,
  };
}

function adaptSolverMesh(solver: MeshSolverMeshResource | null | undefined): SolverMeshView | null {
  if (!solver) {
    return null;
  }
  return {
    mesh_name: solver.mesh_name,
    mesh_id: solver.mesh_id,
    generation_id: solver.generation_id ?? null,
    domain_mesh_mode: solver.domain_mesh_mode ?? null,
    object_segment_count: solver.object_segment_count,
    mesh_part_count: solver.mesh_part_count,
  };
}

function adaptDiagnostics(
  diagnostics: MeshBuildDiagnosticsResource | null | undefined,
): MeshBuildDiagnosticsView | null {
  if (!diagnostics) {
    return null;
  }
  const rawQualitySummary = (diagnostics.mesh_quality_summary ?? null) as
    | Record<string, unknown>
    | null;
  const rawLastBuildSummary = (diagnostics.last_build_summary ?? null) as
    | Record<string, unknown>
    | null;
  const rawPipelineStatus = diagnostics.mesh_pipeline_status ?? null;
  const pipelinePhaseCount = Array.isArray(rawPipelineStatus)
    ? rawPipelineStatus.length
    : rawPipelineStatus == null
      ? 0
      : 1;
  return {
    min_quality: rawQualitySummary ? numericOrNull(rawQualitySummary.min_quality) : null,
    last_build_error: diagnostics.last_build_error ?? null,
    pipeline_phase_count: pipelinePhaseCount,
    raw_quality_summary: rawQualitySummary,
    raw_last_build_summary: rawLastBuildSummary,
    raw_pipeline_status: rawPipelineStatus,
  };
}

export function meshSemanticsResourceToView(
  resource: MeshSemanticsResource | null | undefined,
): MeshWorkspaceSemanticsView | null {
  if (!resource) {
    return null;
  }
  return {
    revision: resource.revision,
    universe: adaptUniverse(resource.universe_config),
    shared_domain_config: resource.shared_domain_config,
    objects: resource.object_configs.map(adaptObjectConfig),
    solver_mesh: adaptSolverMesh(resource.solver_mesh),
    diagnostics: adaptDiagnostics(resource.mesh_build_diagnostics),
    render_only_controls_do_not_change_solver_domain:
      resource.render_only_controls_do_not_change_solver_domain,
  };
}

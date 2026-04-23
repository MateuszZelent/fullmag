import type { MeshConfigRecord } from "../../api/types";

export interface UniverseMeshConfigView {
  mode: string | null;
  size: [number, number, number] | null;
  center: [number, number, number] | null;
  padding: [number, number, number] | null;
  airbox_hmax: number | null;
  raw: MeshConfigRecord | null;
}

export interface ObjectMeshConfigView {
  object_id: string;
  object_name: string;
  mode: string | null;
  hmax: number | null;
  hmin: number | null;
  raw: MeshConfigRecord | null;
}

export interface SolverMeshView {
  mesh_name: string;
  mesh_id: string;
  generation_id: string | null;
  domain_mesh_mode: string | null;
  object_segment_count: number;
  mesh_part_count: number;
}

export interface MeshBuildDiagnosticsView {
  min_quality: number | null;
  last_build_error: string | null;
  pipeline_phase_count: number;
  raw_quality_summary: Record<string, unknown> | null;
  raw_last_build_summary: Record<string, unknown> | null;
  raw_pipeline_status: unknown;
}

export interface MeshWorkspaceSemanticsView {
  revision: number;
  universe: UniverseMeshConfigView | null;
  shared_domain_config: MeshConfigRecord;
  objects: ObjectMeshConfigView[];
  solver_mesh: SolverMeshView | null;
  diagnostics: MeshBuildDiagnosticsView | null;
  render_only_controls_do_not_change_solver_domain: boolean;
}

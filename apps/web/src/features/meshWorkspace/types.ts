import type { MeshConfigRecord } from "../../api/types";
import type {
  CapabilityGateMap,
  DomainRevisionState,
  MeshDirtyState,
  SharedSurfaceStatus,
} from "../workspaceSync/contracts";

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
  raw_mesh_statistics: Record<string, unknown> | null;
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

export type MeshViewMode =
  | "realized-domain"
  | "topology"
  | "quality"
  | "parts"
  | "object-overrides"
  | "build-history";

export type MeshRenderMode = "solid" | "wireframe" | "solid+wireframe" | "points";

export interface MeshWorkspaceToolbarState {
  viewMode: MeshViewMode;
  showObjects: boolean;
  showMesh: boolean;
  showQuality: boolean;
  showLabels: boolean;
  showBoundaries: boolean;
  colorBy: "object" | "material" | "part" | "quality" | "none";
  renderMode: MeshRenderMode;
  opacity: number;
  clipEnabled: boolean;
  clipAxis: "x" | "y" | "z";
  clipPosition: number;
}

export interface MeshWorkspaceCapabilities {
  meshing: boolean;
  structured_grid: boolean;
  explicit_topology: boolean;
  shared_domain_mesh: boolean;
  object_mesh_overrides: boolean;
  mesh_build_history: boolean;
  mesh_quality_metrics: boolean;
  part_manifest: boolean;
  clip_mesh: boolean;
}

export type MeshWorkspaceCapabilityGateMap = {
  [K in keyof MeshWorkspaceCapabilities]: {
    enabled: boolean;
    reason: string | null;
  };
};

export type MeshBuildState =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MeshBuildProjection {
  id: string;
  state: MeshBuildState;
  requestedAtUnixMs: number;
  startedAtUnixMs: number | null;
  finishedAtUnixMs: number | null;
  trigger: "manual" | "auto" | "sync";
  summary: string | null;
  raw: Record<string, unknown> | null;
}

export interface MeshWorkspaceDiagnostics {
  status: SharedSurfaceStatus;
  messages: string[];
  lastBuildError: string | null;
  gates: CapabilityGateMap | null;
}

export interface MeshWorkspaceModel {
  sceneRevision: number | null;
  revisions: DomainRevisionState;
  meshSummary: Record<string, unknown> | null;
  activeBuild: MeshBuildProjection | null;
  buildHistory: MeshBuildProjection[];
  lastSuccess: MeshBuildProjection | null;
  universeConfig: UniverseMeshConfigView | null;
  sharedDomainConfig: MeshConfigRecord | null;
  sharedDomainManifest: {
    meshName: string;
    meshId: string;
    generationId: string | null;
    domainMeshMode: string | null;
    objectSegmentCount: number;
    meshPartCount: number;
  } | null;
  objectConfigs: Record<string, ObjectMeshConfigView>;
  semantics: MeshWorkspaceSemanticsView | null;
  dirty: MeshDirtyState;
  toolbar: MeshWorkspaceToolbarState;
  capabilities: MeshWorkspaceCapabilities;
  capabilityGates: MeshWorkspaceCapabilityGateMap;
  diagnostics: MeshWorkspaceDiagnostics;
}

export const DEFAULT_MESH_WORKSPACE_TOOLBAR_STATE: MeshWorkspaceToolbarState = {
  viewMode: "realized-domain",
  showObjects: true,
  showMesh: true,
  showQuality: false,
  showLabels: false,
  showBoundaries: false,
  colorBy: "object",
  renderMode: "solid+wireframe",
  opacity: 85,
  clipEnabled: false,
  clipAxis: "z",
  clipPosition: 50,
};

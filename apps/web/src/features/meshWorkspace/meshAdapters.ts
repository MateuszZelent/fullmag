import type {
  CapabilityMap,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshBuildDiagnosticsResource,
  MeshCapabilitiesResource,
  MeshConfigRecord,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigEntry,
  MeshSharedDomainManifestResource,
  MeshSemanticsResource,
  MeshSolverMeshResource,
  MeshSummaryResource,
  ResourceRevisionMap,
} from "../../api/types";
import {
  capabilityGateMap,
  domainRevisionStateFromResources,
  sharedCapabilitiesFromApi,
  type MeshDirtyReason,
  type MeshDirtyState,
} from "../workspaceSync/contracts";
import type {
  MeshBuildDiagnosticsView,
  MeshBuildProjection,
  MeshBuildState,
  MeshWorkspaceCapabilities,
  MeshWorkspaceCapabilityGateMap,
  MeshWorkspaceModel,
  MeshWorkspaceSemanticsView,
  ObjectMeshConfigView,
  SolverMeshView,
  UniverseMeshConfigView,
} from "./types";
import { DEFAULT_MESH_WORKSPACE_TOOLBAR_STATE } from "./types";

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
    airbox_hmax: numericOrNull(raw.maximum_element_size ?? raw.airbox_hmax),
    raw: config,
  };
}

function adaptObjectConfig(entry: MeshObjectConfigEntry): ObjectMeshConfigView {
  const raw = (entry.config ?? null) as Record<string, unknown> | null;
  return {
    object_id: entry.object_id,
    object_name: entry.object_name,
    mode: raw && typeof raw.mode === "string" ? raw.mode : null,
    hmax: raw ? numericOrNull(raw.maximum_element_size ?? raw.hmax) : null,
    hmin: raw ? numericOrNull(raw.minimum_element_size ?? raw.hmin) : null,
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
  const rawMeshStatistics = (diagnostics.mesh_statistics ?? null) as
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
    raw_mesh_statistics: rawMeshStatistics,
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

export interface MeshDirtyInput {
  sceneRevision?: number | null;
  meshRevision?: number | null;
  universeConfigRevision?: number | null;
  sharedDomainConfigRevision?: number | null;
  objectConfigRevision?: number | null;
  backendMeshPolicyRevision?: number | null;
  lastSuccessfulBuild?: MeshBuildProjection | null;
  hasUniverseConfig?: boolean;
  hasSharedDomainConfig?: boolean;
}

export function buildMeshDirtyState(input: MeshDirtyInput): MeshDirtyState {
  const reasons: MeshDirtyReason[] = [];
  const buildRevision = revisionFromBuild(input.lastSuccessfulBuild);
  const compareRevision = buildRevision ?? input.meshRevision ?? null;

  if (input.sceneRevision != null && compareRevision != null && input.sceneRevision > compareRevision) {
    reasons.push("scene_changed");
  }
  if (
    input.universeConfigRevision != null &&
    compareRevision != null &&
    input.universeConfigRevision > compareRevision
  ) {
    reasons.push("universe_changed");
  }
  if (
    input.sharedDomainConfigRevision != null &&
    compareRevision != null &&
    input.sharedDomainConfigRevision > compareRevision
  ) {
    reasons.push("shared_domain_changed");
  }
  if (
    input.objectConfigRevision != null &&
    compareRevision != null &&
    input.objectConfigRevision > compareRevision
  ) {
    reasons.push("object_override_changed");
  }
  if (
    input.backendMeshPolicyRevision != null &&
    compareRevision != null &&
    input.backendMeshPolicyRevision > compareRevision
  ) {
    reasons.push("backend_mesh_policy_changed");
  }

  const uniqueReasons = [...new Set(reasons)];
  const missingUniverse = input.hasUniverseConfig === false;
  const missingSharedDomain = input.hasSharedDomainConfig === false;
  const isDirty = uniqueReasons.length > 0 || (!input.lastSuccessfulBuild && input.meshRevision == null);
  return {
    isDirty,
    reasons: uniqueReasons,
    sinceSceneRevision: uniqueReasons.includes("scene_changed") ? input.sceneRevision ?? null : null,
    lastSuccessfulBuildId: input.lastSuccessfulBuild?.id ?? null,
    recommendedAction: missingUniverse
      ? "blocked_by_missing_universe"
      : missingSharedDomain
        ? "blocked_by_invalid_shared_domain"
        : !input.lastSuccessfulBuild
          ? "build_required"
          : isDirty
            ? "rebuild_recommended"
            : "no_action",
  };
}

export function meshWorkspaceCapabilitiesFromResources(args: {
  liveCapabilities?: CapabilityMap | null;
  meshCapabilities?: MeshCapabilitiesResource | null;
  manifest?: MeshSharedDomainManifestResource | null;
  semantics?: MeshWorkspaceSemanticsView | null;
}): MeshWorkspaceCapabilities {
  const raw = (args.meshCapabilities?.mesh_capabilities ?? {}) as Record<string, unknown>;
  const shared = sharedCapabilitiesFromApi(args.liveCapabilities, {
    meshing: boolish(raw.meshing) ?? true,
    mesh_quality_metrics: boolish(raw.mesh_quality_metrics),
    part_manifest: boolish(raw.part_manifest),
  });
  return {
    meshing: shared.meshing,
    structured_grid: shared.structured_grid,
    explicit_topology: shared.explicit_topology,
    shared_domain_mesh: shared.explicit_topology || Boolean(args.manifest),
    object_mesh_overrides: true,
    mesh_build_history: true,
    mesh_quality_metrics: shared.mesh_quality_metrics,
    part_manifest: shared.part_manifest || Boolean(args.manifest?.mesh_parts.length),
    clip_mesh: shared.explicit_topology || shared.structured_grid,
  };
}

export function meshCapabilityGates(
  capabilities: MeshWorkspaceCapabilities,
): MeshWorkspaceCapabilityGateMap {
  const reasons: Record<keyof MeshWorkspaceCapabilities, string> = {
    meshing: "Requires meshing capability",
    structured_grid: "Requires structured_grid capability",
    explicit_topology: "Requires explicit_topology capability",
    shared_domain_mesh: "Requires shared_domain_mesh capability",
    object_mesh_overrides: "Requires object_mesh_overrides capability",
    mesh_build_history: "Requires mesh_build_history capability",
    mesh_quality_metrics: "Requires mesh_quality_metrics capability",
    part_manifest: "Requires part_manifest capability",
    clip_mesh: "Requires clip_mesh capability",
  };
  return Object.fromEntries(
    (Object.keys(capabilities) as Array<keyof MeshWorkspaceCapabilities>).map((key) => [
      key,
      { enabled: capabilities[key], reason: capabilities[key] ? null : reasons[key] },
    ]),
  ) as MeshWorkspaceCapabilityGateMap;
}

export function meshBuildProjectionFromRecord(
  value: unknown,
  fallbackId: string,
): MeshBuildProjection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = stringValue(record.build_id) ?? stringValue(record.id) ?? fallbackId;
  return {
    id,
    state: normalizeBuildState(stringValue(record.status) ?? stringValue(record.state)),
    requestedAtUnixMs: numericValue(record.requested_at_unix_ms) ?? numericValue(record.created_at_unix_ms) ?? 0,
    startedAtUnixMs: numericValue(record.started_at_unix_ms),
    finishedAtUnixMs: numericValue(record.finished_at_unix_ms),
    trigger: normalizeTrigger(stringValue(record.trigger)),
    summary: stringValue(record.summary) ?? stringValue(record.message),
    raw: record,
  };
}

export interface MeshWorkspaceModelInput {
  resources?: Partial<ResourceRevisionMap> | null;
  liveCapabilities?: CapabilityMap | null;
  summary?: MeshSummaryResource | null;
  meshCapabilities?: MeshCapabilitiesResource | null;
  semantics?: MeshSemanticsResource | null;
  activeBuild?: MeshActiveBuildResource | null;
  buildHistory?: MeshBuildHistoryResource | null;
  lastSuccessfulBuild?: MeshLastSuccessfulBuildResource | null;
  manifest?: MeshSharedDomainManifestResource | null;
}

export function buildMeshWorkspaceModel({
  resources,
  liveCapabilities,
  summary,
  meshCapabilities,
  semantics,
  activeBuild,
  buildHistory,
  lastSuccessfulBuild,
  manifest,
}: MeshWorkspaceModelInput): MeshWorkspaceModel {
  const revisions = domainRevisionStateFromResources(resources);
  const semanticsView = meshSemanticsResourceToView(semantics);
  const history = (buildHistory?.history ?? [])
    .map((entry, index) => meshBuildProjectionFromRecord(entry, `history-${index}`))
    .filter((entry): entry is MeshBuildProjection => entry != null);
  const active = meshBuildProjectionFromRecord(activeBuild?.active_build, "active-build");
  const lastSuccess = meshBuildProjectionFromRecord(
    lastSuccessfulBuild?.last_success,
    "last-success",
  );
  const capabilities = meshWorkspaceCapabilitiesFromResources({
    liveCapabilities,
    meshCapabilities,
    manifest,
    semantics: semanticsView,
  });
  const gates = meshCapabilityGates(capabilities);
  const dirty = buildMeshDirtyState({
    sceneRevision: revisions.sceneRevision,
    meshRevision: revisions.meshRevision,
    universeConfigRevision: semantics?.revision ?? null,
    sharedDomainConfigRevision: semantics?.revision ?? null,
    objectConfigRevision: semantics?.revision ?? null,
    lastSuccessfulBuild: lastSuccess,
    hasUniverseConfig: semanticsView?.universe != null,
    hasSharedDomainConfig: semanticsView?.shared_domain_config != null,
  });
  const sharedGates = capabilityGateMap(sharedCapabilitiesFromApi(liveCapabilities));
  const diagnosticsMessages = [
    ...(dirty.isDirty ? ["Mesh out of date"] : []),
    ...(active ? ["Active build running"] : []),
    ...(lastSuccess ? ["Last successful build available"] : ["No successful build yet"]),
    ...(activeBuild?.last_build_error ? [activeBuild.last_build_error] : []),
    ...(lastSuccessfulBuild?.last_build_error ? [lastSuccessfulBuild.last_build_error] : []),
  ];

  return {
    sceneRevision: revisions.sceneRevision,
    revisions,
    meshSummary: summary?.mesh_summary ?? null,
    activeBuild: active,
    buildHistory: history,
    lastSuccess,
    universeConfig: semanticsView?.universe ?? null,
    sharedDomainConfig: semanticsView?.shared_domain_config ?? null,
    sharedDomainManifest: manifest
      ? {
          meshName: manifest.mesh_name,
          meshId: manifest.mesh_id,
          generationId: manifest.generation_id ?? null,
          domainMeshMode: manifest.domain_mesh_mode ?? null,
          objectSegmentCount: manifest.object_segments.length,
          meshPartCount: manifest.mesh_parts.length,
        }
      : null,
    objectConfigs: Object.fromEntries(
      (semanticsView?.objects ?? []).map((object) => [object.object_id, object]),
    ),
    semantics: semanticsView,
    dirty,
    toolbar: DEFAULT_MESH_WORKSPACE_TOOLBAR_STATE,
    capabilities,
    capabilityGates: gates,
    diagnostics: {
      status: active ? "building" : dirty.isDirty ? "stale" : summary ? "ready" : "idle",
      messages: diagnosticsMessages,
      lastBuildError: activeBuild?.last_build_error ?? lastSuccessfulBuild?.last_build_error ?? null,
      gates: sharedGates,
    },
  };
}

function revisionFromBuild(build: MeshBuildProjection | null | undefined): number | null {
  if (!build?.raw) {
    return null;
  }
  return (
    numericValue(build.raw.mesh_revision) ??
    numericValue(build.raw.revision) ??
    numericValue(build.raw.scene_revision)
  );
}

function boolish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numericValue(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBuildState(value: string | null): MeshBuildState {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return value;
    case "success":
    case "completed":
      return "succeeded";
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

function normalizeTrigger(value: string | null): MeshBuildProjection["trigger"] {
  if (value === "auto" || value === "sync") {
    return value;
  }
  return "manual";
}

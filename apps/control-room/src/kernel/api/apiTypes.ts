import type { components } from "./generated/openapi-v2-types";

export type ResourceRevision = string | number;
type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ObjectInteractionKind =
  | "exchange"
  | "demag"
  | "interfacial_dmi"
  | "uniaxial_anisotropy";

interface BaseAuthoringTransaction {
  base_revision?: number | null;
}

export type CommandDetailResource = components["schemas"]["CommandDetailResource"];
export type CommandQueueStatusResource =
  components["schemas"]["CommandQueueStatusResource"];
export type CommandResponse = components["schemas"]["CommandResponse"];
export type CheckpointCreateRequest =
  components["schemas"]["CheckpointCreateRequest"];
export type CheckpointCreateResponse =
  components["schemas"]["CheckpointCreateResponse"];
export type CheckpointEntry = components["schemas"]["CheckpointEntry"];
export type CheckpointListResource =
  components["schemas"]["CheckpointListResponse"];
export type CheckpointRestoreRequest =
  components["schemas"]["CheckpointRestoreRequest"];
export type CheckpointRestoreResponse =
  components["schemas"]["CheckpointRestoreResponse"];
export type CurrentRunResource = components["schemas"]["CurrentRunResource"];
export type DomainMetaResource = components["schemas"]["DomainMeta"];
export type EngineLogResource = components["schemas"]["EngineLogResource"];
export type FieldCatalogResource = components["schemas"]["FieldCatalog"];
export type FieldVectorQuery = components["schemas"]["FieldVectorQuery"];
export type CrossSectionPlane = "xy" | "xz" | "yz";
export type CrossSectionQualityMetric =
  components["schemas"]["CrossSectionQualityMetric"];
type CrossSectionImageColorScale =
  components["schemas"]["CrossSectionImageColorScale"];
export type SliceMeshColorScale = components["schemas"]["SliceMeshColorScale"];
export interface CrossSectionQuery {
  includePolygons?: boolean;
  includeWireframe?: boolean;
  plane: CrossSectionPlane;
  positionPercent: number;
}
export interface CrossSectionImageQuery {
  colorScale?: CrossSectionImageColorScale;
  filterExpression?: string | null;
  legend?: boolean;
  metric: CrossSectionQualityMetric;
  plane: CrossSectionPlane;
  positionPercent: number;
  resolution?: 512 | 1024 | 2048;
  rotationDegrees?: number;
  shrinkFactor?: number;
  wireframe?: boolean;
}
export interface CrossSectionQualityQuery {
  metric: CrossSectionQualityMetric;
  plane: CrossSectionPlane;
  positionPercent: number;
}
export type GeometryCapabilitiesResource =
  components["schemas"]["GeometryCapabilitiesResource"];
export type GeometryDiagnosticsResource =
  components["schemas"]["GeometryDiagnosticsResource"];
export type GeometryRealizationRequest =
  components["schemas"]["GeometryRealizationRequest"];
export type GeometryRealizationResource =
  components["schemas"]["GeometryRealizationSnapshot"];
export type GeometryValidationResource =
  components["schemas"]["GeometryValidationResource"];
export type CpuTelemetryResource =
  components["schemas"]["CpuTelemetryResponse"];
export type GpuTelemetryResource =
  components["schemas"]["GpuTelemetryResponse"];
export type LiveStatusResource = components["schemas"]["LiveStatus"];
export type MagneticResponseSweepResource = JsonObject & {
  schema_version: string;
};
export type SolverProfileResource =
  components["schemas"]["SolverProfileResource"];
export type MaterialPatchRequest =
  components["schemas"]["MaterialPatchRequest"];
export type MaterialResource = components["schemas"]["MaterialResource"];
export type MagnetizationAssetPatchRequest =
  components["schemas"]["MagnetizationAssetPatchRequest"];
export type MagnetizationAssetResource =
  components["schemas"]["MagnetizationAssetResource"];
export type MeshActiveBuildResource =
  components["schemas"]["MeshActiveBuildResource"];
export type MeshBuildHistoryResource =
  components["schemas"]["MeshBuildHistoryResource"];
export type MeshCapabilitiesResource =
  components["schemas"]["MeshCapabilitiesResource"];
export type MeshHistogramBinElementsResource =
  components["schemas"]["MeshHistogramBinElementsResource"];
export type MeshHistogramBinMetric =
  | "characteristic_size"
  | "edge_length"
  | "gamma"
  | "sicn"
  | "volume";
export type MeshLastSuccessfulBuildResource =
  components["schemas"]["MeshLastSuccessfulBuildResource"];
export type MeshObjectQualityResource =
  components["schemas"]["MeshObjectQualityResource"];
export type MeshObjectReportResource =
  components["schemas"]["MeshObjectReportResource"];
export type MeshObjectSizeFieldResource =
  components["schemas"]["MeshObjectSizeFieldResource"];
export type MeshQualityGatesResource =
  components["schemas"]["MeshQualityGatesResource"];
export type MeshRealizedSizeFieldsResource =
  components["schemas"]["MeshRealizedSizeFieldsResource"];
export type MeshSemanticsResource =
  components["schemas"]["MeshSemanticsResource"];
export type MeshSharedDomainConfigResource =
  components["schemas"]["MeshSharedDomainConfigResource"];
export type MeshSharedDomainQualityResource =
  components["schemas"]["MeshSharedDomainQualityResource"];
export type MeshSharedDomainReportResource =
  components["schemas"]["MeshSharedDomainReportResource"];
export type MeshSummaryResource =
  components["schemas"]["MeshSummaryResource"];
export type MeshUniverseQualityResource =
  components["schemas"]["MeshUniverseQualityResource"];
export type MeshUniverseReportResource =
  components["schemas"]["MeshUniverseReportResource"];
export interface MeshObjectConfigReplaceRequest {
  config?: JsonObject | null;
}
export interface MeshObjectConfigResource {
  config?: JsonObject | null;
  object_id: string;
  revision: number;
}
export interface MeshUniverseConfigReplaceRequest {
  config?: JsonObject | null;
}
export interface MeshUniverseConfigResource {
  config?: JsonObject | null;
  revision: number;
}
export interface MeshSharedDomainConfigReplaceRequest {
  config: JsonObject;
}
export type MeshSharedDomainManifestResource =
  components["schemas"]["MeshSharedDomainManifestResource"];
export type RegionListResource = components["schemas"]["RegionListResource"];
export type RegionPatchRequest = components["schemas"]["RegionPatchRequest"];
export type SolverEnergyCurrentResource =
  components["schemas"]["SolverEnergyCurrentResource"];
export type SolverEnergyHistoryResource =
  components["schemas"]["SolverEnergyHistoryResource"];
export type SolverStatusResource = components["schemas"]["SolverStatusResource"];
export type StageExecutionResource =
  components["schemas"]["StageExecutionResource"];
export type StudyRuntimePatchRequest =
  components["schemas"]["StudyRuntimePatchRequest"];
export type StudyRuntimeResource =
  components["schemas"]["StudyRuntimeResource"];
export type AuthoringTransactionRequest =
  | { kind: "replace_scene"; scene: JsonObject }
  | { kind: "merge_patch"; merge_patch: JsonObject }
  | (BaseAuthoringTransaction & ObjectGeometryPatchRequest & {
      kind: "patch_object_geometry";
      object_id: string;
    })
  | (BaseAuthoringTransaction & ObjectCreateRequest & {
      kind: "create_object";
    })
  | (BaseAuthoringTransaction & {
      kind: "delete_object";
      object_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "rename_object";
      name: string;
      object_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "commit_object_transform";
      object_id: string;
      transform: JsonObject;
    })
  | (BaseAuthoringTransaction & {
      kind: "patch_universe";
      sync_study_universe_mesh?: boolean;
      universe: JsonObject;
    });
export interface AuthoringTransactionResponse {
  committed_scene: SceneResource;
  scene_revision: number;
  transaction_kind: string;
}
export interface ObjectCreateRequest extends BaseAuthoringTransaction {
  geometry: JsonObject;
  magnetization_asset?: JsonObject | null;
  magnetization_ref?: string | null;
  material_asset?: JsonObject | null;
  material_ref?: string | null;
  name: string;
  object_id: string;
  region_name?: string | null;
  study_universe_mesh?: JsonObject | null;
  transform?: JsonObject | null;
  universe?: JsonObject | null;
}
export interface ObjectGeometryPatchRequest extends BaseAuthoringTransaction {
  geometry: JsonObject;
  transform?: JsonObject | null;
}
export interface ObjectInteractionPatchRequest {
  enabled?: boolean | null;
  params?: JsonObject;
  present?: boolean | null;
}
export interface ObjectInteractionResource {
  enabled: boolean;
  interaction_kind: ObjectInteractionKind | string;
  object_id: string;
  params: JsonObject;
  present: boolean;
}
export interface ObjectPatchRequest extends BaseAuthoringTransaction {
  geometry?: JsonObject | null;
  magnetization_ref?: string | null;
  material_ref?: string | null;
  name?: string | null;
  notes?: string | null;
  region_name?: string | null;
  transform?: JsonObject | null;
  visible?: boolean | null;
}
export interface ObjectMetricsResource {
  energies: {
    anisotropy: number;
    demag: number;
    dmi: number;
    exchange: number;
    total: number;
    zeeman: number;
  };
  has_solver_sample: boolean;
  magnetization_average: {
    mx: number;
    my: number;
    mz: number;
  };
  object_id: string;
  revision: number;
  source: string;
  step: number;
  time_seconds: number;
}
export type SceneResource = components["schemas"]["SceneResource"];
export type RuntimeCommandPrecondition =
  components["schemas"]["RuntimeCommandPrecondition"];
export type RuntimeCommandTarget =
  components["schemas"]["RuntimeCommandTarget"];
export type ScalarWindowResource = components["schemas"]["ScalarWindow"];
export interface ScalarWindowQuery {
  columns?: string[];
  limit?: number;
  sinceRevision?: number;
}
export type SessionExportRequest =
  components["schemas"]["SessionExportRequest"];
export type ScriptSyncRequest = components["schemas"]["ScriptSyncRequest"];
export type ScriptSyncResponse = components["schemas"]["ScriptSyncResponse"];
export type SessionExportResponse =
  components["schemas"]["SessionExportResponse"];
export type SessionImportCommitRequest =
  components["schemas"]["SessionImportCommitRequest"];
export type SessionImportCommitResponse =
  components["schemas"]["SessionImportCommitResponse"];
export type SessionImportInspectRequest =
  components["schemas"]["SessionImportInspectRequest"];
export type SessionImportInspectResponse =
  components["schemas"]["SessionImportInspectResponse"];
type GeneratedStructuredCommandRequest =
  components["schemas"]["StructuredCommandRequest"];
type RuntimeCommandIntent = components["schemas"]["RuntimeCommandIntent"];
type MeshBuildCommandRequest = RuntimeCommandIntent & {
  kind: "mesh_build";
  mesh_options?: JsonObject | null;
  mesh_reason?: string | null;
  mesh_target?: components["schemas"]["MeshCommandTarget"] | null;
};
export type StructuredCommandRequest =
  | Exclude<GeneratedStructuredCommandRequest, { kind: "mesh_build" }>
  | MeshBuildCommandRequest;
export type UniversePatchRequest = components["schemas"]["UniversePatchRequest"];
export type UniverseResource = components["schemas"]["UniverseResource"];
export type VisualizationStatePatch =
  components["schemas"]["VisualizationStatePatch"];
export type VisualizationStateResource =
  components["schemas"]["VisualizationStateResource"];
export type VisualizationClientAckEntry =
  components["schemas"]["VisualizationClientAckEntry"];
export type VisualizationClientAckRequest =
  components["schemas"]["VisualizationClientAckRequest"];
export type VisualizationClientAckResource =
  components["schemas"]["VisualizationClientAckResource"];

export type BinaryResourceResult<TData> =
  | {
      byteLength: number;
      contentRange?: string | null;
      data: TData;
      etag: string | null;
      status: "ready";
    }
  | {
      etag: string | null;
      status: "not-applicable";
    }
  | {
      etag: string | null;
      status: "not-modified";
    };

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface BinaryRequestOptions extends RequestOptions {
  etag?: string | null;
  range?: string | null;
}

export function isOptionalObjectInteractionKind(
  kind: ObjectInteractionKind,
): boolean {
  return kind === "interfacial_dmi" || kind === "uniaxial_anisotropy";
}

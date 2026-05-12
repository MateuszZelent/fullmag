import type { components } from "./generated/openapi-v2-types";

export type ResourceRevision = string | number;
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const OBJECT_INTERACTION_KINDS = [
  "exchange",
  "demag",
  "interfacial_dmi",
  "uniaxial_anisotropy",
] as const;

export type ObjectInteractionKind = (typeof OBJECT_INTERACTION_KINDS)[number];

interface BaseAuthoringTransaction {
  base_revision?: number | null;
}

export type CommandDetailResource = components["schemas"]["CommandDetailResource"];
export type CommandQueueStatusResource =
  components["schemas"]["CommandQueueStatusResource"];
export type CommandResponse = components["schemas"]["CommandResponse"];
export type DomainMetaResource = components["schemas"]["DomainMeta"];
export type FieldVectorQuery = components["schemas"]["FieldVectorQuery"];
export type GeometryCapabilitiesResource = JsonValue;
export type GeometryDiagnosticsResource = JsonValue;
export type GeometryRealizationRequest =
  components["schemas"]["GeometryRealizationRequest"];
export type GeometryRealizationResource = JsonValue;
export type GeometryValidationResource = JsonValue;
export type LiveStatusResource = components["schemas"]["LiveStatus"];
export type MeshActiveBuildResource =
  components["schemas"]["MeshActiveBuildResource"];
export type MeshBuildHistoryResource =
  components["schemas"]["MeshBuildHistoryResource"];
export type MeshLastSuccessfulBuildResource =
  components["schemas"]["MeshLastSuccessfulBuildResource"];
export type MeshObjectQualityResource =
  components["schemas"]["MeshObjectQualityResource"];
export type MeshObjectReportResource =
  components["schemas"]["MeshObjectReportResource"];
export type MeshObjectSizeFieldResource =
  components["schemas"]["MeshObjectSizeFieldResource"];
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
export type MeshSharedDomainManifestResource =
  components["schemas"]["MeshSharedDomainManifestResource"];
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
  region_name?: string | null;
  transform?: JsonObject | null;
  visible?: boolean | null;
}
export type SceneResource = JsonObject;
export type StructuredCommandRequest =
  components["schemas"]["StructuredCommandRequest"];
export type UniversePatchRequest = components["schemas"]["UniversePatchRequest"];
export type UniverseResource = components["schemas"]["UniverseResource"];
export type VisualizationStatePatch =
  components["schemas"]["VisualizationStatePatch"];
export type VisualizationStateResource =
  components["schemas"]["VisualizationStateResource"];

export type BinaryResourceResult<TData> =
  | {
      byteLength: number;
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
}

export function isOptionalObjectInteractionKind(
  kind: ObjectInteractionKind,
): boolean {
  return kind === "interfacial_dmi" || kind === "uniaxial_anisotropy";
}

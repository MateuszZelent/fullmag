import type { components } from "./generated/openapi-v2-types";

export type ResourceRevision = string | number;

export type CommandDetailResource = components["schemas"]["CommandDetailResource"];
export type CommandQueueStatusResource =
  components["schemas"]["CommandQueueStatusResource"];
export type CommandResponse = components["schemas"]["CommandResponse"];
export type DomainMetaResource = components["schemas"]["DomainMeta"];
export type FieldVectorQuery = components["schemas"]["FieldVectorQuery"];
export type LiveStatusResource = components["schemas"]["LiveStatus"];
export type MeshSharedDomainManifestResource =
  components["schemas"]["MeshSharedDomainManifestResource"];
export type SceneResource = unknown;
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

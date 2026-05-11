import type { components } from "./generated/openapi-v2-types";

export type ResourceRevision = string | number;

export type CommandDetailResource = components["schemas"]["CommandDetailResource"];
export type CommandQueueStatusResource =
  components["schemas"]["CommandQueueStatusResource"];
export type CommandResponse = components["schemas"]["CommandResponse"];
export type LiveStatusResource = components["schemas"]["LiveStatus"];
export type StructuredCommandRequest =
  components["schemas"]["StructuredCommandRequest"];

export interface RequestOptions {
  signal?: AbortSignal;
}

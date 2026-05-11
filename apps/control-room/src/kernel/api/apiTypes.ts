export type ResourceRevision = string | number;

export interface LiveStatusResource {
  api_contract_version: string;
  capabilities?: Record<string, unknown>;
  display?: Record<string, unknown>;
  domain?: Record<string, unknown>;
  energies?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  resources: Record<string, ResourceRevision>;
  run?: Record<string, unknown> | null;
  runtime_bundle_version: string;
  session: Record<string, unknown>;
  solver?: Record<string, unknown>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export interface QuantityCatalogEntry {
  id: string;
  label: string;
  description: string;
  shape: string;
  unit: string;
  location: string;
  domain: string;
  n_comp: number;
  normalization_hint: string;
  interactive_preview: boolean;
  supports_preview_2d: boolean;
  supports_preview_3d: boolean;
  supports_history: boolean;
  supports_export: boolean;
  quick_access_label?: string | null;
  scalar_metric_key?: string | null;
}

export interface QuantityCatalogResponse {
  schema_version: string;
  quantities: QuantityCatalogEntry[];
}

export class QuantitiesModule {
  constructor(private client: LiveApiClient) {}

  async getCatalog(opts?: RequestOptions): Promise<QuantityCatalogResponse> {
    return this.client.get<QuantityCatalogResponse>("/v1/live/current/quantities/catalog", opts);
  }
}

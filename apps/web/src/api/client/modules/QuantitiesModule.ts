import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

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
  constructor(private client: LiveSessionClient) {}

  async getCatalog(opts?: RequestOptions): Promise<QuantityCatalogResponse> {
    return this.client.get<QuantityCatalogResponse>(sessionApiPaths.data.quantities, opts);
  }
}

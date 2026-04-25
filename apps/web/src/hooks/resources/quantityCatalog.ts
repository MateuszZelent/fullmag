import { getLiveApiClient } from "../../api/client/LiveApiClient";
import type { QuantityCatalogResponse } from "../../api/client/modules/QuantitiesModule";

export function fetchRuntimeQuantityCatalog(): Promise<QuantityCatalogResponse> {
  return getLiveApiClient().quantities.getCatalog();
}

import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import type { QuantityCatalogResponse } from "../../api/client/modules/QuantitiesModule";

export function fetchRuntimeQuantityCatalog(): Promise<QuantityCatalogResponse> {
  return getLiveSessionClient().quantities.getCatalog();
}

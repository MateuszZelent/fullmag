import { getDiagnostics, clearDiagnostics } from "../../api/client/interceptors/diagnostics";
import { getLiveApiClient } from "../../api/client/LiveApiClient";

export function readDiagnosticEntries() {
  return getDiagnostics();
}

export function clearDiagnosticEntries() {
  clearDiagnostics();
}

export function readCacheStats() {
  return getLiveApiClient().getCache().getCacheStats();
}

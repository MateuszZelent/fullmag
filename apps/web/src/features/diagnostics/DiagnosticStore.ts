import { getDiagnostics, clearDiagnostics } from "../../api/client/interceptors/diagnostics";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";

export function readDiagnosticEntries() {
  return getDiagnostics();
}

export function clearDiagnosticEntries() {
  clearDiagnostics();
}

export function readCacheStats() {
  return getLiveSessionClient().getCache().getCacheStats();
}

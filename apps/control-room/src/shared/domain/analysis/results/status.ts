import type { AnalysisResultStatusFacets } from "./types";

export type AnalysisResultUiStatus =
  | "ready"
  | "partial"
  | "unsupported"
  | "missing"
  | "error";

export function analysisResultUiStatus(
  status: AnalysisResultStatusFacets | null | undefined,
): AnalysisResultUiStatus {
  if (!status) return "missing";
  const tokens = [status.resource, status.completeness, status.qualification]
    .map((value) => value.toLowerCase());
  if (tokens.some((value) => ["corrupt", "error", "failed"].includes(value))) {
    return "error";
  }
  if (tokens.some((value) => ["unsupported", "unavailable"].includes(value))) {
    return "unsupported";
  }
  if (tokens.some((value) => ["partial", "incomplete", "stale", "legacy"].includes(value))) {
    return "partial";
  }
  return "ready";
}

export function analysisResultStatusLabel(
  status: AnalysisResultStatusFacets | null | undefined,
): string {
  if (!status) return "missing";
  if (status.reason_code) return `${status.completeness}: ${status.reason_code}`;
  return status.completeness;
}

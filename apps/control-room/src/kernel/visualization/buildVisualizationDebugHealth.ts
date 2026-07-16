import type {
  VisualizationDebugDisposition,
  VisualizationDebugEvidenceSource,
  VisualizationDebugIssue,
} from "./visualizationDebugTypes";

export interface VisualizationDebugHealthEvidence {
  adoptedSourceMatches: boolean | null;
  backendRenderRangeMatches: boolean | null;
  domainGenerationMatches: boolean | null;
  evidenceComplete: boolean;
  fieldBufferPresent: boolean | null;
  fieldRequestOk: boolean | null;
  fieldRevisionCurrent: boolean | null;
  frameCommitted: boolean | null;
  nodeIndexCountMatches: boolean | null;
  quantityMatches: boolean | null;
  rangeNotOutlierDominated: boolean | null;
  responseMetadataMatches: boolean | null;
  scopeIdMatches: boolean | null;
  scopeKindMatches: boolean | null;
  surfacePassPresent: boolean | null;
  targetActive: boolean | null;
  topologyHashMatches: boolean | null;
  transportCacheBytesMatch: boolean | null;
  valueCountMatches: boolean | null;
  valueStatisticsSource: VisualizationDebugEvidenceSource | null;
  valuesAllZero: boolean | null;
  valuesFinite: boolean | null;
  vectorPassPresent: boolean | null;
}

export interface VisualizationDebugHealthResult {
  disposition: VisualizationDebugDisposition;
  issues: readonly VisualizationDebugIssue[];
}

type HealthRule = readonly [
  keyof VisualizationDebugHealthEvidence,
  string,
  VisualizationDebugIssue["severity"],
  VisualizationDebugIssue["source"],
  string,
];

const RULES: readonly HealthRule[] = [
  ["targetActive", "target-not-active", "warning", "ui-derived", "Target is not active in the current render model."],
  ["fieldRequestOk", "field-request-error", "error", "transport", "The matched field request failed."],
  ["fieldBufferPresent", "field-buffer-missing", "error", "render-derived", "The render plan requires a field buffer, but none is available."],
  ["quantityMatches", "quantity-mismatch", "error", "decoded-payload", "Requested and decoded quantities differ."],
  ["responseMetadataMatches", "response-metadata-mismatch", "error", "transport", "Response metadata contradicts the decoded payload."],
  ["scopeKindMatches", "scope-kind-mismatch", "error", "decoded-payload", "Planned and decoded scope kinds differ."],
  ["scopeIdMatches", "scope-id-mismatch", "error", "decoded-payload", "Planned and decoded scope identifiers differ."],
  ["valueCountMatches", "value-count-mismatch", "error", "decoded-payload", "pointCount multiplied by nComp differs from valueCount."],
  ["nodeIndexCountMatches", "node-index-count-mismatch", "error", "decoded-payload", "Explicit or sampled node index count differs from point count."],
  ["domainGenerationMatches", "domain-generation-mismatch", "error", "decoded-payload", "Field and current domain generation identifiers differ."],
  ["topologyHashMatches", "topology-hash-mismatch", "error", "decoded-payload", "Field and topology hashes differ."],
  ["fieldRevisionCurrent", "field-revision-stale", "warning", "render-derived", "A retained output uses an older field revision."],
  ["frameCommitted", "frame-not-committed", "warning", "render-derived", "The candidate model has no committed frame receipt."],
  ["adoptedSourceMatches", "adopted-source-mismatch", "warning", "render-derived", "The adopted layer source differs from the candidate source."],
  ["valuesFinite", "non-finite-values", "warning", "decoded-payload", "Payload or render statistics contain non-finite values."],
  ["rangeNotOutlierDominated", "range-outlier-dominated", "warning", "render-derived", "Rendered range is dominated by outliers."],
  ["surfacePassPresent", "surface-pass-missing", "warning", "render-derived", "Surface rendering is requested but scalar colors are unavailable."],
  ["vectorPassPresent", "vector-pass-missing", "warning", "render-derived", "Vector rendering is requested but segments are unavailable."],
  ["backendRenderRangeMatches", "backend-render-range-mismatch", "warning", "render-derived", "Comparable backend and rendered ranges differ beyond tolerance."],
  ["transportCacheBytesMatch", "transport-cache-byte-mismatch", "info", "cache", "Known wire and cache byte counts differ."],
];

export function buildVisualizationDebugHealth(
  evidence: VisualizationDebugHealthEvidence,
): VisualizationDebugHealthResult {
  const issues: VisualizationDebugIssue[] = [];
  for (const [field, code, severity, source, message] of RULES) {
    if (evidence[field] !== false) continue;
    issues.push(Object.freeze({
      code,
      evidence: Object.freeze([field]),
      message,
      severity,
      source:
        field === "valuesFinite"
          ? evidence.valueStatisticsSource ?? source
          : source,
    }));
  }
  if (evidence.valuesAllZero === true) {
    issues.push(Object.freeze({
      code: "all-zero-values",
      evidence: Object.freeze(["valuesAllZero"]),
      message: "All comparable values are zero.",
      severity: "info",
      source: evidence.valueStatisticsSource ?? "decoded-payload",
    }));
  }
  const frozenIssues = Object.freeze(issues);
  const disposition: VisualizationDebugDisposition = frozenIssues.some((issue) => issue.severity === "error")
    ? "blocked"
    : frozenIssues.some((issue) => issue.severity === "warning" && issue.code !== "target-not-active" && issue.code !== "frame-not-committed")
      ? "degraded"
      : !evidence.evidenceComplete || evidence.targetActive === false || evidence.frameCommitted === false
        ? "unknown"
        : "ready";
  return Object.freeze({ disposition, issues: frozenIssues });
}

export function visualizationDebugRangesEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(left), Math.abs(right), 1));
}

export function prioritizeAndBoundVisualizationDebugIssues(
  input: readonly VisualizationDebugIssue[],
  limit: number,
): readonly VisualizationDebugIssue[] {
  const seen = new Set<string>();
  const unique = input.flatMap((entry, index) => {
    const key = JSON.stringify([
      entry.code,
      entry.severity,
      entry.source,
      entry.message,
      entry.evidence,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ entry, index }];
  });
  unique.sort(
    (left, right) =>
      visualizationDebugIssuePriority(left.entry) -
        visualizationDebugIssuePriority(right.entry) ||
      left.index - right.index,
  );
  return Object.freeze(
    unique
      .slice(0, Math.max(0, Math.trunc(limit)))
      .map(({ entry }) => entry),
  );
}

function visualizationDebugIssuePriority(
  issue: VisualizationDebugIssue,
): number {
  if (issue.severity === "error") return 0;
  if (
    issue.severity === "warning" &&
    issue.code !== "target-not-active" &&
    issue.code !== "frame-not-committed"
  ) {
    return 1;
  }
  return issue.severity === "warning" ? 2 : 3;
}

import { describe, expect, it } from "vitest";

import {
  buildVisualizationDebugHealth,
  visualizationDebugRangesEqual,
  type VisualizationDebugHealthEvidence,
} from "./buildVisualizationDebugHealth";

const CODE_CASES: readonly [keyof VisualizationDebugHealthEvidence, string, string][] = [
  ["targetActive", "target-not-active", "warning"],
  ["fieldRequestOk", "field-request-error", "error"],
  ["fieldBufferPresent", "field-buffer-missing", "error"],
  ["quantityMatches", "quantity-mismatch", "error"],
  ["responseMetadataMatches", "response-metadata-mismatch", "error"],
  ["scopeKindMatches", "scope-kind-mismatch", "error"],
  ["scopeIdMatches", "scope-id-mismatch", "error"],
  ["valueCountMatches", "value-count-mismatch", "error"],
  ["nodeIndexCountMatches", "node-index-count-mismatch", "error"],
  ["domainGenerationMatches", "domain-generation-mismatch", "error"],
  ["topologyHashMatches", "topology-hash-mismatch", "error"],
  ["fieldRevisionCurrent", "field-revision-stale", "warning"],
  ["frameCommitted", "frame-not-committed", "warning"],
  ["adoptedSourceMatches", "adopted-source-mismatch", "warning"],
  ["valuesFinite", "non-finite-values", "warning"],
  ["rangeNotOutlierDominated", "range-outlier-dominated", "warning"],
  ["surfacePassPresent", "surface-pass-missing", "warning"],
  ["vectorPassPresent", "vector-pass-missing", "warning"],
  ["backendRenderRangeMatches", "backend-render-range-mismatch", "warning"],
  ["transportCacheBytesMatch", "transport-cache-byte-mismatch", "info"],
];

function healthy(): VisualizationDebugHealthEvidence {
  return {
    adoptedSourceMatches: true,
    backendRenderRangeMatches: true,
    domainGenerationMatches: true,
    evidenceComplete: true,
    fieldBufferPresent: true,
    fieldRequestOk: true,
    fieldRevisionCurrent: true,
    frameCommitted: true,
    nodeIndexCountMatches: true,
    quantityMatches: true,
    rangeNotOutlierDominated: true,
    responseMetadataMatches: true,
    scopeIdMatches: true,
    scopeKindMatches: true,
    surfacePassPresent: true,
    targetActive: true,
    topologyHashMatches: true,
    transportCacheBytesMatch: true,
    valueCountMatches: true,
    valuesAllZero: false,
    valuesFinite: true,
    vectorPassPresent: true,
  };
}

describe("buildVisualizationDebugHealth", () => {
  it.each(CODE_CASES)("emits %s evidence as %s", (field, code, severity) => {
    const result = buildVisualizationDebugHealth({ ...healthy(), [field]: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ code, severity }));
  });

  it("reports all-zero as info without degrading an otherwise healthy snapshot", () => {
    const result = buildVisualizationDebugHealth({ ...healthy(), valuesAllZero: true });
    expect(result.disposition).toBe("ready");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "all-zero-values", severity: "info" }));
  });

  it("prioritizes blocked, then degraded, then unknown, then ready", () => {
    expect(buildVisualizationDebugHealth({ ...healthy(), fieldBufferPresent: false }).disposition).toBe("blocked");
    expect(buildVisualizationDebugHealth({ ...healthy(), valuesFinite: false }).disposition).toBe("degraded");
    expect(buildVisualizationDebugHealth({ ...healthy(), evidenceComplete: false }).disposition).toBe("unknown");
    expect(buildVisualizationDebugHealth(healthy()).disposition).toBe("ready");
  });

  it("uses the shared absolute and relative range tolerance", () => {
    expect(visualizationDebugRangesEqual(1, 1 + 1e-10)).toBe(true);
    expect(visualizationDebugRangesEqual(0, 1e-12)).toBe(true);
    expect(visualizationDebugRangesEqual(1, 1 + 2e-9)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { analysisNodeKindFor, LEGACY_RESULTS_NODE_KIND_ALIASES } from "./analysisNodeKindAliases";
import { ANALYSIS_FEATURE_MANIFESTS } from "./analysisModuleManifests";

describe("legacy Results node kind aliases", () => {
  it("point only at templates declared by a registered module", () => {
    const declared = new Set(
      ANALYSIS_FEATURE_MANIFESTS.flatMap((manifest) => manifest.nodeTemplates.map((template) => template.kind)),
    );
    for (const target of Object.values(LEGACY_RESULTS_NODE_KIND_ALIASES)) {
      expect(declared.has(target)).toBe(true);
    }
  });

  it("pass analysis kinds through and reject unknown kinds", () => {
    expect(analysisNodeKindFor("analysis.dispersion.relation")).toBe("analysis.dispersion.relation");
    expect(analysisNodeKindFor("results.dispersion.modal.relation")).toBe("analysis.dispersion.relation");
    expect(analysisNodeKindFor("object.visualization")).toBeNull();
  });
});

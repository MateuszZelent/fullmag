import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { AnalysisResultDatasetCapabilities } from "@/kernel/api/apiTypes";

import { matchDataset, templateAvailability } from "./analysisDatasetMatching";
import type { MatchableDataset } from "./analysisModuleContract";
import {
  ANALYSIS_FEATURE_MANIFESTS,
  DISPERSION_ANALYSIS_MANIFEST,
  HYSTERESIS_ANALYSIS_MANIFEST,
  RESONANCE_ANALYSIS_MANIFEST,
  TIME_DOMAIN_ANALYSIS_MANIFEST,
} from "./analysisModuleManifests";

const capabilities: AnalysisResultDatasetCapabilities = {
  branch_tracking: false,
  comparison: true,
  export: true,
  fields: true,
  item_paging: true,
  live_partial_results: false,
  result_meshes: false,
  sample_paging: true,
  server_filtering: false,
  server_sorting: false,
};

function dataset(overrides: Partial<MatchableDataset>): MatchableDataset {
  return {
    dataset_id: "dataset",
    product_kind: "modal_eigen",
    item_kinds: ["eigen_mode"],
    axes: [],
    capabilities,
    ...overrides,
  };
}

const kPath = dataset({
  axes: [
    { role: "wavevector", cardinality: 7 },
    { role: "spectral", cardinality: 7 },
  ],
});
const gamma = dataset({ axes: [{ role: "spectral", cardinality: 12 }] });
const fixedK = dataset({ axes: [{ role: "wavevector", cardinality: 1 }] });
const timeDomain = dataset({ product_kind: "time_domain_spectrum", item_kinds: ["spectral_feature"] });

function matchedIds(target: MatchableDataset): string[] {
  return ANALYSIS_FEATURE_MANIFESTS.filter((manifest) => matchDataset(manifest, target).matched).map(
    (manifest) => manifest.id,
  );
}

describe("analysis module dataset matching", () => {
  it("routes a k path to dispersion only", () => {
    expect(matchedIds(kPath)).toEqual(["analysis.dispersion"]);
  });

  it("routes finite or single-k spectra to resonance only", () => {
    expect(matchedIds(gamma)).toEqual(["analysis.resonance"]);
    expect(matchedIds(fixedK)).toEqual(["analysis.resonance"]);
  });

  it("routes time-domain spectra to the time-domain module only", () => {
    expect(matchedIds(timeDomain)).toEqual(["analysis.time-domain"]);
  });

  it("routes a hysteresis loop to the hysteresis module only", () => {
    const loop = dataset({
      product_kind: "hysteresis_loop",
      item_kinds: [],
      axes: [{ role: "outer_sweep", cardinality: 41 }],
    });
    expect(matchedIds(loop)).toEqual(["analysis.hysteresis"]);
    expect(matchDataset(HYSTERESIS_ANALYSIS_MANIFEST, { ...loop, axes: [] })).toEqual({
      matched: false,
      reason: "no outer_sweep axis",
    });
  });

  it("explains a mismatch from published fields", () => {
    expect(matchDataset(DISPERSION_ANALYSIS_MANIFEST, gamma)).toEqual({
      matched: false,
      reason: "no wavevector axis",
    });
    expect(matchDataset(RESONANCE_ANALYSIS_MANIFEST, timeDomain)).toEqual({
      matched: false,
      reason: "product time_domain_spectrum is not handled",
    });
    expect(matchDataset(TIME_DOMAIN_ANALYSIS_MANIFEST, kPath).matched).toBe(false);
  });

  it("keeps optional templates visible with a reason when the dataset lacks them", () => {
    const contour = templateAvailability(DISPERSION_ANALYSIS_MANIFEST, kPath).find(
      (entry) => entry.template.kind === "analysis.dispersion.iso_frequency_contour",
    );
    expect(contour).toMatchObject({ available: false, reason: "no wavevector_grid axis" });
  });

  it("disables mode visualizations when fields are not published", () => {
    const spectrumOnly = { ...kPath, capabilities: { ...capabilities, fields: false } };
    const visualization = templateAvailability(DISPERSION_ANALYSIS_MANIFEST, spectrumOnly).find(
      (entry) => entry.template.kind === "analysis.dispersion.mode_visualization",
    );
    expect(visualization).toMatchObject({ available: false, reason: "capability fields is not published" });
  });
});

describe("analysis module manifests", () => {
  it("use unique module ids and node kinds owned by their module", () => {
    const ids = ANALYSIS_FEATURE_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const manifest of ANALYSIS_FEATURE_MANIFESTS) {
      const kinds = manifest.nodeTemplates.map((template) => template.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const kind of kinds) expect(kind.startsWith(`${manifest.id}.`)).toBe(true);
      for (const template of manifest.nodeTemplates) {
        if (template.parent !== "dataset") expect(kinds).toContain(template.parent);
        if (template.instantiation === "user") expect(manifest.definitionSchemas[template.kind]).toBeTruthy();
      }
    }
  });

  it("stay metadata-only: the manifest file imports no module code statically", () => {
    const source = readFileSync(resolve(__dirname, "analysisModuleManifests.ts"), "utf8");
    const staticImports = [...source.matchAll(/^import\s.+from\s+"([^"]+)";$/gm)].map((match) => match[1]);
    expect(staticImports).toEqual(["./analysisModuleContract"]);
  });

  it("load module code that identifies itself", async () => {
    for (const manifest of ANALYSIS_FEATURE_MANIFESTS) {
      const loaded = await manifest.load();
      expect(loaded.default.id).toBe(manifest.id);
    }
  });
});

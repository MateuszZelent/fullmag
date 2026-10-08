import type { AnalysisFeatureManifest } from "./analysisModuleContract";

/**
 * Registered analysis feature modules. Metadata only: importing this file
 * must not pull in any module view code. Hysteresis and transmission modules
 * are added once the backend publishes a product kind for them.
 */
export const DISPERSION_ANALYSIS_MANIFEST: AnalysisFeatureManifest = {
  id: "analysis.dispersion",
  version: "0.1.0",
  title: "Dispersion",
  matches: [
    {
      productKinds: ["modal_eigen", "driven_response"],
      requiredAxes: [{ role: "wavevector", minCardinality: 2 }],
    },
  ],
  nodeTemplates: [
    { kind: "analysis.dispersion.overview", parent: "dataset", role: "overview", title: "Overview", instantiation: "auto" },
    { kind: "analysis.dispersion.relation", parent: "dataset", role: "plot-1d", title: "Dispersion relation", instantiation: "auto" },
    {
      kind: "analysis.dispersion.reference",
      parent: "analysis.dispersion.relation",
      role: "plot-feature",
      title: "Reference",
      instantiation: "user",
    },
    {
      kind: "analysis.dispersion.iso_frequency_contour",
      parent: "dataset",
      role: "plot-2d",
      title: "Iso-frequency contour",
      instantiation: "optional",
      // A 2D k grid is not published yet; the template stays disabled with this reason.
      availableWhen: {
        productKinds: ["modal_eigen", "driven_response"],
        requiredAxes: [{ role: "wavevector_grid" }],
      },
    },
    {
      kind: "analysis.dispersion.branches",
      parent: "dataset",
      role: "data-collection",
      title: "Branches",
      instantiation: "auto",
      availableWhen: { productKinds: ["modal_eigen"] },
      children: { paging: "server", pageSize: 50 },
    },
    {
      kind: "analysis.dispersion.samples",
      parent: "dataset",
      role: "data-collection",
      title: "k samples",
      instantiation: "auto",
      children: { paging: "server", pageSize: 50 },
    },
    {
      kind: "analysis.dispersion.mode_visualizations",
      parent: "dataset",
      role: "visualization-group",
      title: "Mode visualizations",
      instantiation: "auto",
    },
    {
      kind: "analysis.dispersion.mode_visualization",
      parent: "analysis.dispersion.mode_visualizations",
      role: "field-visualization",
      title: "Mode visualization",
      instantiation: "user",
      availableWhen: { productKinds: ["modal_eigen", "driven_response"], requiredCapabilities: ["fields"] },
    },
    { kind: "analysis.dispersion.quality", parent: "dataset", role: "quality", title: "Quality & provenance", instantiation: "auto" },
  ],
  definitionSchemas: {
    "analysis.dispersion.reference": "analysis.dispersion.reference.v1",
    "analysis.dispersion.mode_visualization": "analysis.dispersion.mode_visualization.v1",
  },
  load: () => import("@/modules/analysis-dispersion/dispersionAnalysisModule"),
};

export const RESONANCE_ANALYSIS_MANIFEST: AnalysisFeatureManifest = {
  id: "analysis.resonance",
  version: "0.1.0",
  title: "Resonance & FMR",
  matches: [
    { productKinds: ["modal_eigen", "driven_response"], absentAxes: ["wavevector"] },
    {
      productKinds: ["modal_eigen", "driven_response"],
      requiredAxes: [{ role: "wavevector", maxCardinality: 1 }],
    },
  ],
  nodeTemplates: [
    { kind: "analysis.resonance.overview", parent: "dataset", role: "overview", title: "Overview", instantiation: "auto" },
    { kind: "analysis.resonance.spectrum", parent: "dataset", role: "plot-1d", title: "Spectrum", instantiation: "auto" },
    {
      kind: "analysis.resonance.field_frequency_map",
      parent: "dataset",
      role: "plot-2d",
      title: "Field–frequency map",
      instantiation: "auto",
      availableWhen: {
        productKinds: ["modal_eigen", "driven_response"],
        requiredAxes: [{ role: "outer_sweep", minCardinality: 2 }],
      },
    },
    {
      kind: "analysis.resonance.mode_visualizations",
      parent: "dataset",
      role: "visualization-group",
      title: "Mode visualizations",
      instantiation: "auto",
    },
    { kind: "analysis.resonance.quality", parent: "dataset", role: "quality", title: "Quality & provenance", instantiation: "auto" },
  ],
  definitionSchemas: {},
  load: () => import("@/modules/analysis-resonance/resonanceAnalysisModule"),
};

export const TIME_DOMAIN_ANALYSIS_MANIFEST: AnalysisFeatureManifest = {
  id: "analysis.time-domain",
  version: "0.1.0",
  title: "Time domain",
  matches: [{ productKinds: ["time_domain_spectrum", "dynamic_structure_factor"] }],
  nodeTemplates: [
    { kind: "analysis.time-domain.overview", parent: "dataset", role: "overview", title: "Overview", instantiation: "auto" },
    { kind: "analysis.time-domain.spectrum", parent: "dataset", role: "plot-1d", title: "FFT / PSD", instantiation: "auto" },
    {
      kind: "analysis.time-domain.structure_factor",
      parent: "dataset",
      role: "plot-2d",
      title: "S(k, f)",
      instantiation: "auto",
      availableWhen: { productKinds: ["dynamic_structure_factor"] },
    },
    { kind: "analysis.time-domain.quality", parent: "dataset", role: "quality", title: "Quality & provenance", instantiation: "auto" },
  ],
  definitionSchemas: {},
  load: () => import("@/modules/analysis-time-domain/timeDomainAnalysisModule"),
};

export const ANALYSIS_FEATURE_MANIFESTS: readonly AnalysisFeatureManifest[] = [
  DISPERSION_ANALYSIS_MANIFEST,
  RESONANCE_ANALYSIS_MANIFEST,
  TIME_DOMAIN_ANALYSIS_MANIFEST,
];

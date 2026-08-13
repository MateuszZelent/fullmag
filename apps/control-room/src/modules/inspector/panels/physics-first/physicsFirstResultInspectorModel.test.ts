import { describe, expect, it } from "vitest";

import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

describe("physicsFirstResultInspectorModel", () => {
  it.each([
    "results.dynamics.root",
    "results.resonance.root",
    "results.resonance.modal.stage",
    "results.resonance.driven.stage",
    "results.resonance.modal.spectrum",
    "results.resonance.modal.modes",
    "results.resonance.modal.mode",
    "results.resonance.modal.coupling",
    "results.resonance.driven.spectrum",
    "results.resonance.driven.peaks",
    "results.resonance.driven.frequency_points",
    "results.resonance.driven.fields",
    "results.resonance.driven.field",
    "results.dispersion.root",
    "results.dispersion.modal.stage",
    "results.dispersion.driven.stage",
    "results.dispersion.k_sampling",
    "results.dispersion.modal.relation",
    "results.dispersion.modal.branches",
    "results.dispersion.modal.modes_at_k",
    "results.dispersion.modal.mode_at_k",
    "results.dispersion.driven.response_map",
    "results.dispersion.driven.field_at_k",
    "results.hysteresis.root",
    "results.analysis_views.root",
    "results.analysis_views.definition",
    "results.derived_values.root",
    "results.derived_values.definition",
    "results.tables.root",
    "results.tables.definition",
    "results.exports.root",
    "results.exports.definition",
  ])("owns a semantic model for %s", (kind) => {
    expect(physicsFirstResultInspectorModel(kind)).not.toBeNull();
  });

  it.each([
    ["results.dynamics.root", "Dynamics Results", "Time-domain results and spectral analysis", "Dynamics", "Runtime observables"],
    ["results.resonance.modal.coupling", "RF Coupling / FMR Activity", "Published modal coupling evidence", "FMR activity", "Modal eigensolve"],
    ["results.dispersion.driven.response_map", "Spectral Response Map · A(k,f)", "Driven k-frequency response; not a modal dispersion relation", "k-resolved response", "Frequency-driven"],
    ["results.analysis_views.root", "Analysis Views", "Dataset-backed saved postprocessing views", "Postprocessing", "View definition"],
    ["results.derived_values.root", "Derived Values", "Evaluated scalar or integral definitions", "Postprocessing", "Derived definition"],
    ["results.tables.root", "Tables", "Dataset-backed tabular definitions", "Postprocessing", "Table definition"],
    ["results.exports.root", "Exports", "Reproducible export definitions", "Postprocessing", "Export definition"],
  ])("maps %s to a dedicated semantic panel model", (kind, title, description, physicalLabel, methodLabel) => {
    expect(physicsFirstResultInspectorModel(kind)).toEqual({
      description,
      methodLabel,
      physicalLabel,
      title,
    });
  });

  it("fails closed for an unowned kind", () => {
    expect(physicsFirstResultInspectorModel("results.unknown")).toBeNull();
  });
});

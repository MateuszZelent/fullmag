import { describe, expect, it } from "vitest";

import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

describe("physicsFirstResultInspectorModel", () => {
  it.each([
    ["results.dynamics.root", "Dynamics", "Time-domain results and spectral analysis", "Dynamics", "Runtime observables"],
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

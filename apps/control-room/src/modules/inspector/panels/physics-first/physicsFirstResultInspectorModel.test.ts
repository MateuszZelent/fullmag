import { describe, expect, it } from "vitest";

import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

describe("physicsFirstResultInspectorModel", () => {
  it.each([
    ["results.dynamics.root", "Dynamics", "Time-domain results and spectral analysis"],
    ["results.resonance.modal.coupling", "RF Coupling / FMR Activity", "Modal coupling evidence"],
    ["results.dispersion.driven.response_map", "Spectral Response Map · A(k,f)", "Driven k-frequency response"],
    ["results.analysis_views.root", "Analysis Views", "Saved postprocessing views"],
    ["results.derived_values.root", "Derived Values", "Evaluated scalar or integral definitions"],
    ["results.tables.root", "Tables", "Dataset-backed tabular definitions"],
    ["results.exports.root", "Exports", "Reproducible export definitions"],
  ])("maps %s to a dedicated semantic panel model", (kind, title, description) => {
    expect(physicsFirstResultInspectorModel(kind)).toEqual({ description, title });
  });

  it("fails closed for an unowned kind", () => {
    expect(physicsFirstResultInspectorModel("results.unknown")).toBeNull();
  });
});

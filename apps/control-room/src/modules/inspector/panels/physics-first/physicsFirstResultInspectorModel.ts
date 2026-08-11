export interface PhysicsFirstResultInspectorModel {
  description: string;
  methodLabel: string;
  physicalLabel: string;
  title: string;
}

const models: Readonly<Record<string, PhysicsFirstResultInspectorModel>> = {
  "results.dynamics.root": model("Dynamics", "Time-domain results and spectral analysis", "Dynamics", "Runtime observables"),
  "results.resonance.root": model("Resonance & FMR", "Modal and driven resonance results", "Resonance", "Mixed products"),
  "results.resonance.modal.coupling": model("RF Coupling / FMR Activity", "Published modal coupling evidence", "FMR activity", "Modal eigensolve"),
  "results.resonance.driven.spectrum": model("Harmonic Response Spectrum", "Driven response; the selected result label states whether the RF observable qualifies as FMR", "Resonance response", "Frequency-driven"),
  "results.dispersion.root": model("Dispersion & k-resolved response", "Wavevector-resolved modal and driven products", "Wavevector-resolved", "Mixed products"),
  "results.dispersion.driven.response_map": model("Spectral Response Map · A(k,f)", "Driven k-frequency response; not a modal dispersion relation", "k-resolved response", "Frequency-driven"),
  "results.hysteresis.root": model("Hysteresis", "Field-sweep branches and loops", "Hysteresis", "Field sweep"),
  "results.analysis_views.root": model("Analysis Views", "Dataset-backed saved postprocessing views", "Postprocessing", "View definition"),
  "results.analysis_views.definition": model("Analysis View", "A view referencing an owned dataset without copying its payload", "Postprocessing", "View definition"),
  "results.derived_values.root": model("Derived Values", "Evaluated scalar or integral definitions", "Postprocessing", "Derived definition"),
  "results.derived_values.definition": model("Derived Value", "A derived operation referencing an owned dataset", "Postprocessing", "Derived definition"),
  "results.tables.root": model("Tables", "Dataset-backed tabular definitions", "Postprocessing", "Table definition"),
  "results.tables.definition": model("Table", "A table definition referencing an owned dataset", "Postprocessing", "Table definition"),
  "results.exports.root": model("Exports", "Reproducible export definitions", "Postprocessing", "Export definition"),
  "results.exports.definition": model("Export", "An export definition referencing an owned dataset", "Postprocessing", "Export definition"),
};

function model(
  title: string,
  description: string,
  physicalLabel: string,
  methodLabel: string,
): PhysicsFirstResultInspectorModel {
  return { description, methodLabel, physicalLabel, title };
}

export function physicsFirstResultInspectorModel(
  kind: string,
): PhysicsFirstResultInspectorModel | null {
  return models[kind] ?? null;
}

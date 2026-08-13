export interface PhysicsFirstResultInspectorModel {
  description: string;
  methodLabel: string;
  physicalLabel: string;
  title: string;
}

const models: Readonly<Record<string, PhysicsFirstResultInspectorModel>> = {
  "results.dynamics.root": model("Dynamics Results", "Time-domain results and spectral analysis", "Dynamics", "Runtime observables"),
  "results.resonance.root": model("Resonance & FMR", "Modal and driven resonance results", "Resonance", "Mixed products"),
  "results.resonance.modal.stage": model("Eigenmodes Result Stage", "Modal eigensolve result stage and its published products", "Modal resonance", "Modal eigensolve"),
  "results.resonance.modal.spectrum": model("Eigenfrequency Spectrum", "Eigenfrequencies at zero wavevector with modal quality evidence", "Modal resonance", "Modal eigensolve"),
  "results.resonance.modal.modes": model("Mode Shapes", "Complex eigenmode fields available for phase-resolved 3D visualization", "Modal fields", "Modal eigensolve"),
  "results.resonance.modal.mode": model("Eigenmode Field", "One exact complex eigenmode field and its immutable result identity", "Modal field", "Modal eigensolve"),
  "results.resonance.modal.coupling": model("RF Coupling / FMR Activity", "Published modal coupling evidence", "FMR activity", "Modal eigensolve"),
  "results.resonance.modal.provenance": model("FMR Modal Provenance", "Equilibrium, modal intent, and resolved eigen artifact provenance", "Modal provenance", "Modal eigensolve"),
  "results.resonance.driven.stage": model("Frequency Response Result Stage", "Frequency-driven result stage and its published products", "Driven resonance", "Frequency-driven"),
  "results.resonance.driven.spectrum": model("Driven Response Spectrum", "Driven response; the selected result label states whether the RF observable qualifies as FMR", "Resonance response", "Frequency-driven"),
  "results.resonance.driven.peaks": model("Resonance Peaks", "Detected peaks with observable, linewidth, and qualification evidence", "Driven resonance", "Frequency-driven"),
  "results.resonance.driven.frequency_points": model("Response Frequency Points", "Solved frequency samples and their response-field availability", "Driven resonance", "Frequency-driven"),
  "results.resonance.driven.fields": model("Response Fields", "Complex response fields for phase-resolved 3D visualization", "Driven fields", "Frequency-driven"),
  "results.resonance.driven.field": model("Response Field", "One exact complex driven-response field and frequency sample", "Driven field", "Frequency-driven"),
  "results.resonance.driven.provenance": model("FMR Driven Provenance", "Equilibrium, drive evidence, and resolved response artifact provenance", "Driven provenance", "Frequency-driven"),
  "results.dispersion.root": model("Dispersion & k-resolved Response", "Wavevector-resolved modal and driven products", "Wavevector-resolved", "Mixed products"),
  "results.dispersion.modal.stage": model("Dispersion Eigenmodes Stage", "Wavevector-resolved modal eigensolve stage", "Modal dispersion", "Modal eigensolve"),
  "results.dispersion.k_sampling": model("k Sampling", "Wavevector path or grid used by the modal eigensolve", "Wavevector sampling", "Modal eigensolve"),
  "results.dispersion.modal.relation": model("Dispersion Relation", "Eigenfrequency branches as a function of wavevector", "Modal dispersion", "Modal eigensolve"),
  "results.dispersion.modal.branches": model("Mode Branches", "Tracked modal branches across wavevector samples", "Modal dispersion", "Modal eigensolve"),
  "results.dispersion.modal.modes_at_k": model("Modes at k", "Complex eigenmode fields at the selected wavevector", "Modal fields", "Modal eigensolve"),
  "results.dispersion.modal.mode_at_k": model("Mode at k", "One exact complex eigenmode field at a fully identified wavevector sample", "Modal field", "Modal eigensolve"),
  "results.dispersion.modal.provenance": model("Modal Dispersion Provenance", "Equilibrium, k-sampling contract, and resolved modal artifact provenance", "Modal provenance", "Modal eigensolve"),
  "results.dispersion.driven.stage": model("k-resolved Frequency Response Stage", "Wavevector-resolved driven-response stage", "k-resolved response", "Frequency-driven"),
  "results.dispersion.driven.response_map": model("Spectral Response Map · A(k,f)", "Driven k-frequency response; not a modal dispersion relation", "k-resolved response", "Frequency-driven"),
  "results.dispersion.driven.field_at_k": model("Response Field at k", "One exact complex driven-response field at identified k and frequency samples", "k-resolved field", "Frequency-driven"),
  "results.dispersion.driven.provenance": model("Driven Response-Map Provenance", "Equilibrium, drive evidence, and resolved k/f response artifact provenance", "Driven provenance", "Frequency-driven"),
  "results.hysteresis.root": model("Hysteresis", "Field-sweep branches and loops", "Hysteresis", "Field sweep"),
  "results.analysis_views.root": model("Analysis Views", "Dataset-backed saved postprocessing views", "Postprocessing", "View definition"),
  "results.analysis_views.definition": model("Analysis View", "A view referencing an owned dataset without copying its payload", "Postprocessing", "View definition"),
  "results.derived_values.root": model("Derived Values", "Evaluated scalar or integral definitions", "Postprocessing", "Derived definition"),
  "results.derived_values.definition": model("Derived Value", "A derived operation referencing an owned dataset", "Postprocessing", "Derived definition"),
  "results.tables.root": model("Tables", "Dataset-backed tabular definitions", "Postprocessing", "Table definition"),
  "results.tables.definition": model("Table Definition", "A table definition referencing an owned dataset", "Postprocessing", "Table definition"),
  "results.exports.root": model("Exports", "Reproducible export definitions", "Postprocessing", "Export definition"),
  "results.exports.definition": model("Export Definition", "An export definition referencing an owned dataset", "Postprocessing", "Export definition"),
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

export interface PhysicsFirstResultInspectorModel {
  description: string;
  title: string;
}

const models: Readonly<Record<string, PhysicsFirstResultInspectorModel>> = {
  "results.dynamics.root": {
    description: "Time-domain results and spectral analysis",
    title: "Dynamics",
  },
  "results.resonance.root": {
    description: "Modal and driven resonance results",
    title: "Resonance & FMR",
  },
  "results.resonance.modal.coupling": {
    description: "Modal coupling evidence",
    title: "RF Coupling / FMR Activity",
  },
  "results.dispersion.root": {
    description: "Wavevector-resolved modal and driven products",
    title: "Dispersion & k-resolved response",
  },
  "results.dispersion.driven.response_map": {
    description: "Driven k-frequency response",
    title: "Spectral Response Map · A(k,f)",
  },
  "results.hysteresis.root": {
    description: "Field-sweep branches and loops",
    title: "Hysteresis",
  },
  "results.analysis_views.root": {
    description: "Saved postprocessing views",
    title: "Analysis Views",
  },
  "results.derived_values.root": {
    description: "Evaluated scalar or integral definitions",
    title: "Derived Values",
  },
  "results.tables.root": {
    description: "Dataset-backed tabular definitions",
    title: "Tables",
  },
  "results.exports.root": {
    description: "Reproducible export definitions",
    title: "Exports",
  },
};

export function physicsFirstResultInspectorModel(
  kind: string,
): PhysicsFirstResultInspectorModel | null {
  return models[kind] ?? null;
}

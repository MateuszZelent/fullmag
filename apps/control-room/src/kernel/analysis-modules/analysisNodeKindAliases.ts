import type { AnalysisNodeKind } from "./analysisModuleContract";

/**
 * Compatibility aliases for one migration stage (ADR 0054, decision 3): legacy
 * Results node kinds keep their Inspector routes and saved selections while
 * hosts resolve them to the owning module's template kinds. Remove once the
 * module builders emit `analysis.*` kinds directly.
 */
export const LEGACY_RESULTS_NODE_KIND_ALIASES: Readonly<Record<string, AnalysisNodeKind>> = {
  "results.dispersion.root": "analysis.dispersion.overview",
  "results.dispersion.modal.stage": "analysis.dispersion.overview",
  "results.dispersion.driven.stage": "analysis.dispersion.overview",
  "results.dispersion.k_sampling": "analysis.dispersion.samples",
  "results.dispersion.modal.relation": "analysis.dispersion.relation",
  "results.dispersion.modal.branches": "analysis.dispersion.branches",
  "results.dispersion.modal.modes_at_k": "analysis.dispersion.mode_visualizations",
  "results.dispersion.modal.mode_at_k": "analysis.dispersion.mode_visualization",
  "results.dispersion.modal.provenance": "analysis.dispersion.quality",
  "results.dispersion.driven.response_map": "analysis.dispersion.relation",
  "results.dispersion.driven.field_at_k": "analysis.dispersion.mode_visualization",
  "results.dispersion.driven.provenance": "analysis.dispersion.quality",
  "results.resonance.root": "analysis.resonance.overview",
  "results.resonance.modal.stage": "analysis.resonance.overview",
  "results.resonance.driven.stage": "analysis.resonance.overview",
  "results.resonance.modal.spectrum": "analysis.resonance.spectrum",
  "results.resonance.driven.spectrum": "analysis.resonance.spectrum",
  "results.resonance.modal.modes": "analysis.resonance.mode_visualizations",
  "results.resonance.driven.fields": "analysis.resonance.mode_visualizations",
  "results.resonance.modal.mode": "analysis.resonance.mode_visualizations",
  "results.resonance.driven.field": "analysis.resonance.mode_visualizations",
  "results.resonance.driven.frequency_points": "analysis.resonance.spectrum",
  "results.resonance.driven.peaks": "analysis.resonance.spectrum",
  "results.resonance.modal.coupling": "analysis.resonance.spectrum",
  "results.resonance.modal.provenance": "analysis.resonance.quality",
  "results.resonance.driven.provenance": "analysis.resonance.quality",
};

export function analysisNodeKindFor(kind: string): AnalysisNodeKind | null {
  if (kind.startsWith("analysis.")) return kind as AnalysisNodeKind;
  return LEGACY_RESULTS_NODE_KIND_ALIASES[kind] ?? null;
}

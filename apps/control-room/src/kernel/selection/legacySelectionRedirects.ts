import type { Selection, SelectionKind } from "./selectionTypes";

/**
 * Transitional compatibility redirects mapping the 52 merged routes, 33 retired
 * legacy frequency-domain routes, 8 dead routes, and unregistered U1..U14
 * selection emitters to their single canonical owner in the 162-route catalog
 * (Volume I §4.1–§4.3). Scheduled for final pruning in Wave 7 (Task 27).
 */
export const LEGACY_SELECTION_KIND_REDIRECTS: Readonly<
  Record<string, SelectionKind>
> = Object.freeze({
  // ── 52 merged routes (Volume I §4.2 MERGE INTO) ──────────────────────────
  "study.stage.eigenmodes.setup": "study.stage.eigenmodes",
  "study.stage.eigenmodes.calculation_mode": "study.stage.eigenmodes",
  "study.stage.eigenmodes.equilibrium": "study.stage.eigenmodes",
  "study.stage.eigenmodes.operator": "study.stage.eigenmodes",
  "study.stage.eigenmodes.solver": "study.stage.eigenmodes",
  "study.stage.eigenmodes.outputs": "study.stage.eigenmodes",
  "study.stage.eigenmodes.diagnostics": "study.stage.eigenmodes",
  "study.stage.eigenmodes.boundary": "study.stage.eigenmodes",
  "study.stage.eigenmodes.periodic_pairs": "study.stage.eigenmodes",
  "study.stage.eigenmodes.k_path": "study.stage.eigenmodes",
  "study.stage.frequency_response.setup": "study.stage.frequency_response",
  "study.stage.frequency_response.calculation_mode": "study.stage.frequency_response",
  "study.stage.frequency_response.equilibrium": "study.stage.frequency_response",
  "study.stage.frequency_response.operator": "study.stage.frequency_response",
  "study.stage.frequency_response.excitation": "study.stage.frequency_response",
  "study.stage.frequency_response.sweep": "study.stage.frequency_response",
  "study.stage.frequency_response.solver": "study.stage.frequency_response",
  "study.stage.frequency_response.outputs": "study.stage.frequency_response",
  "study.stage.frequency_response.diagnostics": "study.stage.frequency_response",
  "study.stage.frequency_response.boundary": "study.stage.frequency_response",
  "study.stage.frequency_response.periodic_pairs": "study.stage.frequency_response",
  "study.stage.frequency_response.k_grid": "study.stage.frequency_response",
  "results.time_domain.spectral_feature": "results.dynamics.root",
  "results.time_domain.dsf_point": "results.dispersion.driven.field_at_k",
  "results.resonance.driven.frequency_points": "results.resonance.driven.spectrum",
  "results.resonance.modal.provenance": "results.resonance.modal.stage",
  "results.resonance.driven.provenance": "results.resonance.driven.stage",
  "results.dispersion.modal.provenance": "results.dispersion.modal.stage",
  "results.dispersion.driven.provenance": "results.dispersion.driven.stage",
  "object.physics.scope": "object.physics",
  "visualizations-2d.parameter": "visualizations-2d.plot",
  "mesh-part-airbox": "airbox.visualization",
  "object.magnetic-parameters": "object.material",
  "object.region.geometry": "object.region",
  "object.region.diagnostics": "object.region",
  "object.magnetic-texture.asset": "object.magnetic-texture",
  "object.magnetic-texture.load": "object.magnetic-texture",
  "object.magnetic-texture.transform": "object.magnetic-texture",
  "mesh.grid.descriptor": "mesh.grid",
  "mesh.grid.common": "mesh.grid",
  "mesh.grid.layers": "mesh.grid",
  "mesh.grid.layer.native-grid": "mesh.grid.layer",
  "mesh.grid.layer.mask": "mesh.grid.layer",
  "mesh.grid.layer.transfer": "mesh.grid.layer",
  "mesh.grid.layer.provenance": "mesh.grid.layer",
  "mesh.grid.magnetic-support": "mesh.grid",
  "mesh.grid.active-unassigned": "mesh.grid",
  "mesh.grid.mask": "mesh.grid",
  "mesh.grid.provenance": "mesh.grid",
  "mesh.grid.region": "mesh.grid",
  "mesh.cross-section.draft": "visualizations-2d.draft",
  "mesh.cross-section.plot": "visualizations-2d.plot",

  // ── 33 retired legacy frequency-domain routes (Volume I §4.2 REMOVE LEGACY)
  "results.frequency_domain.root": "results.resonance.root",
  "results.frequency_domain.run": "results.root",
  "results.frequency_domain.calculation_modes": "results.resonance.root",
  "results.frequency_domain.fmr": "results.resonance.root",
  "results.frequency_domain.fmr_modal_spectrum": "results.resonance.modal.spectrum",
  "results.frequency_domain.fmr_response_sweep": "results.resonance.driven.spectrum",
  "results.frequency_domain.fmr_peaks": "results.resonance.driven.peaks",
  "results.frequency_domain.fmr_peak": "results.resonance.driven.peaks",
  "results.frequency_domain.dispersion": "results.dispersion.root",
  "results.frequency_domain.response_map": "results.dispersion.driven.response_map",
  "results.eigen.root": "results.resonance.modal.stage",
  "results.eigen.study": "results.resonance.modal.stage",
  "results.eigen.spectrum": "results.resonance.modal.spectrum",
  "results.eigen.modes": "results.resonance.modal.modes",
  "results.eigen.modes.visualization": "object.mode_visualization",
  "results.eigen.mode": "results.resonance.modal.mode",
  "results.eigen.dispersion": "results.dispersion.modal.relation",
  "results.eigen.k_path": "results.dispersion.k_sampling",
  "results.eigen.branches": "results.dispersion.modal.branches",
  "results.eigen.branch": "results.dispersion.modal.branches",
  "results.eigen.diagnostics": "results.resonance.modal.stage",
  "results.eigen.provenance": "results.resonance.modal.stage",
  "results.frequency_response.root": "results.resonance.driven.stage",
  "results.frequency_response.study": "results.resonance.driven.stage",
  "results.frequency_response.sweep": "results.resonance.driven.spectrum",
  "results.frequency_response.progress": "results.resonance.driven.stage",
  "results.frequency_response.cancel_requested": "results.resonance.driven.stage",
  "results.frequency_response.frequency_points": "results.resonance.driven.spectrum",
  "results.frequency_response.frequency_point": "results.resonance.driven.field",
  "results.frequency_response.observables": "results.resonance.driven.spectrum",
  "results.frequency_response.diagnostics": "results.resonance.driven.stage",
  "results.frequency_response.provenance": "results.resonance.driven.stage",
  "results.frequency_domain.exports": "results.exports.root",

  // ── 8 retired dead routes (Volume I §4.2 REMOVE DEAD ROUTE) ──────────────
  "results.frequency_response.observable": "results.resonance.driven.spectrum",
  "diagnostics.resource": "resources.runtime",
  "object.region.shape": "object.region",
  "object.region.material": "object.region.magnetic-parameters",
  "object.region-magnetic-texture": "object.region.texture",
  "object.region.regions": "object.region",
  "mesh.grid.universe-outside-support": "mesh.grid",
  "mesh.cross-section": "visualizations-2d.root",

  // ── Unregistered selection emitters U1..U14 + container alias (Volume I §4.3)
  "jobs.frequency_domain.stage_run": "jobs.stage",
  "results.eigen.field_sweep": "results.resonance.modal.field_sweep",
  "results.eigen.samples": "results.dispersion.k_sampling",
  "results.eigen.sample": "results.dispersion.modal.modes_at_k",
  "results.eigen.mode_metadata": "results.resonance.modal.mode",
  "results.eigen.mode_field": "results.resonance.modal.mode",
  "results.eigen.mode_residuals": "results.resonance.modal.mode",
  "resources.analysis.frequency_response.field": "results.resonance.driven.field",
  "results.frequency_domain.fmr_resonance_fits": "results.resonance.driven.fits",
  "results.frequency_domain.fmr_resonance_fit": "results.resonance.driven.fits",
  "results.frequency_domain.fmr_kittel_fit": "results.resonance.kittel_fit",
  object: "object.root",
  "resources.mesh.periodic_pairs": "resources.runtime",
  "model.frozen-spins": "definitions.root",
});

export function resolveCanonicalSelectionKind(kind: string): string {
  return LEGACY_SELECTION_KIND_REDIRECTS[kind] ?? kind;
}

export function resolveCanonicalSelection(selection: Selection): Selection {
  if (!selection.kind) return selection;
  const canonicalKind = resolveCanonicalSelectionKind(selection.kind);
  if (canonicalKind === selection.kind) return selection;
  return {
    ...selection,
    kind: canonicalKind,
  };
}

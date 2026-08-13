import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";

import type { InspectorPanelProps } from "../inspectorTypes";
import { physicsFirstResultInspectorModel } from "./physics-first/physicsFirstResultInspectorModel";

export interface FrequencyDomainNodeDetail {
  artifact: string;
  focus: string;
  resource: string;
  title: string;
  visualization: string;
}

const FREQUENCY_DOMAIN_STAGE_NODE_DETAILS: Record<
  string,
  Omit<FrequencyDomainNodeDetail, "focus"> & { focus: string }
> = {
  "study.stage.eigenmodes": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "modal FMR, free modes, and dispersion eigenmode workflow",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Stage",
    visualization: "stage summary, modal solver readiness, spectrum, and mode-field workflow",
  },
  "study.stage.eigenmodes.setup": {
    artifact: "eigen/study.v2.json",
    focus: "eigenmodes setup",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Setup",
    visualization: "modal intent, target modes, normalization, and execution lane",
  },
  "study.stage.eigenmodes.calculation_mode": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "eigenmodes calculation mode",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Calculation Mode",
    visualization: "FMR modal spectrum and dispersion mode routing",
  },
  "study.stage.eigenmodes.equilibrium": {
    artifact: "frequency_domain/equilibrium_diagnostics.v1.json",
    focus: "eigenmodes equilibrium",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Equilibrium",
    visualization: "linearization source, tangent residual, and equilibrium artifact",
  },
  "study.stage.eigenmodes.operator": {
    artifact: "frequency_domain/operator_diagnostics.v1.json",
    focus: "eigenmodes operator",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Operator",
    visualization: "linearized LLG operator, tangent projection, and physics terms",
  },
  "study.stage.eigenmodes.solver": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigenmodes solver",
    resource: "eigen diagnostics resource",
    title: "Eigenmodes Solver",
    visualization: "modal eigensolver status, residuals, and convergence gates",
  },
  "study.stage.eigenmodes.outputs": {
    artifact: "eigen/spectrum.v2.json",
    focus: "eigenmodes outputs",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigenmodes Outputs",
    visualization: "spectrum, branches, mode fields, and export artifacts",
  },
  "study.stage.eigenmodes.diagnostics": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigenmodes diagnostics",
    resource: "eigen diagnostics resource",
    title: "Eigenmodes Diagnostics",
    visualization: "modal residuals, orthogonality, tangent leakage, and provenance",
  },
  "study.stage.frequency_response": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "driven FMR sweep workflow",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Stage",
    visualization: "stage summary, response solver readiness, sweep progress, and field workflow",
  },
  "study.stage.frequency_response.setup": {
    artifact: "response/study.v1.json",
    focus: "frequency-response setup",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Setup",
    visualization: "driven response intent, sweep setup, and execution lane",
  },
  "study.stage.frequency_response.calculation_mode": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "frequency-response calculation mode",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Calculation Mode",
    visualization: "driven FMR, response sweep, and future response-map routing",
  },
  "study.stage.frequency_response.equilibrium": {
    artifact: "frequency_domain/equilibrium_diagnostics.v1.json",
    focus: "frequency-response equilibrium",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Equilibrium",
    visualization: "linearization source, tangent residual, and equilibrium artifact",
  },
  "study.stage.frequency_response.operator": {
    artifact: "frequency_domain/operator_diagnostics.v1.json",
    focus: "frequency-response operator",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Operator",
    visualization: "harmonic LLG operator, damping, tangent projection, and physics terms",
  },
  "study.stage.frequency_response.excitation": {
    artifact: "response/study.v1.json",
    focus: "frequency-response excitation",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Excitation",
    visualization: "drive field amplitude, phase, direction, and coupling policy",
  },
  "study.stage.frequency_response.sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "frequency-response sweep",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Sweep Setup",
    visualization: "frequency grid, partial progress, response curves, and FMR peaks",
  },
  "study.stage.frequency_response.solver": {
    artifact: "response/diagnostics/solver.v1.json",
    focus: "frequency-response solver",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Solver",
    visualization: "GMRES status, residual history, matrix-free lane, and stop reason",
  },
  "study.stage.frequency_response.outputs": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "frequency-response outputs",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Outputs",
    visualization: "sweep table, field payloads, phase views, and export artifacts",
  },
  "study.stage.frequency_response.diagnostics": {
    artifact: "response/diagnostics/solver.v1.json",
    focus: "frequency-response diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Diagnostics",
    visualization: "solver diagnostics, artifact consistency, capability gates, and provenance",
  },
};

const FREQUENCY_DOMAIN_RESULT_NODE_DETAILS: Record<
  string,
  Omit<FrequencyDomainNodeDetail, "focus"> & { focus: string }
> = {
  "results.frequency_domain.root": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "frequency-domain results",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Results Root Detail",
    visualization: "family manifest, modal results, driven response, and diagnostics",
  },
  "results.frequency_domain.run": {
    artifact: "frequency_domain/run_provenance.v1.json",
    focus: "frequency-domain run",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Run Detail",
    visualization: "requested execution, resolved lane, and artifact status",
  },
  "results.frequency_domain.calculation_modes": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "calculation modes",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Calculation Modes",
    visualization: "FMR modal, driven FMR, dispersion, response map",
  },
  "results.frequency_domain.fmr": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "FMR",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "FMR Result",
    visualization: "modal and driven FMR comparison",
  },
  "results.frequency_domain.fmr_modal_spectrum": {
    artifact: "eigen/spectrum.v2.json",
    focus: "modal FMR spectrum",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "FMR Modal Spectrum",
    visualization: "modal resonance spectrum and mode field",
  },
  "results.frequency_domain.fmr_response_sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "driven FMR sweep",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "FMR Response Sweep",
    visualization: "driven response sweep, phase, absorbed power",
  },
  "results.frequency_domain.fmr_peaks": {
    artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
    focus: "FMR peaks",
    resource: "modal spectrum and driven response resources",
    title: "FMR Peaks",
    visualization: "modal resonance table and driven peak table",
  },
  "results.frequency_domain.fmr_peak": {
    artifact: "eigen/spectrum.v2.json or response/magnetic_response_sweep.v2.json",
    focus: "single FMR peak",
    resource: "modal mode field or driven response field",
    title: "FMR Peak",
    visualization: "peak provenance, frequency, validation, and 3D field target",
  },
  "results.frequency_domain.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "dispersion",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Dispersion Result",
    visualization: "Floquet/Bloch dispersion chart and k-path table",
  },
  "results.frequency_domain.response_map": {
    artifact: "response/response_map.v1.json",
    focus: "response map",
    resource: "response map resource gated",
    title: "Response Map",
    visualization: "future k/f intensity map",
  },
  "results.frequency_domain.comparison": {
    artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
    focus: "modal-driven comparison",
    resource: "modal spectrum and driven response resources",
    title: "Modal vs Driven Comparison",
    visualization: "modal-driven resonance comparison",
  },
  "results.frequency_domain.exports": {
    artifact: "frequency_domain/artifact_manifest.json",
    focus: "exports",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Exports",
    visualization: "artifact export and provenance bundle",
  },
  "results.eigen.root": {
    artifact: "eigen/spectrum.v2.json",
    focus: "eigen results",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigen Results Root Detail",
    visualization: "modal spectrum, modes, branches, dispersion, and diagnostics",
  },
  "results.eigen.study": {
    artifact: "eigen/study.v2.json",
    focus: "eigen study",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigen Study Detail",
    visualization: "modal request, equilibrium source, and solver settings",
  },
  "results.eigen.spectrum": {
    artifact: "eigen/spectrum.v2.json",
    focus: "eigen spectrum",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigen Spectrum",
    visualization: "mode frequency table and spectrum chart",
  },
  "results.eigen.modes": {
    artifact: "eigen/modes",
    focus: "eigen modes",
    resource: "mode metadata resources",
    title: "Eigen Modes",
    visualization: "mode table and selectable 3D mode fields",
  },
  "results.eigen.modes.visualization": {
    artifact: "eigen/modes",
    focus: "shared eigen mode visualization",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigen Modes Visualization",
    visualization: "shared mode shader, color, vector, scope, and phase controls",
  },
  "results.eigen.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "eigen dispersion",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Eigen Dispersion",
    visualization: "dispersion curve and k-path samples",
  },
  "results.eigen.k_path": {
    artifact: "eigen/dispersion.csv",
    focus: "eigen k-path",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Eigen k-Path Result Detail",
    visualization: "Bloch k-path table and endpoint labels",
  },
  "results.eigen.branches": {
    artifact: "eigen/branches.v2.json",
    focus: "eigen branches",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    title: "Eigen Branches",
    visualization: "branch table and dispersion fields",
  },
  "results.eigen.diagnostics": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigen diagnostics",
    resource: "eigen diagnostics resource",
    title: "Eigen Diagnostics",
    visualization: "modal convergence, residuals, tangent leakage, and orthogonality",
  },
  "results.eigen.provenance": {
    artifact: "eigen/provenance.v2.json",
    focus: "eigen provenance",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigen Provenance",
    visualization: "requested modal intent and resolved solver lane",
  },
  "results.frequency_response.root": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "frequency-response results",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Results Root Detail",
    visualization: "driven sweep, progress, frequency points, observables, and diagnostics",
  },
  "results.frequency_response.study": {
    artifact: "response/study.v1.json",
    focus: "frequency-response study",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Study Detail",
    visualization: "drive field, frequency sweep, damping, and solver lane",
  },
  "results.frequency_response.sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "response sweep",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Sweep",
    visualization: "amplitude, phase, susceptibility, and absorbed power charts",
  },
  "results.frequency_response.progress": {
    artifact: "response/progress.v1.json",
    focus: "response progress",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    title: "Frequency Response Progress",
    visualization: "completed frequencies, partial artifacts, and current solve state",
  },
  "results.frequency_response.cancel_requested": {
    artifact: "response/cancel_requested.v1.json",
    focus: "response cancellation",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    title: "Frequency Response Cancellation",
    visualization: "cancel request state and preserved partial artifacts",
  },
  "results.frequency_response.frequency_points": {
    artifact: "response/frequency_points",
    focus: "response frequency points",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Response Frequency Points",
    visualization: "per-frequency point table and 3D response field selection",
  },
  "results.frequency_response.observables": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "response observables",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Response Observables",
    visualization: "observable tables, FMR curves, and absorbed power traces",
  },
  "results.frequency_response.diagnostics": {
    artifact: "response/diagnostics/solver.v1.json",
    focus: "response diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Diagnostics",
    visualization: "GMRES residuals, matrix-free status, and production provenance",
  },
  "results.frequency_response.provenance": {
    artifact: "response/provenance.v1.json",
    focus: "response provenance",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Provenance",
    visualization: "requested driven response intent and resolved execution lane",
  },
};

export function resolveFrequencyDomainNodeDetail(
  selection: InspectorPanelProps["selection"],
): FrequencyDomainNodeDetail {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const kind = selection.kind ?? "";
  const stageNodeDetail = FREQUENCY_DOMAIN_STAGE_NODE_DETAILS[kind];
  if (stageNodeDetail) {
    return {
      ...stageNodeDetail,
      artifact: ref?.artifactPath ?? stageNodeDetail.artifact,
      focus: selection.label ?? stageNodeDetail.focus,
      resource: ref?.resourceRef ?? stageNodeDetail.resource,
    };
  }
  const resultNodeDetail = FREQUENCY_DOMAIN_RESULT_NODE_DETAILS[kind];
  if (resultNodeDetail) {
    return {
      ...resultNodeDetail,
      artifact: ref?.artifactPath ?? resultNodeDetail.artifact,
      focus: selection.label ?? resultNodeDetail.focus,
      resource: ref?.resourceRef ?? resultNodeDetail.resource,
    };
  }
  const physicsFirstDetail = physicsFirstResultInspectorModel(kind);
  if (physicsFirstDetail) {
    return {
      artifact: ref?.artifactPath ?? "result manifest",
      focus: selection.label ?? physicsFirstDetail.physicalLabel,
      resource: ref?.resourceRef ?? "result-owned resource",
      title: physicsFirstDetail.title,
      visualization: physicsFirstDetail.description,
    };
  }
  if (kind === "results.eigen.mode") {
    const sample = ref?.sampleIndex ?? null;
    const mode = ref?.modeIndex ?? null;
    return {
      artifact:
        sample != null && mode != null
          ? `eigen/modes/sample_${String(sample).padStart(4, "0")}/mode_${String(mode).padStart(4, "0")}.json`
          : "not selected",
      focus:
        sample != null && mode != null
          ? `sample ${sample}, mode ${mode}`
          : "mode not selected",
      resource: ref?.fieldId ?? "mode field not selected",
      title: "Eigen Mode",
      visualization: "real, imag, complex abs, phase, animated phase",
    };
  }
  if (kind === "results.eigen.branch") {
    return {
      artifact: "eigen/branches.v2.json",
      focus: ref?.branchId ?? "branch not selected",
      resource: ref?.resourceRef ?? "branch resource",
      title: "Eigen Branch",
      visualization: "dispersion branch chart and selected-mode field",
    };
  }
  if (kind === "results.frequency_response.frequency_point") {
    const frequencyIndex = ref?.frequencyIndex ?? null;
    return {
      artifact:
        frequencyIndex != null
          ? `response/frequency_points/frequency_${String(frequencyIndex).padStart(4, "0")}.json`
          : "not selected",
      focus:
        frequencyIndex != null
          ? `frequency index ${frequencyIndex}`
          : "frequency not selected",
      resource: ref?.fieldId ?? "response field not selected",
      title: "Response Frequency",
      visualization: "real, imag, complex abs, phase, animated phase",
    };
  }
  if (kind === "results.frequency_response.observable") {
    return {
      artifact: "response/magnetic_response_sweep.v2.json",
      focus: ref?.observableId ?? "observable not selected",
      resource: ref?.resourceRef ?? "response sweep resource",
      title: "Response Observable",
      visualization: "FMR sweep chart and observable table",
    };
  }
  if (kind === "results.frequency_domain.fmr_peaks") {
    return {
      artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
      focus: selection.label ?? "FMR peaks",
      resource: ref?.resourceRef ?? "modal spectrum and driven response resources",
      title: "FMR Peaks",
      visualization: "modal resonance table and driven peak table",
    };
  }
  if (kind === "results.frequency_domain.calculation_modes") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/manifest.v1.json",
      focus: selection.label ?? "calculation modes",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "Calculation Modes",
      visualization: "FMR modal, driven FMR, dispersion, response map",
    };
  }
  if (kind === "results.frequency_domain.fmr") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/manifest.v1.json",
      focus: selection.label ?? "FMR",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "FMR Result",
      visualization: "modal and driven FMR comparison",
    };
  }
  if (kind === "results.frequency_domain.fmr_modal_spectrum") {
    return {
      artifact: ref?.artifactPath ?? "eigen/spectrum.v2.json",
      focus: selection.label ?? "modal FMR spectrum",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      title: "FMR Modal Spectrum",
      visualization: "modal resonance spectrum and mode field",
    };
  }
  if (kind === "results.frequency_domain.fmr_response_sweep") {
    return {
      artifact: ref?.artifactPath ?? "response/magnetic_response_sweep.v2.json",
      focus: selection.label ?? "driven FMR sweep",
      resource:
        ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      title: "FMR Response Sweep",
      visualization: "driven response sweep, phase, absorbed power",
    };
  }
  if (kind === "results.frequency_domain.response_map") {
    return {
      artifact: ref?.artifactPath ?? "response/response_map.v1.json",
      focus: selection.label ?? "response map",
      resource: ref?.resourceRef ?? "response map resource gated",
      title: "Response Map",
      visualization: "future k/f intensity map",
    };
  }
  if (kind === "results.frequency_domain.comparison") {
    return {
      artifact:
        ref?.artifactPath ??
        "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
      focus: selection.label ?? "modal-driven comparison",
      resource: ref?.resourceRef ?? "modal spectrum and driven response resources",
      title: "Modal vs Driven Comparison",
      visualization: "modal-driven resonance comparison",
    };
  }
  if (kind === "results.frequency_domain.dispersion") {
    return {
      artifact: ref?.artifactPath ?? "eigen/dispersion.csv",
      focus: selection.label ?? "dispersion",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      title: "Dispersion Result",
      visualization: "Floquet/Bloch dispersion chart and k-path table",
    };
  }
  if (kind === "results.frequency_domain.exports") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/artifact_manifest.json",
      focus: selection.label ?? "exports",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "Frequency-Domain Exports",
      visualization: "artifact export and provenance bundle",
    };
  }
  if (kind === "study.stage.eigenmodes.boundary") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/boundary_conditions.v1.json",
      focus: selection.label ?? "eigenmodes boundary",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Eigenmodes Boundary",
      visualization: "open, periodic, and Floquet modal boundary conditions",
    };
  }
  if (kind === "study.stage.eigenmodes.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "mesh/periodic_pairs.v1.json",
      focus: selection.label ?? "eigenmodes periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Eigenmodes Periodic Pairs",
      visualization: "periodic pair selector and mesh pairing diagnostics",
    };
  }
  if (kind === "study.stage.eigenmodes.k_path") {
    return {
      artifact: ref?.artifactPath ?? "eigen/k_path.v1.json",
      focus: selection.label ?? "eigenmodes k-path",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      title: "Eigenmodes k-Path",
      visualization: "Bloch k-path samples and modal dispersion setup",
    };
  }
  if (kind === "study.stage.frequency_response.boundary") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/response_boundary_conditions.v1.json",
      focus: selection.label ?? "frequency-response boundary",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Frequency Response Boundary",
      visualization: "open, periodic, and driven Floquet boundary conditions",
    };
  }
  if (kind === "study.stage.frequency_response.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "mesh/periodic_pairs.v1.json",
      focus: selection.label ?? "frequency-response periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Frequency Response Periodic Pairs",
      visualization: "periodic pair selector and driven-response Floquet gates",
    };
  }
  if (kind === "study.stage.frequency_response.k_grid") {
    return {
      artifact: ref?.artifactPath ?? "response/k_frequency_grid.v1.json",
      focus: selection.label ?? "frequency-response k/f grid",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      title: "Frequency Response k/f Grid",
      visualization: "future k/f response-map sampling grid",
    };
  }
  if (kind === "resources.mesh.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "periodic-pairs resource",
      focus: selection.label ?? "periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Periodic/Floquet",
      visualization: "periodic pair table and Floquet capability gates",
    };
  }
  return {
    artifact: ref?.artifactPath ?? "not selected",
    focus: selection.label ?? "unknown frequency-domain node",
    resource: ref?.resourceRef ?? "not selected",
    title: "Unknown Frequency-Domain",
    visualization: "unknown node kind; add an exact inspector detail",
  };
}

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";

import type { InspectorPanelProps } from "../inspectorTypes";

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
  "study.stage.eigenmodes.setup": {
    artifact: "eigen/study.v2.json",
    focus: "eigenmodes setup",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Setup Node Detail",
    visualization: "modal intent, target modes, normalization, and execution lane",
  },
  "study.stage.eigenmodes.calculation_mode": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "eigenmodes calculation mode",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Calculation Mode Node Detail",
    visualization: "FMR modal spectrum and dispersion mode routing",
  },
  "study.stage.eigenmodes.equilibrium": {
    artifact: "frequency_domain/equilibrium_diagnostics.v1.json",
    focus: "eigenmodes equilibrium",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Equilibrium Node Detail",
    visualization: "linearization source, tangent residual, and equilibrium artifact",
  },
  "study.stage.eigenmodes.operator": {
    artifact: "frequency_domain/operator_diagnostics.v1.json",
    focus: "eigenmodes operator",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigenmodes Operator Node Detail",
    visualization: "linearized LLG operator, tangent projection, and physics terms",
  },
  "study.stage.eigenmodes.solver": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigenmodes solver",
    resource: "eigen diagnostics resource",
    title: "Eigenmodes Solver Node Detail",
    visualization: "modal eigensolver status, residuals, and convergence gates",
  },
  "study.stage.eigenmodes.outputs": {
    artifact: "eigen/spectrum.v2.json",
    focus: "eigenmodes outputs",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigenmodes Outputs Node Detail",
    visualization: "spectrum, branches, mode fields, and export artifacts",
  },
  "study.stage.eigenmodes.diagnostics": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigenmodes diagnostics",
    resource: "eigen diagnostics resource",
    title: "Eigenmodes Diagnostics Node Detail",
    visualization: "modal residuals, orthogonality, tangent leakage, and provenance",
  },
  "study.stage.frequency_response.setup": {
    artifact: "response/study.v1.json",
    focus: "frequency-response setup",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Setup Node Detail",
    visualization: "driven response intent, sweep setup, and execution lane",
  },
  "study.stage.frequency_response.calculation_mode": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "frequency-response calculation mode",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Calculation Mode Node Detail",
    visualization: "driven FMR, response sweep, and future response-map routing",
  },
  "study.stage.frequency_response.equilibrium": {
    artifact: "frequency_domain/equilibrium_diagnostics.v1.json",
    focus: "frequency-response equilibrium",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Equilibrium Node Detail",
    visualization: "linearization source, tangent residual, and equilibrium artifact",
  },
  "study.stage.frequency_response.operator": {
    artifact: "frequency_domain/operator_diagnostics.v1.json",
    focus: "frequency-response operator",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Operator Node Detail",
    visualization: "harmonic LLG operator, damping, tangent projection, and physics terms",
  },
  "study.stage.frequency_response.excitation": {
    artifact: "response/study.v1.json",
    focus: "frequency-response excitation",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Excitation Node Detail",
    visualization: "drive field amplitude, phase, direction, and coupling policy",
  },
  "study.stage.frequency_response.sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "frequency-response sweep",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Sweep Setup Node Detail",
    visualization: "frequency grid, partial progress, response curves, and FMR peaks",
  },
  "study.stage.frequency_response.solver": {
    artifact: "response/diagnostics.v1.json",
    focus: "frequency-response solver",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Solver Node Detail",
    visualization: "GMRES status, residual history, matrix-free lane, and stop reason",
  },
  "study.stage.frequency_response.outputs": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "frequency-response outputs",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Frequency Response Outputs Node Detail",
    visualization: "sweep table, field payloads, phase views, and export artifacts",
  },
  "study.stage.frequency_response.diagnostics": {
    artifact: "response/diagnostics.v1.json",
    focus: "frequency-response diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Diagnostics Node Detail",
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
    title: "Calculation Modes Node Detail",
    visualization: "FMR modal, driven FMR, dispersion, response map",
  },
  "results.frequency_domain.fmr": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "FMR",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "FMR Result Node Detail",
    visualization: "modal and driven FMR comparison",
  },
  "results.frequency_domain.fmr_modal_spectrum": {
    artifact: "eigen/spectrum.v2.json",
    focus: "modal FMR spectrum",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "FMR Modal Spectrum Node Detail",
    visualization: "modal resonance spectrum and mode overlay",
  },
  "results.frequency_domain.fmr_response_sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "driven FMR sweep",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "FMR Response Sweep Node Detail",
    visualization: "driven response sweep, phase, absorbed power",
  },
  "results.frequency_domain.fmr_peaks": {
    artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
    focus: "FMR peaks",
    resource: "modal spectrum and driven response resources",
    title: "FMR Peaks Node Detail",
    visualization: "modal resonance table and driven peak table",
  },
  "results.frequency_domain.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "dispersion",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Dispersion Result Node Detail",
    visualization: "Floquet/Bloch dispersion chart and k-path table",
  },
  "results.frequency_domain.response_map": {
    artifact: "response/response_map.v1.json",
    focus: "response map",
    resource: "response map resource gated",
    title: "Response Map Node Detail",
    visualization: "future k/f intensity map",
  },
  "results.frequency_domain.comparison": {
    artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
    focus: "modal-driven comparison",
    resource: "modal spectrum and driven response resources",
    title: "Modal vs Driven Comparison Node Detail",
    visualization: "modal-driven resonance comparison",
  },
  "results.frequency_domain.exports": {
    artifact: "frequency_domain/artifact_manifest.json",
    focus: "exports",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Exports Node Detail",
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
    title: "Eigen Spectrum Node Detail",
    visualization: "mode frequency table and spectrum chart",
  },
  "results.eigen.modes": {
    artifact: "eigen/modes",
    focus: "eigen modes",
    resource: "mode metadata resources",
    title: "Eigen Modes Node Detail",
    visualization: "mode table and selectable 3D mode overlays",
  },
  "results.eigen.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "eigen dispersion",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Eigen Dispersion Node Detail",
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
    title: "Eigen Branches Node Detail",
    visualization: "branch table and dispersion overlays",
  },
  "results.eigen.diagnostics": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigen diagnostics",
    resource: "eigen diagnostics resource",
    title: "Eigen Diagnostics Node Detail",
    visualization: "modal convergence, residuals, tangent leakage, and orthogonality",
  },
  "results.eigen.provenance": {
    artifact: "eigen/provenance.v2.json",
    focus: "eigen provenance",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Eigen Provenance Node Detail",
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
    title: "Frequency Response Sweep Node Detail",
    visualization: "amplitude, phase, susceptibility, and absorbed power charts",
  },
  "results.frequency_response.progress": {
    artifact: "response/progress.v1.json",
    focus: "response progress",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    title: "Frequency Response Progress Node Detail",
    visualization: "completed frequencies, partial artifacts, and current solve state",
  },
  "results.frequency_response.cancel_requested": {
    artifact: "response/cancel_requested.v1.json",
    focus: "response cancellation",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    title: "Frequency Response Cancellation Node Detail",
    visualization: "cancel request state and preserved partial artifacts",
  },
  "results.frequency_response.frequency_points": {
    artifact: "response/frequency_points",
    focus: "response frequency points",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Response Frequency Points Node Detail",
    visualization: "per-frequency point table and 3D response field selection",
  },
  "results.frequency_response.observables": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "response observables",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Response Observables Node Detail",
    visualization: "observable tables, FMR curves, and absorbed power traces",
  },
  "results.frequency_response.diagnostics": {
    artifact: "response/diagnostics.v1.json",
    focus: "response diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Frequency Response Diagnostics Node Detail",
    visualization: "GMRES residuals, matrix-free status, and production provenance",
  },
  "results.frequency_response.provenance": {
    artifact: "response/provenance.v1.json",
    focus: "response provenance",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency Response Provenance Node Detail",
    visualization: "requested driven response intent and resolved execution lane",
  },
};

const FREQUENCY_DOMAIN_RESOURCE_NODE_DETAILS: Record<
  string,
  Omit<FrequencyDomainNodeDetail, "focus"> & { focus: string }
> = {
  "resources.analysis.frequency_domain": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "frequency-domain resource family",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Resource Family Detail",
    visualization: "manifest, capability, and artifact availability",
  },
  "resources.analysis.frequency_domain.manifest": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "frequency-domain manifest",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Manifest Resource Detail",
    visualization: "family manifest payload and resource links",
  },
  "resources.analysis.frequency_domain.calculation_modes": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "calculation mode resources",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Calculation Mode Resource Detail",
    visualization: "FMR, dispersion, and response-map capability matrix",
  },
  "resources.analysis.frequency_domain.fmr": {
    artifact: "frequency_domain/manifest.v1.json",
    focus: "FMR resource group",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "FMR Resource Detail",
    visualization: "modal and driven FMR resource availability",
  },
  "resources.analysis.frequency_domain.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "dispersion resource group",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Dispersion Resource Detail",
    visualization: "k-path dispersion table and branch resources",
  },
  "resources.analysis.frequency_domain.response_map": {
    artifact: "response/response_map.v1.json",
    focus: "response-map resource group",
    resource: "response map resource gated",
    title: "Response Map Resource Detail",
    visualization: "future k/f response-map resource gate",
  },
  "resources.analysis.eigen.spectrum": {
    artifact: "eigen/spectrum.v2.json",
    focus: "eigen spectrum resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    title: "Eigen Spectrum Resource Detail",
    visualization: "modal spectrum chart and resonance table",
  },
  "resources.analysis.eigen.branches": {
    artifact: "eigen/branches.v2.json",
    focus: "eigen branches resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    title: "Eigen Branches Resource Detail",
    visualization: "branch table and dispersion branch overlays",
  },
  "resources.analysis.eigen.dispersion": {
    artifact: "eigen/dispersion.csv",
    focus: "eigen dispersion resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    title: "Eigen Dispersion Resource Detail",
    visualization: "dispersion CSV and k-path chart",
  },
  "resources.analysis.eigen.diagnostics": {
    artifact: "eigen/diagnostics.v2.json",
    focus: "eigen diagnostics resource",
    resource: "eigen diagnostics resource",
    title: "Eigen Diagnostics Resource Detail",
    visualization: "modal residuals, tangent leakage, and convergence table",
  },
  "resources.analysis.eigen.mode_metadata": {
    artifact: "eigen/modes/{sample}/{mode}.json",
    focus: "eigen mode metadata resource",
    resource: "selected eigen mode metadata resource",
    title: "Eigen Mode Metadata Resource Detail",
    visualization: "mode metadata, damping, and normalization",
  },
  "resources.analysis.eigen.mode_field": {
    artifact: "eigen/mode field payload",
    focus: "eigen mode field resource",
    resource: "selected eigen mode field resource",
    title: "Eigen Mode Field Resource Detail",
    visualization: "real, imag, abs, phase, and animated phase field views",
  },
  "resources.analysis.frequency_response.sweep": {
    artifact: "response/magnetic_response_sweep.v2.json",
    focus: "response sweep resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    title: "Response Sweep Resource Detail",
    visualization: "driven sweep chart, phase, and absorbed power",
  },
  "resources.analysis.frequency_response.progress": {
    artifact: "response/progress.v1.json",
    focus: "response progress resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    title: "Response Progress Resource Detail",
    visualization: "frequency sweep progress, cancellation, and partial artifacts",
  },
  "resources.analysis.frequency_response.cancel_requested": {
    artifact: "response/cancel_requested.v1.json",
    focus: "response cancellation resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    title: "Response Cancellation Resource Detail",
    visualization: "cancel-requested state and partial artifact checkpoint",
  },
  "resources.analysis.frequency_response.frequency_point": {
    artifact: "response/frequency_points/{frequency}.json",
    focus: "response frequency-point resource",
    resource: "selected response frequency-point resource",
    title: "Response Frequency Point Resource Detail",
    visualization: "single-frequency response field and residual metadata",
  },
  "resources.analysis.frequency_response.field": {
    artifact: "response/field_payloads/{frequency}/vector_xyz.bin",
    focus: "response field resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
    title: "Response Field Resource Detail",
    visualization: "real, imag, abs, phase, and animated phase field views",
  },
  "resources.analysis.frequency_response.diagnostics": {
    artifact: "response/diagnostics.v1.json",
    focus: "response diagnostics resource",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Response Diagnostics Resource Detail",
    visualization: "GMRES residuals, matrix-free status, and solver provenance",
  },
};

const FREQUENCY_DOMAIN_JOB_NODE_DETAILS: Record<
  string,
  Omit<FrequencyDomainNodeDetail, "focus"> & { focus: string }
> = {
  "jobs.frequency_domain.root": {
    artifact: "frequency_domain/job_manifest.v1.json",
    focus: "frequency-domain jobs",
    resource: "frequency-domain job queue",
    title: "Frequency-Domain Jobs Root Detail",
    visualization: "active stage runs, frequency solves, and artifact exports",
  },
  "jobs.frequency_domain.stage_run": {
    artifact: "frequency_domain/stage_run.v1.json",
    focus: "stage run job",
    resource: "frequency-domain stage run",
    title: "Frequency-Domain Stage Run Job Detail",
    visualization: "stage execution status and artifact publication",
  },
  "jobs.frequency_domain.eigen_sample": {
    artifact: "eigen/sample_job.v1.json",
    focus: "eigen sample job",
    resource: "eigen sample solve",
    title: "Eigen Sample Job Detail",
    visualization: "per-k modal solve progress and convergence",
  },
  "jobs.frequency_domain.response_frequency": {
    artifact: "response/frequency_job.v1.json",
    focus: "response frequency job",
    resource: "response frequency solve",
    title: "Response Frequency Job Detail",
    visualization: "single-frequency GMRES solve progress and residuals",
  },
  "jobs.frequency_domain.response_progress": {
    artifact: "response/progress.v1.json",
    focus: "response progress job",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    title: "Response Progress Job Detail",
    visualization: "sweep progress and cancellation state",
  },
  "jobs.frequency_domain.artifact_export": {
    artifact: "frequency_domain/artifact_export.v1.json",
    focus: "artifact export job",
    resource: "frequency-domain export job",
    title: "Frequency-Domain Artifact Export Job Detail",
    visualization: "manifest, payload, and provenance export status",
  },
};

const FREQUENCY_DOMAIN_DIAGNOSTIC_NODE_DETAILS: Record<
  string,
  Omit<FrequencyDomainNodeDetail, "focus"> & { focus: string }
> = {
  "diagnostics.frequency_domain.root": {
    artifact: "frequency_domain/diagnostics.v1.json",
    focus: "frequency-domain diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Diagnostics Root Detail",
    visualization: "capability, operator, solver, artifact, and UI diagnostics",
  },
  "diagnostics.frequency_domain.capabilities": {
    artifact: "frequency_domain/capabilities.v1.json",
    focus: "frequency-domain capabilities",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Frequency-Domain Capability Diagnostic Detail",
    visualization: "CPU, GPU, Floquet, demag-k, and modal capability gates",
  },
  "diagnostics.frequency_domain.equilibrium": {
    artifact: "frequency_domain/equilibrium_diagnostics.v1.json",
    focus: "equilibrium diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Equilibrium Diagnostic Detail",
    visualization: "equilibrium source, tangent residual, and readiness",
  },
  "diagnostics.frequency_domain.operator": {
    artifact: "frequency_domain/operator_diagnostics.v1.json",
    focus: "operator diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Operator Diagnostic Detail",
    visualization: "operator terms, tangent-space checks, and boundary policy",
  },
  "diagnostics.frequency_domain.solver": {
    artifact: "response/diagnostics.v1.json",
    focus: "solver diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    title: "Solver Diagnostic Detail",
    visualization: "GMRES status, residuals, and production provenance",
  },
  "diagnostics.frequency_domain.artifacts": {
    artifact: "frequency_domain/artifact_manifest.json",
    focus: "artifact diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Artifact Diagnostic Detail",
    visualization: "manifest consistency and payload availability",
  },
  "diagnostics.frequency_domain.api_resources": {
    artifact: "frequency_domain/api_resources.v1.json",
    focus: "API resource diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "API Resource Diagnostic Detail",
    visualization: "resource keys, revisions, and missing-resource fallbacks",
  },
  "diagnostics.frequency_domain.visualization": {
    artifact: "frequency_domain/visualization_diagnostics.v1.json",
    focus: "visualization diagnostics",
    resource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    title: "Visualization Diagnostic Detail",
    visualization: "3D mode overlays, phase animation, and chart readiness",
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
  const resourceNodeDetail = FREQUENCY_DOMAIN_RESOURCE_NODE_DETAILS[kind];
  if (resourceNodeDetail) {
    return {
      ...resourceNodeDetail,
      artifact: ref?.artifactPath ?? resourceNodeDetail.artifact,
      focus: selection.label ?? resourceNodeDetail.focus,
      resource: ref?.resourceRef ?? resourceNodeDetail.resource,
    };
  }
  const jobNodeDetail = FREQUENCY_DOMAIN_JOB_NODE_DETAILS[kind];
  if (jobNodeDetail) {
    return {
      ...jobNodeDetail,
      artifact: ref?.artifactPath ?? jobNodeDetail.artifact,
      focus: selection.label ?? jobNodeDetail.focus,
      resource: ref?.resourceRef ?? jobNodeDetail.resource,
    };
  }
  const diagnosticNodeDetail = FREQUENCY_DOMAIN_DIAGNOSTIC_NODE_DETAILS[kind];
  if (diagnosticNodeDetail) {
    return {
      ...diagnosticNodeDetail,
      artifact: ref?.artifactPath ?? diagnosticNodeDetail.artifact,
      focus: selection.label ?? diagnosticNodeDetail.focus,
      resource: ref?.resourceRef ?? diagnosticNodeDetail.resource,
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
      title: "Eigen Mode Node Detail",
      visualization: "real, imag, complex abs, phase, animated phase",
    };
  }
  if (kind === "results.eigen.branch") {
    return {
      artifact: "eigen/branches.v2.json",
      focus: ref?.branchId ?? "branch not selected",
      resource: ref?.resourceRef ?? "branch resource",
      title: "Eigen Branch Node Detail",
      visualization: "dispersion branch chart and selected-mode overlay",
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
      title: "Response Frequency Node Detail",
      visualization: "real, imag, complex abs, phase, animated phase",
    };
  }
  if (kind === "results.frequency_response.observable") {
    return {
      artifact: "response/magnetic_response_sweep.v2.json",
      focus: ref?.observableId ?? "observable not selected",
      resource: ref?.resourceRef ?? "response sweep resource",
      title: "Response Observable Node Detail",
      visualization: "FMR sweep chart and observable table",
    };
  }
  if (kind === "results.frequency_domain.fmr_peaks") {
    return {
      artifact: "eigen/spectrum.v2.json + response/magnetic_response_sweep.v2.json",
      focus: selection.label ?? "FMR peaks",
      resource: ref?.resourceRef ?? "modal spectrum and driven response resources",
      title: "FMR Peaks Node Detail",
      visualization: "modal resonance table and driven peak table",
    };
  }
  if (kind === "results.frequency_domain.calculation_modes") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/manifest.v1.json",
      focus: selection.label ?? "calculation modes",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "Calculation Modes Node Detail",
      visualization: "FMR modal, driven FMR, dispersion, response map",
    };
  }
  if (kind === "results.frequency_domain.fmr") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/manifest.v1.json",
      focus: selection.label ?? "FMR",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "FMR Result Node Detail",
      visualization: "modal and driven FMR comparison",
    };
  }
  if (kind === "results.frequency_domain.fmr_modal_spectrum") {
    return {
      artifact: ref?.artifactPath ?? "eigen/spectrum.v2.json",
      focus: selection.label ?? "modal FMR spectrum",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      title: "FMR Modal Spectrum Node Detail",
      visualization: "modal resonance spectrum and mode overlay",
    };
  }
  if (kind === "results.frequency_domain.fmr_response_sweep") {
    return {
      artifact: ref?.artifactPath ?? "response/magnetic_response_sweep.v2.json",
      focus: selection.label ?? "driven FMR sweep",
      resource:
        ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      title: "FMR Response Sweep Node Detail",
      visualization: "driven response sweep, phase, absorbed power",
    };
  }
  if (kind === "results.frequency_domain.response_map") {
    return {
      artifact: ref?.artifactPath ?? "response/response_map.v1.json",
      focus: selection.label ?? "response map",
      resource: ref?.resourceRef ?? "response map resource gated",
      title: "Response Map Node Detail",
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
      title: "Modal vs Driven Comparison Node Detail",
      visualization: "modal-driven resonance comparison",
    };
  }
  if (kind === "results.frequency_domain.dispersion") {
    return {
      artifact: ref?.artifactPath ?? "eigen/dispersion.csv",
      focus: selection.label ?? "dispersion",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      title: "Dispersion Result Node Detail",
      visualization: "Floquet/Bloch dispersion chart and k-path table",
    };
  }
  if (kind === "results.frequency_domain.exports") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/artifact_manifest.json",
      focus: selection.label ?? "exports",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      title: "Frequency-Domain Exports Node Detail",
      visualization: "artifact export and provenance bundle",
    };
  }
  if (kind === "study.stage.eigenmodes.boundary") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/boundary_conditions.v1.json",
      focus: selection.label ?? "eigenmodes boundary",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Eigenmodes Boundary Node Detail",
      visualization: "open, periodic, and Floquet modal boundary conditions",
    };
  }
  if (kind === "study.stage.eigenmodes.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "mesh/periodic_pairs.v1.json",
      focus: selection.label ?? "eigenmodes periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Eigenmodes Periodic Pairs Node Detail",
      visualization: "periodic pair selector and mesh pairing diagnostics",
    };
  }
  if (kind === "study.stage.eigenmodes.k_path") {
    return {
      artifact: ref?.artifactPath ?? "eigen/k_path.v1.json",
      focus: selection.label ?? "eigenmodes k-path",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      title: "Eigenmodes k-Path Node Detail",
      visualization: "Bloch k-path samples and modal dispersion setup",
    };
  }
  if (kind === "study.stage.frequency_response.boundary") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/response_boundary_conditions.v1.json",
      focus: selection.label ?? "frequency-response boundary",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Frequency Response Boundary Node Detail",
      visualization: "open, periodic, and driven Floquet boundary conditions",
    };
  }
  if (kind === "study.stage.frequency_response.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "mesh/periodic_pairs.v1.json",
      focus: selection.label ?? "frequency-response periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Frequency Response Periodic Pairs Node Detail",
      visualization: "periodic pair selector and driven-response Floquet gates",
    };
  }
  if (kind === "study.stage.frequency_response.k_grid") {
    return {
      artifact: ref?.artifactPath ?? "response/k_frequency_grid.v1.json",
      focus: selection.label ?? "frequency-response k/f grid",
      resource: ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      title: "Frequency Response k/f Grid Node Detail",
      visualization: "future k/f response-map sampling grid",
    };
  }
  if (kind === "diagnostics.frequency_domain.periodic_floquet") {
    return {
      artifact: ref?.artifactPath ?? "frequency_domain/periodic_floquet_diagnostics.v1.json",
      focus: selection.label ?? "periodic/Floquet diagnostics",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Periodic/Floquet Diagnostic Node Detail",
      visualization: "periodic pairing, Bloch phase, and demag-k diagnostics",
    };
  }
  if (kind === "resources.mesh.periodic_pairs") {
    return {
      artifact: ref?.artifactPath ?? "periodic-pairs resource",
      focus: selection.label ?? "periodic pairs",
      resource: ref?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH,
      title: "Periodic/Floquet Node Detail",
      visualization: "periodic pair table and Floquet capability gates",
    };
  }
  return {
    artifact: ref?.artifactPath ?? "not selected",
    focus: selection.label ?? "unknown frequency-domain node",
    resource: ref?.resourceRef ?? "not selected",
    title: "Unknown Frequency-Domain Node Detail",
    visualization: "unknown node kind; add an exact inspector detail",
  };
}

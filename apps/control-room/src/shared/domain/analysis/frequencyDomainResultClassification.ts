export type FrequencyStudyProduct = "driven_response" | "modal_eigen";

export type FrequencyBoundaryContext = "finite_open" | "floquet_periodic";

export type FrequencyKSampling =
  | { kind: "single"; vectorRadPerM: readonly [number, number, number] }
  | { kind: "path"; sampleCount: number; label?: string }
  | { kind: "grid"; sampleCount: number };

export type FrequencyObservableKind =
  | "absorbed_power"
  | "drive_projected_response"
  | "response_amplitude"
  | "rf_coupling"
  | "susceptibility";

export interface FrequencyObservableEvidence {
  identity: string;
  kind: FrequencyObservableKind;
  unit: string;
}

export interface FrequencyDriveEvidence {
  identity: string;
  kind: "magnetic_rf" | "other";
}

export interface FrequencyDomainResultEvidence {
  boundaryContext: FrequencyBoundaryContext;
  drive?: FrequencyDriveEvidence;
  equilibriumId: string;
  kSampling?: FrequencyKSampling;
  normalization?: string;
  observables: readonly FrequencyObservableEvidence[];
  runId: string;
  stageId: string;
  studyProduct: FrequencyStudyProduct;
}

export type FrequencyResultFamily = "k_resolved" | "resonance";

export type FrequencyKContext =
  | { kind: "finite_open"; label: "Finite system · k n/a" }
  | { kind: "gamma"; label: "Γ point · k = 0" }
  | {
      kind: "fixed_k";
      label: string;
      vectorRadPerM: readonly [number, number, number];
    }
  | { kind: "k_path"; label: string; sampleCount: number }
  | { kind: "k_grid"; label: "k grid"; sampleCount: number };

export type FrequencyRelationKind =
  | "driven_response_map"
  | "fixed_k_driven"
  | "fixed_k_modal"
  | "modal_dispersion"
  | "resonance_spectrum";

export interface FrequencyDomainResultClassification {
  activityLabel?: "RF Coupling / FMR Activity";
  family: FrequencyResultFamily;
  fmrQualified: boolean;
  kContext: FrequencyKContext;
  productLabel: "Eigenmodes" | "Frequency Response";
  relationKind: FrequencyRelationKind;
  resultLabel:
    | "Dispersion Relation · fₙ(k)"
    | "Eigenfrequencies at fixed k"
    | "Eigenfrequency Spectrum"
    | "FMR Response Spectrum"
    | "Harmonic Response Spectrum"
    | "Response at fixed k"
    | "Spectral Response Map · A(k,f)";
}

const ZERO_K_TOLERANCE_RAD_PER_M = 1e-12;

function classifyKContext(evidence: FrequencyDomainResultEvidence): FrequencyKContext {
  if (evidence.boundaryContext === "finite_open") {
    return { kind: "finite_open", label: "Finite system · k n/a" };
  }

  const sampling = evidence.kSampling;
  if (!sampling) {
    throw new Error("Periodic/Floquet result requires explicit k sampling");
  }
  if (sampling.kind === "path") {
    return {
      kind: "k_path",
      label: sampling.label ? `k path ${sampling.label}` : "k path",
      sampleCount: sampling.sampleCount,
    };
  }
  if (sampling.kind === "grid") {
    return { kind: "k_grid", label: "k grid", sampleCount: sampling.sampleCount };
  }

  const isGamma = sampling.vectorRadPerM.every(
    (component) => Math.abs(component) <= ZERO_K_TOLERANCE_RAD_PER_M,
  );
  if (isGamma) {
    return { kind: "gamma", label: "Γ point · k = 0" };
  }
  return {
    kind: "fixed_k",
    label: `Fixed k · [${sampling.vectorRadPerM.join(", ")}] rad/m`,
    vectorRadPerM: sampling.vectorRadPerM,
  };
}

function hasModalFmrEvidence(evidence: FrequencyDomainResultEvidence): boolean {
  return evidence.observables.some((observable) => observable.kind === "rf_coupling");
}

function hasDrivenFmrEvidence(evidence: FrequencyDomainResultEvidence): boolean {
  if (evidence.drive?.kind !== "magnetic_rf") {
    return false;
  }
  return evidence.observables.some(
    (observable) =>
      observable.kind === "absorbed_power" ||
      observable.kind === "drive_projected_response" ||
      observable.kind === "susceptibility",
  );
}

export function classifyFrequencyDomainResult(
  evidence: FrequencyDomainResultEvidence,
): FrequencyDomainResultClassification {
  const kContext = classifyKContext(evidence);
  const isKResolved = kContext.kind === "fixed_k" || kContext.kind === "k_path" || kContext.kind === "k_grid";
  const isModal = evidence.studyProduct === "modal_eigen";
  const fmrQualified = isModal
    ? hasModalFmrEvidence(evidence)
    : hasDrivenFmrEvidence(evidence);

  if (isKResolved) {
    if (isModal) {
      return {
        ...(fmrQualified ? { activityLabel: "RF Coupling / FMR Activity" as const } : {}),
        family: "k_resolved",
        fmrQualified,
        kContext,
        productLabel: "Eigenmodes",
        relationKind: kContext.kind === "fixed_k" ? "fixed_k_modal" : "modal_dispersion",
        resultLabel:
          kContext.kind === "fixed_k"
            ? "Eigenfrequencies at fixed k"
            : "Dispersion Relation · fₙ(k)",
      };
    }
    return {
      family: "k_resolved",
      fmrQualified,
      kContext,
      productLabel: "Frequency Response",
      relationKind: kContext.kind === "fixed_k" ? "fixed_k_driven" : "driven_response_map",
      resultLabel:
        kContext.kind === "fixed_k"
          ? "Response at fixed k"
          : "Spectral Response Map · A(k,f)",
    };
  }

  return {
    ...(isModal && fmrQualified
      ? { activityLabel: "RF Coupling / FMR Activity" as const }
      : {}),
    family: "resonance",
    fmrQualified,
    kContext,
    productLabel: isModal ? "Eigenmodes" : "Frequency Response",
    relationKind: "resonance_spectrum",
    resultLabel: isModal
      ? "Eigenfrequency Spectrum"
      : fmrQualified
        ? "FMR Response Spectrum"
        : "Harmonic Response Spectrum",
  };
}

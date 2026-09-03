"use client";

export interface LegacyEigenModeSummary {
  index: number;
  frequency_hz: number;
  frequency_real_hz?: number;
  frequency_imag_hz?: number;
  angular_frequency_rad_per_s: number;
  eigenvalue_field_au_per_m?: number;
  eigenvalue_real?: number;
  eigenvalue_imag?: number;
  norm: number;
  max_amplitude: number;
  dominant_polarization: string;
  k_vector: [number, number, number] | null;
}

export interface SpinWaveBoundaryConfig {
  kind: string;
  boundary_pair_id?: string | null;
  surface_anisotropy_ks?: number | null;
  surface_anisotropy_axis?: [number, number, number] | null;
}

export interface LegacyEigenSpectrumArtifact {
  study_kind: string;
  solver_backend?: string;
  solver_kind?: string;
  solver_notes?: string;
  solver_capabilities?: string[];
  solver_limitations?: string[];
  mesh_name: string | null;
  mode_count: number;
  normalization: string;
  damping_policy: string;
  spin_wave_bc?: string;
  boundary_config?: SpinWaveBoundaryConfig;
  equilibrium_source: {
    kind: string;
    path?: string;
  };
  included_terms?: {
    exchange?: boolean;
    demag?: boolean;
    zeeman?: boolean;
    interfacial_dmi?: boolean;
    bulk_dmi?: boolean;
    surface_anisotropy?: boolean;
  };
  operator: {
    kind: string;
    include_demag: boolean;
  };
  k_sampling: [number, number, number] | null;
  relaxation_steps: number;
  modes: LegacyEigenModeSummary[];
}

export interface LegacyEigenModeArtifact {
  index: number;
  frequency_hz: number;
  frequency_real_hz?: number;
  frequency_imag_hz?: number;
  angular_frequency_rad_per_s: number;
  eigenvalue_real?: number;
  eigenvalue_imag?: number;
  normalization: string;
  damping_policy: string;
  solver_backend?: string;
  solver_kind?: string;
  solver_notes?: string;
  solver_capabilities?: string[];
  solver_limitations?: string[];
  dominant_polarization: string;
  k_vector: [number, number, number] | null;
  real: [number, number, number][];
  imag: [number, number, number][];
  amplitude: number[];
  phase: number[];
}

export interface LegacyDispersionRow {
  modeIndex: number;
  kx: number;
  ky: number;
  kz: number;
  frequencyHz: number;
  angularFrequencyRadPerS: number;
}

export type EigenKSampling =
  | {
      kind: "single";
      k_vector: [number, number, number];
    }
  | {
      kind: "path";
      points: {
        label?: string | null;
        k_vector: [number, number, number];
      }[];
      samples_per_segment: number[];
      closed: boolean;
    };

export interface EigenModeSummaryV2 {
  raw_mode_index: number;
  branch_id?: number | null;
  frequency_real_hz: number;
  frequency_imag_hz: number;
  angular_frequency_rad_per_s: number;
  eigenvalue_real: number;
  eigenvalue_imag: number;
  norm: number;
  max_amplitude: number;
  dominant_polarization: string;
  k_vector: [number, number, number];
}

export interface EigenSampleSpectrumV2 {
  sample_index: number;
  label?: string | null;
  k_vector: [number, number, number];
  path_s: number;
  segment_index?: number | null;
  t_in_segment: number;
  modes: EigenModeSummaryV2[];
}

export interface EigenSpectrumArtifactV2 {
  schema_version: string;
  solver_model: string;
  sample_count: number;
  samples: EigenSampleSpectrumV2[];
}

export interface EigenTrackedBranchPoint {
  sample_index: number;
  raw_mode_index: number;
  frequency_real_hz: number;
  frequency_imag_hz: number;
  tracking_confidence: number;
  overlap_prev?: number | null;
}

export interface EigenTrackedBranch {
  branch_id: number;
  label?: string | null;
  points: EigenTrackedBranchPoint[];
}

export interface EigenBranchesArtifact {
  schema_version: string;
  solver_model: string;
  branches: EigenTrackedBranch[];
}

export interface EigenModeArtifactV2 {
  schema_version: string;
  solver_model: string;
  sample_index: number;
  raw_mode_index: number;
  branch_id?: number | null;
  frequency_real_hz: number;
  frequency_imag_hz: number;
  angular_frequency_rad_per_s: number;
  eigenvalue_real: number;
  eigenvalue_imag: number;
  normalization: string;
  damping_policy: string;
  dominant_polarization: string;
  k_vector: [number, number, number];
  real: [number, number, number][];
  imag: [number, number, number][];
  amplitude: number[];
  phase: number[];
}

export interface EigenSelection {
  sampleIndex: number;
  rawModeIndex: number | null;
  branchId: number | null;
}

export type AnySpectrumArtifact = LegacyEigenSpectrumArtifact | EigenSpectrumArtifactV2;
export type AnyModeArtifact = LegacyEigenModeArtifact | EigenModeArtifactV2;

export function buildModeKey(sampleIndex: number, rawModeIndex: number): string {
  return `${sampleIndex}:${rawModeIndex}`;
}

export function isSpectrumV2(value: AnySpectrumArtifact | null | undefined): value is EigenSpectrumArtifactV2 {
  return Boolean(value && "schema_version" in value && "samples" in value);
}

export function normalizeSpectrumArtifact(
  value: AnySpectrumArtifact | null | undefined,
): EigenSpectrumArtifactV2 | null {
  if (!value) {
    return null;
  }
  if (isSpectrumV2(value)) {
    return value;
  }
  return {
    schema_version: "legacy-adapter",
    solver_model: value.solver_kind ?? value.operator.kind,
    sample_count: 1,
    samples: [
      {
        sample_index: 0,
        label: value.k_sampling ? null : "Γ",
        k_vector: value.k_sampling ?? [0, 0, 0],
        path_s: 0,
        segment_index: null,
        t_in_segment: 0,
        modes: value.modes.map((mode) => ({
          raw_mode_index: mode.index,
          branch_id: mode.index,
          frequency_real_hz: mode.frequency_real_hz ?? mode.frequency_hz,
          frequency_imag_hz: mode.frequency_imag_hz ?? 0,
          angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
          eigenvalue_real: mode.eigenvalue_real ?? mode.eigenvalue_field_au_per_m ?? 0,
          eigenvalue_imag: mode.eigenvalue_imag ?? 0,
          norm: mode.norm,
          max_amplitude: mode.max_amplitude,
          dominant_polarization: mode.dominant_polarization,
          k_vector: mode.k_vector ?? [0, 0, 0],
        })),
      },
    ],
  };
}

export function normalizeModeArtifact(
  value: AnyModeArtifact | null | undefined,
  sampleIndex = 0,
): EigenModeArtifactV2 | null {
  if (!value) {
    return null;
  }
  if ("schema_version" in value && "sample_index" in value) {
    return value;
  }
  return {
    schema_version: "legacy-adapter",
    solver_model: value.solver_kind ?? "legacy",
    sample_index: sampleIndex,
    raw_mode_index: value.index,
    branch_id: value.index,
    frequency_real_hz: value.frequency_real_hz ?? value.frequency_hz,
    frequency_imag_hz: value.frequency_imag_hz ?? 0,
    angular_frequency_rad_per_s: value.angular_frequency_rad_per_s,
    eigenvalue_real: value.eigenvalue_real ?? 0,
    eigenvalue_imag: value.eigenvalue_imag ?? 0,
    normalization: value.normalization,
    damping_policy: value.damping_policy,
    dominant_polarization: value.dominant_polarization,
    k_vector: value.k_vector ?? [0, 0, 0],
    real: value.real,
    imag: value.imag,
    amplitude: value.amplitude,
    phase: value.phase,
  };
}

// Backward-compatibility aliases for existing consumers
export type EigenModeSummary = LegacyEigenModeSummary;
export type EigenSpectrumArtifact = LegacyEigenSpectrumArtifact;
export type EigenModeArtifact = AnyModeArtifact;
export type DispersionRow = LegacyDispersionRow;

export interface FemMeshPayload {
  nodes: [number, number, number][];
  elements: [number, number, number, number][];
  element_markers?: number[];
  boundary_faces: [number, number, number][];
  boundary_markers?: number[];
  object_segments?: {
    object_id: string;
    geometry_id?: string | null;
    node_start: number;
    node_count: number;
    element_start: number;
    element_count: number;
    boundary_face_start: number;
    boundary_face_count: number;
  }[];
}

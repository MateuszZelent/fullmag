#[allow(unused_imports)]
use crate::{
    BackendTarget, DiscretizationHintsIR, ExecutionPrecision, FrequencyExcitationIR,
    FrequencyResponseOutputIR, FrequencySweepIR, IntegratorChoice, KPointIR, MechanicsIR,
    ModeTrackingIR, RelaxationAlgorithmIR, RelaxationControlIR, RequestedFemDemagIR,
    ResolvedFemDemagIR, SpinWaveBoundaryConditionIR, TimeDependenceIR,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RfDriveIR {
    pub current_a: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<TimeDependenceIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AntennaIR {
    Microstrip {
        width: f64,
        thickness: f64,
        height_above_magnet: f64,
        preview_length: f64,
        #[serde(default)]
        center_x: f64,
        #[serde(default)]
        center_y: f64,
        #[serde(default = "default_current_distribution_uniform")]
        current_distribution: String,
    },
    Cpw {
        signal_width: f64,
        gap: f64,
        ground_width: f64,
        thickness: f64,
        height_above_magnet: f64,
        preview_length: f64,
        #[serde(default)]
        center_x: f64,
        #[serde(default)]
        center_y: f64,
        #[serde(default = "default_current_distribution_uniform")]
        current_distribution: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CurrentModuleIR {
    AntennaFieldSource {
        name: String,
        solver: String,
        antenna: AntennaIR,
        drive: RfDriveIR,
        #[serde(default = "default_antenna_air_box_factor")]
        air_box_factor: f64,
    },
    CurrentTransport {
        name: String,
        model: CurrentTransportModelIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solve_region: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conductivity_s_per_m: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CurrentTransportModelIR {
    PrescribedDensity,
    OhmicPoisson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinTorqueModuleIR {
    Slonczewski {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        spin_polarization: [f64; 3],
        lambda_asymmetry: f64,
        #[serde(default)]
        epsilon_prime: f64,
        /// Free-layer thickness [m]. When None, engine defaults to cell_dz.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        free_layer_thickness_m: Option<f64>,
        /// Fixed-layer position: "top" or "bottom". Controls current sign.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fixed_layer_position: Option<String>,
    },
    ZhangLi {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        #[serde(default)]
        beta: f64,
    },
    InterfaceCpp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        spin_polarization: [f64; 3],
        interface_normal: [f64; 3],
        lambda_asymmetry: f64,
        #[serde(default)]
        epsilon_prime: f64,
    },
    DriftDiffusion {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        spin_polarization: [f64; 3],
        #[serde(default)]
        beta: f64,
        spin_diffusion_length_m: f64,
    },
    SpinOrbitTorque {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        charge_current_density_a_per_m2: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        damping_like_efficiency: f64,
        #[serde(default)]
        field_like_efficiency: f64,
        spin_polarization: [f64; 3],
        ferromagnet_thickness_m: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExcitationAnalysisIR {
    pub source: String,
    pub method: String,
    pub propagation_axis: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k_max_rad_per_m: Option<f64>,
    pub samples: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnergyTermIR {
    Exchange,
    Demag {
        #[serde(default)]
        realization: RequestedFemDemagIR,
    },
    InterfacialDmi {
        #[serde(rename = "D")]
        d: f64,
        /// Interface normal for interfacial DMI.
        ///
        /// Strict FEM planners may require this to be provided explicitly
        /// instead of relying on backend defaults.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interface_normal: Option<[f64; 3]>,
    },
    BulkDmi {
        #[serde(rename = "D")]
        d: f64,
    },
    Zeeman {
        #[serde(rename = "B")]
        b: [f64; 3],
    },
    /// Oersted field from a cylindrical conductor (STNO / MTJ pillar).
    ///
    /// The static spatial profile H_oe(x,y,z) is precomputed on the GPU
    /// for I = 1 A, then scaled by `current * time_dependence(t)` at each
    /// RHS evaluation.
    OerstedCylinder {
        /// DC current amplitude [A].  Sign determines field chirality.
        current: f64,
        /// Cylinder radius [m].
        radius: f64,
        /// Centre of the cylinder cross-section [m]. Only the two in-plane
        /// components matter (the third is ignored and taken along `axis`).
        #[serde(default)]
        center: [f64; 3],
        /// Cylinder / current-flow axis (unit vector, default +z).
        #[serde(default = "default_axis_z")]
        axis: [f64; 3],
        /// Optional time-varying envelope for the current.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_dependence: Option<TimeDependenceIR>,
    },
    OerstedField {
        model: OerstedFieldModelIR,
        source: String,
    },
    /// Magnetoelastic coupling energy between a magnet and an elastic body.
    Magnetoelastic {
        /// Name of the MagnetIR.
        magnet: String,
        /// Name of the ElasticBodyIR.
        body: String,
        /// Name of the MagnetostrictionLawIR.
        law: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OerstedFieldModelIR {
    FromCurrentSolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DynamicsIR {
    Llg {
        gyromagnetic_ratio: f64,
        integrator: String,
        fixed_timestep: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        adaptive_timestep: Option<AdaptiveTimeStepIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_refresh: Option<FieldRefreshPolicyIR>,
        /// Optional mechanical coupling mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mechanics: Option<MechanicsIR>,
    },
}

/// Adaptive time-stepping configuration for embedded-error RK methods.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveTimeStepIR {
    pub atol: f64,
    pub rtol: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_initial: Option<f64>,
    pub dt_min: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_max: Option<f64>,
    pub safety: f64,
    pub growth_limit: f64,
    pub shrink_limit: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_spin_rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub norm_tolerance: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldRefreshPolicyIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_interval_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelaxStopIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_tolerance_apm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_tolerance_j: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_pseudotime_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_physical_time_s: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageStopReason {
    Torque,
    Energy,
    MaxSteps,
    MaxPseudotime,
    MaxPhysicalTime,
    UserCancelled,
    BackendError,
    Gradient,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StageCompletionIR {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<StageStopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

// ── Capability matrix for backend/device/precision/integrator/demag mode ──

/// Describes what a specific FEM backend actually supports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemBackendCapability {
    pub backend: String,
    #[serde(default)]
    pub supported_precisions: Vec<ExecutionPrecision>,
    #[serde(default)]
    pub supported_integrators: Vec<IntegratorChoice>,
    #[serde(default)]
    pub supported_demag_realizations: Vec<ResolvedFemDemagIR>,
    #[serde(default)]
    pub supports_thermal: bool,
    #[serde(default)]
    pub supports_magnetoelastic: bool,
    #[serde(default)]
    pub supports_oersted: bool,
    #[serde(default)]
    pub supports_interfacial_dmi: bool,
    #[serde(default)]
    pub supports_bulk_dmi: bool,
    #[serde(default)]
    pub supports_cubic_anisotropy: bool,
    #[serde(default)]
    pub supports_uniaxial_anisotropy: bool,
    #[serde(default)]
    pub supports_periodic_bc: bool,
    #[serde(default)]
    pub supports_stt: bool,
    #[serde(default)]
    pub supports_sot: bool,
}

/// Policy for the linear solver used in FEM Poisson/demag/mechanics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemLinearSolverPolicy {
    #[serde(default = "default_linear_solver")]
    pub solver: String,
    #[serde(default = "default_preconditioner")]
    pub preconditioner: String,
    #[serde(default = "default_rtol")]
    pub rtol: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atol: Option<f64>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    #[serde(default)]
    pub print_level: u32,
}

fn default_linear_solver() -> String {
    "CG".to_string()
}
fn default_preconditioner() -> String {
    "AMG".to_string()
}
fn default_rtol() -> f64 {
    1e-8
}
fn default_max_iterations() -> u32 {
    500
}

impl Default for FemLinearSolverPolicy {
    fn default() -> Self {
        Self {
            solver: default_linear_solver(),
            preconditioner: default_preconditioner(),
            rtol: default_rtol(),
            atol: None,
            max_iterations: default_max_iterations(),
            print_level: 0,
        }
    }
}

/// Seed policy for stochastic fields (thermal noise).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeedPolicy {
    /// Use system entropy — non-reproducible across runs.
    SystemEntropy,
    /// Use a fixed seed value — fully reproducible.
    Fixed,
}

impl Default for SeedPolicy {
    fn default() -> Self {
        Self::SystemEntropy
    }
}

/// Stochastic/thermal configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThermalSeedConfig {
    #[serde(default)]
    pub policy: SeedPolicy,
    /// Seed value; used only when policy = Fixed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
}

impl Default for ThermalSeedConfig {
    fn default() -> Self {
        Self {
            policy: SeedPolicy::SystemEntropy,
            seed: None,
        }
    }
}

/// Oersted realization variant used by backend plans and provenance.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OerstedRealization {
    InfiniteCylinder,
    BiotSavartMidpoint,
}

impl Default for OerstedRealization {
    fn default() -> Self {
        Self::InfiniteCylinder
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingIR {
    pub outputs: Vec<OutputIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_autosave: Option<TableAutosaveIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableAutosaveIR {
    #[serde(default = "default_table_autosave_kind")]
    pub kind: String,
    #[serde(default = "default_table_id")]
    pub table_id: String,
    pub sample_period_s: f64,
    pub quantities: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_ir_deserializes_table_autosave_contract() {
        let sampling: SamplingIR = serde_json::from_value(serde_json::json!({
            "outputs": [],
            "table_autosave": {
                "kind": "table_autosave",
                "table_id": "default",
                "sample_period_s": 2e-12,
                "quantities": ["step", "t", "mx", "e_total"]
            }
        }))
        .expect("sampling table autosave should deserialize");

        let table = sampling
            .table_autosave
            .expect("sampling should preserve table autosave");
        assert_eq!(table.table_id, "default");
        assert_eq!(table.sample_period_s, 2e-12);
        assert_eq!(table.quantities, ["step", "t", "mx", "e_total"]);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EigenOperatorIR {
    LinearizedLlg,
    /// Full 2×2 Herring–Kittel block operator in the tangent plane.
    /// Required for non-uniform equilibria (vortices, skyrmions, domain walls).
    /// Doubles the DOF from N to 2N.
    #[serde(rename = "full_2x2", alias = "full2x2")]
    Full2x2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EigenOperatorConfigIR {
    pub kind: EigenOperatorIR,
    #[serde(default)]
    pub include_demag: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EigenTargetIR {
    Lowest,
    Nearest { frequency_hz: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EquilibriumSourceIR {
    Provided,
    RelaxedInitialState,
    Artifact { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KSamplingIR {
    Single {
        k_vector: [f64; 3],
    },
    Path {
        points: Vec<KPointIR>,
        samples_per_segment: Vec<u32>,
        #[serde(default)]
        closed: bool,
    },
}

impl KSamplingIR {
    pub fn is_single_gamma(&self) -> bool {
        matches!(
            self,
            KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0]
            }
        )
    }

    pub fn sample_count_hint(&self) -> usize {
        match self {
            KSamplingIR::Single { .. } => 1,
            KSamplingIR::Path {
                samples_per_segment,
                ..
            } => {
                if samples_per_segment.is_empty() {
                    0
                } else {
                    let repeated_segment_starts = samples_per_segment.len().saturating_sub(1);
                    samples_per_segment
                        .iter()
                        .map(|value| *value as usize)
                        .sum::<usize>()
                        .saturating_add(1)
                        .saturating_sub(repeated_segment_starts)
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EigenNormalizationIR {
    UnitL2,
    UnitMaxAmplitude,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrequencyResponseNormalizationIR {
    UnitL2,
    UnitMaxAmplitude,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EigenDampingPolicyIR {
    Ignore,
    Include,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyIR {
    TimeEvolution {
        dynamics: DynamicsIR,
        sampling: SamplingIR,
    },
    Relaxation {
        algorithm: RelaxationAlgorithmIR,
        dynamics: DynamicsIR,
        stop: RelaxStopIR,
        sampling: SamplingIR,
    },
    Eigenmodes {
        dynamics: DynamicsIR,
        operator: EigenOperatorConfigIR,
        count: u32,
        target: EigenTargetIR,
        equilibrium: EquilibriumSourceIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        k_sampling: Option<KSamplingIR>,
        normalization: EigenNormalizationIR,
        damping_policy: EigenDampingPolicyIR,
        /// Spin-wave boundary condition applied to the eigenvalue operator.
        #[serde(default)]
        spin_wave_bc: SpinWaveBoundaryConditionIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode_tracking: Option<ModeTrackingIR>,
        sampling: SamplingIR,
    },
    FrequencyResponse {
        dynamics: DynamicsIR,
        operator: EigenOperatorConfigIR,
        equilibrium: EquilibriumSourceIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        k_sampling: Option<KSamplingIR>,
        normalization: FrequencyResponseNormalizationIR,
        damping_policy: EigenDampingPolicyIR,
        #[serde(default)]
        spin_wave_bc: SpinWaveBoundaryConditionIR,
        excitation: FrequencyExcitationIR,
        frequencies_hz: FrequencySweepIR,
        sampling: SamplingIR,
    },
}

impl StudyIR {
    pub fn dynamics(&self) -> &DynamicsIR {
        match self {
            StudyIR::TimeEvolution { dynamics, .. }
            | StudyIR::Relaxation { dynamics, .. }
            | StudyIR::Eigenmodes { dynamics, .. }
            | StudyIR::FrequencyResponse { dynamics, .. } => dynamics,
        }
    }

    pub fn sampling(&self) -> &SamplingIR {
        match self {
            StudyIR::TimeEvolution { sampling, .. }
            | StudyIR::Relaxation { sampling, .. }
            | StudyIR::Eigenmodes { sampling, .. }
            | StudyIR::FrequencyResponse { sampling, .. } => sampling,
        }
    }

    pub fn relaxation(&self) -> Option<RelaxationControlIR> {
        match self {
            StudyIR::TimeEvolution { .. }
            | StudyIR::Eigenmodes { .. }
            | StudyIR::FrequencyResponse { .. } => None,
            StudyIR::Relaxation {
                algorithm, stop, ..
            } => Some(RelaxationControlIR {
                algorithm: *algorithm,
                stop: stop.clone(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutputIR {
    Field {
        name: String,
        every_seconds: f64,
    },
    Scalar {
        name: String,
        every_seconds: f64,
    },
    Snapshot {
        field: String,
        component: String,
        every_seconds: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
    },
    EigenSpectrum {
        quantity: String,
    },
    EigenMode {
        field: String,
        indices: Vec<u32>,
    },
    DispersionCurve {
        name: String,
    },
    FrequencyResponseOutput {
        observable: FrequencyResponseOutputIR,
    },
    EigenDiagnostics {
        #[serde(default)]
        include_tracking: bool,
        #[serde(default)]
        include_residuals: bool,
        #[serde(default)]
        include_overlaps: bool,
        #[serde(default)]
        include_tangent_leakage: bool,
        #[serde(default)]
        include_orthogonality: bool,
    },
    /// Generic quantity save — canonical QuantityId-driven output.
    SaveQuantity {
        /// Canonical quantity ID (e.g. "M", "H_ex", "E_ex").
        quantity_id: String,
        /// Save cadence in simulated seconds.
        every_seconds: f64,
        /// Optional reduction: "average", "sum", "min", "max", "magnitude".
        #[serde(skip_serializing_if = "Option::is_none")]
        reduction: Option<String>,
        /// Optional component: "x", "y", "z", "magnitude", "3D".
        #[serde(skip_serializing_if = "Option::is_none")]
        component: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BackendPolicyIR {
    pub requested_backend: BackendTarget,
    pub execution_precision: ExecutionPrecision,
    pub discretization_hints: Option<DiscretizationHintsIR>,
}

fn default_axis_z() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

fn default_current_distribution_uniform() -> String {
    "uniform".to_string()
}

fn default_table_autosave_kind() -> String {
    "table_autosave".to_string()
}

fn default_table_id() -> String {
    "default".to_string()
}

fn default_antenna_air_box_factor() -> f64 {
    12.0
}

#![allow(non_snake_case)]
#[allow(unused_imports)]
use crate::{
    BackendTarget, DiscretizationHintsIR, ExecutionPrecision, FrequencyExcitationIR,
    FrequencyResponseOutputIR, FrequencySweepIR, IntegratorChoice, KPointIR,
    MagnetostaticBoundaryConditionIR, MechanicsIR, ModeTrackingIR, RelaxationAlgorithmIR,
    RelaxationControlIR, RequestedFemDemagIR, ResolvedFemDemagIR, SpinWaveBoundaryConditionIR,
    TimeDependenceIR,
};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RfDriveIR {
    pub current_a: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<TimeDependenceIR>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaFieldSourceModelIR {
    Mqs2p5dAz,
    PrescribedZeemanMask,
}

fn default_antenna_field_source_model() -> AntennaFieldSourceModelIR {
    AntennaFieldSourceModelIR::Mqs2p5dAz
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaFieldIR {
    #[serde(rename = "amplitude_B_T")]
    pub amplitude_b_t: f64,
    pub direction: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AntennaSpatialProfileIR {
    Uniform,
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_m: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        center_m: Option<f64>,
        #[serde(default = "default_spatial_profile_window")]
        window: String,
    },
}

fn default_spatial_profile_window() -> String {
    "rectangular".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldDriveKindIR {
    Regional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum FieldTargetIR {
    Global {},
    Object {
        object_id: String,
    },
    Region {
        object_id: String,
        region_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum FieldEnvelopeIR {
    Uniform {},
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        #[serde(default)]
        center_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_m: Option<f64>,
        #[serde(default = "default_field_spatial_window")]
        window: String,
    },
}

fn default_field_spatial_window() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum FieldSpatialProfileIR {
    Uniform {},
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        #[serde(default)]
        center_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_m: Option<f64>,
        #[serde(default = "default_field_spatial_window")]
        window: String,
    },
    GeometryMask {
        object_id: String,
        envelope: FieldEnvelopeIR,
    },
    GaussianPlaneWave {
        center_x_m: f64,
        center_y_m: f64,
        carrier_origin_x_m: f64,
        sigma_x_m: f64,
        sigma_y_m: f64,
        wavelength_m: f64,
        carrier_phase_rad: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldTimeOriginIR {
    StageLocal,
    Absolute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum DriveActivationIR {
    AllTimeEvolution {},
    StageIds { stage_ids: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FieldDriveMigrationIR {
    pub migrated_from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RegionalFieldDriveIR {
    pub id: String,
    pub name: String,
    pub kind: FieldDriveKindIR,
    #[serde(default = "default_field_drive_enabled")]
    pub enabled: bool,
    pub target: FieldTargetIR,
    #[serde(rename = "amplitude_B_T")]
    pub amplitude_b_t: f64,
    pub direction: [f64; 3],
    pub spatial_profile: FieldSpatialProfileIR,
    pub waveform: TimeDependenceIR,
    pub time_origin: FieldTimeOriginIR,
    pub activation: DriveActivationIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<FieldDriveMigrationIR>,
}

fn default_field_drive_enabled() -> bool {
    true
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
        #[serde(default = "default_antenna_field_source_model")]
        model: AntennaFieldSourceModelIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solver: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        antenna: Option<AntennaIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        drive: Option<RfDriveIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        air_box_factor: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        object: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field: Option<AntennaFieldIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spatial_profile: Option<AntennaSpatialProfileIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        waveform: Option<TimeDependenceIR>,
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
        #[serde(default)]
        coupling: crate::TransportCouplingIR,
        /// Dimensionless source multiplier evaluated at each accepted stage
        /// time.  The base prescribed density or charge boundary values stay
        /// in SI units; the runtime applies this multiplier to the source
        /// before solving transport and deriving Oersted fields.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_envelope: Option<crate::TimeEnvelopeIR>,
        /// Complete executable charge solve. Legacy records without this
        /// payload remain readable but fail closed for `ohmic_poisson`.
        #[serde(default, flatten, skip_serializing_if = "Option::is_none")]
        definition: Option<crate::ChargeTransportDefinitionIR>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CurrentTransportModelIR {
    PrescribedDensity,
    OhmicPoisson,
    MagnetoresistivePoisson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinTorqueModuleIR {
    Slonczewski {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<RegionRefIR>,
        #[serde(default = "default_legacy_slonczewski_formula_version")]
        formula_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        spin_polarization: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack_normal: Option<[f64; 3]>,
        lambda_asymmetry: f64,
        #[serde(default)]
        epsilon_prime: f64,
        /// Free-layer thickness [m]. When None, engine defaults to cell_dz.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        free_layer_thickness_m: Option<f64>,
        /// Fixed-layer position: "top" or "bottom". Controls current sign.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fixed_layer_position: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        realization: Option<SlonczewskiRealizationIR>,
    },
    ZhangLi {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<RegionRefIR>,
        #[serde(default = "default_legacy_zhang_li_formula_version")]
        formula_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operator_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        #[serde(default)]
        beta: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lande_g: Option<f64>,
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
    DriftDiffusionSpinTorque {
        schema_version: String,
        id: String,
        solve_id: String,
        target: RegionRefIR,
        formula_version: String,
    },
    #[serde(skip)]
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
    PrescribedSot {
        schema_version: String,
        id: String,
        #[serde(default)]
        target: Option<RegionRefIR>,
        #[serde(flatten)]
        formula: PrescribedSotFormulaIR,
    },
}

fn default_legacy_slonczewski_formula_version() -> String {
    "slonczewski.legacy_fullmag.v0".to_string()
}

fn default_legacy_zhang_li_formula_version() -> String {
    "zhang_li.legacy_fullmag.v0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RegionRefIR {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SlonczewskiRealizationIR {
    ThinLayerHomogenized {
        realization_version: String,
    },
    InterfaceFlux {
        interface_id: String,
        realization_version: String,
    },
}

/// Versioned lower-bound tolerance for prescribed-SOT authored axes.
pub const PRESCRIBED_SOT_V1_EPSILON_AXIS: f64 = 1e-12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TimeEnvelopePointIR {
    pub time_s: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeEnvelopeInterpolationIR {
    Linear,
    Previous,
}

impl Default for TimeEnvelopeInterpolationIR {
    fn default() -> Self {
        Self::Linear
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeEnvelopeExtrapolationIR {
    Zero,
    Hold,
    Error,
}

impl Default for TimeEnvelopeExtrapolationIR {
    fn default() -> Self {
        Self::Error
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TimeEnvelopeIR {
    Constant {
        value: f64,
    },
    Sinusoidal {
        amplitude: f64,
        frequency_hz: f64,
        phase_rad: f64,
        offset: f64,
    },
    Pulse {
        amplitude: f64,
        t_on_s: f64,
        t_off_s: f64,
    },
    PiecewiseLinear {
        points: Vec<TimeEnvelopePointIR>,
    },
    Sinc {
        amplitude: f64,
        center_s: f64,
        bandwidth_hz: f64,
        offset: f64,
    },
    Tabulated {
        artifact_ref: String,
        #[serde(default)]
        interpolation: TimeEnvelopeInterpolationIR,
        #[serde(default)]
        extrapolation: TimeEnvelopeExtrapolationIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bandwidth_hz: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "formula_version", deny_unknown_fields)]
pub enum PrescribedSotFormulaIR {
    #[serde(rename = "prescribed_sot.fullmag.v1")]
    FullmagV1 {
        drive: PrescribedSotV1DriveIR,
        xi_dl: f64,
        xi_fl: f64,
        free_layer_thickness_m: f64,
    },
    #[serde(rename = "prescribed_sot.legacy_fullmag.v0")]
    LegacyFullmagV0 {
        drive: PrescribedSotLegacyDriveIR,
        raw_spin_polarization: [f64; 3],
        xi_dl: f64,
        xi_fl: f64,
        free_layer_thickness_m: f64,
        compatibility_origin: PrescribedSotCompatibilityOriginIR,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PrescribedSotV1DriveIR {
    SignedScalar {
        #[serde(rename = "current_density_Apm2")]
        current_density_apm2: f64,
        sigma_hat: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        envelope: Option<TimeEnvelopeIR>,
    },
    VectorCurrentSource {
        current_source_id: String,
        drive_direction: [f64; 3],
        interface_normal: [f64; 3],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PrescribedSotLegacyDriveIR {
    LegacyScalarMagnitude {
        #[serde(rename = "raw_charge_current_density_Apm2")]
        raw_charge_current_density_apm2: f64,
    },
    LegacyCurrentSourceNorm {
        current_source_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PrescribedSotCompatibilityOriginIR {
    pub source_ir_version: String,
    pub authored_kind: String,
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
    /// Brown thermal field configuration. The temperature is also retained on
    /// `ProblemIR` for the native plan; the optional fixed seed is scoped to
    /// the current stochastic runtime realization.
    ThermalNoise {
        temperature: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<u64>,
    },
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
        /// Stable authored module identity. Historical IR may omit it, but
        /// every current authoring surface must publish it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
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
        /// Stable authored module identity shared with PhysicsGraphIR.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdaptiveToleranceModeIR {
    Advanced,
    #[serde(alias = "maximum_error")]
    MaxError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveTimeStepIR {
    pub tolerance_mode: AdaptiveToleranceModeIR,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RelaxStopIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_tolerance_apm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_tolerance_j: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_relaxation_time_s: Option<f64>,
}

#[derive(Deserialize)]
struct RelaxStopIRCompat {
    #[serde(default)]
    torque_tolerance_apm: Option<f64>,
    #[serde(default)]
    energy_tolerance_j: Option<f64>,
    #[serde(default)]
    max_steps: Option<u64>,
    #[serde(default)]
    max_relaxation_time_s: Option<f64>,
    #[serde(default)]
    max_pseudotime_s: Option<f64>,
    #[serde(default)]
    max_physical_time_s: Option<f64>,
}

impl<'de> Deserialize<'de> for RelaxStopIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let compat = RelaxStopIRCompat::deserialize(deserializer)?;
        if compat.max_relaxation_time_s.is_some()
            && (compat.max_pseudotime_s.is_some() || compat.max_physical_time_s.is_some())
        {
            return Err(D::Error::custom(
                "max_relaxation_time_s conflicts with legacy max_pseudotime_s/max_physical_time_s",
            ));
        }
        if compat.max_pseudotime_s.is_some()
            && compat.max_physical_time_s.is_some()
            && compat.max_pseudotime_s != compat.max_physical_time_s
        {
            return Err(D::Error::custom(
                "legacy max_pseudotime_s and max_physical_time_s conflict",
            ));
        }
        Ok(Self {
            torque_tolerance_apm: compat.torque_tolerance_apm,
            energy_tolerance_j: compat.energy_tolerance_j,
            max_steps: compat.max_steps,
            max_relaxation_time_s: compat
                .max_relaxation_time_s
                .or(compat.max_physical_time_s)
                .or(compat.max_pseudotime_s),
        })
    }
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageMetricKind {
    MaxTorqueApm,
    TotalEnergyPlateauRangeJ,
    RelaxationTimeS,
    Steps,
    NumericalStagnation,
}

impl StageMetricKind {
    pub const fn unit(self) -> &'static str {
        match self {
            Self::MaxTorqueApm => "A/m",
            Self::TotalEnergyPlateauRangeJ => "J",
            Self::RelaxationTimeS => "s",
            Self::Steps | Self::NumericalStagnation => "1",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StageCompletionIR {
    pub status: String,
    #[serde(default)]
    pub converged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<StageStopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<StageMetricKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

impl StageCompletionIR {
    pub fn metric_unit(&self) -> Option<&'static str> {
        self.metric.map(StageMetricKind::unit)
    }
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
    FemVectorPotential,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_autosave: Option<StageAutosaveIR>,
}

pub const AUTO_SINC_NYQUIST_GUARD_FACTOR: f64 = 1.3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SamplingPeriodPolicyIR {
    AutoSincCutoff {
        #[serde(default = "default_auto_sinc_nyquist_guard_factor")]
        nyquist_guard_factor: f64,
    },
}

fn default_auto_sinc_nyquist_guard_factor() -> f64 {
    AUTO_SINC_NYQUIST_GUARD_FACTOR
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableAutosaveIR {
    #[serde(default = "default_table_autosave_kind")]
    pub kind: String,
    #[serde(default = "default_table_id")]
    pub table_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_period_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_period_policy: Option<SamplingPeriodPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_sample_period_s: Option<f64>,
    /// Positive count of accepted solver states between table rows. Mutually
    /// exclusive with simulation-time cadence fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_steps: Option<u64>,
    pub quantities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expressions: Vec<String>,
}

impl TableAutosaveIR {
    pub fn explicit_sample_period_s(&self) -> Option<f64> {
        if self.sample_period_policy.is_none()
            && self.resolved_sample_period_s.is_none()
            && self.every_steps.is_none()
        {
            self.sample_period_s
        } else {
            None
        }
    }

    pub fn accepted_step_cadence(&self) -> Option<u64> {
        if self.sample_period_s.is_none()
            && self.sample_period_policy.is_none()
            && self.resolved_sample_period_s.is_none()
        {
            self.every_steps
        } else {
            None
        }
    }

    pub fn requests_auto_sinc_cutoff(&self) -> bool {
        matches!(
            self.sample_period_policy,
            Some(SamplingPeriodPolicyIR::AutoSincCutoff { .. })
        )
    }

    pub fn set_resolved_sample_period_s(&mut self, period_s: f64) {
        self.resolved_sample_period_s = Some(period_s);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutosaveLayoutIR {
    Continuous,
    Separate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutosaveFormatIR {
    Zarr,
    Hdf5,
    Txt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FieldAutosaveIR {
    #[serde(default = "default_field_autosave_kind")]
    pub kind: String,
    pub quantity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_period_policy: Option<SamplingPeriodPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_steps: Option<u64>,
}

impl FieldAutosaveIR {
    pub fn accepted_step_cadence(&self) -> Option<u64> {
        if self.every_seconds.is_none() && self.sample_period_policy.is_none() {
            self.every_steps
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StageAutosaveIR {
    #[serde(default = "default_stage_autosave_kind")]
    pub kind: String,
    pub target: String,
    pub layout: AutosaveLayoutIR,
    pub format: AutosaveFormatIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<TableAutosaveIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldAutosaveIR>,
}

impl StageAutosaveIR {
    pub fn validate_for_study(&self, study: &StudyIR) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.kind != "stage_autosave" {
            errors.push("sampling.stage_autosave.kind must be 'stage_autosave'".to_string());
        }
        if !is_safe_autosave_target(&self.target) {
            errors.push(
                "sampling.stage_autosave.target must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-'"
                    .to_string(),
            );
        }
        if self.table.is_none() && self.fields.is_empty() {
            errors.push("sampling.stage_autosave requires a table or field policy".to_string());
        }
        if self.format == AutosaveFormatIR::Txt && !self.fields.is_empty() {
            errors
                .push("sampling.stage_autosave txt format supports scalar tables only".to_string());
        }
        let is_relaxation = matches!(study, StudyIR::Relaxation { .. });
        if let Some(table) = &self.table {
            validate_stage_table_autosave(table, is_relaxation, &mut errors);
        }
        let mut quantities = std::collections::BTreeSet::new();
        for field in &self.fields {
            if field.kind != "field_autosave" {
                errors.push(
                    "sampling.stage_autosave.fields.kind must be 'field_autosave'".to_string(),
                );
            }
            if field.quantity.trim().is_empty() {
                errors.push("sampling.stage_autosave field quantity must not be empty".to_string());
            } else if !quantities.insert(field.quantity.as_str()) {
                errors.push(format!(
                    "sampling.stage_autosave contains duplicate field quantity '{}'",
                    field.quantity
                ));
            }
            match (
                field.every_seconds,
                field.sample_period_policy.as_ref(),
                field.every_steps,
            ) {
                (Some(period), None, None) if period.is_finite() && period > 0.0 => {}
                (None, Some(_), None) => {}
                (None, None, Some(steps)) if steps > 0 => {}
                _ => errors.push(format!(
                    "sampling.stage_autosave field '{}' requires exactly one finite positive time cadence or accepted-step cadence",
                    field.quantity
                )),
            }
            if is_relaxation && field.accepted_step_cadence().is_none() {
                errors.push(format!(
                    "relaxation field autosave '{}' must use every_steps",
                    field.quantity
                ));
            }
            if !is_relaxation && field.accepted_step_cadence().is_some() {
                errors.push(format!(
                    "field autosave '{}' every_steps is only valid for relaxation studies",
                    field.quantity
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

fn validate_stage_table_autosave(
    table: &TableAutosaveIR,
    is_relaxation: bool,
    errors: &mut Vec<String>,
) {
    if table.quantities.is_empty() {
        errors.push("sampling.stage_autosave.table.quantities must not be empty".to_string());
    }
    let mut quantities = std::collections::BTreeSet::new();
    for quantity in &table.quantities {
        if quantity.trim().is_empty() {
            errors.push(
                "sampling.stage_autosave.table.quantities must not contain empty ids".to_string(),
            );
        } else if !quantities.insert(quantity.as_str()) {
            errors.push(format!(
                "sampling.stage_autosave.table contains duplicate quantity '{}'",
                quantity
            ));
        }
    }
    for expression in &table.expressions {
        if expression.trim().is_empty() {
            errors.push(
                "sampling.stage_autosave.table.expressions must not contain empty expressions"
                    .to_string(),
            );
        }
    }
    if is_relaxation && table.accepted_step_cadence().is_none() {
        errors.push("relaxation stage autosave table must use every_steps".to_string());
    }
    if !is_relaxation && table.accepted_step_cadence().is_some() {
        errors.push(
            "stage autosave table every_steps is only valid for relaxation studies".to_string(),
        );
    }
}

fn is_safe_autosave_target(target: &str) -> bool {
    let mut chars = target.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn default_field_autosave_kind() -> String {
    "field_autosave".to_string()
}

fn default_stage_autosave_kind() -> String {
    "stage_autosave".to_string()
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
        assert_eq!(table.sample_period_s, Some(2e-12));
        assert!(table.sample_period_policy.is_none());
        assert!(table.resolved_sample_period_s.is_none());
        assert_eq!(table.quantities, ["step", "t", "mx", "e_total"]);
    }

    #[test]
    fn hysteresis_field_segment_preserves_piecewise_schedule_metadata() {
        let schedule: FieldScheduleIR = serde_json::from_value(serde_json::json!({
            "segments": [{
                "segmentId": "coarse_start",
                "start": 1000.0,
                "stop": 200.0,
                "step": 50.0,
                "label": "coarse_start",
                "endpoint_policy": "include_stop",
                "reason": "far_from_remanence"
            }]
        }))
        .expect("field schedule should deserialize");

        let segment = &schedule.segments[0];
        assert_eq!(segment.segment_id, "coarse_start");
        assert_eq!(segment.label, "coarse_start");
        assert_eq!(segment.endpoint_policy, "include_stop");
        assert_eq!(segment.reason, "far_from_remanence");
    }

    #[test]
    fn hysteresis_adaptive_refinement_deserializes_defaults_and_overrides() {
        let policy: AdaptiveRefinementIR = serde_json::from_value(serde_json::json!({
            "kind": "adaptive_refinement",
            "enabled": true,
            "max_passes": 2,
            "max_insertions_per_pass": 12,
            "dm_dh_threshold_per_mT": 0.015,
            "max_step_mT": 2.5,
            "min_step_mT": 0.25,
            "include_zero_crossings": true,
            "include_high_susceptibility": false,
            "include_in_metrics": true
        }))
        .expect("adaptive refinement policy should deserialize");

        assert_eq!(policy.kind, "adaptive_refinement");
        assert_eq!(policy.max_passes, 2);
        assert_eq!(policy.max_insertions_per_pass, 12);
        assert_eq!(policy.dm_dh_threshold_per_mT, 0.015);
        assert_eq!(policy.max_step_mT, 2.5);
        assert_eq!(policy.min_step_mT, 0.25);
        assert!(policy.include_zero_crossings);
        assert!(!policy.include_high_susceptibility);
        assert!(policy.include_in_metrics);

        let default_policy: AdaptiveRefinementIR = serde_json::from_value(serde_json::json!({}))
            .expect("adaptive refinement defaults should deserialize");
        assert!(!default_policy.include_in_metrics);
    }

    #[test]
    fn hysteresis_angular_family_deserializes_variants() {
        let family: HysteresisAngularFamilyIR = serde_json::from_value(serde_json::json!({
            "kind": "angular_family",
            "family_id": "oop_ip_family",
            "label": "OOP/IP",
            "variants": [{
                "variant_id": "oop",
                "label": "OOP",
                "orientation": {"kind": "preset", "preset_name": "oop_positive"},
                "measurement_axis": "field_axis"
            }, {
                "variant_id": "ip35",
                "orientation": {"kind": "sample", "theta": 90.0, "phi": 35.0}
            }]
        }))
        .expect("angular family should deserialize");

        assert_eq!(family.kind, "angular_family");
        assert_eq!(family.family_id, "oop_ip_family");
        assert_eq!(family.variants.len(), 2);
        assert_eq!(family.variants[0].variant_id, "oop");
        assert_eq!(
            family.variants[0].measurement_axis,
            Some(MeasurementAxisIR::field_axis())
        );
    }

    #[test]
    fn hysteresis_field_window_preserves_dense_window_priority() {
        let window: FieldWindowIR = serde_json::from_value(serde_json::json!({
            "center_mT": 0.0,
            "half_width_mT": 25.0,
            "step_mT": 1.0,
            "reason": "remanence",
            "priority": 10
        }))
        .expect("field window should deserialize");

        assert_eq!(window.reason, "remanence");
        assert_eq!(window.priority, Some(10));
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
    Nearest {
        frequency_hz: f64,
    },
    FrequencyWindow {
        frequency_min_hz: f64,
        frequency_max_hz: f64,
    },
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BiasFieldSweepEquilibriumPolicyIR {
    RelaxEach,
    Continuation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BiasFieldSweepContinuationSeedIR {
    PreviousAcceptedEquilibrium,
    InitialState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BiasFieldSweepIR {
    pub samples_a_per_m: Vec<[f64; 3]>,
    pub equilibrium_policy: BiasFieldSweepEquilibriumPolicyIR,
    pub ordering: String,
    pub continuation_seed: BiasFieldSweepContinuationSeedIR,
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
            } => samples_per_segment
                .iter()
                .map(|value| *value as usize)
                .sum::<usize>()
                .saturating_add(usize::from(!samples_per_segment.is_empty())),
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
pub enum FrequencyResponseSolverMethodIR {
    Auto,
    DenseReference,
    CpuSparseDirect,
    FullCoupledFieldSplit,
    SchurReduced,
    ModalReduced,
    GpuOperatorHostKrylov,
    GpuDeviceKrylov,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrequencyResponsePreconditionerIR {
    Auto,
    GraphDemagCoarse,
    DemagCoarse,
    BlockJacobi,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrequencyResponseSolverPolicyIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<FrequencyResponseSolverMethodIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preconditioner: Option<FrequencyResponsePreconditionerIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtol: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_iterations: Option<u64>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<DynamicsIR>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bias_field_sweep: Option<BiasFieldSweepIR>,
        normalization: EigenNormalizationIR,
        damping_policy: EigenDampingPolicyIR,
        /// Spin-wave boundary condition applied to the eigenvalue operator.
        #[serde(default)]
        spin_wave_bc: SpinWaveBoundaryConditionIR,
        #[serde(default)]
        magnetostatic_bc: MagnetostaticBoundaryConditionIR,
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
        #[serde(default)]
        magnetostatic_bc: MagnetostaticBoundaryConditionIR,
        excitation: FrequencyExcitationIR,
        frequencies_hz: FrequencySweepIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solver_policy: Option<FrequencyResponseSolverPolicyIR>,
        sampling: SamplingIR,
    },
    Hysteresis {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_min_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_max_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_step_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_values_mT: Option<Vec<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_unit_provenance: Option<FieldUnitProvenanceIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        orientation: Option<FieldOrientationIR>,
        #[serde(default = "default_measurement_axis")]
        measurement_axis: MeasurementAxisIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angular_family: Option<HysteresisAngularFamilyIR>,
        #[serde(default = "default_initial_protocol")]
        initial_protocol: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_state_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        saturation: Option<SaturationProbeIR>,
        #[serde(default = "default_branch_mode")]
        branch_mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settle_pipeline: Option<SettlePipelineIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        storage: Option<HysteresisStorageIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_schedule: Option<FieldScheduleIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule_refinements: Option<Vec<FieldWindowIR>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        adaptive_refinement: Option<AdaptiveRefinementIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minor_loops: Option<Vec<MinorLoopIR>>,
        sampling: SamplingIR,
    },
}

static DEFAULT_DYNAMICS: std::sync::OnceLock<DynamicsIR> = std::sync::OnceLock::new();

fn get_default_dynamics() -> &'static DynamicsIR {
    DEFAULT_DYNAMICS.get_or_init(|| DynamicsIR::Llg {
        gyromagnetic_ratio: 2.211e5,
        integrator: "auto".to_string(),
        fixed_timestep: None,
        adaptive_timestep: None,
        field_refresh: None,
        mechanics: None,
    })
}

impl StudyIR {
    pub fn dynamics(&self) -> &DynamicsIR {
        self.optional_dynamics()
            .expect("this study does not define LLG dynamics")
    }

    pub fn optional_dynamics(&self) -> Option<&DynamicsIR> {
        match self {
            StudyIR::TimeEvolution { dynamics, .. }
            | StudyIR::Eigenmodes { dynamics, .. }
            | StudyIR::FrequencyResponse { dynamics, .. } => Some(dynamics),
            StudyIR::Relaxation { dynamics, .. } => dynamics.as_ref(),
            StudyIR::Hysteresis { .. } => Some(get_default_dynamics()),
        }
    }

    pub fn sampling(&self) -> &SamplingIR {
        match self {
            StudyIR::TimeEvolution { sampling, .. }
            | StudyIR::Relaxation { sampling, .. }
            | StudyIR::Eigenmodes { sampling, .. }
            | StudyIR::FrequencyResponse { sampling, .. }
            | StudyIR::Hysteresis { sampling, .. } => sampling,
        }
    }

    pub fn sampling_mut(&mut self) -> &mut SamplingIR {
        match self {
            StudyIR::TimeEvolution { sampling, .. }
            | StudyIR::Relaxation { sampling, .. }
            | StudyIR::Eigenmodes { sampling, .. }
            | StudyIR::FrequencyResponse { sampling, .. }
            | StudyIR::Hysteresis { sampling, .. } => sampling,
        }
    }

    pub fn relaxation(&self) -> Option<RelaxationControlIR> {
        match self {
            StudyIR::TimeEvolution { .. }
            | StudyIR::Eigenmodes { .. }
            | StudyIR::FrequencyResponse { .. }
            | StudyIR::Hysteresis { .. } => None,
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
    FieldAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyIR,
    },
    FieldResolvedAuto {
        name: String,
        every_seconds: f64,
        requested_policy: SamplingPeriodPolicyIR,
    },
    Scalar {
        name: String,
        every_seconds: f64,
    },
    ScalarAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyIR,
    },
    ScalarResolvedAuto {
        name: String,
        every_seconds: f64,
        requested_policy: SamplingPeriodPolicyIR,
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

impl OutputIR {
    pub fn periodic_name(&self) -> Option<&str> {
        match self {
            Self::Field { name, .. }
            | Self::FieldAuto { name, .. }
            | Self::FieldResolvedAuto { name, .. }
            | Self::Scalar { name, .. }
            | Self::ScalarAuto { name, .. }
            | Self::ScalarResolvedAuto { name, .. } => Some(name),
            _ => None,
        }
    }

    pub fn requests_auto_sinc_cutoff(&self) -> bool {
        matches!(
            self,
            Self::FieldAuto {
                sample_period_policy: SamplingPeriodPolicyIR::AutoSincCutoff { .. },
                ..
            } | Self::ScalarAuto {
                sample_period_policy: SamplingPeriodPolicyIR::AutoSincCutoff { .. },
                ..
            }
        )
    }

    pub fn resolved_auto_period_s(&self) -> Option<f64> {
        match self {
            Self::FieldResolvedAuto { every_seconds, .. }
            | Self::ScalarResolvedAuto { every_seconds, .. } => Some(*every_seconds),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BackendPolicyIR {
    pub requested_backend: BackendTarget,
    pub execution_precision: ExecutionPrecision,
    pub discretization_hints: Option<DiscretizationHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldOrientationIR {
    Preset { preset_name: String },
    Sample { theta: f64, phi: f64 },
    Global { vector: [f64; 3] },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldUnitProvenanceIR {
    pub authored_quantity: String,
    pub authored_unit: String,
    pub canonical_quantity: String,
    pub canonical_unit: String,
    pub display_unit: String,
    pub mu0_h_per_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum MeasurementAxisIR {
    Named(String),
    Custom { kind: String, vector: [f64; 3] },
}

impl MeasurementAxisIR {
    pub fn field_axis() -> Self {
        Self::Named("field_axis".to_string())
    }

    pub fn as_kind(&self) -> &str {
        match self {
            Self::Named(axis) => axis.as_str(),
            Self::Custom { kind, .. } => kind.as_str(),
        }
    }

    pub fn custom_vector(&self) -> Option<[f64; 3]> {
        match self {
            Self::Custom { vector, .. } => Some(*vector),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SaturationProbeIR {
    pub mode: String,
    pub max_field_mT: f64,
    pub susceptibility_threshold: f64,
    pub transverse_threshold: f64,
    #[serde(default = "default_saturation_on_failure")]
    pub on_failure: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HysteresisStorageIR {
    pub scalar_history: bool,
    pub magnetization: String,
    pub every_n: u32,
    pub key_events: bool,
    pub key_event_threshold_dm: f64,
}

fn default_adaptive_refinement_kind() -> String {
    "adaptive_refinement".to_string()
}

fn default_adaptive_refinement_enabled() -> bool {
    true
}

fn default_adaptive_refinement_max_passes() -> u32 {
    1
}

fn default_adaptive_refinement_max_insertions_per_pass() -> u32 {
    16
}

fn default_adaptive_refinement_dm_dh_threshold_per_m_t() -> f64 {
    0.02
}

fn default_adaptive_refinement_max_step_m_t() -> f64 {
    5.0
}

fn default_adaptive_refinement_min_step_m_t() -> f64 {
    0.1
}

fn default_adaptive_refinement_include_in_metrics() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveRefinementIR {
    #[serde(default = "default_adaptive_refinement_kind")]
    pub kind: String,
    #[serde(default = "default_adaptive_refinement_enabled")]
    pub enabled: bool,
    #[serde(default = "default_adaptive_refinement_max_passes")]
    pub max_passes: u32,
    #[serde(default = "default_adaptive_refinement_max_insertions_per_pass")]
    pub max_insertions_per_pass: u32,
    #[serde(default = "default_adaptive_refinement_dm_dh_threshold_per_m_t")]
    pub dm_dh_threshold_per_mT: f64,
    #[serde(default = "default_adaptive_refinement_max_step_m_t")]
    pub max_step_mT: f64,
    #[serde(default = "default_adaptive_refinement_min_step_m_t")]
    pub min_step_mT: f64,
    #[serde(default = "default_adaptive_refinement_enabled")]
    pub include_zero_crossings: bool,
    #[serde(default = "default_adaptive_refinement_enabled")]
    pub include_high_susceptibility: bool,
    #[serde(default = "default_adaptive_refinement_include_in_metrics")]
    pub include_in_metrics: bool,
}

fn default_hysteresis_angular_family_kind() -> String {
    "angular_family".to_string()
}

fn default_hysteresis_angular_family_id() -> String {
    "angular_family".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HysteresisAngularVariantIR {
    pub variant_id: String,
    pub orientation: FieldOrientationIR,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<MeasurementAxisIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HysteresisAngularFamilyIR {
    #[serde(default = "default_hysteresis_angular_family_kind")]
    pub kind: String,
    #[serde(default = "default_hysteresis_angular_family_id")]
    pub family_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    pub variants: Vec<HysteresisAngularVariantIR>,
}

fn default_hysteresis_minor_loop_continuation_policy() -> String {
    "branch_only".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinorLoopIR {
    pub reversal_mT: f64,
    pub return_mT: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub intermediate_fields_mT: Vec<f64>,
    #[serde(default = "default_hysteresis_minor_loop_continuation_policy")]
    pub continuation_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldSegmentIR {
    #[serde(default, alias = "segmentId")]
    pub segment_id: String,
    pub start: f64,
    pub stop: f64,
    pub step: f64,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_field_segment_endpoint_policy")]
    pub endpoint_policy: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldScheduleIR {
    pub segments: Vec<FieldSegmentIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldWindowIR {
    pub center_mT: f64,
    pub half_width_mT: f64,
    pub step_mT: f64,
    #[serde(default)]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettleStepIR {
    Relax {
        method: String,
        alpha: f64,
        torque_tolerance: f64,
        max_steps: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applies_to: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_criteria: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestep_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_pseudotime_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_physical_time_s: Option<f64>,
        on_non_convergence: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_timestep_scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_max_attempts: Option<u32>,
    },
    Minimize {
        method: String,
        torque_tolerance: f64,
        energy_tolerance: f64,
        max_steps: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applies_to: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_criteria: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestep_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_pseudotime_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_physical_time_s: Option<f64>,
        on_non_convergence: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_timestep_scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_max_attempts: Option<u32>,
    },
    DynamicsSettle {
        method: String,
        damping: f64,
        max_steps: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applies_to: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_criteria: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestep_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_pseudotime_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_physical_time_s: Option<f64>,
        on_non_convergence: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_timestep_scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_max_attempts: Option<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SettleBranchIR {
    pub when: String,
    pub run: SettleStepIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettlePipelineIR {
    Sequence {
        steps: Vec<SettleStepIR>,
    },
    Tree {
        default: SettleStepIR,
        branches: Vec<SettleBranchIR>,
    },
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

fn default_measurement_axis() -> MeasurementAxisIR {
    MeasurementAxisIR::field_axis()
}

fn default_initial_protocol() -> String {
    "positive_saturation".to_string()
}

fn default_saturation_on_failure() -> String {
    "continue_with_warning".to_string()
}

fn default_branch_mode() -> String {
    "major_loop".to_string()
}

fn default_field_segment_endpoint_policy() -> String {
    "include_stop".to_string()
}

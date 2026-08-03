use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

fn is_zero_f64(value: &f64) -> bool {
    *value == 0.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct SceneRegionRef {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum CurrentTransportKind {
    #[serde(rename = "current_transport")]
    CurrentTransport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CurrentTransportModel {
    PrescribedDensity,
    OhmicPoisson,
    MagnetoresistivePoisson,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneTransportCoupling {
    #[default]
    OneWay,
    Bidirectional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct KnownSceneCurrentTransport {
    pub kind: CurrentTransportKind,
    pub name: String,
    pub model: CurrentTransportModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_density: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve_region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conductivity_s_per_m: Option<f64>,
    #[serde(default)]
    pub coupling: SceneTransportCoupling,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domain: Vec<SceneRegionRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<SceneChargeTransportMaterialAssignment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundaries: Vec<SceneChargeBoundary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gauge: Option<SceneChargePotentialGauge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver: Option<SceneChargeSolverPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(untagged)]
pub enum SceneCurrentTransport {
    Known(KnownSceneCurrentTransport),
    Unsupported(UnsupportedAuthoringRecord),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct UnsupportedAuthoringRecord {
    #[serde(flatten)]
    pub payload: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneChargeTransportMaterial {
    #[serde(rename = "sigma_Spm")]
    pub sigma_spm: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_parallel_Spm"
    )]
    pub sigma_parallel_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_perpendicular_Spm"
    )]
    pub sigma_perpendicular_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_AHE_Spm"
    )]
    pub sigma_ahe_spm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneChargeTransportMaterialAssignment {
    pub region: SceneRegionRef,
    pub material: SceneChargeTransportMaterial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneChargeBoundary {
    VoltageElectrode {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
        #[serde(rename = "potential_V")]
        potential_v: f64,
    },
    NormalCurrentElectrode {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
        #[serde(rename = "outward_current_density_Apm2")]
        outward_current_density_apm2: f64,
    },
    Insulating {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneChargePotentialGauge {
    DirichletReference,
    ZeroMean,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneChargeSolverPolicy {
    pub engine: String,
    pub linear: SceneLinearTransportSolverPolicy,
    pub physical_residual_version: String,
    pub operator_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneSpinTransportMode {
    Steady,
    Transient,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(untagged)]
pub enum SceneReactionLength {
    Enabled(f64),
    Disabled(SceneDisabledReaction),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum SceneDisabledReaction {
    #[serde(rename = "disabled")]
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneSpinTransportMaterial {
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    pub lambda_j_m: SceneReactionLength,
    pub lambda_phi_m: SceneReactionLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "spin_capacitance_As_per_V_m3")]
    pub spin_capacitance_as_per_v_m3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacitance_formula_version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "density_of_states_per_spin_Jinv_m3"
    )]
    pub density_of_states_per_spin_j_inv_m3: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneSpinTransportMaterialAssignment {
    pub region: SceneRegionRef,
    pub material: SceneSpinTransportMaterial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneSurfaceRef {
    pub object_id: String,
    pub surface_id: String,
    pub orientation: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneSpinMemoryLossReservoir {
    #[serde(rename = "g_n_Spm2")]
    pub g_n_spm2: f64,
    #[serde(rename = "g_f_Spm2")]
    pub g_f_spm2: f64,
    #[serde(rename = "g_lattice_Spm2")]
    pub g_lattice_spm2: f64,
    pub formula_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneSpinInterface {
    Transparent {
        id: String,
        side_a: SceneRegionRef,
        side_b: SceneRegionRef,
        normal_a_to_b: [f64; 3],
    },
    MixingConductance {
        id: String,
        normal_to_ferromagnet: [f64; 3],
        normal_side: SceneRegionRef,
        ferromagnet_side: SceneRegionRef,
        #[serde(rename = "g_up_Spm2")]
        g_up_spm2: f64,
        #[serde(rename = "g_down_Spm2")]
        g_down_spm2: f64,
        #[serde(rename = "g_r_Spm2")]
        g_r_spm2: f64,
        #[serde(rename = "g_i_Spm2")]
        g_i_spm2: f64,
        #[serde(default, skip_serializing_if = "is_zero_f64", rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spin_memory_loss: Option<SceneSpinMemoryLossReservoir>,
        absorption: String,
        formula_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneSpinBoundary {
    SpinInsulating {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
    },
    SpinSink {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
    },
    SpecifiedSpinPotential {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
        #[serde(rename = "spin_potential_V")]
        spin_potential_v: [f64; 3],
    },
    SpecifiedSpinFlux {
        id: String,
        surfaces: Vec<SceneSurfaceRef>,
        #[serde(rename = "normal_spin_flux_Apm2")]
        normal_spin_flux_apm2: [f64; 3],
    },
    PeriodicSpin {
        id: String,
        minus_surface: SceneSurfaceRef,
        plus_surface: SceneSurfaceRef,
        translation_m: [f64; 3],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneLinearTransportSolverPolicy {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneSpinSolverPolicy {
    pub engine: String,
    pub linear: SceneLinearTransportSolverPolicy,
    pub physical_residual_version: String,
    pub operator_version: String,
    pub default_external_boundary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal_nonlinear: Option<SceneReciprocalNonlinearSolverPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneReciprocalNonlinearSolverPolicy {
    pub gmres_restart: u32,
    pub max_picard_iterations: u32,
    pub relative_update_tolerance: f64,
    pub eta_transport: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneTransportDiscretization {
    Fdm,
    Fem,
    Auto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneTransportDevice {
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneTransportPrecision {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneTransportExecutionMode {
    Strict,
    Extended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneRequestedTransportExecution {
    pub discretization: SceneTransportDiscretization,
    pub device: SceneTransportDevice,
    pub precision: SceneTransportPrecision,
    pub execution_mode: SceneTransportExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct KnownSceneSpinTransport {
    pub schema_version: String,
    pub id: String,
    pub current_source_id: String,
    pub mode: SceneSpinTransportMode,
    pub domain: Vec<SceneRegionRef>,
    pub materials: Vec<SceneSpinTransportMaterialAssignment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<SceneSpinInterface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundaries: Vec<SceneSpinBoundary>,
    pub solver: SceneSpinSolverPolicy,
    pub requested_execution: SceneRequestedTransportExecution,
    pub constitutive_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(untagged)]
pub enum SceneSpinTransport {
    Known(KnownSceneSpinTransport),
    Unsupported(UnsupportedAuthoringRecord),
}

impl SceneSpinTransport {
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Known(value) => Some(&value.id),
            Self::Unsupported(value) => value.payload.get("id").and_then(|value| value.as_str()),
        }
    }

    pub fn known(&self) -> Option<&KnownSceneSpinTransport> {
        match self {
            Self::Known(value) => Some(value),
            Self::Unsupported(_) => None,
        }
    }
}

impl SceneCurrentTransport {
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Known(value) => Some(&value.name),
            Self::Unsupported(value) => value.payload.get("name").and_then(|v| v.as_str()),
        }
    }

    pub fn known(&self) -> Option<&KnownSceneCurrentTransport> {
        match self {
            Self::Known(value) => Some(value),
            Self::Unsupported(_) => None,
        }
    }

    pub fn known_mut(&mut self) -> Option<&mut KnownSceneCurrentTransport> {
        match self {
            Self::Known(value) => Some(value),
            Self::Unsupported(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum SlonczewskiFormulaVersion {
    #[serde(rename = "slonczewski.fullmag.v2")]
    FullmagV2,
    /// Historical canonical evaluator. It is accepted only when inspecting
    /// read-only provenance, never when authoring a new scene.
    #[serde(rename = "slonczewski.fullmag.v1")]
    FullmagV1,
    #[serde(rename = "slonczewski.legacy_fullmag.v0")]
    LegacyFullmagV0,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct SlonczewskiRealization {
    pub kind: SlonczewskiRealizationKind,
    pub realization_version: SlonczewskiRealizationVersion,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum SlonczewskiRealizationKind {
    #[serde(rename = "thin_layer_homogenized")]
    ThinLayerHomogenized,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum SlonczewskiRealizationVersion {
    #[serde(rename = "slonczewski_thin_layer_homogenized.v1")]
    V1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum PrescribedSotSchemaVersion {
    #[serde(rename = "prescribed_sot.v1")]
    V1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum PrescribedSotFormulaVersion {
    #[serde(rename = "prescribed_sot.fullmag.v1")]
    FullmagV1,
    #[serde(rename = "prescribed_sot.legacy_fullmag.v0")]
    LegacyFullmagV0,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneTimeEnvelope {
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
        points: Vec<SceneTimeEnvelopePoint>,
    },
    Sinc {
        amplitude: f64,
        center_s: f64,
        bandwidth_hz: f64,
        offset: f64,
    },
    Tabulated {
        artifact_ref: String,
        interpolation: SceneEnvelopeInterpolation,
        extrapolation: SceneEnvelopeExtrapolation,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bandwidth_hz: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct SceneTimeEnvelopePoint {
    pub time_s: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneEnvelopeInterpolation {
    Linear,
    Previous,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneEnvelopeExtrapolation {
    Zero,
    Hold,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScenePrescribedSotDrive {
    SignedScalar {
        #[serde(rename = "current_density_Apm2")]
        current_density_apm2: f64,
        sigma_hat: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        envelope: Option<SceneTimeEnvelope>,
    },
    VectorCurrentSource {
        current_source_id: String,
        drive_direction: [f64; 3],
        interface_normal: [f64; 3],
    },
    LegacyScalarMagnitude {
        #[serde(rename = "raw_charge_current_density_Apm2")]
        raw_charge_current_density_apm2: f64,
    },
    LegacyCurrentSourceNorm {
        current_source_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct SceneCompatibilityOrigin {
    pub source_ir_version: String,
    pub authored_kind: String,
    #[serde(flatten)]
    pub additional: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownSceneSpinTorque {
    Slonczewski {
        #[serde(default)]
        id: String,
        formula_version: SlonczewskiFormulaVersion,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        spin_polarization: [f64; 3],
        degree: f64,
        lambda_asymmetry: f64,
        epsilon_prime: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        free_layer_thickness_m: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fixed_layer_position: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<SceneRegionRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack_normal: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        realization: Option<SlonczewskiRealization>,
    },
    ZhangLi {
        #[serde(default)]
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_density: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_source: Option<String>,
        degree: f64,
        beta: f64,
    },
    PrescribedSot {
        #[serde(default)]
        id: String,
        schema_version: PrescribedSotSchemaVersion,
        formula_version: PrescribedSotFormulaVersion,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<SceneRegionRef>,
        drive: ScenePrescribedSotDrive,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_spin_polarization: Option<[f64; 3]>,
        xi_dl: f64,
        xi_fl: f64,
        free_layer_thickness_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compatibility_origin: Option<SceneCompatibilityOrigin>,
    },
}

impl KnownSceneSpinTorque {
    pub fn id(&self) -> &str {
        match self {
            Self::Slonczewski { id, .. }
            | Self::ZhangLi { id, .. }
            | Self::PrescribedSot { id, .. } => id,
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        match self {
            Self::Slonczewski { id, .. }
            | Self::ZhangLi { id, .. }
            | Self::PrescribedSot { id, .. }
                if id.is_empty() =>
            {
                *id = fallback
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(untagged)]
pub enum SceneSpinTorque {
    Known(KnownSceneSpinTorque),
    Unsupported(UnsupportedAuthoringRecord),
}

impl SceneSpinTorque {
    pub fn id(&self) -> &str {
        match self {
            Self::Known(value) => value.id(),
            Self::Unsupported(value) => value
                .payload
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        if let Self::Known(value) = self {
            value.ensure_authoring_id(fallback);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneOerstedTimeDependence {
    Constant,
    Sinusoidal {
        frequency_hz: f64,
        phase_rad: f64,
        offset: f64,
    },
    Pulse {
        t_on: f64,
        t_off: f64,
    },
    PiecewiseLinear {
        points: Vec<[f64; 2]>,
    },
    SincPulse {
        cutoff_hz: f64,
        t0: f64,
        amplitude: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum OerstedFieldModel {
    #[serde(rename = "from_current_solution")]
    FromCurrentSolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownSceneOerstedField {
    OerstedCylinder {
        #[serde(default)]
        id: String,
        current: f64,
        radius: f64,
        center: [f64; 3],
        axis: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_dependence: Option<SceneOerstedTimeDependence>,
    },
    OerstedField {
        #[serde(default)]
        id: String,
        source: String,
        model: OerstedFieldModel,
    },
}

impl KnownSceneOerstedField {
    pub fn id(&self) -> &str {
        match self {
            Self::OerstedCylinder { id, .. } | Self::OerstedField { id, .. } => id,
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        match self {
            Self::OerstedCylinder { id, .. } | Self::OerstedField { id, .. } if id.is_empty() => {
                *id = fallback;
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(untagged)]
pub enum SceneOerstedField {
    Known(KnownSceneOerstedField),
    Unsupported(UnsupportedAuthoringRecord),
}

impl SceneOerstedField {
    pub fn id(&self) -> &str {
        match self {
            Self::Known(value) => value.id(),
            Self::Unsupported(value) => value
                .payload
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        if let Self::Known(value) = self {
            value.ensure_authoring_id(fallback);
        }
    }
}

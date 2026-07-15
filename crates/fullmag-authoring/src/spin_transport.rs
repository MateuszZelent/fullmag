use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

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

impl SceneCurrentTransport {
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Known(value) => Some(&value.name),
            Self::Unsupported(value) => value.payload.get("name").and_then(|v| v.as_str()),
        }
    }

    pub fn known(&self) -> Option<&KnownSceneCurrentTransport> {
        match self { Self::Known(value) => Some(value), Self::Unsupported(_) => None }
    }

    pub fn known_mut(&mut self) -> Option<&mut KnownSceneCurrentTransport> {
        match self { Self::Known(value) => Some(value), Self::Unsupported(_) => None }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum SlonczewskiFormulaVersion {
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
            | Self::PrescribedSot { id, .. } if id.is_empty() => *id = fallback,
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
            Self::Unsupported(value) => value.payload.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        if let Self::Known(value) = self { value.ensure_authoring_id(fallback); }
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
            Self::Unsupported(value) => value.payload.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        }
    }

    pub fn ensure_authoring_id(&mut self, fallback: String) {
        if let Self::Known(value) = self { value.ensure_authoring_id(fallback); }
    }
}

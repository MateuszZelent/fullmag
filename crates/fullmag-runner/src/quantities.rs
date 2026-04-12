use crate::types::{RunError, StepStats};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityId {
    M,
    HEx,
    HDemag,
    HExt,
    HAnt,
    HEff,
    HAni,
    HDmi,
    HMel,
    // FND-010 fix: add F-12 observable quantities
    HAniCubic,
    HDmiBulk,
    HOe,
    HTherm,
    EEx,
    EDemag,
    EExt,
    EAni,
    EDmi,
    ETotal,
    ModeAmplitude,
    ModeReal,
    ModeImag,
    ModePhase,
}

/// Where the quantity is located on the mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityLocation {
    /// Per-node (vertex) value.
    Node,
    /// Per-cell (element) value.
    Cell,
    /// Single global scalar (not spatially distributed).
    Global,
}

impl QuantityLocation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Cell => "cell",
            Self::Global => "global",
        }
    }
}

/// Spatial domain that a quantity physically occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityDomain {
    /// Defined only on magnetic elements/nodes.
    MagneticOnly,
    /// Defined on the entire computational domain including airbox.
    FullDomain,
}

impl QuantityDomain {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MagneticOnly => "magnetic_only",
            Self::FullDomain => "full_domain",
        }
    }
}

/// Hint for how the UI should normalize visual representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizationHint {
    /// Already normalised to [-1, 1] (e.g. reduced magnetization).
    UnitVector,
    /// Normalize by the max absolute value in the dataset.
    MaxAbs,
    /// No normalization — show raw values.
    None,
}

impl QuantityId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::M => "m",
            Self::HEx => "H_ex",
            Self::HDemag => "H_demag",
            Self::HExt => "H_ext",
            Self::HAnt => "H_ant",
            Self::HEff => "H_eff",
            Self::HAni => "H_ani",
            Self::HDmi => "H_dmi",
            Self::HMel => "H_mel",
            Self::HAniCubic => "H_ani_cubic",
            Self::HDmiBulk => "H_dmi_bulk",
            Self::HOe => "H_oe",
            Self::HTherm => "H_therm",
            Self::EEx => "E_ex",
            Self::EDemag => "E_demag",
            Self::EExt => "E_ext",
            Self::EAni => "E_ani",
            Self::EDmi => "E_dmi",
            Self::ETotal => "E_total",
            Self::ModeAmplitude => "mode_amplitude",
            Self::ModeReal => "mode_real",
            Self::ModeImag => "mode_imag",
            Self::ModePhase => "mode_phase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityComponent {
    Vector3,
    X,
    Y,
    Z,
    Magnitude,
}

impl QuantityComponent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Vector3 => "3D",
            Self::X => "x",
            Self::Y => "y",
            Self::Z => "z",
            Self::Magnitude => "magnitude",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuantityKind {
    VectorField,
    SpatialScalar,
    GlobalScalar,
}

impl QuantityKind {
    pub const fn as_api_kind(self) -> &'static str {
        match self {
            Self::VectorField => "vector_field",
            Self::SpatialScalar => "spatial_scalar",
            Self::GlobalScalar => "global_scalar",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct QuantitySpec {
    pub id: QuantityId,
    pub label: &'static str,
    pub kind: QuantityKind,
    pub unit: &'static str,
    pub interactive_preview: bool,
    pub quick_access_label: Option<&'static str>,
    pub scalar_metric_key: Option<&'static str>,
    pub ui_exposed: bool,
    // --- PH-01: extended contract fields ---
    /// Number of components (3 for vector, 1 for scalar).
    pub n_comp: u8,
    /// Where the quantity lives on the mesh.
    pub location: QuantityLocation,
    /// Physical region the quantity occupies.
    pub domain: QuantityDomain,
    /// UI normalization strategy.
    pub normalization_hint: NormalizationHint,
    /// Whether the quantity supports 2-D preview slicing.
    pub supports_preview_2d: bool,
    /// Whether the quantity supports 3-D preview rendering.
    pub supports_preview_3d: bool,
    /// Whether the quantity can appear in time-series history charts.
    pub supports_history: bool,
    /// Whether the quantity can be exported to VTK / HDF5.
    pub supports_export: bool,
}

const QUANTITY_SPECS: [QuantitySpec; 23] = [
    QuantitySpec {
        id: QuantityId::M,
        label: "Magnetization",
        kind: QuantityKind::VectorField,
        unit: "dimensionless",
        interactive_preview: true,
        quick_access_label: Some("M"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::UnitVector,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HEx,
        label: "Exchange Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_ex"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HDemag,
        label: "Demagnetization Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_demag"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HExt,
        label: "External Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_ext"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HAnt,
        label: "Antenna Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_ant"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HEff,
        label: "Effective Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_eff"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HAni,
        label: "Anisotropy Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_ani"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HDmi,
        label: "DMI Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_dmi"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HMel,
        label: "Magnetoelastic Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_mel"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    // FND-010 fix: add F-12 observable quantity specs
    QuantitySpec {
        id: QuantityId::HAniCubic,
        label: "Cubic Anisotropy Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_ani_cubic"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HDmiBulk,
        label: "Bulk DMI Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_dmi_bulk"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HOe,
        label: "Oersted Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_oe"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::HTherm,
        label: "Thermal Noise Field",
        kind: QuantityKind::VectorField,
        unit: "A/m",
        interactive_preview: true,
        quick_access_label: Some("H_therm"),
        scalar_metric_key: None,
        ui_exposed: true,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: true,
        supports_preview_3d: true,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::EEx,
        label: "Exchange Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_ex"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    },
    QuantitySpec {
        id: QuantityId::EDemag,
        label: "Demagnetization Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_demag"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::EExt,
        label: "External Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_ext"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::EAni,
        label: "Anisotropy Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_ani"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::EDmi,
        label: "DMI Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_dmi"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::ETotal,
        label: "Total Energy",
        kind: QuantityKind::GlobalScalar,
        unit: "J",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: Some("e_total"),
        ui_exposed: true,
        n_comp: 1,
        location: QuantityLocation::Global,
        domain: QuantityDomain::FullDomain,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: true,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::ModeAmplitude,
        label: "Mode Amplitude",
        kind: QuantityKind::SpatialScalar,
        unit: "dimensionless",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: None,
        ui_exposed: false,
        n_comp: 1,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::ModeReal,
        label: "Mode Real Part",
        kind: QuantityKind::VectorField,
        unit: "dimensionless",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: None,
        ui_exposed: false,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::ModeImag,
        label: "Mode Imaginary Part",
        kind: QuantityKind::VectorField,
        unit: "dimensionless",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: None,
        ui_exposed: false,
        n_comp: 3,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::MaxAbs,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: false,
        supports_export: true,
    },
    QuantitySpec {
        id: QuantityId::ModePhase,
        label: "Mode Phase",
        kind: QuantityKind::SpatialScalar,
        unit: "rad",
        interactive_preview: false,
        quick_access_label: None,
        scalar_metric_key: None,
        ui_exposed: false,
        n_comp: 1,
        location: QuantityLocation::Node,
        domain: QuantityDomain::MagneticOnly,
        normalization_hint: NormalizationHint::None,
        supports_preview_2d: false,
        supports_preview_3d: false,
        supports_history: false,
        supports_export: true,
    },
];

pub fn quantity_specs() -> &'static [QuantitySpec] {
    &QUANTITY_SPECS
}

pub fn quantity_spec(id: &str) -> Option<&'static QuantitySpec> {
    let normalized = normalize_quantity_id(id).ok()?;
    QUANTITY_SPECS
        .iter()
        .find(|spec| spec.id.as_str() == normalized.as_str())
}

pub fn interactive_preview_quantity_ids() -> Vec<&'static str> {
    QUANTITY_SPECS
        .iter()
        .filter(|spec| spec.ui_exposed && spec.interactive_preview)
        .map(|spec| spec.id.as_str())
        .collect()
}

pub fn cached_preview_quantity_ids() -> Vec<&'static str> {
    QUANTITY_SPECS
        .iter()
        .filter(|spec| {
            spec.ui_exposed && spec.interactive_preview && spec.kind == QuantityKind::VectorField
        })
        .map(|spec| spec.id.as_str())
        .collect()
}

pub fn quantity_unit(id: &str) -> &'static str {
    quantity_spec(id).map(|spec| spec.unit).unwrap_or("")
}

pub fn quantity_spatial_domain(id: &str) -> &'static str {
    quantity_spec(id)
        .map(|spec| spec.domain.as_str())
        .unwrap_or(QuantityDomain::FullDomain.as_str())
}

pub fn normalize_quantity_id(requested: &str) -> Result<QuantityId, RunError> {
    match requested {
        "m" => Ok(QuantityId::M),
        "H_ex" => Ok(QuantityId::HEx),
        "H_demag" => Ok(QuantityId::HDemag),
        "H_ant" => Ok(QuantityId::HAnt),
        "H_ext" => Ok(QuantityId::HExt),
        "H_eff" => Ok(QuantityId::HEff),
        "H_ani" => Ok(QuantityId::HAni),
        "H_dmi" => Ok(QuantityId::HDmi),
        "H_mel" => Ok(QuantityId::HMel),
        "H_ani_cubic" => Ok(QuantityId::HAniCubic),
        "H_dmi_bulk" => Ok(QuantityId::HDmiBulk),
        "H_oe" => Ok(QuantityId::HOe),
        "H_therm" => Ok(QuantityId::HTherm),
        "E_ex" => Ok(QuantityId::EEx),
        "E_demag" => Ok(QuantityId::EDemag),
        "E_ext" => Ok(QuantityId::EExt),
        "E_ani" => Ok(QuantityId::EAni),
        "E_dmi" => Ok(QuantityId::EDmi),
        "E_total" => Ok(QuantityId::ETotal),
        "mode_amplitude" => Ok(QuantityId::ModeAmplitude),
        "mode_real" => Ok(QuantityId::ModeReal),
        "mode_imag" => Ok(QuantityId::ModeImag),
        "mode_phase" => Ok(QuantityId::ModePhase),
        other => Err(RunError {
            message: format!("unsupported quantity '{}'", other),
        }),
    }
}

pub fn parse_quantity_component(component: &str) -> Result<QuantityComponent, RunError> {
    match component {
        "3D" => Ok(QuantityComponent::Vector3),
        "x" => Ok(QuantityComponent::X),
        "y" => Ok(QuantityComponent::Y),
        "z" => Ok(QuantityComponent::Z),
        "magnitude" => Ok(QuantityComponent::Magnitude),
        other => Err(RunError {
            message: format!("unsupported quantity component '{}'", other),
        }),
    }
}

pub fn normalized_quantity_name(requested: &str) -> Result<&'static str, RunError> {
    Ok(normalize_quantity_id(requested)?.as_str())
}

pub fn global_scalar_value(id: &str, stats: &StepStats) -> Option<f64> {
    match quantity_spec(id)?.scalar_metric_key? {
        "e_ex" => Some(stats.e_ex),
        "e_demag" => Some(stats.e_demag),
        "e_ext" => Some(stats.e_ext),
        "e_ani" => Some(stats.e_ani),
        "e_dmi" => Some(stats.e_dmi),
        "e_total" => Some(stats.e_total),
        _ => None,
    }
}

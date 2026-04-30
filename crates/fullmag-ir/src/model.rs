//! Physical model types for `ProblemIR`.
//!
//! Contains: problem metadata, geometry (entries, CSG), region/material/magnet
//! definitions, initial magnetization (texture/uniform/sampled), and the
//! time-dependence envelope used by fields and currents.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::ImportedGeometryScaleIR;

// ── Problem metadata ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProblemMeta {
    pub name: String,
    pub description: Option<String>,
    pub script_language: String,
    pub script_source: Option<String>,
    pub script_api_version: String,
    pub serializer_version: String,
    pub entrypoint_kind: String,
    pub source_hash: Option<String>,
    pub runtime_metadata: BTreeMap<String, Value>,
    pub backend_revision: Option<String>,
    pub seeds: Vec<u64>,
}

// ── Geometry ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeometryIR {
    pub entries: Vec<GeometryEntryIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GeometryEntryIR {
    ImportedGeometry {
        name: String,
        source: String,
        format: String,
        #[serde(default)]
        scale: ImportedGeometryScaleIR,
    },
    Box {
        name: String,
        size: [f64; 3],
    },
    Cylinder {
        name: String,
        radius: f64,
        height: f64,
    },
    Ellipsoid {
        name: String,
        radii: [f64; 3],
    },
    Sphere {
        name: String,
        radius: f64,
    },
    Ellipse {
        name: String,
        radii: [f64; 2],
        height: f64,
    },
    Difference {
        name: String,
        base: std::boxed::Box<GeometryEntryIR>,
        tool: std::boxed::Box<GeometryEntryIR>,
    },
    Union {
        name: String,
        a: std::boxed::Box<GeometryEntryIR>,
        b: std::boxed::Box<GeometryEntryIR>,
    },
    Intersection {
        name: String,
        a: std::boxed::Box<GeometryEntryIR>,
        b: std::boxed::Box<GeometryEntryIR>,
    },
    Translate {
        name: String,
        base: std::boxed::Box<GeometryEntryIR>,
        by: [f64; 3],
    },
}

impl GeometryEntryIR {
    pub fn name(&self) -> &str {
        match self {
            Self::ImportedGeometry { name, .. }
            | Self::Box { name, .. }
            | Self::Cylinder { name, .. }
            | Self::Ellipsoid { name, .. }
            | Self::Sphere { name, .. }
            | Self::Ellipse { name, .. }
            | Self::Difference { name, .. }
            | Self::Union { name, .. }
            | Self::Intersection { name, .. }
            | Self::Translate { name, .. } => name,
        }
    }
}

// ── Region / material / magnet ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegionIR {
    pub name: String,
    pub geometry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialIR {
    pub name: String,
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub uniaxial_anisotropy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniaxial_anisotropy_k2: Option<f64>,
    pub anisotropy_axis: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis1: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis2: Option<[f64; 3]>,
    // Per-node spatially varying fields (when Some, override the scalar)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ku_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ku2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc1_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc3_field: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MagnetIR {
    pub name: String,
    pub region: String,
    pub material: String,
    pub initial_magnetization: Option<InitialMagnetizationIR>,
}

// ── Initial magnetization / texture ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialMagnetizationIR {
    Uniform {
        value: [f64; 3],
    },
    #[serde(alias = "random")]
    RandomSeeded {
        seed: u64,
    },
    SampledField {
        values: Vec<[f64; 3]>,
    },
    PresetTexture {
        preset_kind: String,
        #[serde(default)]
        params: BTreeMap<String, Value>,
        #[serde(default)]
        mapping: TextureMappingIR,
        #[serde(default)]
        texture_transform: TextureTransform3DIR,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextureMappingIR {
    #[serde(default = "default_texture_mapping_space")]
    pub space: String,
    #[serde(default)]
    pub projection: TextureProjectionMode,
    #[serde(default = "default_texture_mapping_clamp_mode")]
    pub clamp_mode: String,
}

/// Supported texture projection modes.
///
/// Kept in sync with the frontend `TextureProjectionMode` union
/// and the planner `match mapping.projection { … }`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextureProjectionMode {
    #[default]
    ObjectLocal,
    PlanarXy,
    PlanarXz,
    PlanarYz,
}

impl std::fmt::Display for TextureProjectionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ObjectLocal => write!(f, "object_local"),
            Self::PlanarXy => write!(f, "planar_xy"),
            Self::PlanarXz => write!(f, "planar_xz"),
            Self::PlanarYz => write!(f, "planar_yz"),
        }
    }
}

impl Default for TextureMappingIR {
    fn default() -> Self {
        Self {
            space: default_texture_mapping_space(),
            projection: TextureProjectionMode::default(),
            clamp_mode: default_texture_mapping_clamp_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextureTransform3DIR {
    #[serde(default = "default_texture_translation")]
    pub translation: [f64; 3],
    #[serde(default = "default_texture_rotation_quat")]
    pub rotation_quat: [f64; 4],
    #[serde(default = "default_texture_scale")]
    pub scale: [f64; 3],
    #[serde(default = "default_texture_pivot")]
    pub pivot: [f64; 3],
}

impl Default for TextureTransform3DIR {
    fn default() -> Self {
        Self {
            translation: default_texture_translation(),
            rotation_quat: default_texture_rotation_quat(),
            scale: default_texture_scale(),
            pivot: default_texture_pivot(),
        }
    }
}

fn default_texture_mapping_space() -> String {
    "object".to_string()
}

fn default_texture_mapping_clamp_mode() -> String {
    "clamp".to_string()
}

fn default_texture_translation() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

fn default_texture_rotation_quat() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn default_texture_scale() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}

fn default_texture_pivot() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

// ── Time-dependence envelope ──────────────────────────────────────────────────

/// Time-dependence envelope for fields and currents.
///
/// The effective value at time `t` is: `amplitude(t) = base * f(t)`
/// where `f(t)` is defined by the variant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimeDependenceIR {
    /// Constant: f(t) = 1
    Constant,
    /// Sinusoidal: f(t) = sin(2π·freq·t + phase) + offset
    Sinusoidal {
        frequency_hz: f64,
        #[serde(default)]
        phase_rad: f64,
        #[serde(default)]
        offset: f64,
    },
    /// Rectangular pulse: f(t) = 1 for t_on ≤ t < t_off, else 0
    Pulse { t_on: f64, t_off: f64 },
    /// Piecewise linear: pairs of (time, value), linearly interpolated
    PiecewiseLinear { points: Vec<[f64; 2]> },
}

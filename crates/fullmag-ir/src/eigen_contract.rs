//! Eigen / dispersion contract extracted from the monolithic `lib.rs`.
//!
//! This file is designed to be imported from `crates/fullmag-ir/src/lib.rs`
//! and to replace the current inline eigen-only contract pieces. It does not
//! try to move the whole IR out of `lib.rs`; it only isolates the modal /
//! dispersion surface so that the runner and the frontend can evolve without
//! repeatedly editing a giant catch-all file.

use serde::{Deserialize, Serialize};

fn default_overlap_floor() -> f64 {
    0.50
}

fn default_max_branch_gap() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhaseConventionIR {
    ExpMinusIKDotDeltaR,
}

impl Default for PhaseConventionIR {
    fn default() -> Self {
        Self::ExpMinusIKDotDeltaR
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KPointIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub k_vector: [f64; 3],
}

impl KPointIR {
    pub fn gamma() -> Self {
        Self {
            label: Some("Γ".to_string()),
            k_vector: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EigenSpectrumScopeIR {
    Global,
    PerSample,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModeTrackingMethodIR {
    OverlapGreedy,
    OverlapHungarian,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModeTrackingIR {
    pub method: ModeTrackingMethodIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency_window_hz: Option<f64>,
    #[serde(default = "default_overlap_floor")]
    pub overlap_floor: f64,
    #[serde(default = "default_max_branch_gap")]
    pub max_branch_gap: u32,
}

impl Default for ModeTrackingIR {
    fn default() -> Self {
        Self {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: default_overlap_floor(),
            max_branch_gap: default_max_branch_gap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SampleSelectorIR {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample_labels: Vec<String>,
}

impl SampleSelectorIR {
    pub fn is_empty(&self) -> bool {
        self.sample_indices.is_empty() && self.sample_labels.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EigenSpectrumOutputIR {
    pub quantity: String,
    pub scope: EigenSpectrumScopeIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EigenModeOutputIR {
    pub field: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_selector: Option<SampleSelectorIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DispersionCurveOutputIR {
    pub name: String,
    #[serde(default)]
    pub include_branch_table: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EigenDiagnosticsOutputIR {
    #[serde(default)]
    pub include_tracking: bool,
    #[serde(default)]
    pub include_residuals: bool,
    #[serde(default)]
    pub include_overlaps: bool,
    #[serde(default)]
    pub include_tangent_leakage: bool,
    #[serde(default)]
    pub include_orthogonality: bool,
}

impl Default for EigenDiagnosticsOutputIR {
    fn default() -> Self {
        Self {
            include_tracking: true,
            include_residuals: true,
            include_overlaps: true,
            include_tangent_leakage: true,
            include_orthogonality: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DynamicFieldIR {
    pub field_au_per_m: [f64; 3],
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SweepIR {
    pub values_hz: Vec<f64>,
}

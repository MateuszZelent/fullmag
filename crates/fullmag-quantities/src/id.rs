//! Canonical quantity identifiers.

use serde::{Deserialize, Serialize};

/// Canonical quantity identifier.
///
/// The `as_str()` representation is the frozen wire-format string used
/// across IR, API, Python, and frontend.  These values **must not change**.
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
    // ── Second wave (QB-17) ──
    /// Spatial exchange energy density (J/m³).
    EdenEx,
    /// Spatial demagnetization energy density (J/m³).
    EdenDemag,
    /// Spatial Zeeman energy density (J/m³).
    EdenExt,
    /// Spatial anisotropy energy density (J/m³).
    EdenAni,
    /// Spatial DMI energy density (J/m³).
    EdenDmi,
    /// Spatial total energy density (J/m³).
    EdenTotal,
    /// Magnetization rate of change (spatial vector field).
    DmDt,
    /// Spin-transfer torque — adiabatic / field-like (spatial vector field).
    TorqueStt,
    /// Spin-orbit torque — damping-like (spatial vector field).
    TorqueSot,
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
            // Second wave (QB-17)
            Self::EdenEx => "eden_ex",
            Self::EdenDemag => "eden_demag",
            Self::EdenExt => "eden_ext",
            Self::EdenAni => "eden_ani",
            Self::EdenDmi => "eden_dmi",
            Self::EdenTotal => "eden_total",
            Self::DmDt => "dm_dt",
            Self::TorqueStt => "torque_stt",
            Self::TorqueSot => "torque_sot",
        }
    }

    /// All defined quantity IDs.
    pub const ALL: &'static [QuantityId] = &[
        Self::M,
        Self::HEx,
        Self::HDemag,
        Self::HExt,
        Self::HAnt,
        Self::HEff,
        Self::HAni,
        Self::HDmi,
        Self::HMel,
        Self::HAniCubic,
        Self::HDmiBulk,
        Self::HOe,
        Self::HTherm,
        Self::EEx,
        Self::EDemag,
        Self::EExt,
        Self::EAni,
        Self::EDmi,
        Self::ETotal,
        Self::ModeAmplitude,
        Self::ModeReal,
        Self::ModeImag,
        Self::ModePhase,
        // Second wave (QB-17)
        Self::EdenEx,
        Self::EdenDemag,
        Self::EdenExt,
        Self::EdenAni,
        Self::EdenDmi,
        Self::EdenTotal,
        Self::DmDt,
        Self::TorqueStt,
        Self::TorqueSot,
    ];
}

impl std::fmt::Display for QuantityId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned when a quantity ID string is not recognized.
#[derive(Debug, Clone)]
pub struct QuantityIdError {
    pub requested: String,
}

impl std::fmt::Display for QuantityIdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unsupported quantity '{}'", self.requested)
    }
}

impl std::error::Error for QuantityIdError {}

/// Parse a string into a canonical `QuantityId`.
///
/// Accepts the canonical wire-format strings plus common aliases
/// (e.g. `"M"` → `QuantityId::M`).
pub fn normalize_quantity_id(requested: &str) -> Result<QuantityId, QuantityIdError> {
    match requested {
        "m" | "M" => Ok(QuantityId::M),
        "H_ex" => Ok(QuantityId::HEx),
        "H_demag" => Ok(QuantityId::HDemag),
        "H_ext" => Ok(QuantityId::HExt),
        "H_ant" => Ok(QuantityId::HAnt),
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
        // Second wave (QB-17)
        "eden_ex" => Ok(QuantityId::EdenEx),
        "eden_demag" => Ok(QuantityId::EdenDemag),
        "eden_ext" => Ok(QuantityId::EdenExt),
        "eden_ani" => Ok(QuantityId::EdenAni),
        "eden_dmi" => Ok(QuantityId::EdenDmi),
        "eden_total" => Ok(QuantityId::EdenTotal),
        "dm_dt" => Ok(QuantityId::DmDt),
        "torque_stt" => Ok(QuantityId::TorqueStt),
        "torque_sot" => Ok(QuantityId::TorqueSot),
        other => Err(QuantityIdError {
            requested: other.to_string(),
        }),
    }
}

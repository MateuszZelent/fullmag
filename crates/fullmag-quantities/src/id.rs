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
    Torque,
    HAni,
    HDmi,
    HMel,
    U,
    Eps,
    Sigma,
    HAniCubic,
    HDmiBulk,
    HOe,
    HTherm,
    EEx,
    EDemag,
    EExt,
    EAni,
    EDmi,
    EEl,
    EKinEl,
    ElasticResidualNorm,
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
    /// Magnetostatic scalar potential from the Poisson demag solve.
    DemagPhi,
    /// Spatial Zeeman energy density (J/m³).
    EdenExt,
    /// Spatial anisotropy energy density (J/m³).
    EdenAni,
    /// Spatial DMI energy density (J/m³).
    EdenDmi,
    /// Spatial total energy density (J/m³).
    EdenTotal,
    /// Resolved saturation magnetization material parameter (A/m).
    MatMs,
    /// Resolved exchange stiffness material parameter (J/m).
    MatAex,
    /// Resolved Gilbert damping material parameter (dimensionless).
    MatAlpha,
    /// Resolved interfacial DMI material parameter (J/m²).
    MatDind,
    /// Resolved bulk DMI material parameter (J/m³).
    MatDbulk,
    /// Magnetization rate of change (spatial vector field).
    DmDt,
    /// Electric scalar potential from charge transport.
    VElectric,
    /// Charge-current density.
    JCharge,
    /// Spin-accumulation potential.
    SpinPotential,
    /// Spin-current tensor in row-major Q_ia order.
    SpinCurrentTensor,
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
            Self::Torque => "torque",
            Self::HAni => "H_ani",
            Self::HDmi => "H_dmi",
            Self::HMel => "H_mel",
            Self::U => "u",
            Self::Eps => "eps",
            Self::Sigma => "sigma",
            Self::HAniCubic => "H_ani_cubic",
            Self::HDmiBulk => "H_dmi_bulk",
            Self::HOe => "H_oe",
            Self::HTherm => "H_therm",
            Self::EEx => "E_ex",
            Self::EDemag => "E_demag",
            Self::EExt => "E_ext",
            Self::EAni => "E_ani",
            Self::EDmi => "E_dmi",
            Self::EEl => "E_el",
            Self::EKinEl => "E_kin_el",
            Self::ElasticResidualNorm => "elastic_residual_norm",
            Self::ETotal => "E_total",
            Self::ModeAmplitude => "mode_amplitude",
            Self::ModeReal => "mode_real",
            Self::ModeImag => "mode_imag",
            Self::ModePhase => "mode_phase",
            // Second wave (QB-17)
            Self::EdenEx => "eden_ex",
            Self::EdenDemag => "eden_demag",
            Self::DemagPhi => "demag_phi",
            Self::EdenExt => "eden_ext",
            Self::EdenAni => "eden_ani",
            Self::EdenDmi => "eden_dmi",
            Self::EdenTotal => "eden_total",
            Self::MatMs => "mat_ms",
            Self::MatAex => "mat_aex",
            Self::MatAlpha => "mat_alpha",
            Self::MatDind => "mat_dind",
            Self::MatDbulk => "mat_dbulk",
            Self::DmDt => "dm_dt",
            Self::VElectric => "V_electric",
            Self::JCharge => "J_charge",
            Self::SpinPotential => "spin_potential",
            Self::SpinCurrentTensor => "spin_current_tensor",
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
        Self::Torque,
        Self::HAni,
        Self::HDmi,
        Self::HMel,
        Self::U,
        Self::Eps,
        Self::Sigma,
        Self::HAniCubic,
        Self::HDmiBulk,
        Self::HOe,
        Self::HTherm,
        Self::EEx,
        Self::EDemag,
        Self::EExt,
        Self::EAni,
        Self::EDmi,
        Self::EEl,
        Self::EKinEl,
        Self::ElasticResidualNorm,
        Self::ETotal,
        Self::ModeAmplitude,
        Self::ModeReal,
        Self::ModeImag,
        Self::ModePhase,
        // Second wave (QB-17)
        Self::EdenEx,
        Self::EdenDemag,
        Self::DemagPhi,
        Self::EdenExt,
        Self::EdenAni,
        Self::EdenDmi,
        Self::EdenTotal,
        Self::MatMs,
        Self::MatAex,
        Self::MatAlpha,
        Self::MatDind,
        Self::MatDbulk,
        Self::DmDt,
        Self::VElectric,
        Self::JCharge,
        Self::SpinPotential,
        Self::SpinCurrentTensor,
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
        "H_ex" | "h_ex" => Ok(QuantityId::HEx),
        "H_demag" | "h_demag" => Ok(QuantityId::HDemag),
        "H_ext" | "h_ext" => Ok(QuantityId::HExt),
        "H_ant" | "h_ant" => Ok(QuantityId::HAnt),
        "H_eff" | "h_eff" => Ok(QuantityId::HEff),
        "torque" => Ok(QuantityId::Torque),
        "H_ani" | "h_ani" => Ok(QuantityId::HAni),
        "H_dmi" | "h_dmi" => Ok(QuantityId::HDmi),
        "H_mel" | "h_mel" => Ok(QuantityId::HMel),
        "u" => Ok(QuantityId::U),
        "eps" => Ok(QuantityId::Eps),
        "sigma" => Ok(QuantityId::Sigma),
        "H_ani_cubic" | "h_ani_cubic" => Ok(QuantityId::HAniCubic),
        "H_dmi_bulk" | "h_dmi_bulk" => Ok(QuantityId::HDmiBulk),
        "H_oe" | "h_oe" | "H_OE" => Ok(QuantityId::HOe),
        "H_therm" | "h_therm" => Ok(QuantityId::HTherm),
        "E_ex" | "e_ex" => Ok(QuantityId::EEx),
        "E_demag" | "e_demag" => Ok(QuantityId::EDemag),
        "E_ext" | "e_ext" => Ok(QuantityId::EExt),
        "E_ani" | "e_ani" => Ok(QuantityId::EAni),
        "E_dmi" | "e_dmi" => Ok(QuantityId::EDmi),
        "E_el" | "e_el" => Ok(QuantityId::EEl),
        "E_kin_el" | "e_kin_el" => Ok(QuantityId::EKinEl),
        "elastic_residual_norm" => Ok(QuantityId::ElasticResidualNorm),
        "E_total" | "e_total" => Ok(QuantityId::ETotal),
        "mode_amplitude" => Ok(QuantityId::ModeAmplitude),
        "mode_real" => Ok(QuantityId::ModeReal),
        "mode_imag" => Ok(QuantityId::ModeImag),
        "mode_phase" => Ok(QuantityId::ModePhase),
        // Second wave (QB-17)
        "eden_ex" => Ok(QuantityId::EdenEx),
        "eden_demag" => Ok(QuantityId::EdenDemag),
        "demag_phi" | "phi" | "magnetostatic_potential" => Ok(QuantityId::DemagPhi),
        "eden_ext" => Ok(QuantityId::EdenExt),
        "eden_ani" => Ok(QuantityId::EdenAni),
        "eden_dmi" => Ok(QuantityId::EdenDmi),
        "eden_total" => Ok(QuantityId::EdenTotal),
        "mat_ms" | "material_ms" => Ok(QuantityId::MatMs),
        "mat_aex" | "material_aex" | "material_a" => Ok(QuantityId::MatAex),
        "mat_alpha" | "material_alpha" => Ok(QuantityId::MatAlpha),
        "mat_dind" | "material_dind" => Ok(QuantityId::MatDind),
        "mat_dbulk" | "material_dbulk" => Ok(QuantityId::MatDbulk),
        "dm_dt" => Ok(QuantityId::DmDt),
        "V_electric" | "v_electric" => Ok(QuantityId::VElectric),
        "J_charge" | "j_charge" => Ok(QuantityId::JCharge),
        "spin_potential" => Ok(QuantityId::SpinPotential),
        "spin_current_tensor" => Ok(QuantityId::SpinCurrentTensor),
        "torque_stt" => Ok(QuantityId::TorqueStt),
        "torque_sot" => Ok(QuantityId::TorqueSot),
        other => Err(QuantityIdError {
            requested: other.to_string(),
        }),
    }
}

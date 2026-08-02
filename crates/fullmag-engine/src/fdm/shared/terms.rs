//! FDM effective-field term configuration.

use crate::magnetoelastic;
use crate::Vector3;

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveFieldTerms {
    pub exchange: bool,
    pub demag: bool,
    pub external_field: Option<Vector3>,
    /// Per-node inhomogeneous external field (e.g. antenna Biot-Savart).
    /// When set, this is added on top of `external_field` for each node.
    pub per_node_field: Option<Vec<Vector3>>,
    /// Optional magnetoelastic prescribed-strain configuration.
    pub magnetoelastic: Option<MagnetoelasticTermConfig>,
    /// Uniaxial magnetocrystalline anisotropy (Ku1 + optionally Ku2).
    pub uniaxial_anisotropy: Option<UniaxialAnisotropyConfig>,
    /// Cubic magnetocrystalline anisotropy (Kc1 + optionally Kc2).
    pub cubic_anisotropy: Option<CubicAnisotropyConfig>,
    /// Interfacial (Néel) DMI constant D [J/m²]. None = disabled.
    pub interfacial_dmi: Option<f64>,
    /// Bulk (Bloch) DMI constant D [J/m³]. None = disabled.
    pub bulk_dmi: Option<f64>,
    /// Zhang-Li (CIP) spin-transfer torque. None = disabled.
    pub zhang_li_stt: Option<ZhangLiSttConfig>,
    /// Slonczewski (CPP) spin-transfer torque. None = disabled.
    pub slonczewski_stt: Option<SlonczewskiSttConfig>,
    /// Spin-Orbit Torque (SOT, damping-like + field-like). None = disabled.
    pub sot: Option<SotConfig>,
    /// Oersted field from an infinite cylindrical conductor. None = disabled.
    pub oersted_cylinder: Option<OerstedCylinderConfig>,
}

/// Uniaxial magnetocrystalline anisotropy configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct UniaxialAnisotropyConfig {
    /// First-order anisotropy constant Ku1 [J/m³].
    pub ku1: f64,
    /// Second-order anisotropy constant Ku2 [J/m³]. 0.0 = first-order only.
    pub ku2: f64,
    /// Easy-axis unit vector (automatically normalised at runtime).
    pub axis: Vector3,
}

/// Cubic magnetocrystalline anisotropy configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct CubicAnisotropyConfig {
    /// First-order cubic constant Kc1 [J/m³].
    pub kc1: f64,
    /// Second-order cubic constant Kc2 [J/m³].
    pub kc2: f64,
    /// First crystal axis (unit vector). Third axis = axis1 × axis2.
    pub axis1: Vector3,
    /// Second crystal axis (unit vector).
    pub axis2: Vector3,
}

/// Zhang-Li (CIP) spin-transfer torque configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct ZhangLiSttConfig {
    /// Current density vector j [A/m²].
    pub current_density: Vector3,
    /// Spin polarization P (dimensionless, 0 < P ≤ 1).
    pub spin_polarization: f64,
    /// Non-adiabaticity parameter β (dimensionless).
    pub non_adiabaticity: f64,
}

/// Slonczewski (CPP) spin-transfer torque configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct SlonczewskiSttConfig {
    /// Versioned evaluator contract.
    pub formula: SlonczewskiFormula,
    /// Current density magnitude |j| [A/m²].
    pub current_density_magnitude: f64,
    /// Spin-polarization axis (unit vector p̂).
    pub spin_polarization_axis: Vector3,
    /// Asymmetry parameter Λ (dimensionless, Λ >= 1).
    pub lambda: f64,
    /// Secondary spin-transfer parameter ε' (dimensionless).
    pub epsilon_prime: f64,
    /// Spin polarization degree P (dimensionless).
    pub degree: f64,
    /// Layer thickness d [m] (used in β_STT prefactor).
    pub thickness: f64,
    /// Current sign from fixed-layer position: +1.0 for top, -1.0 for bottom.
    /// Equivalent to amumax `currentSignFromFixedLayerPosition`.
    pub current_sign: f64,
    /// Optional resolved target mask; canonical v1 requires it.
    pub active_mask: Option<Vec<bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlonczewskiFormula {
    /// Corrected canonical SI evaluator. With the MuMax efficiency
    /// definition epsilon=P*Lambda^2/denominator, Omega_J uses hbar/e.
    FullmagV2,
    /// Historical canonical evaluator kept only for read-only provenance.
    /// It contains the additional 1/2 and is not accepted for new runs.
    FullmagV1,
    LegacyFullmagV0,
}

/// Spin-Orbit Torque (SOT) configuration.
///
/// Models the Spin Hall Effect torque on the FM layer from an adjacent HM layer.
/// Both damping-like (DL) and field-like (FL) components are supported.
#[derive(Debug, Clone, PartialEq)]
pub struct SotConfig {
    /// Versioned evaluator contract.
    pub formula: SotFormula,
    /// Signed conventional charge-current density J [A/m²] in the HM layer.
    pub current_density: f64,
    /// Damping-like efficiency ξ_DL (≈ spin Hall angle θ_SH, dimensionless).
    pub xi_dl: f64,
    /// Field-like efficiency ξ_FL (Rashba term, dimensionless, often ~0).
    pub xi_fl: f64,
    /// Spin polarisation unit vector σ̂ (normalised at runtime if needed).
    pub sigma: Vector3,
    /// FM layer thickness t_F [m] (used in amplitude prefactor).
    pub thickness: f64,
    /// Optional per-cell torque target mask, already intersected with the magnetic active mask.
    pub active_mask: Option<Vec<bool>>,
    /// Exact authored envelope. The M0 engine admits constant envelopes only.
    pub envelope: Option<fullmag_ir::TimeEnvelopeIR>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SotFormula {
    FullmagV1,
    LegacyFullmagV0,
}

/// Oersted field configuration for infinite cylindrical conductor.
///
/// Analytical field: H_φ(r) = I·r / (2π·R²) for r <= R,
///                   H_φ(r) = I / (2π·r) for r > R.
#[derive(Debug, Clone, PartialEq)]
pub struct OerstedCylinderConfig {
    /// DC current [A].
    pub current: f64,
    /// Cylinder radius [m].
    pub radius: f64,
    /// Cross-section centre [m] (in-plane components).
    pub center: Vector3,
    /// Current-flow axis (unit vector, typically +z).
    pub axis: Vector3,
    /// Time-dependence envelope kind: 0 = constant, 1 = sinusoidal, 2 = pulse.
    pub time_dep_kind: u32,
    /// Sinusoidal frequency [Hz].
    pub time_dep_freq: f64,
    /// Sinusoidal phase [rad].
    pub time_dep_phase: f64,
    /// Sinusoidal offset.
    pub time_dep_offset: f64,
    /// Pulse on-time [s].
    pub time_dep_t_on: f64,
    /// Pulse off-time [s].
    pub time_dep_t_off: f64,
}

/// Configuration for the magnetoelastic effective field term.
#[derive(Debug, Clone, PartialEq)]
pub struct MagnetoelasticTermConfig {
    pub params: magnetoelastic::MagnetoelasticParams,
    pub strain: magnetoelastic::PrescribedStrainField,
}

impl Default for EffectiveFieldTerms {
    fn default() -> Self {
        Self {
            exchange: true,
            demag: true,
            external_field: None,
            per_node_field: None,
            magnetoelastic: None,
            uniaxial_anisotropy: None,
            cubic_anisotropy: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            zhang_li_stt: None,
            slonczewski_stt: None,
            sot: None,
            oersted_cylinder: None,
        }
    }
}

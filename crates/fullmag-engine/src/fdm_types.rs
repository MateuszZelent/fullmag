//! FDM type definitions: grid, material, config structs, error handling.

use std::error::Error;
use std::fmt;

use crate::magnetoelastic;
use crate::Vector3;

// ── Error ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    message: String,
}

impl EngineError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for EngineError {}

pub type Result<T> = std::result::Result<T, EngineError>;

// ── Grid & Cell ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridShape {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
}

impl GridShape {
    pub fn new(nx: usize, ny: usize, nz: usize) -> Result<Self> {
        if nx == 0 || ny == 0 || nz == 0 {
            return Err(EngineError::new("grid shape components must be >= 1"));
        }
        Ok(Self { nx, ny, nz })
    }

    pub fn cell_count(self) -> usize {
        self.nx * self.ny * self.nz
    }

    pub(crate) fn index(self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellSize {
    pub dx: f64,
    pub dy: f64,
    pub dz: f64,
}

impl CellSize {
    pub fn new(dx: f64, dy: f64, dz: f64) -> Result<Self> {
        for (name, value) in [("dx", dx), ("dy", dy), ("dz", dz)] {
            if value <= 0.0 {
                return Err(EngineError::new(format!("{name} must be positive")));
            }
        }
        Ok(Self { dx, dy, dz })
    }

    pub fn volume(self) -> f64 {
        self.dx * self.dy * self.dz
    }
}

// ── Periodic boundary policy ───────────────────────────────────────────

/// Per-axis boundary policy (open = clamp, periodic = wrap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AxisBoundary {
    #[default]
    Open,
    Periodic,
}

/// FDM boundary policy for each axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FdmBoundaryPolicy {
    pub x: AxisBoundary,
    pub y: AxisBoundary,
    pub z: AxisBoundary,
}

impl Default for FdmBoundaryPolicy {
    fn default() -> Self {
        Self {
            x: AxisBoundary::Open,
            y: AxisBoundary::Open,
            z: AxisBoundary::Open,
        }
    }
}

impl FdmBoundaryPolicy {
    /// Returns `true` if any axis is periodic.
    pub fn has_any_periodic(&self) -> bool {
        matches!(self.x, AxisBoundary::Periodic)
            || matches!(self.y, AxisBoundary::Periodic)
            || matches!(self.z, AxisBoundary::Periodic)
    }
}

/// Compute neighbor index along one axis with clamp or wrap semantics.
///
/// - `i`: current index along the axis
/// - `n`: axis extent (number of cells)
/// - `delta`: neighbor offset (`-1` or `+1`)
/// - `periodic`: whether the axis wraps around
#[inline]
pub fn neighbor_index(i: usize, n: usize, delta: i32, periodic: bool) -> usize {
    if periodic {
        ((i as i32 + delta).rem_euclid(n as i32)) as usize
    } else {
        (i as i32 + delta).clamp(0, n as i32 - 1) as usize
    }
}

// ── Material ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialParameters {
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
}

impl MaterialParameters {
    pub fn new(
        saturation_magnetisation: f64,
        exchange_stiffness: f64,
        damping: f64,
    ) -> Result<Self> {
        if saturation_magnetisation <= 0.0 {
            return Err(EngineError::new(
                "saturation_magnetisation must be positive",
            ));
        }
        if exchange_stiffness <= 0.0 {
            return Err(EngineError::new("exchange_stiffness must be positive"));
        }
        if damping < 0.0 {
            return Err(EngineError::new("damping must be >= 0"));
        }
        Ok(Self {
            saturation_magnetisation,
            exchange_stiffness,
            damping,
        })
    }
}

// ── Integrator & dynamics config ───────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeIntegrator {
    Heun,
    RK4,
    RK23,
    RK45,
    /// Adams–Bashforth–Moulton 3rd-order predictor-corrector.
    /// After 3-step Heun warmup, uses only 1 RHS evaluation per step.
    ABM3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveStepConfig {
    pub max_error: f64,
    pub dt_min: f64,
    pub dt_max: f64,
    pub headroom: f64,
    /// Relative tolerance for mixed atol/rtol error norm.  0.0 = pure atol.
    pub rtol: f64,
    /// Maximum factor by which dt can grow in one accepted step (e.g. 2.0).
    /// `f64::INFINITY` disables the limit.
    pub growth_limit: f64,
    /// Minimum factor by which dt can shrink on rejection (e.g. 0.2).
    /// 0.0 disables the limit.
    pub shrink_limit: f64,
}

impl Default for AdaptiveStepConfig {
    fn default() -> Self {
        Self {
            max_error: 1e-5,
            dt_min: 1e-18,
            dt_max: 1e-10,
            headroom: 0.8,
            rtol: 0.0,
            growth_limit: f64::INFINITY,
            shrink_limit: 0.0,
        }
    }
}

use crate::DEFAULT_GYROMAGNETIC_RATIO;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LlgConfig {
    pub gyromagnetic_ratio: f64,
    pub integrator: TimeIntegrator,
    pub adaptive: AdaptiveStepConfig,
    pub precession_enabled: bool,
}

impl Default for LlgConfig {
    fn default() -> Self {
        Self {
            gyromagnetic_ratio: DEFAULT_GYROMAGNETIC_RATIO,
            integrator: TimeIntegrator::Heun,
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
        }
    }
}

impl LlgConfig {
    pub fn new(gyromagnetic_ratio: f64, integrator: TimeIntegrator) -> Result<Self> {
        if gyromagnetic_ratio <= 0.0 {
            return Err(EngineError::new("gyromagnetic_ratio must be positive"));
        }
        Ok(Self {
            gyromagnetic_ratio,
            integrator,
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
        })
    }

    pub fn with_adaptive(mut self, config: AdaptiveStepConfig) -> Self {
        self.adaptive = config;
        self
    }

    pub fn with_precession_enabled(mut self, enabled: bool) -> Self {
        self.precession_enabled = enabled;
        self
    }
}

// ── Effective field configuration ──────────────────────────────────────

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
    /// Current density magnitude |j| [A/m²].
    pub current_density_magnitude: f64,
    /// Spin-polarization axis (unit vector p̂).
    pub spin_polarization_axis: Vector3,
    /// Asymmetry parameter Λ (dimensionless, Λ ≥ 1).
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
}

/// Spin-Orbit Torque (SOT) configuration.
///
/// Models the Spin Hall Effect torque on the FM layer from an adjacent HM layer.
/// Both damping-like (DL) and field-like (FL) components are supported.
#[derive(Debug, Clone, PartialEq)]
pub struct SotConfig {
    /// Charge current density magnitude |Je| [A/m²] in the HM layer.
    pub current_density: f64,
    /// Damping-like efficiency ξ_DL (≈ spin Hall angle θ_SH, dimensionless).
    pub xi_dl: f64,
    /// Field-like efficiency ξ_FL (Rashba term, dimensionless, often ~0).
    pub xi_fl: f64,
    /// Spin polarisation unit vector σ̂ (normalised at runtime if needed).
    pub sigma: Vector3,
    /// FM layer thickness t_F [m] (used in amplitude prefactor).
    pub thickness: f64,
}

/// Oersted field configuration for infinite cylindrical conductor.
///
/// Analytical field: H_φ(r) = I·r / (2π·R²) for r ≤ R,
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

// ── EvaluationRequest (B3: Physics/Observables separation) ─────────────

/// Policy controlling which quantities are computed at step end.
///
/// Integrators need `h_eff` and `rhs`, but energy decomposition and per-term
/// field amplitudes are only required for artefacts / preview / diagnostics.
/// Using `Minimal` skips the costly scratch-buffer passes that separate
/// exchange / demag / external energies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationRequest {
    /// Compute only h_eff, rhs, and max amplitudes.
    /// Energies are returned as 0.0 (not computed).
    Minimal,
    /// Compute h_eff, rhs, amplitudes, and per-term energies.
    /// This is the current default behaviour.
    Full,
}

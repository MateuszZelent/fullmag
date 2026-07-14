//! Execution-policy and boundary-condition enums for `ProblemIR`.
//!
//! Contains: discretization/device/precision choices, integrator selection,
//! relaxation algorithm variants, exchange/axis/demag boundary conditions,
//! FDM periodicity, spin-wave boundary conditions, and imported geometry scale.

use crate::PhaseConventionIR;
use serde::{Deserialize, Serialize};

// ── Core execution choices ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Strict,
    Extended,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackendTarget {
    Auto,
    Fdm,
    Fem,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPrecision {
    Single,
    #[default]
    Double,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionDevice {
    #[default]
    Auto,
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum IntegratorChoice {
    #[default]
    Heun,
    Rk4,
    Rk23,
    Rk45,
    Abm3,
}

// ── Relaxation algorithm ──────────────────────────────────────────────────────

/// Algorithm selection for relaxation (energy-minimization) studies.
///
/// See `docs/physics/0500-fdm-relaxation-algorithms.md` for full specification.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelaxationAlgorithmIR {
    /// Overdamped Landau–Lifshitz–Gilbert time-stepping with high damping.
    /// Reuses the standard LLG integration pipeline.  Public-executable on FDM and FEM.
    LlgOverdamped,
    /// Projected steepest descent with Barzilai–Borwein step selection on the
    /// sphere product manifold.  Uses alternating BB1/BB2 step sizes with Armijo
    /// backtracking line search.  Public-executable on FDM.
    ProjectedGradientBb,
    /// Nonlinear conjugate gradient (Polak–Ribière+) with tangent-space vector
    /// transport, periodic restarts, and Armijo backtracking.  Public-executable
    /// on FDM.
    NonlinearCg,
    /// FEM-only linearly implicit tangent-plane relaxation.  Public-executable
    /// on the native CPU/MFEM backend; GPU/libCEED execution is still pending.
    TangentPlaneImplicit,
}

// ── Exchange and axis boundary conditions ─────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeBoundaryCondition {
    #[default]
    Neumann,
}

// ── Periodic Boundary Conditions (FDM) ───────────────────────────────────────

/// Maximum non-background region id addressable by the fixed-size FDM
/// exchange lookup table. Region id `0` is reserved for the background, while
/// the native table has 256 rows/columns.
pub const MAX_FDM_REGION_IDS: u32 = 255;

/// Validate resolved FDM region ids before a runner or native lane can
/// allocate/copy the exchange lookup table.
pub fn validate_fdm_region_lut_indices(
    region_mask: &[u32],
    exchange_pairs: &[(u32, u32, f64)],
) -> Result<(), String> {
    if let Some(maximum) = region_mask.iter().copied().max() {
        if maximum > MAX_FDM_REGION_IDS {
            return Err(format!(
                "fdm_region_lut_capacity_exceeded: requested_region_id={} supported_region_ids={}",
                maximum, MAX_FDM_REGION_IDS
            ));
        }
    }
    for (index, &(region_i, region_j, _)) in exchange_pairs.iter().enumerate() {
        if region_i > MAX_FDM_REGION_IDS || region_j > MAX_FDM_REGION_IDS {
            return Err(format!(
                "fdm_region_lut_capacity_exceeded: exchange_pair_index={} requested_region_ids=({}, {}) supported_region_ids={}",
                index, region_i, region_j, MAX_FDM_REGION_IDS
            ));
        }
    }
    Ok(())
}

/// Per-axis boundary policy for FDM PBC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AxisBoundary {
    #[default]
    Open,
    Periodic,
}

/// FDM periodicity configuration, carried in `FdmPlanIR`.
///
/// See `docs/physics/0600-periodic-boundary-conditions.md`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmPeriodicityIR {
    /// Per-axis boundary: `[x, y, z]`.
    pub axes: [AxisBoundary; 3],
    /// Demagnetization periodicity semantics.
    pub demag: FdmDemagPeriodicityIR,
    /// Per-axis image count for `TruncatedImages` demag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_counts: Option<[u32; 3]>,
}

/// Planner-resolved demagnetization boundary realization for FDM.
///
/// `FdmPeriodicityIR` remains the requested public policy.  Runtime lanes
/// must consume this resolved value so that CPU and CUDA cannot reinterpret
/// `open` differently when local operators are periodic.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedFdmDemagBoundaryIR {
    Open,
    PeriodicTruncatedImages { image_counts: [u32; 3] },
}

/// Demag periodicity semantics for FDM.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FdmDemagPeriodicityIR {
    /// Standard open-boundary zero-padded FFT convolution.
    #[default]
    Open,
    /// Truncated periodic images (MuMax-style N^pbc kernel).
    TruncatedImages,
    /// Static k=0 FEM periodic-airbox demag.
    PeriodicAirboxK0,
}

impl FdmPeriodicityIR {
    /// Returns `true` if any axis is periodic.
    pub fn has_any_periodic(&self) -> bool {
        self.axes
            .iter()
            .any(|a| matches!(a, AxisBoundary::Periodic))
    }

    /// Returns `true` if a specific axis index (0=x, 1=y, 2=z) is periodic.
    pub fn is_periodic(&self, axis: usize) -> bool {
        matches!(self.axes[axis], AxisBoundary::Periodic)
    }

    /// Resolve the requested demagnetization policy for one executable FDM
    /// plan.  Periodic local operators plus an open demagnetization kernel are
    /// not a legal physical realization and must fail before either runtime
    /// lane is constructed.
    pub fn resolve_demag_boundary(
        &self,
        demag_enabled: bool,
    ) -> Result<ResolvedFdmDemagBoundaryIR, String> {
        if self.demag == FdmDemagPeriodicityIR::PeriodicAirboxK0 {
            return Err(
                "FDM periodic demag does not support pbc.demag='periodic_airbox_k0'; use 'open' without periodic axes or 'truncated_images'".to_string(),
            );
        }
        if !demag_enabled {
            return Ok(ResolvedFdmDemagBoundaryIR::Open);
        }
        if self.has_any_periodic() && self.demag == FdmDemagPeriodicityIR::Open {
            return Err(
                "FDM periodic demag requires pbc.demag='truncated_images'; pbc.demag='open' is incompatible with periodic axes".to_string(),
            );
        }
        if self.demag == FdmDemagPeriodicityIR::TruncatedImages && self.has_any_periodic() {
            let requested = self.image_counts.unwrap_or([10, 10, 10]);
            let mut image_counts = [0; 3];
            let mut image_terms = 1_u64;
            for (axis, count) in image_counts.iter_mut().enumerate() {
                if self.is_periodic(axis) {
                    *count = requested[axis];
                    let span = u64::from(*count)
                        .checked_mul(2)
                        .and_then(|value| value.checked_add(1))
                        .ok_or_else(|| {
                            format!(
                                "FDM periodic image count overflow on axis {axis}: {}",
                                requested[axis]
                            )
                        })?;
                    image_terms = image_terms.checked_mul(span).ok_or_else(|| {
                        "FDM periodic image term count overflow".to_string()
                    })?;
                }
            }
            const MAX_PERIODIC_IMAGE_TERMS: u64 = 1_000_000;
            if image_terms > MAX_PERIODIC_IMAGE_TERMS {
                return Err(format!(
                    "FDM periodic image budget exceeded: {image_terms} image terms > {MAX_PERIODIC_IMAGE_TERMS}"
                ));
            }
            return Ok(ResolvedFdmDemagBoundaryIR::PeriodicTruncatedImages {
                image_counts,
            });
        }
        Ok(ResolvedFdmDemagBoundaryIR::Open)
    }
}

// ── Spin-wave boundary conditions ────────────────────────────────────────────

/// Spin-wave boundary condition applied to the linearised LLG eigenvalue problem.
///
/// * `Free` (default) — natural Neumann BC: ∂m/∂n = 0 at the magnetic surface.
///   This is equivalent to zero surface torque and is the standard choice for
///   fully unpinned spins.
/// * `Pinned` — homogeneous Dirichlet BC: m = 0 at the magnetic surface.
///   Surface spins are frozen; precession amplitude is forced to zero there.
///   Computed by removing surface DOFs from the assembled eigenvalue problem.
/// * `Periodic` — periodic (Bloch) BC on the specified boundary pair.
///   Opposite-face DOFs are merged.  Requires a mesh with matched periodic
///   node pairs; the runner will return an error until that is implemented.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SpinWaveBoundaryKindIR {
    #[default]
    Free,
    Pinned,
    Periodic,
    Floquet,
    SurfaceAnisotropy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinWaveBoundaryConfigIR {
    pub kind: SpinWaveBoundaryKindIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_pair_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pair_ids: Vec<String>,
    #[serde(default)]
    pub phase_convention: PhaseConventionIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_anisotropy_ks: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_anisotropy_axis: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum SpinWaveBoundaryConditionIR {
    Legacy(SpinWaveBoundaryKindIR),
    Config(SpinWaveBoundaryConfigIR),
}

impl Default for SpinWaveBoundaryConditionIR {
    fn default() -> Self {
        Self::Legacy(SpinWaveBoundaryKindIR::Free)
    }
}

impl SpinWaveBoundaryConditionIR {
    pub fn kind(&self) -> SpinWaveBoundaryKindIR {
        match self {
            Self::Legacy(kind) => *kind,
            Self::Config(config) => config.kind,
        }
    }

    pub fn boundary_pair_id(&self) -> Option<&str> {
        match self {
            Self::Legacy(_) => None,
            Self::Config(config) => config
                .boundary_pair_id
                .as_deref()
                .or_else(|| config.pair_ids.first().map(String::as_str)),
        }
    }

    pub fn boundary_pair_ids(&self) -> Vec<&str> {
        match self {
            Self::Legacy(_) => Vec::new(),
            Self::Config(config) => {
                if config.pair_ids.is_empty() {
                    config.boundary_pair_id.iter().map(String::as_str).collect()
                } else {
                    config.pair_ids.iter().map(String::as_str).collect()
                }
            }
        }
    }

    pub fn surface_anisotropy_ks(&self) -> Option<f64> {
        match self {
            Self::Legacy(_) => None,
            Self::Config(config) => config.surface_anisotropy_ks,
        }
    }

    pub fn phase_convention(&self) -> PhaseConventionIR {
        match self {
            Self::Legacy(_) => PhaseConventionIR::default(),
            Self::Config(config) => config.phase_convention,
        }
    }

    pub fn surface_anisotropy_axis(&self) -> Option<[f64; 3]> {
        match self {
            Self::Legacy(_) => None,
            Self::Config(config) => config.surface_anisotropy_axis,
        }
    }
}

// ── Magnetostatic boundary conditions for frequency-domain demag ─────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MagnetostaticBoundaryConditionIR {
    #[default]
    Open,
    PeriodicAirboxK0,
    FloquetAirbox,
}

// ── Geometry scale ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ImportedGeometryScaleIR {
    Uniform(f64),
    Anisotropic([f64; 3]),
}

impl Default for ImportedGeometryScaleIR {
    fn default() -> Self {
        Self::Uniform(1.0)
    }
}

impl ImportedGeometryScaleIR {
    pub fn is_positive(&self) -> bool {
        match self {
            Self::Uniform(scale) => *scale > 0.0,
            Self::Anisotropic(scale) => scale.iter().all(|component| *component > 0.0),
        }
    }
}

impl BackendTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            BackendTarget::Auto => "auto",
            BackendTarget::Fdm => "fdm",
            BackendTarget::Fem => "fem",
            BackendTarget::Hybrid => "hybrid",
        }
    }
}

impl RelaxationAlgorithmIR {
    pub fn as_str(self) -> &'static str {
        match self {
            RelaxationAlgorithmIR::LlgOverdamped => "llg_overdamped",
            RelaxationAlgorithmIR::ProjectedGradientBb => "projected_gradient_bb",
            RelaxationAlgorithmIR::NonlinearCg => "nonlinear_cg",
            RelaxationAlgorithmIR::TangentPlaneImplicit => "tangent_plane_implicit",
        }
    }

    /// Default integrator for the LLG relaxation family.
    ///
    /// Direct minimizers do not integrate dynamics and therefore resolve no
    /// time integrator.
    pub fn default_integrator(self) -> Option<IntegratorChoice> {
        match self {
            Self::LlgOverdamped => Some(IntegratorChoice::Rk23),
            Self::ProjectedGradientBb | Self::NonlinearCg | Self::TangentPlaneImplicit => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn truncated(counts: [u32; 3]) -> FdmPeriodicityIR {
        FdmPeriodicityIR {
            axes: [
                AxisBoundary::Periodic,
                AxisBoundary::Periodic,
                AxisBoundary::Periodic,
            ],
            demag: FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some(counts),
        }
    }

    #[test]
    fn periodic_image_budget_accepts_boundary_case() {
        let resolved = truncated([49, 49, 49])
            .resolve_demag_boundary(true)
            .expect("49^3 image spans should fit the production budget");
        assert_eq!(
            resolved,
            ResolvedFdmDemagBoundaryIR::PeriodicTruncatedImages {
                image_counts: [49, 49, 49]
            }
        );
    }

    #[test]
    fn periodic_image_budget_rejects_excessive_work() {
        let error = truncated([100, 100, 100])
            .resolve_demag_boundary(true)
            .expect_err("excessive periodic image work must fail before runtime");
        assert!(error.contains("periodic image budget exceeded"));
    }

    #[test]
    fn periodic_image_budget_checks_u32_arithmetic() {
        let error = truncated([u32::MAX, 0, 0])
            .resolve_demag_boundary(true)
            .expect_err("u32 image span must be checked");
        assert!(error.contains("periodic image budget exceeded"));
    }
}

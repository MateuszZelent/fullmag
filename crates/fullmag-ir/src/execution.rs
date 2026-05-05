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
    /// FEM-only linearly implicit tangent-plane relaxation.  Semantic-only;
    /// execution deferred until FEM tangent-space infrastructure is ready.
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

/// Demag periodicity semantics for FDM.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FdmDemagPeriodicityIR {
    /// Standard open-boundary zero-padded FFT convolution.
    #[default]
    Open,
    /// Truncated periodic images (MuMax-style N^pbc kernel).
    TruncatedImages,
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

    /// Physics-optimal default integrator for each relaxation algorithm.
    ///
    /// - `LlgOverdamped` / `ProjectedGradientBb` / `NonlinearCg` → RK23
    ///   (mumax3 Relax pattern: cheap 3rd-order adaptive, fast overdamped convergence)
    /// - `TangentPlaneImplicit` → Heun (FEM implicit; Heun for explicit sub-steps)
    pub fn default_integrator(self) -> IntegratorChoice {
        match self {
            Self::LlgOverdamped | Self::ProjectedGradientBb | Self::NonlinearCg => {
                IntegratorChoice::Rk23
            }
            Self::TangentPlaneImplicit => IntegratorChoice::Heun,
        }
    }
}

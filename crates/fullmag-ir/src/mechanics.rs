use serde::{Deserialize, Serialize};
use crate::ExecutionMode;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HybridHintsIR {
    pub demag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidationProfileIR {
    pub execution_mode: ExecutionMode,
}

// ---------------------------------------------------------------------------
// Magnetoelastic IR types
// ---------------------------------------------------------------------------

/// Linear elastic material with cubic symmetry constants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElasticMaterialIR {
    pub name: String,
    /// Elastic constant C11 [Pa].
    pub c11: f64,
    /// Elastic constant C12 [Pa].
    pub c12: f64,
    /// Elastic constant C44 [Pa].
    pub c44: f64,
    /// Mass density [kg/m³].
    pub density: f64,
    /// Mechanical damping coefficient (dimensionless, for elastodynamics).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanical_damping: Option<f64>,
}

/// Elastic domain bound to a geometry and an elastic material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElasticBodyIR {
    pub name: String,
    /// References a GeometryIR entry name.
    pub geometry: String,
    /// References an ElasticMaterialIR name.
    pub elastic_material: String,
}

/// Magnetostriction coupling law.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MagnetostrictionLawIR {
    /// Cubic magnetostriction: B1, B2 coupling constants [Pa].
    Cubic { name: String, b1: f64, b2: f64 },
    /// Isotropic magnetostriction: saturation magnetostriction λ_s [1].
    Isotropic { name: String, lambda_s: f64 },
}

impl MagnetostrictionLawIR {
    pub fn name(&self) -> &str {
        match self {
            Self::Cubic { name, .. } | Self::Isotropic { name, .. } => name,
        }
    }
}

/// Mechanical boundary condition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MechanicalBoundaryConditionIR {
    TractionFree { surface: String },
    Clamped { surface: String },
    PrescribedDisplacement { surface: String, u: [f64; 3] },
    PrescribedTraction { surface: String, t: [f64; 3] },
}

/// External mechanical load.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MechanicalLoadIR {
    BodyForce { f: [f64; 3] },
    PrescribedStrain { strain: [f64; 6] },
    PrescribedStress { stress: [f64; 6] },
}

/// Mechanical coupling mode within DynamicsIR.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MechanicsIR {
    PrescribedStrain,
    QuasistaticElasticity {
        max_picard_iterations: u32,
        picard_tolerance: f64,
    },
    Elastodynamics {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mechanical_dt: Option<f64>,
    },
}


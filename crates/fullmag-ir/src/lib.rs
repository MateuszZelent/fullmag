use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeometryIR {
    pub imports: Vec<ImportedGeometryIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportedGeometryIR {
    pub name: String,
    pub kind: String,
    pub source: String,
    pub format: String,
}

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
    pub anisotropy_axis: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MagnetIR {
    pub name: String,
    pub region: String,
    pub material: String,
    pub initial_magnetization: Option<InitialMagnetizationIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialMagnetizationIR {
    Uniform { value: [f64; 3] },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnergyTermIR {
    Exchange,
    Demag,
    InterfacialDmi {
        #[serde(rename = "D")]
        d: f64,
    },
    Zeeman {
        #[serde(rename = "B")]
        b: [f64; 3],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DynamicsIR {
    Llg {
        gyromagnetic_ratio: f64,
        integrator: String,
        fixed_timestep: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingIR {
    pub outputs: Vec<OutputIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutputIR {
    Field { name: String, every_seconds: f64 },
    Scalar { name: String, every_seconds: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BackendPolicyIR {
    pub requested_backend: BackendTarget,
    pub discretization_hints: Option<DiscretizationHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscretizationHintsIR {
    pub fdm: Option<FdmHintsIR>,
    pub fem: Option<FemHintsIR>,
    pub hybrid: Option<HybridHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmHintsIR {
    pub cell: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemHintsIR {
    pub order: u32,
    pub hmax: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HybridHintsIR {
    pub demag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidationProfileIR {
    pub execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProblemIR {
    pub ir_version: String,
    pub problem_meta: ProblemMeta,
    pub geometry: GeometryIR,
    pub regions: Vec<RegionIR>,
    pub materials: Vec<MaterialIR>,
    pub magnets: Vec<MagnetIR>,
    pub energy_terms: Vec<EnergyTermIR>,
    pub dynamics: DynamicsIR,
    pub sampling: SamplingIR,
    pub backend_policy: BackendPolicyIR,
    pub validation_profile: ValidationProfileIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionPlanSummary {
    pub requested_backend: BackendTarget,
    pub resolved_backend: BackendTarget,
    pub execution_mode: ExecutionMode,
    pub notes: Vec<String>,
}

impl ProblemIR {
    pub fn bootstrap_example() -> Self {
        Self {
            ir_version: "0.1.0".to_string(),
            problem_meta: ProblemMeta {
                name: "dw_track".to_string(),
                description: Some("Domain-wall track bootstrap example.".to_string()),
                script_language: "python".to_string(),
                script_source: Some(include_str!("../../../examples/dw_track.py").to_string()),
                script_api_version: "0.1.0".to_string(),
                serializer_version: "0.1.0".to_string(),
                entrypoint_kind: "build".to_string(),
                source_hash: None,
                runtime_metadata: BTreeMap::new(),
                backend_revision: None,
                seeds: Vec::new(),
            },
            geometry: GeometryIR {
                imports: vec![ImportedGeometryIR {
                    name: "track".to_string(),
                    kind: "imported_geometry".to_string(),
                    source: "track.step".to_string(),
                    format: "step".to_string(),
                }],
            },
            regions: vec![RegionIR {
                name: "track".to_string(),
                geometry: "track".to_string(),
            }],
            materials: vec![MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.01,
                uniaxial_anisotropy: Some(0.5e6),
                anisotropy_axis: Some([0.0, 0.0, 1.0]),
            }],
            magnets: vec![MagnetIR {
                name: "track".to_string(),
                region: "track".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                }),
            }],
            energy_terms: vec![
                EnergyTermIR::Exchange,
                EnergyTermIR::Demag,
                EnergyTermIR::InterfacialDmi { d: 3e-3 },
                EnergyTermIR::Zeeman { b: [0.0, 0.0, 0.1] },
            ],
            dynamics: DynamicsIR::Llg {
                gyromagnetic_ratio: 2.211e5,
                integrator: "heun".to_string(),
                fixed_timestep: None,
            },
            sampling: SamplingIR {
                outputs: vec![
                    OutputIR::Field {
                        name: "m".to_string(),
                        every_seconds: 10e-12,
                    },
                    OutputIR::Scalar {
                        name: "E_total".to_string(),
                        every_seconds: 10e-12,
                    },
                ],
            },
            backend_policy: BackendPolicyIR {
                requested_backend: BackendTarget::Auto,
                discretization_hints: Some(DiscretizationHintsIR {
                    fdm: Some(FdmHintsIR {
                        cell: [2e-9, 2e-9, 1e-9],
                    }),
                    fem: Some(FemHintsIR {
                        order: 1,
                        hmax: 2e-9,
                    }),
                    hybrid: Some(HybridHintsIR {
                        demag: "fft_aux_grid".to_string(),
                    }),
                }),
            },
            validation_profile: ValidationProfileIR {
                execution_mode: ExecutionMode::Strict,
            },
        }
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.ir_version.trim().is_empty() {
            errors.push("ir_version must not be empty".to_string());
        }
        if self.problem_meta.name.trim().is_empty() {
            errors.push("problem_meta.name must not be empty".to_string());
        }
        if self.problem_meta.script_language != "python" {
            errors.push("problem_meta.script_language must be 'python'".to_string());
        }
        if self.problem_meta.script_api_version.trim().is_empty() {
            errors.push("problem_meta.script_api_version must not be empty".to_string());
        }
        if self.problem_meta.serializer_version.trim().is_empty() {
            errors.push("problem_meta.serializer_version must not be empty".to_string());
        }
        if self.problem_meta.entrypoint_kind.trim().is_empty() {
            errors.push("problem_meta.entrypoint_kind must not be empty".to_string());
        }
        if self.geometry.imports.is_empty() {
            errors.push("at least one imported geometry is required".to_string());
        }
        if self.regions.is_empty() {
            errors.push("at least one region is required".to_string());
        }
        if self.materials.is_empty() {
            errors.push("at least one material is required".to_string());
        }
        if self.magnets.is_empty() {
            errors.push("at least one magnet is required".to_string());
        }
        if self.energy_terms.is_empty() {
            errors.push("at least one energy term is required".to_string());
        }
        if self.sampling.outputs.is_empty() {
            errors.push("at least one output is required".to_string());
        }
        match &self.dynamics {
            DynamicsIR::Llg {
                gyromagnetic_ratio,
                integrator,
                fixed_timestep,
            } => {
                if *gyromagnetic_ratio <= 0.0 {
                    errors.push("llg.gyromagnetic_ratio must be positive".to_string());
                }
                if integrator.trim().is_empty() {
                    errors.push("llg.integrator must not be empty".to_string());
                } else if integrator != "heun" {
                    errors.push("llg.integrator must currently be 'heun'".to_string());
                }
                if fixed_timestep.is_some_and(|value| value <= 0.0) {
                    errors.push("llg.fixed_timestep must be positive when provided".to_string());
                }
            }
        }

        validate_unique_names(
            self.geometry
                .imports
                .iter()
                .map(|geometry| geometry.name.as_str()),
            "geometry imports",
            &mut errors,
        );
        validate_unique_names(
            self.regions.iter().map(|region| region.name.as_str()),
            "regions",
            &mut errors,
        );
        validate_unique_names(
            self.materials.iter().map(|material| material.name.as_str()),
            "materials",
            &mut errors,
        );
        validate_unique_names(
            self.magnets.iter().map(|magnet| magnet.name.as_str()),
            "magnets",
            &mut errors,
        );

        let region_names: BTreeSet<&str> = self
            .regions
            .iter()
            .map(|region| region.name.as_str())
            .collect();
        let material_names: BTreeSet<&str> = self
            .materials
            .iter()
            .map(|material| material.name.as_str())
            .collect();

        for magnet in &self.magnets {
            if !region_names.contains(magnet.region.as_str()) {
                errors.push(format!(
                    "magnet '{}' references missing region '{}'",
                    magnet.name, magnet.region
                ));
            }
            if !material_names.contains(magnet.material.as_str()) {
                errors.push(format!(
                    "magnet '{}' references missing material '{}'",
                    magnet.name, magnet.material
                ));
            }
        }

        match (
            self.backend_policy.requested_backend,
            self.validation_profile.execution_mode,
        ) {
            (BackendTarget::Hybrid, mode) if mode != ExecutionMode::Hybrid => errors
                .push("requested_backend='hybrid' requires execution_mode='hybrid'".to_string()),
            (backend, ExecutionMode::Hybrid) if backend != BackendTarget::Hybrid => errors
                .push("execution_mode='hybrid' requires requested_backend='hybrid'".to_string()),
            _ => {}
        }

        if let Some(hints) = &self.backend_policy.discretization_hints {
            if let Some(fdm) = &hints.fdm {
                if fdm.cell.iter().any(|component| *component <= 0.0) {
                    errors.push("fdm.cell components must be positive".to_string());
                }
            }
            if let Some(fem) = &hints.fem {
                if fem.order == 0 {
                    errors.push("fem.order must be >= 1".to_string());
                }
                if fem.hmax <= 0.0 {
                    errors.push("fem.hmax must be positive".to_string());
                }
            }
            if let Some(hybrid) = &hints.hybrid {
                if hybrid.demag.trim().is_empty() {
                    errors.push("hybrid.demag must not be empty".to_string());
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    pub fn plan_for(
        &self,
        backend_override: Option<BackendTarget>,
    ) -> Result<ExecutionPlanSummary, Vec<String>> {
        self.validate()?;

        let requested_backend = backend_override.unwrap_or(self.backend_policy.requested_backend);
        let execution_mode = self.validation_profile.execution_mode;

        let mut errors = Vec::new();
        match (requested_backend, execution_mode) {
            (BackendTarget::Hybrid, mode) if mode != ExecutionMode::Hybrid => errors
                .push("planning backend 'hybrid' requires execution_mode='hybrid'".to_string()),
            (backend, ExecutionMode::Hybrid) if backend != BackendTarget::Hybrid => errors
                .push("execution_mode='hybrid' can only plan the 'hybrid' backend".to_string()),
            _ => {}
        }
        if !errors.is_empty() {
            return Err(errors);
        }

        let resolved_backend = match requested_backend {
            BackendTarget::Auto => match execution_mode {
                ExecutionMode::Hybrid => BackendTarget::Hybrid,
                ExecutionMode::Strict | ExecutionMode::Extended => BackendTarget::Fdm,
            },
            backend => backend,
        };

        let mut notes = vec![format!(
            "{} energy terms mapped into planning-only execution.",
            self.energy_terms.len()
        )];
        if requested_backend == BackendTarget::Auto {
            notes.push(format!(
                "requested_backend='auto' resolves to '{}' during bootstrap planning",
                resolved_backend.as_str()
            ));
        }

        Ok(ExecutionPlanSummary {
            requested_backend,
            resolved_backend,
            execution_mode,
            notes,
        })
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

fn validate_unique_names<'a>(
    names: impl Iterator<Item = &'a str>,
    label: &str,
    errors: &mut Vec<String>,
) {
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for name in names {
        if !seen.insert(name) {
            duplicates.insert(name.to_string());
        }
    }
    if !duplicates.is_empty() {
        errors.push(format!(
            "{} must have unique names: {}",
            label,
            duplicates.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_example_round_trips_as_json() {
        let ir = ProblemIR::bootstrap_example();
        let json = serde_json::to_string_pretty(&ir).expect("bootstrap example should serialize");
        let decoded: ProblemIR =
            serde_json::from_str(&json).expect("bootstrap example should deserialize");
        assert_eq!(decoded.problem_meta.script_language, "python");
        assert_eq!(
            decoded.validation_profile.execution_mode,
            ExecutionMode::Strict
        );
    }

    #[test]
    fn bootstrap_example_validates() {
        let ir = ProblemIR::bootstrap_example();
        assert!(ir.validate().is_ok());
    }

    #[test]
    fn hybrid_mode_requires_hybrid_backend() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.validation_profile.execution_mode = ExecutionMode::Hybrid;

        let errors = ir
            .validate()
            .expect_err("hybrid mode without hybrid backend must fail");
        assert!(errors
            .iter()
            .any(|error| error
                .contains("execution_mode='hybrid' requires requested_backend='hybrid'")));
    }

    #[test]
    fn planning_with_backend_override_produces_summary() {
        let ir = ProblemIR::bootstrap_example();

        let plan = ir
            .plan_for(Some(BackendTarget::Fem))
            .expect("planning for FEM should succeed");

        assert_eq!(plan.requested_backend, BackendTarget::Fem);
        assert_eq!(plan.resolved_backend, BackendTarget::Fem);
        assert_eq!(plan.execution_mode, ExecutionMode::Strict);
    }

    #[test]
    fn llg_requires_supported_integrator() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.dynamics = DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "rk4".to_string(),
            fixed_timestep: None,
        };

        let errors = ir
            .validate()
            .expect_err("unsupported llg integrator must fail validation");
        assert!(errors
            .iter()
            .any(|error| error.contains("llg.integrator must currently be 'heun'")));
    }
}

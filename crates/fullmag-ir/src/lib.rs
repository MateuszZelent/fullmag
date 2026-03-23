use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const IR_VERSION: &str = "0.2.0";

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegratorChoice {
    Heun,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeBoundaryCondition {
    Neumann,
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
    pub entries: Vec<GeometryEntryIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GeometryEntryIR {
    ImportedGeometry {
        name: String,
        source: String,
        format: String,
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
}

impl GeometryEntryIR {
    fn name(&self) -> &str {
        match self {
            Self::ImportedGeometry { name, .. }
            | Self::Box { name, .. }
            | Self::Cylinder { name, .. } => name,
        }
    }
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
    RandomSeeded { seed: u64 },
    SampledField { values: Vec<[f64; 3]> },
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionPlanIR {
    pub common: CommonPlanMeta,
    pub backend_plan: BackendPlanIR,
    pub output_plan: OutputPlanIR,
    pub provenance: ProvenancePlanIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommonPlanMeta {
    pub ir_version: String,
    pub requested_backend: BackendTarget,
    pub resolved_backend: BackendTarget,
    pub execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendPlanIR {
    Fdm(FdmPlanIR),
    Fem(FemPlanIR),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GridDimensions {
    pub cells: [u32; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmPlanIR {
    pub grid: GridDimensions,
    pub cell_size: [f64; 3],
    pub region_mask: Vec<u32>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub exchange_bc: ExchangeBoundaryCondition,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemPlanIR {
    pub mesh_name: String,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub exchange_bc: ExchangeBoundaryCondition,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputPlanIR {
    pub outputs: Vec<OutputIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProvenancePlanIR {
    pub notes: Vec<String>,
}

impl ProblemIR {
    pub fn bootstrap_example() -> Self {
        Self {
            ir_version: IR_VERSION.to_string(),
            problem_meta: ProblemMeta {
                name: "exchange_relax".to_string(),
                description: Some("Exchange-only relaxation bootstrap example.".to_string()),
                script_language: "python".to_string(),
                script_source: Some(
                    include_str!("../../../examples/exchange_relax.py").to_string(),
                ),
                script_api_version: IR_VERSION.to_string(),
                serializer_version: IR_VERSION.to_string(),
                entrypoint_kind: "build".to_string(),
                source_hash: None,
                runtime_metadata: BTreeMap::new(),
                backend_revision: None,
                seeds: Vec::new(),
            },
            geometry: GeometryIR {
                entries: vec![GeometryEntryIR::Box {
                    name: "strip".to_string(),
                    size: [200e-9, 20e-9, 5e-9],
                }],
            },
            regions: vec![RegionIR {
                name: "strip".to_string(),
                geometry: "strip".to_string(),
            }],
            materials: vec![MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.02,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            }],
            magnets: vec![MagnetIR {
                name: "strip".to_string(),
                region: "strip".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.2, 0.0],
                }),
            }],
            energy_terms: vec![EnergyTermIR::Exchange],
            dynamics: DynamicsIR::Llg {
                gyromagnetic_ratio: 2.211e5,
                integrator: "heun".to_string(),
                fixed_timestep: Some(1e-13),
            },
            sampling: SamplingIR {
                outputs: vec![
                    OutputIR::Field {
                        name: "m".to_string(),
                        every_seconds: 1e-12,
                    },
                    OutputIR::Field {
                        name: "H_ex".to_string(),
                        every_seconds: 1e-12,
                    },
                    OutputIR::Scalar {
                        name: "E_ex".to_string(),
                        every_seconds: 1e-12,
                    },
                ],
            },
            backend_policy: BackendPolicyIR {
                requested_backend: BackendTarget::Auto,
                discretization_hints: Some(DiscretizationHintsIR {
                    fdm: Some(FdmHintsIR {
                        cell: [2e-9, 2e-9, 2e-9],
                    }),
                    fem: Some(FemHintsIR {
                        order: 1,
                        hmax: 2e-9,
                    }),
                    hybrid: None,
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
        if self.geometry.entries.is_empty() {
            errors.push("at least one geometry entry is required".to_string());
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
            self.geometry.entries.iter().map(GeometryEntryIR::name),
            "geometry entries",
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

        for geometry in &self.geometry.entries {
            match geometry {
                GeometryEntryIR::ImportedGeometry {
                    name,
                    source,
                    format,
                } => {
                    if name.trim().is_empty() {
                        errors.push("imported geometry name must not be empty".to_string());
                    }
                    if source.trim().is_empty() {
                        errors.push(format!("geometry '{}' source must not be empty", name));
                    }
                    if format.trim().is_empty() {
                        errors.push(format!("geometry '{}' format must not be empty", name));
                    }
                }
                GeometryEntryIR::Box { name, size } => {
                    if name.trim().is_empty() {
                        errors.push("box geometry name must not be empty".to_string());
                    }
                    if size.iter().any(|component| *component <= 0.0) {
                        errors.push(format!(
                            "box geometry '{}' size components must be positive",
                            name
                        ));
                    }
                }
                GeometryEntryIR::Cylinder {
                    name,
                    radius,
                    height,
                } => {
                    if name.trim().is_empty() {
                        errors.push("cylinder geometry name must not be empty".to_string());
                    }
                    if *radius <= 0.0 {
                        errors.push(format!(
                            "cylinder geometry '{}' radius must be positive",
                            name
                        ));
                    }
                    if *height <= 0.0 {
                        errors.push(format!(
                            "cylinder geometry '{}' height must be positive",
                            name
                        ));
                    }
                }
            }
        }

        let geometry_names: BTreeSet<&str> = self
            .geometry
            .entries
            .iter()
            .map(GeometryEntryIR::name)
            .collect();
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

        for region in &self.regions {
            if !geometry_names.contains(region.geometry.as_str()) {
                errors.push(format!(
                    "region '{}' references missing geometry '{}'",
                    region.name, region.geometry
                ));
            }
        }

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
            if let Some(initial_magnetization) = &magnet.initial_magnetization {
                match initial_magnetization {
                    InitialMagnetizationIR::Uniform { .. } => {}
                    InitialMagnetizationIR::RandomSeeded { seed } => {
                        if *seed == 0 {
                            errors.push(format!(
                                "magnet '{}' random_seeded seed must be positive",
                                magnet.name
                            ));
                        }
                    }
                    InitialMagnetizationIR::SampledField { values } => {
                        if values.is_empty() {
                            errors.push(format!(
                                "magnet '{}' sampled_field values must not be empty",
                                magnet.name
                            ));
                        }
                    }
                }
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
        assert_eq!(decoded.ir_version, IR_VERSION);
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

    #[test]
    fn random_seeded_initial_magnetization_must_be_positive() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.magnets[0].initial_magnetization =
            Some(InitialMagnetizationIR::RandomSeeded { seed: 0 });

        let errors = ir
            .validate()
            .expect_err("zero random seed must fail validation");
        assert!(errors
            .iter()
            .any(|error| error.contains("random_seeded seed must be positive")));
    }

    #[test]
    fn sampled_field_initial_magnetization_must_not_be_empty() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.magnets[0].initial_magnetization =
            Some(InitialMagnetizationIR::SampledField { values: vec![] });

        let errors = ir
            .validate()
            .expect_err("empty sampled field must fail validation");
        assert!(errors
            .iter()
            .any(|error| error.contains("sampled_field values must not be empty")));
    }

    #[test]
    fn analytic_geometry_must_have_positive_dimensions() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries[0] = GeometryEntryIR::Cylinder {
            name: "strip".to_string(),
            radius: -1.0,
            height: 5e-9,
        };

        let errors = ir
            .validate()
            .expect_err("negative cylinder radius must fail validation");
        assert!(errors
            .iter()
            .any(|error| error.contains("cylinder geometry 'strip' radius must be positive")));
    }

    #[test]
    fn execution_plan_ir_serializes() {
        let plan = ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: IR_VERSION.to_string(),
                requested_backend: BackendTarget::Auto,
                resolved_backend: BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
            },
            backend_plan: BackendPlanIR::Fdm(FdmPlanIR {
                grid: GridDimensions {
                    cells: [100, 10, 3],
                },
                cell_size: [2e-9, 2e-9, 2e-9],
                region_mask: vec![0, 0, 1],
                initial_magnetization: vec![[1.0, 0.0, 0.0]],
                exchange_bc: ExchangeBoundaryCondition::Neumann,
                integrator: IntegratorChoice::Heun,
                fixed_timestep: Some(1e-13),
            }),
            output_plan: OutputPlanIR {
                outputs: vec![OutputIR::Field {
                    name: "m".to_string(),
                    every_seconds: 1e-12,
                }],
            },
            provenance: ProvenancePlanIR {
                notes: vec!["planner stub".to_string()],
            },
        };

        let encoded = serde_json::to_string(&plan).expect("execution plan should serialize");
        let decoded: ExecutionPlanIR =
            serde_json::from_str(&encoded).expect("execution plan should deserialize");
        assert_eq!(decoded, plan);
    }
}

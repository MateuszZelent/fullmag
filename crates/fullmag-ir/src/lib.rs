use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub mod eigen_contract;
pub mod execution;
pub mod mechanics;
pub mod mesh_assets;
pub mod mesh_hints;
pub mod model;
pub mod plan;
pub mod quantities;
pub mod study;
mod validation;
pub use eigen_contract::*;
pub use execution::*;
pub use mechanics::*;
pub use mesh_assets::*;
pub use mesh_hints::*;
pub use model::*;
pub use plan::*;
pub use quantities::{
    field_to_quantity_output, scalar_to_quantity_output, OutputSinkIR, QuantityOutputIR,
};
pub use study::*;
use validation::*;

pub const IR_VERSION: &str = "0.2.0";
pub const CURRENT_IR_VERSION: &str = IR_VERSION;
pub const PREVIOUS_PUBLIC_IR_VERSION: &str = "0.1.0";
pub const SUPPORTED_READ_IR_VERSIONS: &[&str] = &[CURRENT_IR_VERSION, PREVIOUS_PUBLIC_IR_VERSION];

pub fn is_supported_ir_version_for_read(version: &str) -> bool {
    let normalized = version.trim();
    !normalized.is_empty() && SUPPORTED_READ_IR_VERSIONS.contains(&normalized)
}

pub fn requires_ir_migration(version: &str) -> bool {
    let normalized = version.trim();
    is_supported_ir_version_for_read(normalized) && normalized != CURRENT_IR_VERSION
}

pub fn migrate_problem_ir_json_value(value: &mut Value) -> Result<bool, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "ProblemIR payload must be a JSON object".to_string())?;
    let version = object
        .get("ir_version")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "ProblemIR.ir_version must be a string".to_string())?;

    if version == CURRENT_IR_VERSION {
        return Ok(false);
    }
    if version != PREVIOUS_PUBLIC_IR_VERSION {
        return Err(format!("ir_version '{version}' is not supported for read"));
    }

    object.insert(
        "ir_version".to_string(),
        Value::String(CURRENT_IR_VERSION.to_string()),
    );

    if let Some(meta) = object
        .get_mut("problem_meta")
        .and_then(Value::as_object_mut)
    {
        for key in ["script_api_version", "serializer_version"] {
            if meta
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim() == PREVIOUS_PUBLIC_IR_VERSION)
            {
                meta.insert(
                    key.to_string(),
                    Value::String(CURRENT_IR_VERSION.to_string()),
                );
            }
        }
    }

    Ok(true)
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProblemIR {
    pub ir_version: String,
    pub problem_meta: ProblemMeta,
    pub geometry: GeometryIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_assets: Option<GeometryAssetsIR>,
    pub regions: Vec<RegionIR>,
    pub materials: Vec<MaterialIR>,
    pub magnets: Vec<MagnetIR>,
    pub energy_terms: Vec<EnergyTermIR>,
    pub study: StudyIR,
    pub backend_policy: BackendPolicyIR,
    pub validation_profile: ValidationProfileIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_modules: Vec<CurrentModuleIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excitation_analysis: Option<ExcitationAnalysisIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_torque_modules: Vec<SpinTorqueModuleIR>,

    /// Global current density for Zhang-Li STT [A/m^2]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_density: Option<[f64; 3]>,
    /// Spin polarization degree for Zhang-Li STT (P)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_degree: Option<f64>,
    /// Non-adiabaticity parameter for Zhang-Li STT (beta)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_beta: Option<f64>,

    /// Fixed spin polarization vector for Slonczewski STT (p)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_spin_polarization: Option<[f64; 3]>,
    /// Slonczewski asymmetry parameter (Lambda)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_lambda: Option<f64>,
    /// Slonczewski secondary spin-transfer term (epsilon')
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_epsilon_prime: Option<f64>,

    /// Temperature in Kelvin for Brown thermal field (sLLG). None or 0 = no thermal noise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,

    // ── Magnetoelastic extensions ──────────────────────────
    /// Elastic material definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub elastic_materials: Vec<ElasticMaterialIR>,
    /// Elastic body definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub elastic_bodies: Vec<ElasticBodyIR>,
    /// Magnetostriction coupling law definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetostriction_laws: Vec<MagnetostrictionLawIR>,
    /// Mechanical boundary conditions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mechanical_bcs: Vec<MechanicalBoundaryConditionIR>,
    /// External mechanical loads.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mechanical_loads: Vec<MechanicalLoadIR>,

    /// User-configurable policy for air-box construction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_box_policy: Option<AirBoxPolicyIR>,

    /// Periodic boundary conditions for FDM (per-axis).
    /// `None` means fully open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pbc: Option<FdmPeriodicityIR>,

    /// Canonical three-level mesh semantics:
    /// universe policy, per-object policies, and derived solver mesh provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_semantics: Option<MeshSemanticsIR>,
}

impl<'de> Deserialize<'de> for ProblemIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        migrate_problem_ir_json_value(&mut value).map_err(D::Error::custom)?;

        #[derive(Deserialize)]
        struct ProblemIRWire {
            ir_version: String,
            problem_meta: ProblemMeta,
            geometry: GeometryIR,
            #[serde(default)]
            geometry_assets: Option<GeometryAssetsIR>,
            regions: Vec<RegionIR>,
            materials: Vec<MaterialIR>,
            magnets: Vec<MagnetIR>,
            energy_terms: Vec<EnergyTermIR>,
            study: StudyIR,
            backend_policy: BackendPolicyIR,
            validation_profile: ValidationProfileIR,
            #[serde(default)]
            current_modules: Vec<CurrentModuleIR>,
            #[serde(default)]
            excitation_analysis: Option<ExcitationAnalysisIR>,
            #[serde(default)]
            spin_torque_modules: Vec<SpinTorqueModuleIR>,
            #[serde(default)]
            current_density: Option<[f64; 3]>,
            #[serde(default)]
            stt_degree: Option<f64>,
            #[serde(default)]
            stt_beta: Option<f64>,
            #[serde(default)]
            stt_spin_polarization: Option<[f64; 3]>,
            #[serde(default)]
            stt_lambda: Option<f64>,
            #[serde(default)]
            stt_epsilon_prime: Option<f64>,
            #[serde(default)]
            temperature: Option<f64>,
            #[serde(default)]
            elastic_materials: Vec<ElasticMaterialIR>,
            #[serde(default)]
            elastic_bodies: Vec<ElasticBodyIR>,
            #[serde(default)]
            magnetostriction_laws: Vec<MagnetostrictionLawIR>,
            #[serde(default)]
            mechanical_bcs: Vec<MechanicalBoundaryConditionIR>,
            #[serde(default)]
            mechanical_loads: Vec<MechanicalLoadIR>,
            #[serde(default)]
            air_box_policy: Option<AirBoxPolicyIR>,
            #[serde(default)]
            pbc: Option<FdmPeriodicityIR>,
            #[serde(default)]
            mesh_semantics: Option<MeshSemanticsIR>,
        }

        let wire = ProblemIRWire::deserialize(value).map_err(D::Error::custom)?;
        Ok(Self {
            ir_version: wire.ir_version,
            problem_meta: wire.problem_meta,
            geometry: wire.geometry,
            geometry_assets: wire.geometry_assets,
            regions: wire.regions,
            materials: wire.materials,
            magnets: wire.magnets,
            energy_terms: wire.energy_terms,
            study: wire.study,
            backend_policy: wire.backend_policy,
            validation_profile: wire.validation_profile,
            current_modules: wire.current_modules,
            excitation_analysis: wire.excitation_analysis,
            spin_torque_modules: wire.spin_torque_modules,
            current_density: wire.current_density,
            stt_degree: wire.stt_degree,
            stt_beta: wire.stt_beta,
            stt_spin_polarization: wire.stt_spin_polarization,
            stt_lambda: wire.stt_lambda,
            stt_epsilon_prime: wire.stt_epsilon_prime,
            temperature: wire.temperature,
            elastic_materials: wire.elastic_materials,
            elastic_bodies: wire.elastic_bodies,
            magnetostriction_laws: wire.magnetostriction_laws,
            mechanical_bcs: wire.mechanical_bcs,
            mechanical_loads: wire.mechanical_loads,
            air_box_policy: wire.air_box_policy,
            pbc: wire.pbc,
            mesh_semantics: wire.mesh_semantics,
        })
    }
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
                    size: [200e-9, 20e-9, 6e-9],
                }],
            },
            geometry_assets: None,
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
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
            }],
            magnets: vec![MagnetIR {
                name: "strip".to_string(),
                region: "strip".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::RandomSeeded { seed: 42 }),
            }],
            energy_terms: vec![EnergyTermIR::Exchange],
            study: StudyIR::TimeEvolution {
                dynamics: DynamicsIR::Llg {
                    gyromagnetic_ratio: 2.211e5,
                    integrator: "heun".to_string(),
                    fixed_timestep: Some(1e-13),
                    adaptive_timestep: None,
                    field_refresh: None,
                    mechanics: None,
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
            },
            backend_policy: BackendPolicyIR {
                requested_backend: BackendTarget::Fdm,
                execution_precision: ExecutionPrecision::Double,
                discretization_hints: Some(DiscretizationHintsIR {
                    fdm: Some(FdmHintsIR {
                        cell: [2e-9, 2e-9, 2e-9],
                        default_cell: None,
                        per_magnet: None,
                        demag: None,
                        boundary_correction: None,
                        boundary_phi_floor: None,
                        boundary_delta_min: None,
                    }),
                    fem: Some(FemHintsIR {
                        order: 1,
                        hmax: 2e-9,
                        mesh: None,
                        demag_solver_policy: None,
                    }),
                    hybrid: None,
                }),
            },
            validation_profile: ValidationProfileIR {
                execution_mode: ExecutionMode::Strict,
            },
            current_modules: Vec::new(),
            excitation_analysis: None,
            spin_torque_modules: Vec::new(),
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            temperature: None,
            elastic_materials: vec![],
            elastic_bodies: vec![],
            magnetostriction_laws: vec![],
            mechanical_bcs: vec![],
            mechanical_loads: vec![],
            air_box_policy: None,
            pbc: None,
            mesh_semantics: None,
        }
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.ir_version.trim().is_empty() {
            errors.push("ir_version must not be empty".to_string());
        } else if !is_supported_ir_version_for_read(self.ir_version.as_str()) {
            errors.push(format!(
                "ir_version '{}' is not supported for read",
                self.ir_version
            ));
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
        if let Some(geometry_assets) = &self.geometry_assets {
            if let Err(asset_errors) = geometry_assets.validate() {
                errors.extend(asset_errors);
            }
        }
        if let Some(mesh_semantics) = &self.mesh_semantics {
            if let Err(mesh_errors) = mesh_semantics.validate() {
                errors.extend(
                    mesh_errors
                        .into_iter()
                        .map(|error| format!("mesh_semantics.{error}")),
                );
            }
        }
        validate_current_modules(self, &mut errors);
        validate_oersted_energy_terms(self, &mut errors);
        validate_legacy_spin_torque_fields(self, &mut errors);
        validate_spin_torque_modules(self, &mut errors);
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
        if self.study.sampling().outputs.is_empty() {
            errors.push("at least one output is required".to_string());
        }
        for output in &self.study.sampling().outputs {
            match output {
                OutputIR::Field {
                    name,
                    every_seconds,
                } => {
                    if name.trim().is_empty() {
                        errors.push("field output name must not be empty".to_string());
                    }
                    if *every_seconds <= 0.0 {
                        errors.push(format!(
                            "field output '{}' must have positive every_seconds",
                            name
                        ));
                    }
                }
                OutputIR::Scalar {
                    name,
                    every_seconds,
                } => {
                    if name.trim().is_empty() {
                        errors.push("scalar output name must not be empty".to_string());
                    }
                    if *every_seconds <= 0.0 {
                        errors.push(format!(
                            "scalar output '{}' must have positive every_seconds",
                            name
                        ));
                    }
                }
                OutputIR::Snapshot {
                    field,
                    component,
                    every_seconds,
                    ..
                } => {
                    if field.trim().is_empty() {
                        errors.push("snapshot field name must not be empty".to_string());
                    }
                    let valid_components = ["x", "y", "z", "3D"];
                    if !valid_components.contains(&component.as_str()) {
                        errors.push(format!(
                            "snapshot component '{}' must be one of: x, y, z, 3D",
                            component
                        ));
                    }
                    if *every_seconds <= 0.0 {
                        errors.push(format!(
                            "snapshot '{}' must have positive every_seconds",
                            field
                        ));
                    }
                }
                OutputIR::EigenSpectrum { quantity } => {
                    if quantity.trim().is_empty() {
                        errors.push("eigen_spectrum quantity must not be empty".to_string());
                    }
                }
                OutputIR::EigenMode { field, indices } => {
                    if field.trim().is_empty() {
                        errors.push("eigen_mode field must not be empty".to_string());
                    }
                    if indices.is_empty() {
                        errors.push("eigen_mode must contain at least one mode index".to_string());
                    }
                }
                OutputIR::DispersionCurve { name } => {
                    if name.trim().is_empty() {
                        errors.push("dispersion_curve name must not be empty".to_string());
                    }
                }
                OutputIR::EigenDiagnostics { .. } => {
                    // No additional validation needed for diagnostics flags
                }
                OutputIR::SaveQuantity {
                    quantity_id,
                    every_seconds,
                    ..
                } => {
                    if quantity_id.trim().is_empty() {
                        errors.push("save_quantity quantity_id must not be empty".to_string());
                    }
                    if *every_seconds <= 0.0 {
                        errors.push(format!(
                            "save_quantity '{}' must have positive every_seconds",
                            quantity_id
                        ));
                    }
                }
            }
        }
        match &self.study {
            StudyIR::TimeEvolution { dynamics, .. } => {
                validate_study_dynamics(dynamics, &mut errors);
                for output in &self.study.sampling().outputs {
                    if matches!(
                        output,
                        OutputIR::EigenSpectrum { .. }
                            | OutputIR::EigenMode { .. }
                            | OutputIR::DispersionCurve { .. }
                    ) {
                        errors.push(
                            "time_evolution outputs must be field/scalar/snapshot requests"
                                .to_string(),
                        );
                    }
                }
            }
            StudyIR::Relaxation { dynamics, stop, .. } => {
                validate_study_dynamics(dynamics, &mut errors);
                if stop.torque_tolerance_apm.is_some_and(|value| value <= 0.0) {
                    errors
                        .push("relaxation.stop.torque_tolerance_apm must be positive".to_string());
                }
                if stop.energy_tolerance_j.is_some_and(|value| value <= 0.0) {
                    errors.push(
                        "relaxation.stop.energy_tolerance_j must be positive when provided"
                            .to_string(),
                    );
                }
                if stop.max_steps.is_some_and(|value| value == 0) {
                    errors.push("relaxation.stop.max_steps must be > 0".to_string());
                }
                if stop.max_pseudotime_s.is_some_and(|value| value <= 0.0) {
                    errors.push(
                        "relaxation.stop.max_pseudotime_s must be positive when provided"
                            .to_string(),
                    );
                }
                if stop.max_physical_time_s.is_some_and(|value| value <= 0.0) {
                    errors.push(
                        "relaxation.stop.max_physical_time_s must be positive when provided"
                            .to_string(),
                    );
                }
                if stop.torque_tolerance_apm.is_none()
                    && stop.energy_tolerance_j.is_none()
                    && stop.max_steps.is_none()
                    && stop.max_pseudotime_s.is_none()
                    && stop.max_physical_time_s.is_none()
                {
                    errors.push("relaxation.stop requires at least one stop criterion".to_string());
                }
                for output in &self.study.sampling().outputs {
                    if matches!(
                        output,
                        OutputIR::EigenSpectrum { .. }
                            | OutputIR::EigenMode { .. }
                            | OutputIR::DispersionCurve { .. }
                    ) {
                        errors.push(
                            "relaxation outputs must be field/scalar/snapshot requests".to_string(),
                        );
                    }
                }
            }
            StudyIR::Eigenmodes {
                dynamics,
                operator,
                count,
                target,
                equilibrium,
                k_sampling,
                ..
            } => {
                validate_study_dynamics(dynamics, &mut errors);
                if *count == 0 {
                    errors.push("eigenmodes.count must be > 0".to_string());
                }
                match operator.kind {
                    EigenOperatorIR::LinearizedLlg => {}
                    EigenOperatorIR::Full2x2 => {}
                }
                match target {
                    EigenTargetIR::Lowest => {}
                    EigenTargetIR::Nearest { frequency_hz } => {
                        if *frequency_hz <= 0.0 {
                            errors.push(
                                "eigenmodes.target.frequency_hz must be positive".to_string(),
                            );
                        }
                    }
                }
                if let EquilibriumSourceIR::Artifact { path } = equilibrium {
                    if path.trim().is_empty() {
                        errors.push(
                            "eigenmodes.equilibrium artifact path must not be empty".to_string(),
                        );
                    }
                }
                if let Some(KSamplingIR::Single { k_vector }) = k_sampling {
                    if !k_vector.iter().all(|value| value.is_finite()) {
                        errors.push(
                            "eigenmodes.k_sampling.k_vector must contain finite values".to_string(),
                        );
                    }
                }
                if let Some(KSamplingIR::Path {
                    points,
                    samples_per_segment,
                    ..
                }) = k_sampling
                {
                    if points.len() < 2 {
                        errors.push(
                            "eigenmodes.k_sampling.path requires at least two control points"
                                .to_string(),
                        );
                    }
                    for point in points {
                        if !point.k_vector.iter().all(|v| v.is_finite()) {
                            errors.push(
                                "eigenmodes.k_sampling.path point k_vector must contain finite values".to_string(),
                            );
                        }
                    }
                    if samples_per_segment.iter().any(|n| *n == 0) {
                        errors.push(
                            "eigenmodes.k_sampling.path samples_per_segment entries must be > 0"
                                .to_string(),
                        );
                    }
                }
                let has_mode_output = self
                    .study
                    .sampling()
                    .outputs
                    .iter()
                    .any(|output| matches!(output, OutputIR::EigenMode { .. }));
                let has_spectrum_output = self
                    .study
                    .sampling()
                    .outputs
                    .iter()
                    .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
                if !has_mode_output && !has_spectrum_output {
                    errors.push(
                        "eigenmodes study requires at least one eigen_spectrum or eigen_mode output"
                            .to_string(),
                    );
                }
                for output in &self.study.sampling().outputs {
                    if matches!(
                        output,
                        OutputIR::Field { .. }
                            | OutputIR::Scalar { .. }
                            | OutputIR::Snapshot { .. }
                    ) {
                        errors.push(
                            "eigenmodes outputs must be eigen_spectrum/eigen_mode/dispersion_curve requests"
                                .to_string(),
                        );
                    }
                }
            }
        }

        for magnet in &self.magnets {
            if let Some(ref init_mag) = magnet.initial_magnetization {
                match init_mag {
                    InitialMagnetizationIR::Uniform { value } => {
                        let norm =
                            (value[0] * value[0] + value[1] * value[1] + value[2] * value[2])
                                .sqrt();
                        if norm <= 0.0 {
                            errors.push(format!(
                                "magnet '{}': uniform initial magnetization must be non-zero",
                                magnet.name
                            ));
                        }
                    }
                    InitialMagnetizationIR::RandomSeeded { seed } => {
                        if *seed == 0 {
                            errors.push(format!(
                                "magnet '{}': random_seeded seed must be > 0",
                                magnet.name
                            ));
                        }
                    }
                    InitialMagnetizationIR::SampledField { values } => {
                        if values.is_empty() {
                            errors.push(format!(
                                "magnet '{}': sampled_field values must not be empty",
                                magnet.name
                            ));
                        }
                    }
                    InitialMagnetizationIR::PresetTexture { preset_kind, .. } => {
                        if preset_kind.trim().is_empty() {
                            errors.push(format!(
                                "magnet '{}': preset_texture preset_kind must not be empty",
                                magnet.name
                            ));
                        }
                    }
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
        validate_unique_names(
            self.current_modules.iter().map(current_module_name),
            "current modules",
            &mut errors,
        );

        if let Some(analysis) = self.excitation_analysis.as_ref() {
            let source_exists = self.current_modules.iter().any(|module| {
                matches!(
                    module,
                    CurrentModuleIR::AntennaFieldSource { name, .. } if name == &analysis.source
                )
            });
            if !source_exists {
                errors.push(format!(
                    "excitation_analysis.source '{}' must reference an antenna_field_source current module",
                    analysis.source
                ));
            }
            if analysis.method.trim().is_empty() {
                errors.push("excitation_analysis.method must not be empty".to_string());
            }
            if analysis.samples < 2 {
                errors.push("excitation_analysis.samples must be >= 2".to_string());
            }
        }

        for geometry in &self.geometry.entries {
            match geometry {
                GeometryEntryIR::ImportedGeometry {
                    name,
                    source,
                    format,
                    scale,
                } => {
                    if name.trim().is_empty() {
                        errors.push("imported geometry name must not be empty".to_string());
                    }
                    if source.trim().is_empty() {
                        errors.push(format!("geometry '{}' source must not be empty", name));
                    }
                    if !scale.is_positive() {
                        errors.push(format!("geometry '{}' scale must be positive", name));
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
                GeometryEntryIR::Difference { name, base, tool } => {
                    if name.trim().is_empty() {
                        errors.push("difference geometry name must not be empty".to_string());
                    }
                    let _ = (base, tool);
                }
                // CSG compounds and transforms: validate name only
                GeometryEntryIR::Ellipsoid { name, .. }
                | GeometryEntryIR::Sphere { name, .. }
                | GeometryEntryIR::Ellipse { name, .. }
                | GeometryEntryIR::Union { name, .. }
                | GeometryEntryIR::Intersection { name, .. }
                | GeometryEntryIR::Translate { name, .. } => {
                    if name.trim().is_empty() {
                        errors.push("geometry name must not be empty".to_string());
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
                    InitialMagnetizationIR::PresetTexture { preset_kind, .. } => {
                        if preset_kind.trim().is_empty() {
                            errors.push(format!(
                                "magnet '{}' preset_texture preset_kind must not be empty",
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
                if fem.mesh.as_ref().is_some_and(|mesh| mesh.trim().is_empty()) {
                    errors.push("fem.mesh must not be empty when provided".to_string());
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

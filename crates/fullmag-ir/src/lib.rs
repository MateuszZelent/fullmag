use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub mod eigen_contract;
pub mod execution;
pub mod frequency_response_contract;
pub mod mechanics;
pub mod mesh_assets;
pub mod mesh_hints;
pub mod model;
pub mod plan;
pub mod planar_monitor;
pub mod quantities;
pub mod spectral_validation;
pub mod study;
mod validation;
pub use eigen_contract::*;
pub use execution::*;
pub use frequency_response_contract::*;
pub use mechanics::*;
pub use mesh_assets::*;
pub use mesh_hints::*;
pub use model::*;
pub use plan::*;
pub use planar_monitor::*;
pub use quantities::{
    field_to_quantity_output, scalar_to_quantity_output, OutputSinkIR, QuantityOutputIR,
};
pub use spectral_validation::BlochWavevectorIR;
pub use study::*;
use validation::*;

pub const IR_VERSION: &str = "0.3.0";
pub const CURRENT_IR_VERSION: &str = IR_VERSION;
pub const PREVIOUS_PUBLIC_IR_VERSION: &str = "0.2.0";
pub const LEGACY_PUBLIC_IR_VERSION: &str = "0.1.0";
pub const SUPPORTED_READ_IR_VERSIONS: &[&str] = &[
    CURRENT_IR_VERSION,
    PREVIOUS_PUBLIC_IR_VERSION,
    LEGACY_PUBLIC_IR_VERSION,
];
const MU0_H_PER_M: f64 = 1.256_637_061_435_917_2e-6;

fn validate_sampling_period_policy(
    path: &str,
    policy: &SamplingPeriodPolicyIR,
    errors: &mut Vec<String>,
) {
    match policy {
        SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor,
        } => {
            if *nyquist_guard_factor != AUTO_SINC_NYQUIST_GUARD_FACTOR {
                errors.push(format!(
                    "{path}.nyquist_guard_factor must be exactly {AUTO_SINC_NYQUIST_GUARD_FACTOR}"
                ));
            }
        }
    }
}

pub fn is_supported_ir_version_for_read(version: &str) -> bool {
    let normalized = version.trim();
    !normalized.is_empty() && SUPPORTED_READ_IR_VERSIONS.contains(&normalized)
}

pub fn requires_ir_migration(version: &str) -> bool {
    let normalized = version.trim();
    is_supported_ir_version_for_read(normalized) && normalized != CURRENT_IR_VERSION
}

fn migrate_legacy_cylinder_axes(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.get("kind").and_then(Value::as_str) == Some("cylinder")
                && !object.contains_key("axis")
            {
                object.insert("axis".to_string(), serde_json::json!([0.0, 0.0, 1.0]));
            }
            for child in object.values_mut() {
                migrate_legacy_cylinder_axes(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                migrate_legacy_cylinder_axes(child);
            }
        }
        _ => {}
    }
}

fn migrate_dynamics_adaptive_tolerance_mode(value: &mut Value) {
    if let Some(adaptive) = value
        .as_object_mut()
        .and_then(|dynamics| dynamics.get_mut("adaptive_timestep"))
        .and_then(Value::as_object_mut)
    {
        adaptive
            .entry("tolerance_mode".to_string())
            .or_insert_with(|| Value::String("advanced".to_string()));
    }
}

fn migrate_study_adaptive_tolerance_modes(value: &mut Value) {
    let Some(study) = value.as_object_mut() else {
        return;
    };
    if let Some(dynamics) = study.get_mut("dynamics") {
        migrate_dynamics_adaptive_tolerance_mode(dynamics);
    }
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
    if !SUPPORTED_READ_IR_VERSIONS.contains(&version) {
        return Err(format!("ir_version '{version}' is not supported for read"));
    }

    let source_version = version.to_string();
    object.insert(
        "ir_version".to_string(),
        Value::String(CURRENT_IR_VERSION.to_string()),
    );

    if let Some(meta) = object
        .get_mut("problem_meta")
        .and_then(Value::as_object_mut)
    {
        for key in ["script_api_version", "serializer_version"] {
            if let Some(value) = meta.get(key).and_then(Value::as_str).map(str::trim) {
                if SUPPORTED_READ_IR_VERSIONS.contains(&value) && value != source_version {
                    return Err(format!("ProblemIR.ir_version '{source_version}' conflicts with problem_meta.{key} '{value}'"));
                }
                if value == source_version {
                    meta.insert(
                        key.to_string(),
                        Value::String(CURRENT_IR_VERSION.to_string()),
                    );
                }
            }
        }
    }

    if source_version == LEGACY_PUBLIC_IR_VERSION {
        for value in object.values_mut() {
            migrate_legacy_cylinder_axes(value);
        }
    }
    if matches!(
        source_version.as_str(),
        PREVIOUS_PUBLIC_IR_VERSION | LEGACY_PUBLIC_IR_VERSION
    ) {
        if let Some(study) = object.get_mut("study") {
            migrate_study_adaptive_tolerance_modes(study);
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_regions: Vec<ObjectRegionIR>,
    pub materials: Vec<MaterialIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_parameter_fields: Vec<MaterialParameterAssignmentIR>,
    pub magnets: Vec<MagnetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub couplings: Vec<CouplingIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planar_monitors: Vec<PlanarMonitorIR>,
    pub energy_terms: Vec<EnergyTermIR>,
    pub study: StudyIR,
    pub backend_policy: BackendPolicyIR,
    pub validation_profile: ValidationProfileIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_modules: Vec<CurrentModuleIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_drives: Vec<RegionalFieldDriveIR>,
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
    /// Slonczewski free-layer thickness [m]. When None, engine defaults to cell_dz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_thickness: Option<f64>,
    /// Slonczewski fixed-layer position: "top" or "bottom". Controls current sign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_fixed_layer_position: Option<String>,

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
            #[serde(default)]
            object_regions: Vec<ObjectRegionIR>,
            materials: Vec<MaterialIR>,
            #[serde(default)]
            material_parameter_fields: Vec<MaterialParameterAssignmentIR>,
            magnets: Vec<MagnetIR>,
            #[serde(default)]
            couplings: Vec<CouplingIR>,
            #[serde(default)]
            planar_monitors: Vec<PlanarMonitorIR>,
            energy_terms: Vec<EnergyTermIR>,
            study: StudyIR,
            backend_policy: BackendPolicyIR,
            validation_profile: ValidationProfileIR,
            #[serde(default)]
            current_modules: Vec<CurrentModuleIR>,
            #[serde(default)]
            field_drives: Vec<RegionalFieldDriveIR>,
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
            stt_thickness: Option<f64>,
            #[serde(default)]
            stt_fixed_layer_position: Option<String>,
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
            object_regions: wire.object_regions,
            materials: wire.materials,
            material_parameter_fields: wire.material_parameter_fields,
            magnets: wire.magnets,
            couplings: wire.couplings,
            planar_monitors: wire.planar_monitors,
            energy_terms: wire.energy_terms,
            study: wire.study,
            backend_policy: wire.backend_policy,
            validation_profile: wire.validation_profile,
            current_modules: wire.current_modules,
            field_drives: wire.field_drives,
            excitation_analysis: wire.excitation_analysis,
            spin_torque_modules: wire.spin_torque_modules,
            current_density: wire.current_density,
            stt_degree: wire.stt_degree,
            stt_beta: wire.stt_beta,
            stt_spin_polarization: wire.stt_spin_polarization,
            stt_lambda: wire.stt_lambda,
            stt_epsilon_prime: wire.stt_epsilon_prime,
            stt_thickness: wire.stt_thickness,
            stt_fixed_layer_position: wire.stt_fixed_layer_position,
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
            object_regions: Vec::new(),
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
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            }],
            material_parameter_fields: Vec::new(),
            magnets: vec![MagnetIR {
                name: "strip".to_string(),
                region: "strip".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::RandomSeeded { seed: 42 }),
            }],
            couplings: Vec::new(),
            planar_monitors: Vec::new(),
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
                    table_autosave: None,
                    stage_autosave: None,
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
            field_drives: Vec::new(),
            excitation_analysis: None,
            spin_torque_modules: Vec::new(),
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
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
        validate_runtime_selection(self, &mut errors);
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
        validate_field_drives(self, &mut errors);
        validate_planar_monitors(self, &mut errors);
        validate_spin_wave_response_request(self, &mut errors);
        validate_oersted_energy_terms(self, &mut errors);
        validate_dmi_energy_terms(self, &mut errors);
        validate_material_scalar_values(self, &mut errors);
        validate_material_dmi_values(self, &mut errors);
        validate_legacy_spin_torque_fields(self, &mut errors);
        validate_spin_torque_modules(self, &mut errors);
        validate_magnetoelastic(self, &mut errors);
        validate_region_owned_semantics(self, &mut errors);
        if self.regions.is_empty() {
            errors.push("at least one region is required".to_string());
        }
        if self.materials.is_empty() {
            errors.push("at least one material is required".to_string());
        }
        if self.magnets.is_empty() {
            errors.push("at least one magnet is required".to_string());
        }
        let has_material_anisotropy = self.materials.iter().any(|material| {
            material.uniaxial_anisotropy.is_some()
                || material.uniaxial_anisotropy_k2.is_some()
                || material.cubic_anisotropy_kc1.is_some()
                || material.cubic_anisotropy_kc2.is_some()
                || material.cubic_anisotropy_kc3.is_some()
                || material.ku_field.is_some()
                || material.ku2_field.is_some()
                || material.kc1_field.is_some()
                || material.kc2_field.is_some()
                || material.kc3_field.is_some()
        });
        if self.energy_terms.is_empty() && !has_material_anisotropy {
            errors.push("at least one interaction or material anisotropy is required".to_string());
        }
        if matches!(
            &self.study,
            StudyIR::Eigenmodes { .. } | StudyIR::FrequencyResponse { .. }
        ) && self.study.sampling().outputs.is_empty()
        {
            errors.push("spectral study requires at least one output".to_string());
        }
        for output in &self.study.sampling().outputs {
            match output {
                OutputIR::FieldResolvedAuto {
                    requested_policy, ..
                } => validate_sampling_period_policy(
                    "field_resolved_auto output",
                    requested_policy,
                    &mut errors,
                ),
                OutputIR::ScalarResolvedAuto {
                    requested_policy, ..
                } => validate_sampling_period_policy(
                    "scalar_resolved_auto output",
                    requested_policy,
                    &mut errors,
                ),
                _ => {}
            }
            match output {
                OutputIR::Field {
                    name,
                    every_seconds,
                }
                | OutputIR::FieldResolvedAuto {
                    name,
                    every_seconds,
                    ..
                } => {
                    if name.trim().is_empty() {
                        errors.push("field output name must not be empty".to_string());
                    }
                    if !every_seconds.is_finite() || *every_seconds <= 0.0 {
                        errors.push(format!(
                            "field output '{}' must have finite positive every_seconds",
                            name
                        ));
                    }
                }
                OutputIR::FieldAuto {
                    name,
                    sample_period_policy,
                } => {
                    if name.trim().is_empty() {
                        errors.push("field_auto output name must not be empty".to_string());
                    }
                    validate_sampling_period_policy(
                        "field_auto output",
                        sample_period_policy,
                        &mut errors,
                    );
                }
                OutputIR::Scalar {
                    name,
                    every_seconds,
                }
                | OutputIR::ScalarResolvedAuto {
                    name,
                    every_seconds,
                    ..
                } => {
                    if name.trim().is_empty() {
                        errors.push("scalar output name must not be empty".to_string());
                    }
                    if !every_seconds.is_finite() || *every_seconds <= 0.0 {
                        errors.push(format!(
                            "scalar output '{}' must have finite positive every_seconds",
                            name
                        ));
                    }
                }
                OutputIR::ScalarAuto {
                    name,
                    sample_period_policy,
                } => {
                    if name.trim().is_empty() {
                        errors.push("scalar_auto output name must not be empty".to_string());
                    }
                    validate_sampling_period_policy(
                        "scalar_auto output",
                        sample_period_policy,
                        &mut errors,
                    );
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
                    if !every_seconds.is_finite() || *every_seconds <= 0.0 {
                        errors.push(format!(
                            "snapshot '{}' must have finite positive every_seconds",
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
                OutputIR::FrequencyResponseOutput { .. } => {
                    // Observable enum constrains response output names.
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
                    if !every_seconds.is_finite() || *every_seconds <= 0.0 {
                        errors.push(format!(
                            "save_quantity '{}' must have finite positive every_seconds",
                            quantity_id
                        ));
                    }
                }
            }
        }
        if let Some(table_autosave) = &self.study.sampling().table_autosave {
            if table_autosave.kind != "table_autosave" {
                errors.push("sampling.table_autosave.kind must be 'table_autosave'".to_string());
            }
            if table_autosave.table_id.trim().is_empty() {
                errors.push("sampling.table_autosave.table_id must not be empty".to_string());
            }
            match (
                table_autosave.sample_period_s,
                table_autosave.sample_period_policy.as_ref(),
                table_autosave.resolved_sample_period_s,
                table_autosave.every_steps,
            ) {
                (None, None, None, None) => errors.push(
                    "sampling.table_autosave requires sample_period_s or sample_period_policy"
                        .to_string(),
                ),
                (Some(sample_period_s), None, None, None) => {
                    if !sample_period_s.is_finite() || sample_period_s <= 0.0 {
                        errors.push(
                            "sampling.table_autosave.sample_period_s must be finite and positive"
                                .to_string(),
                        );
                    }
                }
                (None, Some(policy), None, None) => validate_sampling_period_policy(
                    "sampling.table_autosave.sample_period_policy",
                    policy,
                    &mut errors,
                ),
                (None, Some(policy), Some(resolved_sample_period_s), None) => {
                    if !resolved_sample_period_s.is_finite() || resolved_sample_period_s <= 0.0 {
                        errors.push(
                            "sampling.table_autosave.resolved_sample_period_s must be finite and positive"
                                .to_string(),
                        );
                    }
                    validate_sampling_period_policy(
                        "sampling.table_autosave.sample_period_policy",
                        policy,
                        &mut errors,
                    );
                }
                (None, None, None, Some(every_steps)) => {
                    if every_steps == 0 {
                        errors.push(
                            "sampling.table_autosave.every_steps must be a positive accepted-step count"
                                .to_string(),
                        );
                    }
                }
                _ => errors.push(
                    "sampling.table_autosave cadence state is ambiguous; use exactly one of explicit sample_period_s, unresolved sample_period_policy, sample_period_policy with resolved_sample_period_s, or every_steps"
                        .to_string(),
                ),
            }
            let is_relaxation = matches!(&self.study, StudyIR::Relaxation { .. });
            if table_autosave.accepted_step_cadence().is_some() && !is_relaxation {
                errors.push(
                    "sampling.table_autosave.every_steps is only valid for relaxation studies"
                        .to_string(),
                );
            }
            if table_autosave.accepted_step_cadence().is_none() && is_relaxation {
                errors.push(
                    "relaxation table_autosave must use every_steps; simulation-time cadence is not physically meaningful for relaxation"
                        .to_string(),
                );
            }
            if table_autosave.quantities.is_empty() {
                errors.push("sampling.table_autosave.quantities must not be empty".to_string());
            }
            for quantity in &table_autosave.quantities {
                if quantity.trim().is_empty() {
                    errors.push(
                        "sampling.table_autosave.quantities must not contain empty ids".to_string(),
                    );
                }
            }
        }
        if let Some(stage_autosave) = &self.study.sampling().stage_autosave {
            if let Err(stage_errors) = stage_autosave.validate_for_study(&self.study) {
                errors.extend(stage_errors);
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
                            | OutputIR::FrequencyResponseOutput { .. }
                    ) {
                        errors.push(
                            "time_evolution outputs must be field/scalar/snapshot requests"
                                .to_string(),
                        );
                    }
                }
            }
            StudyIR::Relaxation {
                algorithm,
                dynamics,
                stop,
                ..
            } => {
                match (algorithm, dynamics) {
                    (RelaxationAlgorithmIR::LlgOverdamped, Some(dynamics)) => {
                        validate_study_dynamics(dynamics, &mut errors);
                    }
                    (RelaxationAlgorithmIR::LlgOverdamped, None) => errors.push(
                        "relaxation algorithm 'llg_overdamped' requires dynamics".to_string(),
                    ),
                    (_, Some(_)) => errors.push(format!(
                        "relaxation algorithm '{}' is a direct minimizer and requires dynamics=None",
                        algorithm.as_str()
                    )),
                    (_, None) => {}
                }
                if stop
                    .torque_tolerance_apm
                    .is_some_and(|value| !value.is_finite() || value <= 0.0)
                {
                    errors.push(
                        "relaxation.stop.torque_tolerance_apm must be finite and positive"
                            .to_string(),
                    );
                }
                if stop
                    .energy_tolerance_j
                    .is_some_and(|value| !value.is_finite() || value <= 0.0)
                {
                    errors.push(
                        "relaxation.stop.energy_tolerance_j must be finite and positive when provided"
                            .to_string(),
                    );
                }
                if stop.max_steps.is_some_and(|value| value == 0) {
                    errors.push("relaxation.stop.max_steps must be > 0".to_string());
                }
                if stop
                    .max_relaxation_time_s
                    .is_some_and(|value| !value.is_finite() || value <= 0.0)
                {
                    errors.push(
                        "relaxation.stop.max_relaxation_time_s must be finite and positive when provided"
                            .to_string(),
                    );
                }
                if *algorithm != RelaxationAlgorithmIR::LlgOverdamped
                    && stop.max_relaxation_time_s.is_some()
                {
                    errors.push(format!(
                        "relaxation algorithm '{}' is a direct minimizer and does not accept max_relaxation_time_s",
                        algorithm.as_str()
                    ));
                }
                if stop.torque_tolerance_apm.is_none()
                    && stop.energy_tolerance_j.is_none()
                    && stop.max_steps.is_none()
                    && stop.max_relaxation_time_s.is_none()
                {
                    errors.push("relaxation.stop requires at least one stop criterion".to_string());
                }
                for output in &self.study.sampling().outputs {
                    if matches!(
                        output,
                        OutputIR::EigenSpectrum { .. }
                            | OutputIR::EigenMode { .. }
                            | OutputIR::DispersionCurve { .. }
                            | OutputIR::FrequencyResponseOutput { .. }
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
                damping_policy,
                spin_wave_bc,
                magnetostatic_bc,
                ..
            } => {
                validate_frequency_response_dynamics(dynamics, &mut errors);
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
                    EigenTargetIR::FrequencyWindow {
                        frequency_min_hz,
                        frequency_max_hz,
                    } => {
                        if *frequency_min_hz <= 0.0 {
                            errors.push(
                                "eigenmodes.target.frequency_min_hz must be positive".to_string(),
                            );
                        }
                        if *frequency_max_hz <= 0.0 {
                            errors.push(
                                "eigenmodes.target.frequency_max_hz must be positive".to_string(),
                            );
                        }
                        if frequency_min_hz >= frequency_max_hz {
                            errors.push(
                                "eigenmodes.target.frequency_min_hz must be less than frequency_max_hz".to_string(),
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
                    closed,
                }) = k_sampling
                {
                    validate_k_sampling_path(
                        "eigenmodes.k_sampling.path",
                        points,
                        samples_per_segment,
                        *closed,
                        &mut errors,
                    );
                }
                if *magnetostatic_bc == MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
                    if !operator.include_demag {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_demag".to_string());
                    }
                    if spin_wave_bc.kind() != SpinWaveBoundaryKindIR::Periodic {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_periodic_spin_wave_bc".to_string());
                    }
                    if !matches!(k_sampling, Some(KSamplingIR::Single { k_vector: [0.0, 0.0, 0.0] })) {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_exact_zero_k".to_string());
                    }
                    if *damping_policy != EigenDampingPolicyIR::Ignore {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_alpha_zero".to_string());
                    }
                    if self.backend_policy.execution_precision != ExecutionPrecision::Double {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_double_precision".to_string());
                    }
                    if !self.energy_terms.iter().any(|term| matches!(term, EnergyTermIR::Demag { .. })) {
                        errors.push("eigenmodes.k0_periodic_airbox_requires_demag_energy".to_string());
                    }
                    match &self.pbc {
                        Some(periodicity)
                            if periodicity.axes == [AxisBoundary::Periodic, AxisBoundary::Periodic, AxisBoundary::Open] => {}
                        Some(periodicity) if periodicity.axes[2] == AxisBoundary::Periodic => {
                            errors.push("eigenmodes.k0_periodic_airbox_rejects_fully_periodic_3d".to_string());
                        }
                        _ => errors.push("eigenmodes.k0_periodic_airbox_requires_xy_periodic_open_z".to_string()),
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
                            | OutputIR::FieldAuto { .. }
                            | OutputIR::FieldResolvedAuto { .. }
                            | OutputIR::Scalar { .. }
                            | OutputIR::ScalarAuto { .. }
                            | OutputIR::ScalarResolvedAuto { .. }
                            | OutputIR::Snapshot { .. }
                    ) {
                        errors.push(
                            "eigenmodes outputs must be eigen_spectrum/eigen_mode/dispersion_curve requests"
                                .to_string(),
                        );
                    }
                }
            }
            StudyIR::FrequencyResponse {
                dynamics,
                operator,
                equilibrium,
                k_sampling,
                excitation,
                frequencies_hz,
                solver_policy,
                ..
            } => {
                validate_frequency_response_dynamics(dynamics, &mut errors);
                match operator.kind {
                    EigenOperatorIR::LinearizedLlg => {}
                    EigenOperatorIR::Full2x2 => {}
                }
                if let EquilibriumSourceIR::Artifact { path } = equilibrium {
                    if path.trim().is_empty() {
                        errors.push(
                            "frequency_response.equilibrium artifact path must not be empty"
                                .to_string(),
                        );
                    }
                }
                if let Some(KSamplingIR::Single { k_vector }) = k_sampling {
                    if !k_vector.iter().all(|value| value.is_finite()) {
                        errors.push(
                            "frequency_response.k_sampling.k_vector must contain finite values"
                                .to_string(),
                        );
                    }
                }
                if let Some(KSamplingIR::Path {
                    points,
                    samples_per_segment,
                    closed,
                }) = k_sampling
                {
                    validate_k_sampling_path(
                        "frequency_response.k_sampling.path",
                        points,
                        samples_per_segment,
                        *closed,
                        &mut errors,
                    );
                }
                if !excitation
                    .field_au_per_m
                    .iter()
                    .all(|value| value.is_finite())
                {
                    errors.push(
                        "frequency_response.excitation.field_au_per_m must contain finite values"
                            .to_string(),
                    );
                }
                if !excitation.phase_rad.is_finite() {
                    errors
                        .push("frequency_response.excitation.phase_rad must be finite".to_string());
                }
                if frequencies_hz.values_hz.is_empty() {
                    errors.push(
                        "frequency_response.frequencies_hz.values_hz must not be empty".to_string(),
                    );
                }
                if frequencies_hz
                    .values_hz
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
                {
                    errors.push(
                        "frequency_response.frequencies_hz.values_hz entries must be finite and > 0"
                            .to_string(),
                    );
                }
                if let Some(policy) = solver_policy {
                    if let Some(rtol) = policy.rtol {
                        if !rtol.is_finite() || rtol <= 0.0 {
                            errors.push(
                                "frequency_response.solver_policy.rtol must be finite and > 0"
                                    .to_string(),
                            );
                        }
                    }
                    if let Some(0) = policy.max_iterations {
                        errors.push(
                            "frequency_response.solver_policy.max_iterations must be > 0"
                                .to_string(),
                        );
                    }
                    if let Some(0) = policy.restart_iterations {
                        errors.push(
                            "frequency_response.solver_policy.restart_iterations must be > 0"
                                .to_string(),
                        );
                    }
                    if let (Some(restart), Some(max)) =
                        (policy.restart_iterations, policy.max_iterations)
                    {
                        if restart > max {
                            errors.push(
                                "frequency_response.solver_policy.restart_iterations must be <= max_iterations"
                                    .to_string(),
                            );
                        }
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
                let has_response_output = self
                    .study
                    .sampling()
                    .outputs
                    .iter()
                    .any(|output| matches!(output, OutputIR::FrequencyResponseOutput { .. }));
                if !has_mode_output && !has_spectrum_output && !has_response_output {
                    errors.push(
                        "frequency_response study requires at least one frequency_response_output, eigen_spectrum, or eigen_mode output"
                            .to_string(),
                    );
                }
                for output in &self.study.sampling().outputs {
                    if matches!(
                        output,
                        OutputIR::Field { .. }
                            | OutputIR::FieldAuto { .. }
                            | OutputIR::FieldResolvedAuto { .. }
                            | OutputIR::Scalar { .. }
                            | OutputIR::ScalarAuto { .. }
                            | OutputIR::ScalarResolvedAuto { .. }
                            | OutputIR::Snapshot { .. }
                    ) {
                        errors.push(
                            "frequency_response outputs must be frequency_response_output/eigen_spectrum/eigen_mode/dispersion_curve requests"
                                .to_string(),
                        );
                    }
                }
            }
            StudyIR::Hysteresis {
                direction,
                orientation,
                measurement_axis,
                angular_family,
                initial_protocol,
                initial_state_ref,
                saturation,
                branch_mode,
                storage,
                field_min_mT,
                field_max_mT,
                field_step_mT,
                field_values_mT,
                field_unit_provenance,
                settle_pipeline,
                field_schedule,
                schedule_refinements,
                adaptive_refinement,
                minor_loops,
                ..
            } => {
                if field_min_mT.is_some_and(|value| !value.is_finite()) {
                    errors
                        .push("study.stages[].hysteresis.field_min_mT must be finite".to_string());
                }
                if field_max_mT.is_some_and(|value| !value.is_finite()) {
                    errors
                        .push("study.stages[].hysteresis.field_max_mT must be finite".to_string());
                }
                if let Some(d) = direction {
                    if !vector_is_finite(d) {
                        errors.push(
                            "study.stages[].hysteresis.direction must contain finite values"
                                .to_string(),
                        );
                    } else if vector_norm_sq(d) <= 1e-30 {
                        errors.push(
                            "study.stages[].hysteresis.direction must not be the zero vector"
                                .to_string(),
                        );
                    }
                }
                validate_hysteresis_orientation(orientation.as_ref(), &mut errors);
                validate_hysteresis_measurement_axis(measurement_axis, &mut errors);
                if let Some(family) = angular_family {
                    validate_hysteresis_angular_family(family, &mut errors);
                }
                if !matches!(
                    initial_protocol.as_str(),
                    "as_authored"
                        | "zero_field_relaxed"
                        | "positive_saturation"
                        | "negative_saturation"
                        | "checkpoint"
                ) {
                    errors.push(
                        "study.stages[].hysteresis.initial_protocol is unsupported".to_string(),
                    );
                }
                if initial_protocol == "checkpoint"
                    && initial_state_ref.as_deref().is_none_or(str::is_empty)
                {
                    errors.push(
                        "study.stages[].hysteresis.initial_state_ref is required when initial_protocol is checkpoint"
                            .to_string(),
                    );
                }
                if !matches!(
                    branch_mode.as_str(),
                    "major_loop"
                        | "major_with_minor_loops"
                        | "virgin_curve"
                        | "virgin_then_major_loop"
                ) {
                    errors.push("study.stages[].hysteresis.branch_mode is unsupported".to_string());
                }
                if let Some(probe) = saturation {
                    validate_hysteresis_saturation_probe(probe, &mut errors);
                }
                if let Some(policy) = storage {
                    validate_hysteresis_storage(policy, &mut errors);
                }
                if field_values_mT.as_ref().is_some_and(Vec::is_empty) {
                    errors.push(
                        "study.stages[].hysteresis.field_values_mT must not be empty".to_string(),
                    );
                }
                if let Some(values) = field_values_mT {
                    for (idx, value) in values.iter().enumerate() {
                        if !value.is_finite() {
                            errors.push(format!(
                                "study.stages[].hysteresis.field_values_mT[{}] must be finite",
                                idx
                            ));
                        }
                    }
                }
                if let Some(provenance) = field_unit_provenance {
                    validate_hysteresis_field_unit_provenance(provenance, &mut errors);
                }
                if let Some(step) = field_step_mT {
                    if !step.is_finite() {
                        errors.push(
                            "study.stages[].hysteresis.field_step_mT must be finite".to_string(),
                        );
                    } else if *step == 0.0 {
                        errors.push(
                            "study.stages[].hysteresis.field_step_mT must not be zero".to_string(),
                        );
                    }
                }
                if let Some(sched) = field_schedule {
                    if sched.segments.is_empty() {
                        errors.push(
                            "study.stages[].hysteresis.field_schedule.segments must not be empty"
                                .to_string(),
                        );
                    }
                    for (idx, seg) in sched.segments.iter().enumerate() {
                        if seg.segment_id.trim().is_empty() {
                            errors.push(format!("study.stages[].hysteresis.field_schedule.segments[{}].segment_id must not be empty", idx));
                        }
                        if seg.step <= 0.0 {
                            errors.push(format!("study.stages[].hysteresis.field_schedule.segments[{}].step must be positive", idx));
                        }
                        if !seg.start.is_finite() || !seg.stop.is_finite() || !seg.step.is_finite()
                        {
                            errors.push(format!("study.stages[].hysteresis.field_schedule.segments[{}] start, stop, and step must be finite", idx));
                        }
                        if seg.start == seg.stop {
                            errors.push(format!("study.stages[].hysteresis.field_schedule.segments[{}].start and stop must differ", idx));
                        }
                        if !matches!(
                            seg.endpoint_policy.as_str(),
                            "include_stop" | "skip_start" | "include_both"
                        ) {
                            errors.push(format!("study.stages[].hysteresis.field_schedule.segments[{}].endpoint_policy is unsupported", idx));
                        }
                    }
                }
                if let Some(windows) = schedule_refinements {
                    validate_hysteresis_field_windows(windows, &mut errors);
                }
                if let Some(policy) = adaptive_refinement {
                    validate_hysteresis_adaptive_refinement(policy, &mut errors);
                }
                if let Some(loops) = minor_loops {
                    validate_hysteresis_minor_loops(loops, &mut errors);
                }
                if let Some(pipeline) = settle_pipeline {
                    match pipeline {
                        SettlePipelineIR::Sequence { steps } => {
                            if steps.is_empty() {
                                errors.push(
                                    "study.stages[].hysteresis.settle_pipeline must not be empty"
                                        .to_string(),
                                );
                            }
                            for (idx, step) in steps.iter().enumerate() {
                                validate_settle_step(step, idx, &mut errors);
                                if settle_non_convergence(step) == "run_next_algorithm"
                                    && idx + 1 == steps.len()
                                {
                                    errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].on_non_convergence run_next_algorithm requires a following step", idx));
                                }
                            }
                        }
                        SettlePipelineIR::Tree { default, branches } => {
                            validate_settle_step(default, 0, &mut errors);
                            if settle_non_convergence(default) == "run_next_algorithm"
                                && !branches.iter().any(|branch| {
                                    matches!(
                                        branch.when.as_str(),
                                        "non_converged" | "fallback" | "run_next_algorithm"
                                    )
                                })
                            {
                                errors.push("study.stages[].hysteresis.settle_pipeline.default.on_non_convergence run_next_algorithm requires a non_converged fallback branch".to_string());
                            }
                            for (idx, branch) in branches.iter().enumerate() {
                                validate_settle_step(&branch.run, idx + 1, &mut errors);
                            }
                        }
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
                    axis,
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
                    if axis.iter().any(|component| !component.is_finite()) {
                        errors.push(format!(
                            "cylinder geometry '{}' axis must contain finite values",
                            name
                        ));
                    } else {
                        let norm_sq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
                        if norm_sq <= 1e-30 {
                            errors.push(format!(
                                "cylinder geometry '{}' axis must be non-zero",
                                name
                            ));
                        }
                    }
                }
                GeometryEntryIR::SinWaveguide {
                    name,
                    length,
                    width,
                    height,
                    period,
                    amplitude,
                    phase,
                    z0,
                } => {
                    if name.trim().is_empty() {
                        errors.push("sin_waveguide geometry name must not be empty".to_string());
                    }
                    if *length <= 0.0 {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' length must be positive",
                            name
                        ));
                    }
                    if *width <= 0.0 {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' width must be positive",
                            name
                        ));
                    }
                    if *height <= 0.0 {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' height must be positive",
                            name
                        ));
                    }
                    if *period <= 0.0 {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' period must be positive",
                            name
                        ));
                    }
                    if !amplitude.is_finite() {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' amplitude must be finite",
                            name
                        ));
                    }
                    if !phase.is_finite() {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' phase must be finite",
                            name
                        ));
                    }
                    if !z0.is_finite() {
                        errors.push(format!(
                            "sin_waveguide geometry '{}' z0 must be finite",
                            name
                        ));
                    }
                }
                GeometryEntryIR::ArchWaveguide {
                    name,
                    length,
                    width,
                    height,
                    arch_height,
                    z0,
                } => {
                    if name.trim().is_empty() {
                        errors.push("arch_waveguide geometry name must not be empty".to_string());
                    }
                    if *length <= 0.0 {
                        errors.push(format!(
                            "arch_waveguide geometry '{}' length must be positive",
                            name
                        ));
                    }
                    if *width <= 0.0 {
                        errors.push(format!(
                            "arch_waveguide geometry '{}' width must be positive",
                            name
                        ));
                    }
                    if *height <= 0.0 {
                        errors.push(format!(
                            "arch_waveguide geometry '{}' height must be positive",
                            name
                        ));
                    }
                    if !arch_height.is_finite() {
                        errors.push(format!(
                            "arch_waveguide geometry '{}' arch_height must be finite",
                            name
                        ));
                    }
                    if !z0.is_finite() {
                        errors.push(format!(
                            "arch_waveguide geometry '{}' z0 must be finite",
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
                validate_initial_magnetization(
                    &format!("magnet '{}'", magnet.name),
                    initial_magnetization,
                    &mut errors,
                );
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
                let legacy_cell =
                    (!fdm.cell.iter().all(|component| *component == 0.0)).then_some(fdm.cell);
                let default_cell = fdm.default_cell.or(legacy_cell);
                if let Some(cell) = default_cell {
                    if cell
                        .iter()
                        .any(|component| !component.is_finite() || *component <= 0.0)
                    {
                        errors.push(
                            "fdm.default_cell components must be finite and positive".to_string(),
                        );
                    }
                }
                if let Some(per_magnet) = &fdm.per_magnet {
                    for (magnet_name, grid) in per_magnet {
                        if magnet_name.trim().is_empty() {
                            errors.push("fdm.per_magnet keys must not be empty".to_string());
                        }
                        if grid
                            .cell
                            .iter()
                            .any(|component| !component.is_finite() || *component <= 0.0)
                        {
                            errors.push(format!(
                                "fdm.per_magnet['{}'].cell components must be finite and positive",
                                magnet_name
                            ));
                        }
                    }
                    let magnet_names: std::collections::BTreeSet<&str> = self
                        .magnets
                        .iter()
                        .map(|magnet| magnet.name.as_str())
                        .collect();
                    for magnet in &self.magnets {
                        if default_cell.is_none() && !per_magnet.contains_key(&magnet.name) {
                            errors.push(format!(
                                "fdm.per_magnet missing cell override for magnet '{}' and no default_cell is set",
                                magnet.name
                            ));
                        }
                    }
                    for override_name in per_magnet.keys() {
                        if !magnet_names.contains(override_name.as_str()) {
                            errors.push(format!(
                                "fdm.per_magnet contains override for unknown magnet '{}'",
                                override_name
                            ));
                        }
                    }
                } else if default_cell.is_none() {
                    errors.push(
                        "fdm requires default_cell (or legacy cell) when per_magnet is absent"
                            .to_string(),
                    );
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

fn validate_k_sampling_path(
    prefix: &str,
    points: &[KPointIR],
    samples_per_segment: &[u32],
    closed: bool,
    errors: &mut Vec<String>,
) {
    if points.len() < 2 {
        errors.push(format!("{prefix} requires at least two control points"));
    }
    for point in points {
        if !point.k_vector.iter().all(|v| v.is_finite()) {
            errors.push(format!(
                "{prefix} point k_vector must contain finite values"
            ));
        }
    }
    let expected_segments = if closed {
        points.len()
    } else {
        points.len().saturating_sub(1)
    };
    if samples_per_segment.len() != expected_segments {
        errors.push(format!(
            "{prefix} expected {expected_segments} samples_per_segment entries, got {}",
            samples_per_segment.len()
        ));
    }
    if samples_per_segment.iter().any(|n| *n == 0) {
        errors.push(format!("{prefix} samples_per_segment entries must be > 0"));
    }
}

fn validate_region_owned_semantics(problem: &ProblemIR, errors: &mut Vec<String>) {
    let geometry_names: BTreeSet<&str> = problem
        .geometry
        .entries
        .iter()
        .map(GeometryEntryIR::name)
        .collect();
    let magnet_names: BTreeSet<&str> = problem
        .magnets
        .iter()
        .map(|magnet| magnet.name.as_str())
        .collect();
    let region_ids: BTreeSet<&str> = problem
        .object_regions
        .iter()
        .map(|region| region.region_id.as_str())
        .collect();
    let region_owner_by_id: BTreeMap<&str, &str> = problem
        .object_regions
        .iter()
        .map(|region| (region.region_id.as_str(), region.owner_object.as_str()))
        .collect();
    let region_enabled_by_id: BTreeMap<&str, bool> = problem
        .object_regions
        .iter()
        .map(|region| (region.region_id.as_str(), region.enabled))
        .collect();

    let mut seen_region_ids = BTreeSet::new();
    let mut seen_region_names = BTreeSet::new();
    for (index, region) in problem.object_regions.iter().enumerate() {
        if region.region_id.trim().is_empty() {
            errors.push(format!(
                "object_regions[{index}] region_id must not be empty"
            ));
        } else if !seen_region_ids.insert(region.region_id.as_str()) {
            errors.push(format!(
                "object_regions[{index}] duplicate region_id '{}'",
                region.region_id
            ));
        }
        validate_magnetic_object_ref(
            &format!("object_regions[{index}].owner_object"),
            region.owner_object.as_str(),
            &geometry_names,
            &magnet_names,
            errors,
        );
        if region.name.trim().is_empty() {
            errors.push(format!("object_regions[{index}] name must not be empty"));
        } else if !seen_region_names.insert((region.owner_object.as_str(), region.name.as_str())) {
            errors.push(format!(
                "object_regions[{index}] duplicate name '{}' for owner '{}'",
                region.name, region.owner_object
            ));
        }
        validate_object_region_shape(index, &region.shape, errors);
        if let Some(mesh_policy) = &region.mesh_policy {
            validate_region_mesh_policy(index, mesh_policy, errors);
        }
        validate_material_transition(
            &format!("object_regions[{index}].material_transition"),
            &region.material_transition,
            errors,
        );
        for (override_index, material_override) in region.material_overrides.iter().enumerate() {
            validate_material_parameter_field(
                &format!("object_regions[{index}].material_overrides[{override_index}]"),
                material_override.parameter,
                &material_override.value,
                errors,
            );
        }
        if let Some(texture_override) = &region.texture_override {
            validate_initial_magnetization(
                &format!("object_regions[{index}].texture_override.initial_magnetization"),
                &texture_override.initial_magnetization,
                errors,
            );
        }
    }

    let mut seen_assignment_ids = BTreeSet::new();
    for (index, assignment) in problem.material_parameter_fields.iter().enumerate() {
        if assignment.assignment_id.trim().is_empty() {
            errors.push(format!(
                "material_parameter_fields[{index}] assignment_id must not be empty"
            ));
        } else if !seen_assignment_ids.insert(assignment.assignment_id.as_str()) {
            errors.push(format!(
                "material_parameter_fields[{index}] duplicate assignment_id '{}'",
                assignment.assignment_id
            ));
        }
        validate_magnetic_object_ref(
            &format!("material_parameter_fields[{index}].owner_object"),
            assignment.owner_object.as_str(),
            &geometry_names,
            &magnet_names,
            errors,
        );
        if let Some(region_id) = assignment.region_id.as_deref() {
            if !region_ids.contains(region_id) {
                errors.push(format!(
                    "material_parameter_fields[{index}] region_id '{}' does not reference an object_region",
                    region_id
                ));
            } else if region_owner_by_id
                .get(region_id)
                .is_some_and(|owner| *owner != assignment.owner_object.as_str())
            {
                errors.push(format!(
                    "material_parameter_fields[{index}] region_id '{}' belongs to a different owner than '{}'",
                    region_id, assignment.owner_object
                ));
            }
        }
        validate_material_parameter_field(
            &format!("material_parameter_fields[{index}]"),
            assignment.parameter,
            &assignment.value,
            errors,
        );
    }

    let mut seen_coupling_ids = BTreeSet::new();
    for (index, coupling) in problem.couplings.iter().enumerate() {
        if coupling.coupling_id.trim().is_empty() {
            errors.push(format!("couplings[{index}] coupling_id must not be empty"));
        } else if !seen_coupling_ids.insert(coupling.coupling_id.as_str()) {
            errors.push(format!(
                "couplings[{index}] duplicate coupling_id '{}'",
                coupling.coupling_id
            ));
        }
        validate_coupling_endpoint(
            &format!("couplings[{index}].source"),
            &coupling.source,
            &geometry_names,
            &magnet_names,
            &region_ids,
            &region_owner_by_id,
            &region_enabled_by_id,
            coupling.enabled,
            errors,
        );
        validate_coupling_endpoint(
            &format!("couplings[{index}].target"),
            &coupling.target,
            &geometry_names,
            &magnet_names,
            &region_ids,
            &region_owner_by_id,
            &region_enabled_by_id,
            coupling.enabled,
            errors,
        );
        match (&coupling.kind, &coupling.parameters) {
            (
                CouplingKindIR::Exchange,
                CouplingParametersIR::Exchange {
                    mode,
                    scale,
                    inter_exchange,
                },
            ) => {
                if scale.is_some_and(|value| !value.is_finite() || value < 0.0) {
                    errors.push(format!(
                        "couplings[{index}] exchange scale must be finite and >= 0"
                    ));
                }
                match mode {
                    ExchangeCouplingModeIR::HarmonicMean if inter_exchange.is_some() => {
                        errors.push(format!(
                            "couplings[{index}] harmonic_mean exchange must not define inter_exchange"
                        ));
                    }
                    ExchangeCouplingModeIR::Explicit => {
                        if !inter_exchange.is_some_and(f64::is_finite) {
                            errors.push(format!(
                                "couplings[{index}] explicit exchange requires finite inter_exchange"
                            ));
                        }
                    }
                    _ => {}
                }
            }
            (CouplingKindIR::Rkky, CouplingParametersIR::Rkky { j1 })
            | (
                CouplingKindIR::InterlayerExchange,
                CouplingParametersIR::InterlayerExchange { j1, .. },
            ) => {
                if !j1.is_finite() {
                    errors.push(format!("couplings[{index}] J1 must be finite"));
                }
                if !matches!(coupling.source, CouplingEndpointIR::Surface { .. })
                    || !matches!(coupling.target, CouplingEndpointIR::Surface { .. })
                {
                    errors.push(format!(
                        "couplings[{index}] rkky/interlayer_exchange endpoints must be surfaces"
                    ));
                }
            }
            _ => errors.push(format!(
                "couplings[{index}] kind and parameters kind must match"
            )),
        }
    }

    validate_region_owned_material_conflicts(problem, errors);
}

fn validate_initial_magnetization(
    path: &str,
    initial_magnetization: &InitialMagnetizationIR,
    errors: &mut Vec<String>,
) {
    match initial_magnetization {
        InitialMagnetizationIR::Uniform { .. } => {}
        InitialMagnetizationIR::RandomSeeded { seed } => {
            if *seed == 0 {
                errors.push(format!("{path} random_seeded seed must be positive"));
            }
        }
        InitialMagnetizationIR::SampledField { values } => {
            if values.is_empty() {
                errors.push(format!("{path} sampled_field values must not be empty"));
            }
        }
        InitialMagnetizationIR::PresetTexture { preset_kind, .. } => {
            if preset_kind.trim().is_empty() {
                errors.push(format!(
                    "{path} preset_texture preset_kind must not be empty"
                ));
            }
        }
    }
}

fn validate_region_owned_material_conflicts(problem: &ProblemIR, errors: &mut Vec<String>) {
    #[derive(Clone)]
    struct MaterialSupport {
        source: String,
        owner_object: String,
        region_id: Option<String>,
        parameter: MaterialParameterNameIR,
        priority: i32,
    }

    fn supports_overlap(left: &MaterialSupport, right: &MaterialSupport) -> bool {
        left.owner_object == right.owner_object
            && left.parameter == right.parameter
            && left.priority == right.priority
            && (left.region_id.is_none()
                || right.region_id.is_none()
                || left.region_id == right.region_id)
    }

    let mut supports = Vec::new();
    let enabled_region_ids = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled)
        .map(|region| region.region_id.as_str())
        .collect::<BTreeSet<_>>();
    for (region_index, region) in problem.object_regions.iter().enumerate() {
        if !region.enabled {
            continue;
        }
        for (override_index, material_override) in region.material_overrides.iter().enumerate() {
            supports.push(MaterialSupport {
                source: format!(
                    "object_regions[{region_index}].material_overrides[{override_index}]"
                ),
                owner_object: region.owner_object.clone(),
                region_id: Some(region.region_id.clone()),
                parameter: material_override.parameter,
                priority: material_override.priority,
            });
        }
    }
    for (assignment_index, assignment) in problem.material_parameter_fields.iter().enumerate() {
        if assignment
            .region_id
            .as_deref()
            .is_some_and(|region_id| !enabled_region_ids.contains(region_id))
        {
            continue;
        }
        supports.push(MaterialSupport {
            source: format!("material_parameter_fields[{assignment_index}]"),
            owner_object: assignment.owner_object.clone(),
            region_id: assignment.region_id.clone(),
            parameter: assignment.parameter,
            priority: assignment.priority,
        });
    }

    for left_index in 0..supports.len() {
        for right_index in (left_index + 1)..supports.len() {
            let left = &supports[left_index];
            let right = &supports[right_index];
            if supports_overlap(left, right) {
                errors.push(format!(
                    "region-owned material parameter conflict: {} and {} both assign {:?} on overlapping support at priority {}; use distinct priorities",
                    left.source, right.source, left.parameter, left.priority
                ));
            }
        }
    }
}

fn validate_magnetic_object_ref(
    path: &str,
    object: &str,
    geometry_names: &BTreeSet<&str>,
    magnet_names: &BTreeSet<&str>,
    errors: &mut Vec<String>,
) {
    if object.trim().is_empty() {
        errors.push(format!("{path} must not be empty"));
    } else if is_airbox_name(object) {
        errors.push(format!("{path} must be magnetic, not airbox"));
    } else if !geometry_names.contains(object) && !magnet_names.contains(object) {
        errors.push(format!(
            "{path} '{}' does not reference a known geometry or magnet",
            object
        ));
    }
}

fn validate_object_region_shape(index: usize, shape: &RegionShapeIR, errors: &mut Vec<String>) {
    match shape {
        RegionShapeIR::Box { size, center } => {
            if size.iter().any(|value| !value.is_finite() || *value <= 0.0) {
                errors.push(format!(
                    "object_regions[{index}] box size components must be finite and > 0"
                ));
            }
            if !vector_is_finite(center) {
                errors.push(format!(
                    "object_regions[{index}] box center must contain finite values"
                ));
            }
        }
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            if !radius.is_finite() || *radius <= 0.0 {
                errors.push(format!(
                    "object_regions[{index}] cylinder radius must be finite and > 0"
                ));
            }
            if !height.is_finite() || *height <= 0.0 {
                errors.push(format!(
                    "object_regions[{index}] cylinder height must be finite and > 0"
                ));
            }
            if !vector_is_finite(center) {
                errors.push(format!(
                    "object_regions[{index}] cylinder center must contain finite values"
                ));
            }
            if !vector_is_finite(axis) || vector_norm_sq(axis) <= 1e-30 {
                errors.push(format!(
                    "object_regions[{index}] cylinder axis must be finite and non-zero"
                ));
            }
        }
        RegionShapeIR::Sphere { radius, center } => {
            if !radius.is_finite() || *radius <= 0.0 {
                errors.push(format!(
                    "object_regions[{index}] sphere radius must be finite and > 0"
                ));
            }
            if !vector_is_finite(center) {
                errors.push(format!(
                    "object_regions[{index}] sphere center must contain finite values"
                ));
            }
        }
        RegionShapeIR::Csg { expression } => {
            if expression.name().trim().is_empty() {
                errors.push(format!(
                    "object_regions[{index}] csg expression name must not be empty"
                ));
            }
        }
    }
}

fn validate_region_mesh_policy(
    index: usize,
    policy: &RegionMeshPolicyIR,
    errors: &mut Vec<String>,
) {
    if policy
        .maximum_element_size
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        errors.push(format!(
            "object_regions[{index}] mesh_policy.maximum_element_size must be finite and > 0"
        ));
    }
    if policy
        .minimum_element_size
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        errors.push(format!(
            "object_regions[{index}] mesh_policy.minimum_element_size must be finite and > 0"
        ));
    }
    if policy
        .transition_distance
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        errors.push(format!(
            "object_regions[{index}] mesh_policy.transition_distance must be finite and >= 0"
        ));
    }
    if policy.order.is_some_and(|order| order == 0) {
        errors.push(format!(
            "object_regions[{index}] mesh_policy.order must be >= 1"
        ));
    }
}

fn validate_material_transition(
    path: &str,
    transition: &Option<MaterialTransitionSpecIR>,
    errors: &mut Vec<String>,
) {
    match transition {
        Some(MaterialTransitionSpecIR::MeshRelative { cells, .. }) if *cells == 0 => {
            errors.push(format!("{path}.cells must be >= 1"));
        }
        Some(MaterialTransitionSpecIR::Metric { width, .. })
            if !width.is_finite() || *width <= 0.0 =>
        {
            errors.push(format!("{path}.width must be finite and > 0"));
        }
        _ => {}
    }
}

fn validate_material_parameter_field(
    path: &str,
    parameter: MaterialParameterNameIR,
    field: &MaterialParameterFieldIR,
    errors: &mut Vec<String>,
) {
    match field {
        MaterialParameterFieldIR::Constant { value, .. } => {
            if let Some(number) = value.as_f64() {
                validate_material_parameter_number(path, parameter, number, errors);
            } else if parameter != MaterialParameterNameIR::AnisotropyAxis {
                errors.push(format!("{path} constant value must be numeric"));
            }
        }
        MaterialParameterFieldIR::Linear { base, gradient, .. } => {
            validate_material_parameter_number(path, parameter, *base, errors);
            if !vector_is_finite(gradient) {
                errors.push(format!("{path} linear gradient must contain finite values"));
            }
        }
        MaterialParameterFieldIR::Radial {
            center,
            radius,
            inside,
            outside,
            ..
        } => {
            if !vector_is_finite(center) {
                errors.push(format!("{path} radial center must contain finite values"));
            }
            if !radius.is_finite() || *radius <= 0.0 {
                errors.push(format!("{path} radial radius must be finite and > 0"));
            }
            validate_material_parameter_number(path, parameter, *inside, errors);
            validate_material_parameter_number(path, parameter, *outside, errors);
        }
        MaterialParameterFieldIR::Sampled {
            asset_id,
            component_count,
            unit,
            ..
        } => {
            if asset_id.trim().is_empty() {
                errors.push(format!("{path} sampled asset_id must not be empty"));
            }
            if *component_count == 0 {
                errors.push(format!("{path} sampled component_count must be > 0"));
            }
            if unit.trim().is_empty() {
                errors.push(format!("{path} sampled unit must not be empty"));
            }
        }
    }
}

fn validate_material_parameter_number(
    path: &str,
    parameter: MaterialParameterNameIR,
    value: f64,
    errors: &mut Vec<String>,
) {
    if !value.is_finite() {
        errors.push(format!("{path} value must be finite"));
        return;
    }
    match parameter {
        MaterialParameterNameIR::Ms if value <= 0.0 => {
            errors.push(format!("{path} Ms must be > 0 in active magnetic objects"));
        }
        MaterialParameterNameIR::Aex | MaterialParameterNameIR::Alpha if value < 0.0 => {
            errors.push(format!("{path} {parameter:?} must be >= 0"));
        }
        _ => {}
    }
}

fn validate_material_scalar_values(problem: &ProblemIR, errors: &mut Vec<String>) {
    for (index, material) in problem.materials.iter().enumerate() {
        validate_material_parameter_number(
            &format!("materials[{index}].saturation_magnetisation"),
            MaterialParameterNameIR::Ms,
            material.saturation_magnetisation,
            errors,
        );
        validate_material_parameter_number(
            &format!("materials[{index}].exchange_stiffness"),
            MaterialParameterNameIR::Aex,
            material.exchange_stiffness,
            errors,
        );
        validate_material_parameter_number(
            &format!("materials[{index}].damping"),
            MaterialParameterNameIR::Alpha,
            material.damping,
            errors,
        );
        if let Some(value) = material.uniaxial_anisotropy {
            validate_material_parameter_number(
                &format!("materials[{index}].uniaxial_anisotropy"),
                MaterialParameterNameIR::Ku1,
                value,
                errors,
            );
        }
        if let Some(value) = material.uniaxial_anisotropy_k2 {
            validate_material_parameter_number(
                &format!("materials[{index}].uniaxial_anisotropy_k2"),
                MaterialParameterNameIR::Ku2,
                value,
                errors,
            );
        }
    }
}

fn validate_coupling_endpoint(
    path: &str,
    endpoint: &CouplingEndpointIR,
    geometry_names: &BTreeSet<&str>,
    magnet_names: &BTreeSet<&str>,
    region_ids: &BTreeSet<&str>,
    region_owner_by_id: &BTreeMap<&str, &str>,
    region_enabled_by_id: &BTreeMap<&str, bool>,
    coupling_enabled: bool,
    errors: &mut Vec<String>,
) {
    let object = match endpoint {
        CouplingEndpointIR::Object { object }
        | CouplingEndpointIR::Region { object, .. }
        | CouplingEndpointIR::Surface { object, .. } => object,
    };
    validate_magnetic_object_ref(path, object, geometry_names, magnet_names, errors);
    match endpoint {
        CouplingEndpointIR::Region { region_id, .. } => {
            if region_id.trim().is_empty() {
                errors.push(format!("{path}.region_id must not be empty"));
            } else if !region_ids.contains(region_id.as_str()) {
                errors.push(format!(
                    "{path}.region_id '{}' does not reference an object_region",
                    region_id
                ));
            } else if region_owner_by_id
                .get(region_id.as_str())
                .is_some_and(|owner| *owner != object.as_str())
            {
                errors.push(format!(
                    "{path}.region_id '{}' belongs to a different owner than '{}'",
                    region_id, object
                ));
            } else if coupling_enabled
                && region_enabled_by_id
                    .get(region_id.as_str())
                    .is_some_and(|enabled| !enabled)
            {
                errors.push(format!(
                    "{path}.region_id '{}' references disabled object_region",
                    region_id
                ));
            }
        }
        CouplingEndpointIR::Surface { selector, .. } => {
            let normalized = selector.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                errors.push(format!("{path}.selector must not be empty"));
            } else if !matches!(
                normalized.as_str(),
                "top" | "bottom" | "left" | "right" | "front" | "back"
            ) {
                errors.push(format!(
                    "{path}.selector '{}' is unsupported in v1; use top/bottom/left/right/front/back",
                    selector
                ));
            }
        }
        CouplingEndpointIR::Object { .. } => {}
    }
}

fn is_airbox_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "airbox" | "__air__"
    )
}

fn vector_is_finite(vector: &[f64; 3]) -> bool {
    vector.iter().all(|value| value.is_finite())
}

fn vector_norm_sq(vector: &[f64; 3]) -> f64 {
    vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]
}

fn validate_settle_step(step: &SettleStepIR, idx: usize, errors: &mut Vec<String>) {
    match step {
        SettleStepIR::Relax {
            method,
            alpha,
            torque_tolerance,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
            ..
        } => {
            if method.trim().is_empty() {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].method must not be empty",
                    idx
                ));
            }
            if *alpha <= 0.0 {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].alpha must be positive",
                    idx
                ));
            }
            if *torque_tolerance <= 0.0 {
                errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].torque_tolerance must be positive", idx));
            }
            if *max_steps == 0 {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].max_steps must be > 0",
                    idx
                ));
            }
            validate_settle_time_controls(
                *timestep_s,
                *max_pseudotime_s,
                *max_physical_time_s,
                idx,
                errors,
            );
            validate_settle_direct_minimizer_physical_time(
                method,
                *max_pseudotime_s,
                *max_physical_time_s,
                idx,
                errors,
            );
            validate_settle_applies_to(applies_to.as_ref(), idx, errors);
            validate_settle_stop_criteria(stop_criteria.as_ref(), idx, errors);
            validate_settle_non_convergence_policy(on_non_convergence, idx, errors);
            validate_settle_retry_policy(
                on_non_convergence,
                *retry_timestep_scale,
                *retry_max_attempts,
                idx,
                errors,
            );
        }
        SettleStepIR::Minimize {
            method,
            torque_tolerance,
            energy_tolerance,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
            ..
        } => {
            if method.trim().is_empty() {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].method must not be empty",
                    idx
                ));
            }
            if *torque_tolerance <= 0.0 {
                errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].torque_tolerance must be positive", idx));
            }
            if *energy_tolerance <= 0.0 {
                errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].energy_tolerance must be positive", idx));
            }
            if *max_steps == 0 {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].max_steps must be > 0",
                    idx
                ));
            }
            validate_settle_time_controls(
                *timestep_s,
                *max_pseudotime_s,
                *max_physical_time_s,
                idx,
                errors,
            );
            validate_settle_direct_minimizer_physical_time(
                method,
                *max_pseudotime_s,
                *max_physical_time_s,
                idx,
                errors,
            );
            validate_settle_applies_to(applies_to.as_ref(), idx, errors);
            validate_settle_stop_criteria(stop_criteria.as_ref(), idx, errors);
            validate_settle_non_convergence_policy(on_non_convergence, idx, errors);
            validate_settle_retry_policy(
                on_non_convergence,
                *retry_timestep_scale,
                *retry_max_attempts,
                idx,
                errors,
            );
        }
        SettleStepIR::DynamicsSettle {
            method,
            damping,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
            ..
        } => {
            if method.trim().is_empty() {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].method must not be empty",
                    idx
                ));
            }
            if *damping <= 0.0 {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].damping must be positive",
                    idx
                ));
            }
            if *max_steps == 0 {
                errors.push(format!(
                    "study.stages[].hysteresis.settle_pipeline.steps[{}].max_steps must be > 0",
                    idx
                ));
            }
            validate_settle_time_controls(
                *timestep_s,
                *max_pseudotime_s,
                *max_physical_time_s,
                idx,
                errors,
            );
            validate_settle_applies_to(applies_to.as_ref(), idx, errors);
            validate_dynamics_settle_stop_criteria(stop_criteria.as_ref(), idx, errors);
            validate_settle_non_convergence_policy(on_non_convergence, idx, errors);
            validate_settle_retry_policy(
                on_non_convergence,
                *retry_timestep_scale,
                *retry_max_attempts,
                idx,
                errors,
            );
        }
    }
}

fn validate_settle_time_controls(
    timestep_s: Option<f64>,
    max_pseudotime_s: Option<f64>,
    max_physical_time_s: Option<f64>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    if max_pseudotime_s.is_some()
        && max_physical_time_s.is_some()
        && max_pseudotime_s != max_physical_time_s
    {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].max_pseudotime_s conflicts with max_physical_time_s",
            idx
        ));
    }
    if let Some(value) = timestep_s {
        if !value.is_finite() || value <= 0.0 {
            errors.push(format!(
                "study.stages[].hysteresis.settle_pipeline.steps[{}].timestep_s must be finite and positive",
                idx
            ));
        }
    }
    if let Some(value) = max_pseudotime_s {
        if !value.is_finite() || value <= 0.0 {
            errors.push(format!(
                "study.stages[].hysteresis.settle_pipeline.steps[{}].max_pseudotime_s must be finite and positive",
                idx
            ));
        }
    }
    if let Some(value) = max_physical_time_s {
        if !value.is_finite() || value <= 0.0 {
            errors.push(format!(
                "study.stages[].hysteresis.settle_pipeline.steps[{}].max_physical_time_s must be finite and positive",
                idx
            ));
        }
    }
}

fn validate_settle_direct_minimizer_physical_time(
    method: &str,
    max_pseudotime_s: Option<f64>,
    max_physical_time_s: Option<f64>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    let Some(algorithm) = direct_minimizer_relaxation_method(method) else {
        return;
    };
    if max_pseudotime_s.is_some() {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].max_pseudotime_s is unsupported for direct minimizer '{}'; direct minimizers accept max_steps, not seconds-valued aliases",
            idx,
            algorithm
        ));
    }
    if max_physical_time_s.is_some() {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].max_physical_time_s is unsupported for direct minimizer '{}'; direct minimizers accept max_steps, not seconds-valued aliases",
            idx,
            algorithm
        ));
    }
}

fn direct_minimizer_relaxation_method(method: &str) -> Option<&'static str> {
    match method.trim() {
        "projected_gradient_bb" => Some("projected_gradient_bb"),
        "nonlinear_cg" => Some("nonlinear_cg"),
        "tangent_plane_implicit" => Some("tangent_plane_implicit"),
        _ => None,
    }
}

fn validate_dynamics_settle_stop_criteria(
    stop_criteria: Option<&serde_json::Value>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    if stop_criteria.is_some() {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].stop_criteria is unsupported for DynamicsSettle because dynamics-settle is duration-based; use relax or minimize settle steps for convergence criteria",
            idx
        ));
    }
}

fn validate_hysteresis_orientation(
    orientation: Option<&FieldOrientationIR>,
    errors: &mut Vec<String>,
) {
    let Some(orientation) = orientation else {
        return;
    };
    match orientation {
        FieldOrientationIR::Preset { preset_name } => {
            if !matches!(
                preset_name.as_str(),
                "oop_positive" | "oop_negative" | "in_plane_x" | "in_plane_y"
            ) {
                errors.push(
                    "study.stages[].hysteresis.orientation.preset_name is unsupported".to_string(),
                );
            }
        }
        FieldOrientationIR::Sample { theta, phi } => {
            if !theta.is_finite() || !phi.is_finite() {
                errors.push(
                    "study.stages[].hysteresis.orientation sample theta and phi must be finite"
                        .to_string(),
                );
            }
        }
        FieldOrientationIR::Global { vector } => {
            if !vector_is_finite(vector) {
                errors.push(
                    "study.stages[].hysteresis.orientation global vector must contain finite values"
                        .to_string(),
                );
            } else if vector_norm_sq(vector) <= 1e-30 {
                errors.push(
                    "study.stages[].hysteresis.orientation global vector must not be zero"
                        .to_string(),
                );
            }
        }
    }
}

fn validate_hysteresis_measurement_axis(
    measurement_axis: &MeasurementAxisIR,
    errors: &mut Vec<String>,
) {
    match measurement_axis {
        MeasurementAxisIR::Named(axis) => {
            if !matches!(axis.as_str(), "field_axis" | "sample_normal" | "easy_axis") {
                errors
                    .push("study.stages[].hysteresis.measurement_axis is unsupported".to_string());
            }
        }
        MeasurementAxisIR::Custom { kind, vector } => {
            if kind != "custom" {
                errors
                    .push("study.stages[].hysteresis.measurement_axis is unsupported".to_string());
            }
            if !vector_is_finite(vector) {
                errors.push(
                    "study.stages[].hysteresis.measurement_axis custom vector must contain finite values"
                        .to_string(),
                );
            } else if vector_norm_sq(vector) <= 1e-30 {
                errors.push(
                    "study.stages[].hysteresis.measurement_axis custom vector must not be zero"
                        .to_string(),
                );
            }
        }
    }
}

fn validate_hysteresis_field_unit_provenance(
    provenance: &FieldUnitProvenanceIR,
    errors: &mut Vec<String>,
) {
    if provenance.authored_quantity != "mu0_h" {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.authored_quantity is unsupported"
                .to_string(),
        );
    }
    if provenance.authored_unit != "mT" {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.authored_unit is unsupported"
                .to_string(),
        );
    }
    if provenance.canonical_quantity != "h_ext" {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.canonical_quantity is unsupported"
                .to_string(),
        );
    }
    if provenance.canonical_unit != "A/m" {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.canonical_unit is unsupported"
                .to_string(),
        );
    }
    if provenance.display_unit != "mT" {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.display_unit is unsupported"
                .to_string(),
        );
    }
    if !provenance.mu0_h_per_m.is_finite() || (provenance.mu0_h_per_m - MU0_H_PER_M).abs() > 1.0e-18
    {
        errors.push(
            "study.stages[].hysteresis.field_unit_provenance.mu0_h_per_m must match vacuum permeability"
                .to_string(),
        );
    }
}

fn validate_hysteresis_angular_family(
    family: &HysteresisAngularFamilyIR,
    errors: &mut Vec<String>,
) {
    if family.kind != "angular_family" {
        errors.push("study.stages[].hysteresis.angular_family.kind is unsupported".to_string());
    }
    if family.family_id.trim().is_empty() {
        errors.push(
            "study.stages[].hysteresis.angular_family.family_id must not be empty".to_string(),
        );
    }
    if family.variants.is_empty() {
        errors.push(
            "study.stages[].hysteresis.angular_family.variants must not be empty".to_string(),
        );
    }

    let mut seen = std::collections::BTreeSet::new();
    for (idx, variant) in family.variants.iter().enumerate() {
        if variant.variant_id.trim().is_empty() {
            errors.push(format!(
                "study.stages[].hysteresis.angular_family.variants[{}].variant_id must not be empty",
                idx
            ));
        } else if !seen.insert(variant.variant_id.as_str()) {
            errors.push(format!(
                "study.stages[].hysteresis.angular_family.variants[{}].variant_id must be unique",
                idx
            ));
        }
        validate_hysteresis_orientation(Some(&variant.orientation), errors);
        if let Some(axis) = variant.measurement_axis.as_ref() {
            validate_hysteresis_measurement_axis(axis, errors);
        }
    }
}

fn validate_hysteresis_saturation_probe(probe: &SaturationProbeIR, errors: &mut Vec<String>) {
    if probe.mode.trim().is_empty() {
        errors.push("study.stages[].hysteresis.saturation.mode must not be empty".to_string());
    }
    if !probe.max_field_mT.is_finite() || probe.max_field_mT <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.saturation.max_field_mT must be finite and positive"
                .to_string(),
        );
    }
    if !probe.susceptibility_threshold.is_finite() || probe.susceptibility_threshold <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.saturation.susceptibility_threshold must be finite and positive"
                .to_string(),
        );
    }
    if !probe.transverse_threshold.is_finite() || probe.transverse_threshold <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.saturation.transverse_threshold must be finite and positive"
                .to_string(),
        );
    }
    if !matches!(
        probe.on_failure.as_str(),
        "continue_with_warning" | "stop_stage"
    ) {
        errors.push("study.stages[].hysteresis.saturation.on_failure is unsupported".to_string());
    }
}

fn validate_hysteresis_storage(policy: &HysteresisStorageIR, errors: &mut Vec<String>) {
    if !matches!(
        policy.magnetization.as_str(),
        "none" | "selected" | "every_n" | "every_step" | "key_events"
    ) {
        errors.push("study.stages[].hysteresis.storage.magnetization is unsupported".to_string());
    }
    if matches!(policy.magnetization.as_str(), "selected" | "every_n") && policy.every_n == 0 {
        errors.push(
            "study.stages[].hysteresis.storage.every_n must be positive for selected/every_n magnetization storage"
                .to_string(),
        );
    }
    if !policy.key_event_threshold_dm.is_finite() || policy.key_event_threshold_dm <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.storage.key_event_threshold_dm must be finite and positive"
                .to_string(),
        );
    }
}

fn validate_hysteresis_minor_loops(loops: &[MinorLoopIR], errors: &mut Vec<String>) {
    for (idx, minor_loop) in loops.iter().enumerate() {
        if !minor_loop.reversal_mT.is_finite() || !minor_loop.return_mT.is_finite() {
            errors.push(format!(
                "study.stages[].hysteresis.minor_loops[{}] reversal_mT and return_mT must be finite",
                idx
            ));
        } else if minor_loop.reversal_mT == minor_loop.return_mT {
            errors.push(format!(
                "study.stages[].hysteresis.minor_loops[{}] reversal_mT and return_mT must differ",
                idx
            ));
        }
        if minor_loop
            .intermediate_fields_mT
            .iter()
            .any(|field| !field.is_finite())
        {
            errors.push(format!(
                "study.stages[].hysteresis.minor_loops[{}] intermediate_fields_mT values must be finite",
                idx
            ));
        }
        let mut scheduled_fields = Vec::with_capacity(minor_loop.intermediate_fields_mT.len() + 2);
        scheduled_fields.push(minor_loop.reversal_mT);
        scheduled_fields.extend(minor_loop.intermediate_fields_mT.iter().copied());
        scheduled_fields.push(minor_loop.return_mT);
        if scheduled_fields
            .windows(2)
            .any(|fields| fields[0] == fields[1])
        {
            errors.push(format!(
                "study.stages[].hysteresis.minor_loops[{}] intermediate_fields_mT must not repeat adjacent fields",
                idx
            ));
        }
        if !matches!(
            minor_loop.continuation_policy.as_str(),
            "branch_only" | "resume_parent" | "replace_parent"
        ) {
            errors.push(format!(
                "study.stages[].hysteresis.minor_loops[{}] continuation_policy must be one of: branch_only, resume_parent, replace_parent",
                idx
            ));
        }
    }
}

fn validate_settle_applies_to(
    applies_to: Option<&serde_json::Value>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    let Some(value) = applies_to else {
        return;
    };
    if !validate_settle_applies_to_value(value) {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].applies_to is unsupported",
            idx
        ));
    }
}

fn validate_settle_applies_to_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(selector) => matches!(
            selector.as_str(),
            "all_points"
                | "preparation"
                | "saturation_probe"
                | "major"
                | "major_descending"
                | "major_ascending"
                | "minor"
                | "recoil"
                | "key_events"
        ),
        serde_json::Value::Array(selectors) => {
            !selectors.is_empty() && selectors.iter().all(validate_settle_applies_to_value)
        }
        serde_json::Value::Object(object) => validate_settle_applies_to_object(object),
        _ => false,
    }
}

fn validate_settle_applies_to_object(object: &serde_json::Map<String, serde_json::Value>) -> bool {
    let Some(kind) = object.get("kind").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match kind {
        "branch_id" => object
            .get("branch_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|branch_id| !branch_id.trim().is_empty()),
        "point_selector" => object
            .get("point_ids")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|point_ids| {
                !point_ids.is_empty()
                    && point_ids.iter().all(|point_id| point_id.as_u64().is_some())
            }),
        _ => validate_settle_applies_to_value(&serde_json::Value::String(kind.to_string())),
    }
}

fn validate_settle_stop_criteria(
    stop_criteria: Option<&serde_json::Value>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    let Some(value) = stop_criteria else {
        return;
    };
    if !validate_settle_stop_criteria_value(value) {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].stop_criteria is unsupported",
            idx
        ));
    }
}

fn validate_settle_stop_criteria_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(criterion) => matches!(
            criterion.as_str(),
            "torque_below"
                | "energy_delta_below"
                | "max_steps"
                | "max_pseudotime_s"
                | "max_physical_time_s"
                | "m_delta_below"
        ),
        serde_json::Value::Array(criteria) => {
            !criteria.is_empty() && criteria.iter().all(validate_settle_stop_criteria_value)
        }
        serde_json::Value::Object(object) => {
            let Some(kind) = object.get("kind").and_then(|value| value.as_str()) else {
                return false;
            };
            if !matches!(kind, "all_of" | "any_of") {
                return false;
            }
            object
                .get("criteria")
                .is_some_and(|criteria| match criteria {
                    serde_json::Value::Array(items) => {
                        !items.is_empty() && items.iter().all(validate_settle_stop_criteria_value)
                    }
                    _ => false,
                })
        }
        _ => false,
    }
}

fn validate_settle_non_convergence_policy(policy: &str, idx: usize, errors: &mut Vec<String>) {
    if !matches!(
        policy,
        "continue_with_warning" | "stop_stage" | "run_next_algorithm" | "retry_with_smaller_dt"
    ) {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].on_non_convergence is unsupported",
            idx
        ));
    }
}

fn validate_settle_retry_policy(
    policy: &str,
    retry_timestep_scale: Option<f64>,
    retry_max_attempts: Option<u32>,
    idx: usize,
    errors: &mut Vec<String>,
) {
    if let Some(scale) = retry_timestep_scale {
        if !scale.is_finite() || scale <= 0.0 || scale >= 1.0 {
            errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].retry_timestep_scale must be finite, positive, and smaller than 1", idx));
        }
    }
    if retry_max_attempts == Some(0) {
        errors.push(format!(
            "study.stages[].hysteresis.settle_pipeline.steps[{}].retry_max_attempts must be > 0",
            idx
        ));
    }
    if policy == "retry_with_smaller_dt" && retry_timestep_scale.is_none() {
        errors.push(format!("study.stages[].hysteresis.settle_pipeline.steps[{}].on_non_convergence retry_with_smaller_dt requires retry_timestep_scale", idx));
    }
}

fn settle_non_convergence(step: &SettleStepIR) -> &str {
    match step {
        SettleStepIR::Relax {
            on_non_convergence, ..
        }
        | SettleStepIR::Minimize {
            on_non_convergence, ..
        }
        | SettleStepIR::DynamicsSettle {
            on_non_convergence, ..
        } => on_non_convergence,
    }
}

fn validate_hysteresis_field_windows(windows: &[FieldWindowIR], errors: &mut Vec<String>) {
    for (idx, window) in windows.iter().enumerate() {
        if !window.center_mT.is_finite()
            || !window.half_width_mT.is_finite()
            || !window.step_mT.is_finite()
        {
            errors.push(format!(
                "study.stages[].hysteresis.schedule_refinements[{}] center_mT, half_width_mT, and step_mT must be finite",
                idx
            ));
        }
        if window.half_width_mT <= 0.0 {
            errors.push(format!(
                "study.stages[].hysteresis.schedule_refinements[{}].half_width_mT must be positive",
                idx
            ));
        }
        if window.step_mT <= 0.0 {
            errors.push(format!(
                "study.stages[].hysteresis.schedule_refinements[{}].step_mT must be positive",
                idx
            ));
        }
    }

    let mut ranges: Vec<(f64, f64, Option<u32>, usize)> = windows
        .iter()
        .enumerate()
        .map(|(idx, window)| {
            (
                window.center_mT - window.half_width_mT,
                window.center_mT + window.half_width_mT,
                window.priority,
                idx,
            )
        })
        .collect();
    ranges.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1)));

    let mut previous: Option<(f64, Option<u32>, usize)> = None;
    for (start, end, priority, idx) in ranges {
        if let Some((previous_end, previous_priority, previous_idx)) = previous {
            if start < previous_end {
                match (previous_priority, priority) {
                    (Some(left), Some(right)) if left != right => {}
                    _ => errors.push(format!(
                        "study.stages[].hysteresis.schedule_refinements[{}] overlaps schedule_refinements[{}] without distinct priorities",
                        idx, previous_idx
                    )),
                }
            }
            previous = Some((previous_end.max(end), priority, idx));
        } else {
            previous = Some((end, priority, idx));
        }
    }
}

fn validate_hysteresis_adaptive_refinement(
    policy: &AdaptiveRefinementIR,
    errors: &mut Vec<String>,
) {
    if policy.kind != "adaptive_refinement" {
        errors
            .push("study.stages[].hysteresis.adaptive_refinement.kind is unsupported".to_string());
    }
    if policy.max_passes == 0 {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.max_passes must be positive".to_string(),
        );
    }
    if policy.max_insertions_per_pass == 0 {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.max_insertions_per_pass must be positive"
                .to_string(),
        );
    }
    if !policy.dm_dh_threshold_per_mT.is_finite() || policy.dm_dh_threshold_per_mT <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.dm_dh_threshold_per_mT must be finite and positive"
                .to_string(),
        );
    }
    if !policy.max_step_mT.is_finite() || policy.max_step_mT <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.max_step_mT must be finite and positive"
                .to_string(),
        );
    }
    if !policy.min_step_mT.is_finite() || policy.min_step_mT <= 0.0 {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.min_step_mT must be finite and positive"
                .to_string(),
        );
    }
    if policy.min_step_mT > policy.max_step_mT {
        errors.push(
            "study.stages[].hysteresis.adaptive_refinement.min_step_mT must not exceed max_step_mT"
                .to_string(),
        );
    }
}

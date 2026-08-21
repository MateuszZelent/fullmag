use crate::{
    AbsorbingBoundaryLayerIR, AirBoxPolicyIR, BackendPolicyIR, CouplingIR, CurrentModuleIR,
    ElasticBodyIR, ElasticMaterialIR, EnergyTermIR, ExcitationAnalysisIR, FdmPeriodicityIR,
    GeometryAssetsIR, GeometryIR, InitialMagnetizationIR, MagnetostrictionLawIR, MaterialIR,
    MaterialParameterAssignmentIR, MechanicalBoundaryConditionIR, MechanicalLoadIR,
    MeshSemanticsIR, ObjectRegionIR, PlanarMonitorIR, ProblemIR, ProblemMeta, RegionIR,
    RegionRefIR, RegionalFieldDriveIR, SpinTorqueModuleIR, SpinTransportModuleIR, StudyIR,
    SurfaceRefIR, ValidationProfileIR,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const PHYSICS_OBJECT_SCHEMA_VERSION: &str = "physics_object.v1";
pub const OBJECT_MATERIAL_ASSIGNMENT_SCHEMA_VERSION: &str = "object_material_assignment.v1";
pub const PHYSICS_INTERFACE_SCHEMA_VERSION: &str = "physics_interface.v1";
pub const MAGNETIZATION_MODULE_SCHEMA_VERSION: &str = "magnetization_module.v1";
pub const PROBLEM_IR_V04_VERSION: &str = "0.4.0";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhysicsObjectTypeIR {
    Geometry,
    Ferromagnet,
    Conductor,
    Antenna,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsObjectIR {
    pub schema_version: String,
    pub object_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub object_type: PhysicsObjectTypeIR,
    pub geometry_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_assignment_ids: Vec<String>,
}

impl PhysicsObjectIR {
    pub fn new(
        object_id: impl Into<String>,
        name: impl Into<String>,
        object_type: PhysicsObjectTypeIR,
        geometry_id: impl Into<String>,
    ) -> Self {
        let object_id = object_id.into();
        let name = name.into();
        let geometry_id = geometry_id.into();
        assert!(!object_id.trim().is_empty(), "object_id must not be empty");
        assert!(!name.trim().is_empty(), "name must not be empty");
        assert!(
            !geometry_id.trim().is_empty(),
            "geometry_id must not be empty"
        );
        Self {
            schema_version: PHYSICS_OBJECT_SCHEMA_VERSION.to_string(),
            object_id,
            name,
            label: None,
            object_type,
            geometry_id,
            material_assignment_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObjectMaterialAssignmentIR {
    pub schema_version: String,
    pub assignment_id: String,
    pub target: RegionRefIR,
    pub material_id: String,
}

impl ObjectMaterialAssignmentIR {
    pub fn new(
        assignment_id: impl Into<String>,
        target: RegionRefIR,
        material_id: impl Into<String>,
    ) -> Self {
        let assignment_id = assignment_id.into();
        let material_id = material_id.into();
        assert!(
            !assignment_id.trim().is_empty(),
            "assignment_id must not be empty"
        );
        assert!(
            !target.object_id.trim().is_empty(),
            "target.object_id must not be empty"
        );
        assert!(
            !material_id.trim().is_empty(),
            "material_id must not be empty"
        );
        Self {
            schema_version: OBJECT_MATERIAL_ASSIGNMENT_SCHEMA_VERSION.to_string(),
            assignment_id,
            target,
            material_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsInterfaceIR {
    pub schema_version: String,
    pub interface_id: String,
    pub name: String,
    pub side_a: SurfaceRefIR,
    pub side_b: SurfaceRefIR,
    pub side_a_to_side_b: [f64; 3],
}

impl PhysicsInterfaceIR {
    pub fn new(
        interface_id: impl Into<String>,
        name: impl Into<String>,
        side_a: SurfaceRefIR,
        side_b: SurfaceRefIR,
        side_a_to_side_b: [f64; 3],
    ) -> Self {
        let interface_id = interface_id.into();
        let name = name.into();
        assert!(
            !interface_id.trim().is_empty(),
            "interface_id must not be empty"
        );
        assert!(!name.trim().is_empty(), "name must not be empty");
        assert!(
            !side_a.object_id.trim().is_empty(),
            "side_a.object_id must not be empty"
        );
        assert!(
            !side_b.object_id.trim().is_empty(),
            "side_b.object_id must not be empty"
        );
        Self {
            schema_version: PHYSICS_INTERFACE_SCHEMA_VERSION.to_string(),
            interface_id,
            name,
            side_a,
            side_b,
            side_a_to_side_b,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MagnetizationModuleIR {
    pub schema_version: String,
    pub module_id: String,
    pub target: RegionRefIR,
    pub material_id: String,
    pub initial_magnetization: InitialMagnetizationIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absorbing_boundary: Option<AbsorbingBoundaryLayerIR>,
}

impl MagnetizationModuleIR {
    pub fn new(
        module_id: impl Into<String>,
        target: RegionRefIR,
        material_id: impl Into<String>,
        initial_magnetization: InitialMagnetizationIR,
    ) -> Self {
        let module_id = module_id.into();
        let material_id = material_id.into();
        assert!(!module_id.trim().is_empty(), "module_id must not be empty");
        assert!(
            !target.object_id.trim().is_empty(),
            "target.object_id must not be empty"
        );
        assert!(
            !material_id.trim().is_empty(),
            "material_id must not be empty"
        );
        Self {
            schema_version: MAGNETIZATION_MODULE_SCHEMA_VERSION.to_string(),
            module_id,
            target,
            material_id,
            initial_magnetization,
            absorbing_boundary: None,
        }
    }
}

/// The explicit 0.4 wire model is intentionally separate from `ProblemIR`.
/// The public writer remains 0.3 until the cross-layer switch is atomic.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProblemIRV04 {
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
    pub objects: Vec<PhysicsObjectIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_assignments: Vec<ObjectMaterialAssignmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<PhysicsInterfaceIR>,
    #[serde(default)]
    pub magnetization_modules: Vec<MagnetizationModuleIR>,
    #[serde(default)]
    pub selections: Vec<crate::SelectionDefinitionIR>,
    #[serde(default)]
    pub magnetization_constraints: Vec<crate::MagnetizationConstraintIR>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_transport_modules: Vec<SpinTransportModuleIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_density: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_degree: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_beta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_spin_polarization: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_lambda: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_epsilon_prime: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_fixed_layer_position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub elastic_materials: Vec<ElasticMaterialIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub elastic_bodies: Vec<ElasticBodyIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetostriction_laws: Vec<MagnetostrictionLawIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mechanical_bcs: Vec<MechanicalBoundaryConditionIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mechanical_loads: Vec<MechanicalLoadIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_box_policy: Option<AirBoxPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pbc: Option<FdmPeriodicityIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_semantics: Option<MeshSemanticsIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physics_graph: Option<Value>,
    #[serde(flatten)]
    pub legacy_extensions: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
struct ProblemIRV04Wire {
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
    objects: Vec<PhysicsObjectIR>,
    #[serde(default)]
    material_assignments: Vec<ObjectMaterialAssignmentIR>,
    #[serde(default)]
    interfaces: Vec<PhysicsInterfaceIR>,
    #[serde(default)]
    magnetization_modules: Vec<MagnetizationModuleIR>,
    #[serde(default)]
    selections: Vec<crate::SelectionDefinitionIR>,
    #[serde(default)]
    magnetization_constraints: Vec<crate::MagnetizationConstraintIR>,
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
    spin_transport_modules: Vec<SpinTransportModuleIR>,
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
    #[serde(default)]
    physics_graph: Option<Value>,
    #[serde(flatten)]
    legacy_extensions: BTreeMap<String, Value>,
}

impl From<ProblemIRV04Wire> for ProblemIRV04 {
    fn from(wire: ProblemIRV04Wire) -> Self {
        Self {
            ir_version: wire.ir_version,
            problem_meta: wire.problem_meta,
            geometry: wire.geometry,
            geometry_assets: wire.geometry_assets,
            regions: wire.regions,
            object_regions: wire.object_regions,
            materials: wire.materials,
            material_parameter_fields: wire.material_parameter_fields,
            objects: wire.objects,
            material_assignments: wire.material_assignments,
            interfaces: wire.interfaces,
            magnetization_modules: wire.magnetization_modules,
            selections: wire.selections,
            magnetization_constraints: wire.magnetization_constraints,
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
            spin_transport_modules: wire.spin_transport_modules,
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
            physics_graph: wire.physics_graph,
            legacy_extensions: wire.legacy_extensions,
        }
    }
}

impl<'de> Deserialize<'de> for ProblemIRV04 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        crate::normalize_frozen_membership_defaults_in_problem_value(&mut value)
            .map_err(serde::de::Error::custom)?;
        let wire = ProblemIRV04Wire::deserialize(value).map_err(serde::de::Error::custom)?;
        Ok(wire.into())
    }
}

impl ProblemIRV04 {
    pub fn bootstrap_example() -> Self {
        let mut value = serde_json::to_value(ProblemIR::bootstrap_example())
            .expect("ProblemIR bootstrap must serialize");
        migrate_v0_3_problem_ir_to_v0_4(&mut value)
            .expect("ProblemIR bootstrap must migrate to the V04 wire model");
        serde_json::from_value(value).expect("migrated bootstrap must satisfy the V04 wire model")
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        crate::validate_physics_object_problem(self)
    }
}

fn required_string(value: &Value, pointer: &str) -> Result<String, String> {
    value
        .as_str()
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{pointer}: expected a non-empty string"))
}

fn array_at<'a>(
    root: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a Vec<Value>, String> {
    root.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("/{key}: expected an array"))
}

fn object_at<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{pointer}: expected an object"))
}

fn object_id_for(legacy_name: &str) -> String {
    format!("obj_{legacy_name}")
}

/// Migrate one 0.3 JSON document to the explicit 0.4 object wire model.
/// It is deliberately opt-in: direct `ProblemIR` deserialization still reads 0.3.
pub fn migrate_v0_3_problem_ir_to_v0_4(value: &mut Value) -> Result<(), String> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| "ProblemIR payload must be a JSON object".to_string())?;
    if root.get("ir_version").and_then(Value::as_str) != Some("0.3.0") {
        return Err("/ir_version: expected '0.3.0' for the 0.3 -> 0.4 migration".to_string());
    }

    let geometry_entries = root
        .get("geometry")
        .and_then(Value::as_object)
        .and_then(|geometry| geometry.get("entries"))
        .and_then(Value::as_array)
        .ok_or_else(|| "/geometry/entries: expected an array".to_string())?;
    let mut geometry_by_name = BTreeMap::new();
    for (index, entry) in geometry_entries.iter().enumerate() {
        let entry = object_at(entry, &format!("/geometry/entries/{index}"))?;
        let name = required_string(
            entry.get("name").unwrap_or(&Value::Null),
            &format!("/geometry/entries/{index}/name"),
        )?;
        if geometry_by_name.insert(name.clone(), index).is_some() {
            return Err(format!(
                "/geometry/entries/{index}/name: duplicate geometry name '{name}'"
            ));
        }
    }

    let regions = array_at(root, "regions")?;
    let mut region_geometry_by_name = BTreeMap::new();
    for (index, region) in regions.iter().enumerate() {
        let region = object_at(region, &format!("/regions/{index}"))?;
        let name = required_string(
            region.get("name").unwrap_or(&Value::Null),
            &format!("/regions/{index}/name"),
        )?;
        let geometry = required_string(
            region.get("geometry").unwrap_or(&Value::Null),
            &format!("/regions/{index}/geometry"),
        )?;
        if !geometry_by_name.contains_key(&geometry) {
            return Err(format!(
                "/regions/{index}/geometry: unresolved geometry '{geometry}'"
            ));
        }
        if region_geometry_by_name
            .insert(name.clone(), geometry)
            .is_some()
        {
            return Err(format!(
                "/regions/{index}/name: ambiguous legacy region '{name}'"
            ));
        }
    }

    let magnets = array_at(root, "magnets")?.clone();
    let mut objects = Vec::new();
    let mut material_assignments = Vec::new();
    let mut magnetization_modules = Vec::new();
    let mut object_id_by_legacy_name = BTreeMap::new();
    let mut magnetic_geometry_ids = BTreeSet::new();
    let mut seen_object_ids = BTreeSet::new();
    let mut seen_names = BTreeSet::new();

    for (index, magnet) in magnets.iter().enumerate() {
        let magnet = object_at(magnet, &format!("/magnets/{index}"))?;
        let name = required_string(
            magnet.get("name").unwrap_or(&Value::Null),
            &format!("/magnets/{index}/name"),
        )?;
        let region = required_string(
            magnet.get("region").unwrap_or(&Value::Null),
            &format!("/magnets/{index}/region"),
        )?;
        let material = required_string(
            magnet.get("material").unwrap_or(&Value::Null),
            &format!("/magnets/{index}/material"),
        )?;
        let geometry_id = region_geometry_by_name.get(&region).ok_or_else(|| {
            format!("/magnets/{index}/region: unresolved legacy region '{region}'")
        })?;
        if !geometry_by_name.contains_key(geometry_id) {
            return Err(format!(
                "/regions: geometry '{geometry_id}' referenced by /magnets/{index}/region does not exist"
            ));
        }
        let object_id = magnet
            .get("object_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| object_id_for(&name));
        if !seen_object_ids.insert(object_id.clone()) {
            return Err(format!(
                "/magnets/{index}/name: duplicate migrated object_id '{object_id}'"
            ));
        }
        if !seen_names.insert(name.clone()) {
            return Err(format!(
                "/magnets/{index}/name: duplicate migrated object name '{name}'"
            ));
        }
        object_id_by_legacy_name.insert(name.clone(), object_id.clone());
        object_id_by_legacy_name.insert(object_id.clone(), object_id.clone());
        magnetic_geometry_ids.insert(geometry_id.clone());

        let assignment_id = format!("assignment_{object_id}");
        let module_id = format!("magnetization_{object_id}");
        let initial_magnetization =
            magnet
                .get("initial_magnetization")
                .cloned()
                .ok_or_else(|| {
                    format!("/magnets/{index}/initial_magnetization: missing required legacy value")
                })?;
        let initial_magnetization = serde_json::from_value(initial_magnetization)
            .map_err(|error| format!("/magnets/{index}/initial_magnetization: {error}"))?;
        let absorbing_boundary = magnet
            .get("absorbing_boundary")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| format!("/magnets/{index}/absorbing_boundary: {error}"))?;

        let target = RegionRefIR {
            object_id: object_id.clone(),
            region_id: None,
        };
        let mut object = PhysicsObjectIR::new(
            object_id.clone(),
            name,
            PhysicsObjectTypeIR::Ferromagnet,
            geometry_id.clone(),
        );
        object.material_assignment_ids.push(assignment_id.clone());
        objects.push(object);
        material_assignments.push(ObjectMaterialAssignmentIR::new(
            assignment_id,
            target.clone(),
            material.clone(),
        ));
        let mut module =
            MagnetizationModuleIR::new(module_id, target, material, initial_magnetization);
        module.absorbing_boundary = absorbing_boundary;
        magnetization_modules.push(module);
    }

    for (name, index) in &geometry_by_name {
        if magnetic_geometry_ids.contains(name) {
            continue;
        }
        let object_id = object_id_for(name);
        if !seen_object_ids.insert(object_id.clone()) {
            return Err(format!(
                "/geometry/entries/{index}/name: duplicate migrated object_id '{object_id}'"
            ));
        }
        if !seen_names.insert(name.clone()) {
            return Err(format!(
                "/geometry/entries/{index}/name: duplicate migrated object name '{name}'"
            ));
        }
        let hint = geometry_entries[*index]
            .get("legacy_object_type")
            .or_else(|| geometry_entries[*index].get("role"))
            .and_then(Value::as_str);
        let object_type = if hint == Some("antenna") {
            PhysicsObjectTypeIR::Antenna
        } else {
            PhysicsObjectTypeIR::Geometry
        };
        object_id_by_legacy_name.insert(name.clone(), object_id.clone());
        objects.push(PhysicsObjectIR::new(
            object_id,
            name.clone(),
            object_type,
            name.clone(),
        ));
    }

    let legacy_interfaces = root
        .remove("interfaces")
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut interfaces = Vec::new();
    for (index, interface) in legacy_interfaces
        .as_array()
        .ok_or_else(|| "/interfaces: expected an array".to_string())?
        .iter()
        .enumerate()
    {
        let mut interface = object_at(interface, &format!("/interfaces/{index}"))?.clone();
        for side in ["side_a", "side_b"] {
            let side_value = interface
                .get_mut(side)
                .ok_or_else(|| format!("/interfaces/{index}/{side}: missing surface reference"))?;
            let side_object = side_value
                .as_object_mut()
                .ok_or_else(|| format!("/interfaces/{index}/{side}: expected an object"))?;
            let legacy_owner = required_string(
                side_object.get("object_id").unwrap_or(&Value::Null),
                &format!("/interfaces/{index}/{side}/object_id"),
            )?;
            let object_id = object_id_by_legacy_name.get(&legacy_owner).ok_or_else(|| {
                format!("/interfaces/{index}/{side}/object_id: unresolved legacy object '{legacy_owner}'")
            })?;
            side_object.insert("object_id".to_string(), Value::String(object_id.clone()));
        }
        interfaces.push(
            serde_json::from_value::<PhysicsInterfaceIR>(Value::Object(interface))
                .map_err(|error| format!("/interfaces/{index}: {error}"))?,
        );
    }

    if let Some(assignments) = root
        .get_mut("material_parameter_fields")
        .and_then(Value::as_array_mut)
    {
        for (index, assignment) in assignments.iter_mut().enumerate() {
            let assignment = assignment
                .as_object_mut()
                .ok_or_else(|| format!("/material_parameter_fields/{index}: expected an object"))?;
            let legacy_owner = required_string(
                assignment.get("owner_object").unwrap_or(&Value::Null),
                &format!("/material_parameter_fields/{index}/owner_object"),
            )?;
            let object_id = object_id_by_legacy_name.get(&legacy_owner).ok_or_else(|| {
                format!(
                    "/material_parameter_fields/{index}/owner_object: unresolved legacy object '{legacy_owner}'"
                )
            })?;
            assignment.insert("owner_object".to_string(), Value::String(object_id.clone()));
        }
    }
    if let Some(boundary_conditions) = root
        .get_mut("surface_boundary_conditions")
        .and_then(Value::as_array_mut)
    {
        for (index, boundary_condition) in boundary_conditions.iter_mut().enumerate() {
            let boundary_condition = boundary_condition.as_object_mut().ok_or_else(|| {
                format!("/surface_boundary_conditions/{index}: expected an object")
            })?;
            let surface = boundary_condition
                .get_mut("surface")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    format!("/surface_boundary_conditions/{index}/surface: expected an object")
                })?;
            let legacy_owner = required_string(
                surface.get("object_id").unwrap_or(&Value::Null),
                &format!("/surface_boundary_conditions/{index}/surface/object_id"),
            )?;
            let object_id = object_id_by_legacy_name.get(&legacy_owner).ok_or_else(|| {
                format!(
                    "/surface_boundary_conditions/{index}/surface/object_id: unresolved legacy object '{legacy_owner}'"
                )
            })?;
            surface.insert("object_id".to_string(), Value::String(object_id.clone()));
        }
    }

    root.remove("magnets");
    root.insert(
        "ir_version".to_string(),
        Value::String(PROBLEM_IR_V04_VERSION.to_string()),
    );
    let bootstrap = serde_json::to_value(ProblemIR::bootstrap_example())
        .expect("ProblemIR bootstrap must serialize");
    for key in [
        "energy_terms",
        "study",
        "backend_policy",
        "validation_profile",
    ] {
        if !root.contains_key(key) {
            root.insert(key.to_string(), bootstrap[key].clone());
        }
    }
    if let Some(meta) = root.get_mut("problem_meta").and_then(Value::as_object_mut) {
        meta.entry("description".to_string()).or_insert(Value::Null);
        meta.entry("script_language".to_string())
            .or_insert_with(|| Value::String("python".to_string()));
        meta.entry("script_source".to_string())
            .or_insert(Value::Null);
        meta.entry("entrypoint_kind".to_string())
            .or_insert_with(|| Value::String("build".to_string()));
        meta.entry("source_hash".to_string()).or_insert(Value::Null);
        meta.entry("runtime_metadata".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        meta.entry("backend_revision".to_string())
            .or_insert(Value::Null);
        meta.entry("seeds".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        for key in ["script_api_version", "serializer_version"] {
            if meta.get(key).and_then(Value::as_str) == Some("0.3.0") {
                meta.insert(
                    key.to_string(),
                    Value::String(PROBLEM_IR_V04_VERSION.to_string()),
                );
            }
        }
    }
    root.insert(
        "objects".to_string(),
        serde_json::to_value(objects).expect("object IR serializes"),
    );
    root.insert(
        "material_assignments".to_string(),
        serde_json::to_value(material_assignments).expect("assignment IR serializes"),
    );
    root.insert(
        "interfaces".to_string(),
        serde_json::to_value(interfaces).expect("interface IR serializes"),
    );
    root.insert(
        "magnetization_modules".to_string(),
        serde_json::to_value(magnetization_modules).expect("magnetization module IR serializes"),
    );
    root.entry("selections".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    root.entry("magnetization_constraints".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    crate::normalize_frozen_membership_defaults_in_problem_value(value)?;
    Ok(())
}

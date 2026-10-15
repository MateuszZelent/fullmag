//! Physical model types for `ProblemIR`.
//!
//! Contains: problem metadata, geometry (entries, CSG), region/material/magnet
//! definitions, initial magnetization (texture/uniform/sampled), and the
//! time-dependence envelope used by fields and currents.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::{
    AntennaConductorPartIR, AntennaRigidTransformIR, AntennaTerminalFaceSelectorsIR,
    CpwWidthStationIR, ImportedGeometryScaleIR, MicrostripWidthStationIR,
};

// ── Problem metadata ──────────────────────────────────────────────────────────

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

// ── Geometry ──────────────────────────────────────────────────────────────────

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
        #[serde(default)]
        scale: ImportedGeometryScaleIR,
    },
    Box {
        name: String,
        size: [f64; 3],
    },
    Cylinder {
        name: String,
        radius: f64,
        height: f64,
        axis: [f64; 3],
    },
    SinWaveguide {
        name: String,
        length: f64,
        width: f64,
        height: f64,
        period: f64,
        amplitude: f64,
        #[serde(default)]
        phase: f64,
        #[serde(default)]
        z0: f64,
    },
    ArchWaveguide {
        name: String,
        length: f64,
        width: f64,
        height: f64,
        arch_height: f64,
        #[serde(default)]
        z0: f64,
    },
    #[serde(rename = "microstrip")]
    MicrostripAntenna {
        name: String,
        length_m: f64,
        thickness_m: f64,
        conductivity_s_per_m: f64,
        transform: AntennaRigidTransformIR,
        stations: Vec<MicrostripWidthStationIR>,
        return_width_m: f64,
        return_offset_m: f64,
        conductors: Vec<AntennaConductorPartIR>,
        terminal_faces: BTreeMap<String, AntennaTerminalFaceSelectorsIR>,
    },
    #[serde(rename = "cpw")]
    CpwAntenna {
        name: String,
        length_m: f64,
        thickness_m: f64,
        conductivity_s_per_m: f64,
        transform: AntennaRigidTransformIR,
        stations: Vec<CpwWidthStationIR>,
        conductors: Vec<AntennaConductorPartIR>,
        terminal_faces: BTreeMap<String, AntennaTerminalFaceSelectorsIR>,
    },
    Ellipsoid {
        name: String,
        radii: [f64; 3],
    },
    Sphere {
        name: String,
        radius: f64,
    },
    Ellipse {
        name: String,
        radii: [f64; 2],
        height: f64,
    },
    Difference {
        name: String,
        base: std::boxed::Box<GeometryEntryIR>,
        tool: std::boxed::Box<GeometryEntryIR>,
    },
    Union {
        name: String,
        a: std::boxed::Box<GeometryEntryIR>,
        b: std::boxed::Box<GeometryEntryIR>,
    },
    Intersection {
        name: String,
        a: std::boxed::Box<GeometryEntryIR>,
        b: std::boxed::Box<GeometryEntryIR>,
    },
    Translate {
        name: String,
        base: std::boxed::Box<GeometryEntryIR>,
        by: [f64; 3],
    },
}

impl GeometryEntryIR {
    pub fn name(&self) -> &str {
        match self {
            Self::ImportedGeometry { name, .. }
            | Self::Box { name, .. }
            | Self::Cylinder { name, .. }
            | Self::SinWaveguide { name, .. }
            | Self::ArchWaveguide { name, .. }
            | Self::MicrostripAntenna { name, .. }
            | Self::CpwAntenna { name, .. }
            | Self::Ellipsoid { name, .. }
            | Self::Sphere { name, .. }
            | Self::Ellipse { name, .. }
            | Self::Difference { name, .. }
            | Self::Union { name, .. }
            | Self::Intersection { name, .. }
            | Self::Translate { name, .. } => name,
        }
    }
}

// ── Region / material / magnet ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegionIR {
    pub name: String,
    pub geometry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectRegionIR {
    pub region_id: String,
    pub owner_object: String,
    pub name: String,
    pub shape: RegionShapeIR,
    #[serde(default)]
    pub frame: RegionFrameIR,
    #[serde(default = "default_object_region_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_policy: Option<RegionMeshPolicyIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_overrides: Vec<RegionMaterialOverrideIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_override: Option<RegionTextureOverrideIR>,
    #[serde(default)]
    pub realization_policy: RegionRealizationPolicyIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_transition: Option<MaterialTransitionSpecIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegionShapeIR {
    Box {
        size: [f64; 3],
        center: [f64; 3],
    },
    Cylinder {
        radius: f64,
        height: f64,
        center: [f64; 3],
        axis: [f64; 3],
    },
    Sphere {
        radius: f64,
        center: [f64; 3],
    },
    Csg {
        expression: std::boxed::Box<GeometryEntryIR>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RegionFrameIR {
    #[default]
    Object,
    World,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RegionRealizationPolicyIR {
    #[default]
    Inherit,
    Conformal,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MaterialTransitionSpecIR {
    MeshRelative {
        cells: u32,
        #[serde(default = "default_material_transition_scope")]
        scope: MaterialTransitionScopeIR,
    },
    Metric {
        width: f64,
        #[serde(default = "default_material_transition_scope")]
        scope: MaterialTransitionScopeIR,
    },
    Sharp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterialTransitionScopeIR {
    Boundary,
    Inside,
    Outside,
}

fn default_material_transition_scope() -> MaterialTransitionScopeIR {
    MaterialTransitionScopeIR::Boundary
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegionMeshPolicyIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegionMaterialOverrideIR {
    pub parameter: MaterialParameterNameIR,
    pub value: MaterialParameterFieldIR,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub conflict_policy: RegionConflictPolicyIR,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterialParameterNameIR {
    Ms,
    Aex,
    Alpha,
    Ku1,
    Ku2,
    AnisotropyAxis,
    Kc1,
    Kc2,
    Kc3,
    Dind,
    Dbulk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MaterialParameterFieldIR {
    Constant {
        value: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Linear {
        base: f64,
        gradient: [f64; 3],
        #[serde(default)]
        frame: RegionFrameIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Radial {
        center: [f64; 3],
        radius: f64,
        inside: f64,
        outside: f64,
        #[serde(default)]
        frame: RegionFrameIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Sampled {
        asset_id: String,
        component_count: u32,
        location: MaterialFieldLocationIR,
        unit: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterialFieldLocationIR {
    Cell,
    Node,
    Element,
    Quadrature,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RegionConflictPolicyIR {
    #[default]
    Error,
    HigherPriorityWins,
    MinMeshSizeWins,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegionTextureOverrideIR {
    pub initial_magnetization: InitialMagnetizationIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialParameterAssignmentIR {
    pub assignment_id: String,
    pub owner_object: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
    pub parameter: MaterialParameterNameIR,
    pub value: MaterialParameterFieldIR,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub conflict_policy: RegionConflictPolicyIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CouplingIR {
    pub coupling_id: String,
    pub kind: CouplingKindIR,
    pub source: CouplingEndpointIR,
    pub target: CouplingEndpointIR,
    #[serde(default = "default_object_region_enabled")]
    pub enabled: bool,
    pub parameters: CouplingParametersIR,
    #[serde(default)]
    pub capability_policy: CouplingCapabilityPolicyIR,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CouplingKindIR {
    Exchange,
    Rkky,
    InterlayerExchange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CouplingEndpointIR {
    Object { object: String },
    Region { object: String, region_id: String },
    Surface { object: String, selector: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CouplingParametersIR {
    Exchange {
        mode: ExchangeCouplingModeIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inter_exchange: Option<f64>,
    },
    Rkky {
        j1: f64,
    },
    InterlayerExchange {
        j1: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        j2: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeCouplingModeIR {
    HarmonicMean,
    Explicit,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CouplingCapabilityPolicyIR {
    #[default]
    RequireRuntime,
    AuthoredOnly,
}

fn default_object_region_enabled() -> bool {
    true
}

/// Identity of the exact canonical mesh node ordering used by material nodal fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MaterialNodalFieldBindingIR {
    pub canonical_mesh_fingerprint: String,
    pub node_count: usize,
}

impl MaterialNodalFieldBindingIR {
    pub fn validate(&self) -> Result<(), String> {
        let Some(digest) = self.canonical_mesh_fingerprint.strip_prefix("sha256:") else {
            return Err(
                "Material.nodal_field_binding.canonical_mesh_fingerprint must use sha256:<64 lowercase hex>"
                    .to_string(),
            );
        };
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                "Material.nodal_field_binding.canonical_mesh_fingerprint must use sha256:<64 lowercase hex>"
                    .to_string(),
            );
        }
        if self.node_count == 0 {
            return Err("Material.nodal_field_binding.node_count must be positive".to_string());
        }
        Ok(())
    }
}

fn validate_material_nodal_values(
    field_name: &str,
    values: &[f64],
    node_count: usize,
    positive: bool,
    non_negative: bool,
) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("Material.{field_name} must not be empty"));
    }
    if values.len() != node_count {
        return Err(format!(
            "Material.{field_name} has {} values, but nodal_field_binding declares {node_count} nodes",
            values.len()
        ));
    }
    for (index, value) in values.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("Material.{field_name}[{index}] must be finite"));
        }
        if positive && *value <= 0.0 {
            return Err(format!(
                "Material.{field_name}[{index}] must be positive"
            ));
        }
        if non_negative && *value < 0.0 {
            return Err(format!(
                "Material.{field_name}[{index}] must be non-negative"
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialIR {
    pub name: String,
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub uniaxial_anisotropy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniaxial_anisotropy_k2: Option<f64>,
    pub anisotropy_axis: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis1: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis2: Option<[f64; 3]>,
    // Per-node spatially varying fields (when Some, override the scalar)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ku_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ku2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc1_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc3_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dind_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dbulk_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodal_field_binding: Option<MaterialNodalFieldBindingIR>,
}

/// Non-physical zero/default material scaffold for programmatic plan builders.
/// A resolved execution plan must overwrite the scalar material parameters;
/// this implementation only makes `FemPlanIR::default()` ergonomic for tests
/// and runtime probe construction.
impl Default for MaterialIR {
    fn default() -> Self {
        Self {
            name: String::new(),
            saturation_magnetisation: 0.0,
            exchange_stiffness: 0.0,
            damping: 0.0,
            uniaxial_anisotropy: None,
            uniaxial_anisotropy_k2: None,
            anisotropy_axis: None,
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
            nodal_field_binding: None,
        }
    }
}

impl MaterialIR {
    /// Return whether any authored per-node material arrays are present.
    pub fn has_nodal_fields(&self) -> bool {
        self.ms_field.is_some()
            || self.a_field.is_some()
            || self.alpha_field.is_some()
            || self.ku_field.is_some()
            || self.ku2_field.is_some()
            || self.kc1_field.is_some()
            || self.kc2_field.is_some()
            || self.kc3_field.is_some()
            || self.dind_field.is_some()
            || self.dbulk_field.is_some()
    }

    /// Validate authored nodal arrays and their declared shape without resolving a mesh.
    pub fn validate_nodal_field_shape(&self) -> Result<(), String> {
        let fields: [(&str, Option<&[f64]>, bool, bool); 10] = [
            ("ms_field", self.ms_field.as_deref(), true, false),
            ("a_field", self.a_field.as_deref(), false, true),
            ("alpha_field", self.alpha_field.as_deref(), false, true),
            ("ku_field", self.ku_field.as_deref(), false, false),
            ("ku2_field", self.ku2_field.as_deref(), false, false),
            ("kc1_field", self.kc1_field.as_deref(), false, false),
            ("kc2_field", self.kc2_field.as_deref(), false, false),
            ("kc3_field", self.kc3_field.as_deref(), false, false),
            ("dind_field", self.dind_field.as_deref(), false, false),
            ("dbulk_field", self.dbulk_field.as_deref(), false, false),
        ];
        let has_fields = self.has_nodal_fields();
        let Some(binding) = self.nodal_field_binding.as_ref() else {
            return if has_fields {
                Err("Material nodal fields require nodal_field_binding".to_string())
            } else {
                Ok(())
            };
        };
        if !has_fields {
            return Err("Material.nodal_field_binding requires at least one nodal field".to_string());
        }
        binding.validate()?;
        for (field_name, values, positive, non_negative) in fields {
            if let Some(values) = values {
                validate_material_nodal_values(
                    field_name,
                    values,
                    binding.node_count,
                    positive,
                    non_negative,
                )?;
            }
        }
        Ok(())
    }

    /// Validate material nodal arrays against the exact canonical mesh identity and node ordering.
    pub fn validate_nodal_fields(&self, mesh: &crate::MeshIR) -> Result<(), String> {
        self.validate_nodal_field_shape()?;
        let Some(binding) = self.nodal_field_binding.as_ref() else {
            return Ok(());
        };
        if binding.node_count != mesh.nodes.len() {
            return Err(format!(
                "Material.nodal_field_binding declares {} nodes, but the mesh contains {}",
                binding.node_count,
                mesh.nodes.len()
            ));
        }
        let mesh_fingerprint = mesh.topology_fingerprint_v6();
        if binding.canonical_mesh_fingerprint != mesh_fingerprint {
            return Err(format!(
                "Material.nodal_field_binding fingerprint does not match the canonical mesh topology: expected {}, got {}",
                mesh_fingerprint,
                binding.canonical_mesh_fingerprint
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod material_nodal_field_binding_tests {
    use super::*;
    use crate::MeshIR;

    fn mesh_with_nodes(nodes: Vec<[f64; 3]>) -> MeshIR {
        let mut mesh = MeshIR::default();
        mesh.nodes = nodes;
        mesh
    }

    fn valid_material_for(mesh: &MeshIR) -> MaterialIR {
        let mut material = MaterialIR::default();
        material.nodal_field_binding = Some(MaterialNodalFieldBindingIR {
            canonical_mesh_fingerprint: mesh.topology_fingerprint_v6(),
            node_count: mesh.nodes.len(),
        });
        material.ms_field = Some(vec![8.0e5; mesh.nodes.len()]);
        material
    }

    #[test]
    fn legacy_material_without_binding_deserializes_but_cannot_validate_nodal_fields() {
        let mut material: MaterialIR = serde_json::from_value(serde_json::json!({
            "name": "legacy",
            "saturation_magnetisation": 8.0e5,
            "exchange_stiffness": 1.3e-11,
            "damping": 0.01,
            "ms_field": [8.0e5]
        }))
        .expect("historical MaterialIR without a binding must remain readable");
        assert_eq!(material.nodal_field_binding, None);
        assert!(material.validate_nodal_fields(&mesh_with_nodes(vec![[0.0; 3]])).is_err());

        let serialized = serde_json::to_value(MaterialIR::default()).unwrap();
        assert!(serialized
            .as_object()
            .unwrap()
            .get("nodal_field_binding")
            .is_none());
    }

    #[test]
    fn scalar_material_without_nodal_fields_validates_without_a_mesh_binding() {
        let material = MaterialIR::default();
        assert!(!material.has_nodal_fields());
        assert!(material
            .validate_nodal_fields(&MeshIR::default())
            .is_ok());
    }

    #[test]
    fn wrong_declared_node_count_is_rejected_even_with_the_same_mesh_fingerprint() {
        let mesh = mesh_with_nodes(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]);
        let mut material = valid_material_for(&mesh);
        let binding = material.nodal_field_binding.as_mut().unwrap();
        binding.node_count = 1;
        material.ms_field = Some(vec![8.0e5]);

        assert_eq!(
            material
                .nodal_field_binding
                .as_ref()
                .unwrap()
                .canonical_mesh_fingerprint,
            mesh.topology_fingerprint_v6()
        );
        assert!(material.validate_nodal_fields(&mesh).is_err());
    }

    #[test]
    fn same_node_count_does_not_allow_a_different_mesh_fingerprint() {
        let mesh_a = mesh_with_nodes(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]);
        let mesh_b = mesh_with_nodes(vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0]]);
        let material = valid_material_for(&mesh_a);

        assert_eq!(mesh_a.nodes.len(), mesh_b.nodes.len());
        assert!(material.validate_nodal_fields(&mesh_a).is_ok());
        assert!(material.validate_nodal_fields(&mesh_b).is_err());
    }

    #[test]
    fn permutation_of_the_same_nodes_is_not_the_same_field_order() {
        let mesh_a = mesh_with_nodes(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]);
        let mesh_b = mesh_with_nodes(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]]);
        let mut material = valid_material_for(&mesh_a);
        material.ms_field = Some(vec![7.0e5, 9.0e5]);
        assert_eq!(mesh_a.nodes.len(), mesh_b.nodes.len());
        assert_ne!(mesh_a.topology_fingerprint_v6(), mesh_b.topology_fingerprint_v6());
        assert!(material.validate_nodal_fields(&mesh_a).is_ok());
        assert!(material.validate_nodal_fields(&mesh_b).is_err());
    }

    #[test]
    fn all_ten_nodal_fields_round_trip_with_binding_and_signed_fields() {
        let mesh = mesh_with_nodes(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]);
        let mut material = valid_material_for(&mesh);
        material.ms_field = Some(vec![8.0e5, 8.1e5]);
        material.a_field = Some(vec![1.3e-11, 1.4e-11]);
        material.alpha_field = Some(vec![0.01, 0.02]);
        material.ku_field = Some(vec![-2.0e4, 3.0e4]);
        material.ku2_field = Some(vec![-4.0e3, 2.0e3]);
        material.kc1_field = Some(vec![-1.0e3, 2.0e3]);
        material.kc2_field = Some(vec![3.0e3, -4.0e3]);
        material.kc3_field = Some(vec![-5.0e3, 6.0e3]);
        material.dind_field = Some(vec![-1.0e-3, 2.0e-3]);
        material.dbulk_field = Some(vec![3.0e-4, -4.0e-4]);

        material.validate_nodal_fields(&mesh).unwrap();
        let encoded = serde_json::to_value(&material).unwrap();
        let decoded: MaterialIR = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, material);
        decoded.validate_nodal_fields(&mesh).unwrap();
    }

    #[test]
    fn nodal_binding_and_values_reject_missing_or_invalid_payloads() {
        let mesh = mesh_with_nodes(vec![[0.0, 0.0, 0.0]]);
        let mut missing_binding = MaterialIR::default();
        missing_binding.ms_field = Some(vec![8.0e5]);
        assert!(missing_binding.validate_nodal_fields(&mesh).is_err());

        let mut binding_without_fields = MaterialIR::default();
        binding_without_fields.nodal_field_binding = Some(MaterialNodalFieldBindingIR {
            canonical_mesh_fingerprint: mesh.topology_fingerprint_v6(),
            node_count: 1,
        });
        assert!(binding_without_fields.validate_nodal_fields(&mesh).is_err());

        let valid = valid_material_for(&mesh);
        let mut invalid = valid.clone();
        invalid.ms_field = Some(Vec::new());
        assert!(invalid.validate_nodal_fields(&mesh).is_err());
        invalid = valid.clone();
        invalid.a_field = Some(vec![1.0, 2.0]);
        assert!(invalid.validate_nodal_fields(&mesh).is_err());
        invalid = valid.clone();
        invalid.ms_field = Some(vec![0.0]);
        assert!(invalid.validate_nodal_fields(&mesh).is_err());
        invalid = valid.clone();
        invalid.a_field = Some(vec![-1.0]);
        assert!(invalid.validate_nodal_fields(&mesh).is_err());
        invalid = valid.clone();
        invalid.alpha_field = Some(vec![-0.1]);
        assert!(invalid.validate_nodal_fields(&mesh).is_err());
        invalid = valid.clone();
        invalid.ku_field = Some(vec![f64::NAN]);
        assert!(invalid.validate_nodal_fields(&mesh).is_err());

        let invalid_binding = MaterialNodalFieldBindingIR {
            canonical_mesh_fingerprint: "sha256:ABC".to_string(),
            node_count: 1,
        };
        assert!(invalid_binding.validate().is_err());
        let zero_nodes = MaterialNodalFieldBindingIR {
            canonical_mesh_fingerprint: mesh.topology_fingerprint_v6(),
            node_count: 0,
        };
        assert!(zero_nodes.validate().is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MagnetIR {
    #[serde(default)]
    pub object_id: Option<String>,
    pub name: String,
    pub region: String,
    pub material: String,
    pub initial_magnetization: Option<InitialMagnetizationIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absorbing_boundary: Option<AbsorbingBoundaryLayerIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AbsorbingBoundaryLayerIR {
    pub total_width_m: f64,
    pub ramp_width_m: f64,
    pub max_damping: f64,
    pub faces: Vec<AbsorbingBoundaryFaceIR>,
    pub profile: AbsorbingBoundaryProfileIR,
    pub frame: AbsorbingBoundaryFrameIR,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum AbsorbingBoundaryFaceIR {
    #[serde(rename = "x+")]
    XPlus,
    #[serde(rename = "x-")]
    XMinus,
    #[serde(rename = "y+")]
    YPlus,
    #[serde(rename = "y-")]
    YMinus,
    #[serde(rename = "z+")]
    ZPlus,
    #[serde(rename = "z-")]
    ZMinus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AbsorbingBoundaryProfileIR {
    Linear,
    Quadratic,
    Smootherstep,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AbsorbingBoundaryFrameIR {
    Object,
    Universe,
}

// ── Initial magnetization / texture ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialMagnetizationIR {
    Uniform {
        value: [f64; 3],
    },
    #[serde(alias = "random")]
    RandomSeeded {
        seed: u64,
    },
    SampledField {
        values: Vec<[f64; 3]>,
    },
    PresetTexture {
        preset_kind: String,
        #[serde(default = "default_preset_version")]
        preset_version: u32,
        #[serde(default, alias = "params")]
        preset_params: BTreeMap<String, Value>,
        #[serde(default)]
        mapping: TextureMappingIR,
        #[serde(default)]
        texture_transform: TextureTransform3DIR,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextureMappingIR {
    #[serde(default = "default_texture_mapping_space")]
    pub space: String,
    #[serde(default)]
    pub projection: TextureProjectionMode,
    #[serde(default = "default_texture_mapping_clamp_mode")]
    pub clamp_mode: String,
}

/// Supported texture projection modes.
///
/// Kept in sync with the frontend `TextureProjectionMode` union
/// and the planner `match mapping.projection { … }`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextureProjectionMode {
    #[default]
    ObjectLocal,
    PlanarXy,
    PlanarXz,
    PlanarYz,
}

impl std::fmt::Display for TextureProjectionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ObjectLocal => write!(f, "object_local"),
            Self::PlanarXy => write!(f, "planar_xy"),
            Self::PlanarXz => write!(f, "planar_xz"),
            Self::PlanarYz => write!(f, "planar_yz"),
        }
    }
}

impl Default for TextureMappingIR {
    fn default() -> Self {
        Self {
            space: default_texture_mapping_space(),
            projection: TextureProjectionMode::default(),
            clamp_mode: default_texture_mapping_clamp_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextureTransform3DIR {
    #[serde(default = "default_texture_translation")]
    pub translation: [f64; 3],
    #[serde(default = "default_texture_rotation_quat")]
    pub rotation_quat: [f64; 4],
    #[serde(default = "default_texture_scale")]
    pub scale: [f64; 3],
    #[serde(default = "default_texture_pivot")]
    pub pivot: [f64; 3],
}

impl Default for TextureTransform3DIR {
    fn default() -> Self {
        Self {
            translation: default_texture_translation(),
            rotation_quat: default_texture_rotation_quat(),
            scale: default_texture_scale(),
            pivot: default_texture_pivot(),
        }
    }
}

fn default_texture_mapping_space() -> String {
    "object".to_string()
}

fn default_texture_mapping_clamp_mode() -> String {
    "clamp".to_string()
}

fn default_texture_translation() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

fn default_texture_rotation_quat() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn default_texture_scale() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}

fn default_texture_pivot() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

// ── Time-dependence envelope ──────────────────────────────────────────────────

/// Time-dependence envelope for fields and currents.
///
/// The effective value at time `t` is: `amplitude(t) = base * f(t)`
/// where `f(t)` is defined by the variant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimeDependenceIR {
    /// Constant: f(t) = 1
    Constant,
    /// Sinusoidal: f(t) = sin(2π·freq·t + phase) + offset
    Sinusoidal {
        frequency_hz: f64,
        #[serde(default)]
        phase_rad: f64,
        #[serde(default)]
        offset: f64,
    },
    /// Rectangular pulse: f(t) = 1 for t_on ≤ t < t_off, else 0
    Pulse { t_on: f64, t_off: f64 },
    /// Piecewise linear: pairs of (time, value), linearly interpolated
    PiecewiseLinear { points: Vec<[f64; 2]> },
    /// Normalized sinc pulse: f(t) = amplitude * sinc(2 * cutoff_hz * (t - t0))
    SincPulse {
        cutoff_hz: f64,
        #[serde(default)]
        t0: f64,
        #[serde(default = "default_unit_amplitude")]
        amplitude: f64,
    },
}

fn default_unit_amplitude() -> f64 {
    1.0
}

fn default_preset_version() -> u32 {
    1
}

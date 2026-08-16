//! Backend-neutral normalization of authored physics modules.
//!
//! The graph records presence and scope.  It deliberately does not contain
//! constitutive equations or mesh storage details; those remain in the family
//! payload and in the planner/backend lane.

use crate::{
    KnownSceneOerstedField, KnownSceneSpinTorque, SceneCurrentTransport, SceneDocument,
    SceneRegionRef, SceneSpinInterface, SceneSpinTransport,
};
use fullmag_ir::{DriveActivationIR, FieldTargetIR};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PhysicsScopeRef {
    Global,
    Object {
        object_id: String,
    },
    Region {
        object_id: String,
        region_id: String,
    },
    Interface {
        side_a: SceneRegionRef,
        side_b: SceneRegionRef,
    },
    CrossObject {
        object_ids: Vec<String>,
    },
    Unresolved {
        reason: String,
        source_path: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PhysicsActivation {
    Configured,
    Active,
    Inactive,
    Blocked,
    Unsupported,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PhysicsModulePresentation {
    pub family: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsModuleIR {
    pub id: String,
    pub kind: String,
    pub applies_to: Vec<PhysicsScopeRef>,
    pub solve_domain: Vec<SceneRegionRef>,
    pub depends_on: Vec<String>,
    pub activation: PhysicsActivation,
    pub authored_state: String,
    pub capability: String,
    pub source_path: String,
    pub presentation: PhysicsModulePresentation,
    pub family_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PhysicsEdgeIR {
    pub kind: String,
    pub source_id: String,
    pub target_id: String,
    pub status: PhysicsActivation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsGraphIR {
    pub schema_version: String,
    pub scene_revision: u64,
    pub modules: Vec<PhysicsModuleIR>,
    pub edges: Vec<PhysicsEdgeIR>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhysicsGraphError {
    DuplicateModuleId(String),
    MissingObject {
        object_id: String,
        source_path: String,
    },
    MissingRegion {
        object_id: String,
        region_id: String,
        source_path: String,
    },
}

impl fmt::Display for PhysicsGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateModuleId(id) => write!(f, "duplicate physics module id '{id}'"),
            Self::MissingObject {
                object_id,
                source_path,
            } => write!(f, "{source_path} refers to missing object '{object_id}'"),
            Self::MissingRegion {
                object_id,
                region_id,
                source_path,
            } => write!(
                f,
                "{source_path} refers to missing region '{object_id}:{region_id}'"
            ),
        }
    }
}

impl std::error::Error for PhysicsGraphError {}

pub fn normalize_physics_graph(scene: &SceneDocument) -> Result<PhysicsGraphIR, PhysicsGraphError> {
    let object_ids: BTreeSet<&str> = scene
        .objects
        .iter()
        .map(|object| object.id.as_str())
        .collect();
    let mut modules = Vec::new();
    let mut edges = Vec::new();

    for (index, record) in scene.current_transports.iter().enumerate() {
        let source_path = format!("/current_transports/{index}");
        match record {
            SceneCurrentTransport::Known(current) => {
                let id = current.name.clone();
                let solve_domain = current_solve_domain(current);
                let solve_domain =
                    validate_domain(&solve_domain, &object_ids, scene, &source_path)?;
                let applies_to = scope_from_domain(&solve_domain);
                let activation = current_activation(current.current_density, current.model);
                push_module(
                    &mut modules,
                    PhysicsModuleIR {
                        id,
                        kind: "current_transport".to_string(),
                        applies_to,
                        solve_domain,
                        depends_on: Vec::new(),
                        activation,
                        authored_state: "authored".to_string(),
                        capability: "semantic_only".to_string(),
                        source_path,
                        presentation: current_presentation(current.model),
                        family_payload: serde_json::to_value(current).expect("current payload"),
                    },
                )?;
            }
            SceneCurrentTransport::Unsupported(record) => {
                let id = unsupported_id(&record.payload, "current", &source_path);
                push_module(
                    &mut modules,
                    unsupported_module(id, "current_transport", source_path, &record.payload),
                )?;
            }
        }
    }

    let statuses = module_statuses(&modules);
    for (index, record) in scene.spin_transports.iter().enumerate() {
        let source_path = format!("/spin_transports/{index}");
        match record {
            SceneSpinTransport::Known(spin) => {
                let solve_domain = validate_domain(&spin.domain, &object_ids, scene, &source_path)?;
                let own = if spin.mode == crate::SceneSpinTransportMode::Steady {
                    PhysicsActivation::Active
                } else {
                    PhysicsActivation::Configured
                };
                let activation = dependency_activation(own, &spin.current_source_id, &statuses);
                push_module(
                    &mut modules,
                    PhysicsModuleIR {
                        id: spin.id.clone(),
                        kind: "spin_transport".to_string(),
                        applies_to: scope_from_domain(&solve_domain),
                        solve_domain,
                        depends_on: vec![spin.current_source_id.clone()],
                        activation,
                        authored_state: "authored".to_string(),
                        capability: "semantic_only".to_string(),
                        source_path: source_path.clone(),
                        presentation: spin_transport_presentation(spin.mode),
                        family_payload: serde_json::to_value(spin).expect("spin payload"),
                    },
                )?;
                edges.push(PhysicsEdgeIR {
                    kind: "current_to_spin_transport".to_string(),
                    source_id: spin.current_source_id.clone(),
                    target_id: spin.id.clone(),
                    status: activation,
                });
                let statuses = module_statuses(&modules);
                for (interface_index, interface) in spin.interfaces.iter().enumerate() {
                    let interface_path = format!("{source_path}/interfaces/{interface_index}");
                    let (id, scope, sides) =
                        interface_module(interface, &object_ids, scene, &interface_path)?;
                    let interface_activation =
                        dependency_activation(PhysicsActivation::Active, &spin.id, &statuses);
                    push_module(
                        &mut modules,
                        PhysicsModuleIR {
                            id: id.clone(),
                            kind: "spin_interface".to_string(),
                            applies_to: vec![scope],
                            solve_domain: sides,
                            depends_on: vec![spin.id.clone()],
                            activation: interface_activation,
                            authored_state: "authored".to_string(),
                            capability: "semantic_only".to_string(),
                            source_path: interface_path,
                            presentation: interface_presentation(interface),
                            family_payload: serde_json::to_value(interface)
                                .expect("interface payload"),
                        },
                    )?;
                }
            }
            SceneSpinTransport::Unsupported(record) => {
                let id = unsupported_id(&record.payload, "spin", &source_path);
                push_module(
                    &mut modules,
                    unsupported_module(id, "spin_transport", source_path, &record.payload),
                )?;
            }
        }
    }

    let statuses = module_statuses(&modules);
    for (index, record) in scene.spin_torques.iter().enumerate() {
        let source_path = format!("/spin_torques/{index}");
        match record {
            crate::SceneSpinTorque::Known(torque) => {
                let id = torque.id().to_string();
                let dependency_edge_kind = if matches!(
                    torque,
                    KnownSceneSpinTorque::DriftDiffusionSpinTorque { .. }
                ) {
                    "spin_transport_to_torque"
                } else {
                    "current_to_torque"
                };
                let (scope, source_id) = torque_scope_and_source(torque);
                let solve_domain = scope_domain(&scope);
                validate_domain(&solve_domain, &object_ids, scene, &source_path)?;
                let own = PhysicsActivation::Active;
                let activation = source_id
                    .as_deref()
                    .map(|source| dependency_activation(own, source, &statuses))
                    .unwrap_or(own);
                push_module(
                    &mut modules,
                    PhysicsModuleIR {
                        id: id.clone(),
                        kind: "spin_torque".to_string(),
                        applies_to: vec![scope],
                        solve_domain,
                        depends_on: source_id.clone().into_iter().collect(),
                        activation,
                        authored_state: "authored".to_string(),
                        capability: "semantic_only".to_string(),
                        source_path,
                        presentation: torque_presentation(torque),
                        family_payload: serde_json::to_value(torque).expect("torque payload"),
                    },
                )?;
                if let Some(source_id) = source_id {
                    edges.push(PhysicsEdgeIR {
                        kind: dependency_edge_kind.to_string(),
                        source_id,
                        target_id: id,
                        status: activation,
                    });
                }
            }
            crate::SceneSpinTorque::Unsupported(record) => {
                let id = unsupported_id(&record.payload, "torque", &source_path);
                let activation = if record.payload.contains_key("current_source")
                    || record.payload.contains_key("target")
                {
                    PhysicsActivation::Unresolved
                } else {
                    PhysicsActivation::Unsupported
                };
                push_module(
                    &mut modules,
                    PhysicsModuleIR {
                        id,
                        kind: "unsupported".to_string(),
                        applies_to: vec![PhysicsScopeRef::Unresolved {
                            reason: "unknown spin torque record or target".to_string(),
                            source_path: source_path.clone(),
                        }],
                        solve_domain: Vec::new(),
                        depends_on: Vec::new(),
                        activation,
                        authored_state: "preserved".to_string(),
                        capability: "semantic_only".to_string(),
                        source_path,
                        presentation: unsupported_presentation(),
                        family_payload: Value::Object(record.payload.clone().into_iter().collect()),
                    },
                )?;
            }
        }
    }

    let statuses = module_statuses(&modules);
    for (index, record) in scene.oersted_fields.iter().enumerate() {
        let source_path = format!("/oersted_fields/{index}");
        match record {
            crate::SceneOerstedField::Known(field) => {
                let (id, source_id, scope, payload) = oersted_details(field);
                let activation = source_id
                    .as_deref()
                    .map(|source| {
                        dependency_activation(PhysicsActivation::Active, source, &statuses)
                    })
                    .unwrap_or(PhysicsActivation::Active);
                let solve_domain = scope_domain(&scope);
                push_module(
                    &mut modules,
                    PhysicsModuleIR {
                        id: id.clone(),
                        kind: "oersted_field".to_string(),
                        applies_to: vec![scope],
                        solve_domain,
                        depends_on: source_id.clone().into_iter().collect(),
                        activation,
                        authored_state: "authored".to_string(),
                        capability: "semantic_only".to_string(),
                        source_path,
                        presentation: oersted_presentation(field),
                        family_payload: payload,
                    },
                )?;
                if let Some(source_id) = source_id {
                    edges.push(PhysicsEdgeIR {
                        kind: "current_to_oersted".to_string(),
                        source_id,
                        target_id: id,
                        status: activation,
                    });
                }
            }
            crate::SceneOerstedField::Unsupported(record) => {
                let id = unsupported_id(&record.payload, "oersted", &source_path);
                push_module(
                    &mut modules,
                    unsupported_module(id, "oersted_field", source_path, &record.payload),
                )?;
            }
        }
    }

    for drive in &scene.field_drives.drives {
        let source_path = format!("/field_drives/drives[id={} ]", drive.id).replace(" ", "");
        let scope = field_scope(&drive.target, &object_ids, scene, &source_path)?;
        let activation = if !drive.enabled {
            PhysicsActivation::Inactive
        } else if matches!(drive.activation, DriveActivationIR::AllTimeEvolution {}) {
            PhysicsActivation::Active
        } else {
            PhysicsActivation::Configured
        };
        push_module(
            &mut modules,
            PhysicsModuleIR {
                id: drive.id.clone(),
                kind: "regional_field_drive".to_string(),
                applies_to: vec![scope],
                solve_domain: Vec::new(),
                depends_on: Vec::new(),
                activation,
                authored_state: "authored".to_string(),
                capability: "semantic_only".to_string(),
                source_path,
                presentation: presentation("regional_field_drive", "Regional field drive"),
                family_payload: serde_json::to_value(drive).expect("field drive payload"),
            },
        )?;
    }

    if let Some(field) = scene.study.external_field {
        let activation = if field.iter().all(|value| *value == 0.0) {
            PhysicsActivation::Inactive
        } else {
            PhysicsActivation::Active
        };
        push_module(
            &mut modules,
            PhysicsModuleIR {
                id: "field:external:global".to_string(),
                kind: "external_field".to_string(),
                applies_to: vec![PhysicsScopeRef::Global],
                solve_domain: Vec::new(),
                depends_on: Vec::new(),
                activation,
                authored_state: "authored".to_string(),
                capability: "semantic_only".to_string(),
                source_path: "/study/external_field".to_string(),
                presentation: presentation("external_field", "External magnetic field"),
                family_payload: serde_json::json!({"field_B_T": field}),
            },
        )?;
    }

    modules.sort_by(|left, right| module_sort_key(left).cmp(&module_sort_key(right)));
    edges.sort_by(|left, right| {
        (&left.kind, &left.source_id, &left.target_id).cmp(&(
            &right.kind,
            &right.source_id,
            &right.target_id,
        ))
    });
    Ok(PhysicsGraphIR {
        schema_version: "physics_graph.v1".to_string(),
        scene_revision: scene.revision,
        modules,
        edges,
    })
}

fn current_solve_domain(current: &crate::KnownSceneCurrentTransport) -> Vec<SceneRegionRef> {
    if !current.domain.is_empty() {
        return current.domain.clone();
    }
    current
        .solve_region
        .as_ref()
        .map(|object_id| {
            vec![SceneRegionRef {
                object_id: object_id.clone(),
                region_id: None,
            }]
        })
        .unwrap_or_default()
}

fn push_module(
    modules: &mut Vec<PhysicsModuleIR>,
    module: PhysicsModuleIR,
) -> Result<(), PhysicsGraphError> {
    if modules.iter().any(|existing| existing.id == module.id) {
        return Err(PhysicsGraphError::DuplicateModuleId(module.id));
    }
    modules.push(module);
    Ok(())
}

fn module_sort_key(module: &PhysicsModuleIR) -> (u8, &str) {
    let rank = match module.kind.as_str() {
        "current_transport" => 0,
        "spin_transport" => 1,
        "spin_interface" => 2,
        "spin_torque" => 3,
        "oersted_field" => 4,
        "regional_field_drive" => 5,
        "external_field" => 6,
        _ => 7,
    };
    (rank, module.id.as_str())
}

fn module_statuses(modules: &[PhysicsModuleIR]) -> BTreeMap<String, PhysicsActivation> {
    modules
        .iter()
        .map(|module| (module.id.clone(), module.activation))
        .collect()
}

fn dependency_activation(
    own: PhysicsActivation,
    dependency: &str,
    statuses: &BTreeMap<String, PhysicsActivation>,
) -> PhysicsActivation {
    match statuses.get(dependency) {
        None => PhysicsActivation::Blocked,
        Some(PhysicsActivation::Active | PhysicsActivation::Configured) => own,
        Some(PhysicsActivation::Inactive) => PhysicsActivation::Inactive,
        Some(
            PhysicsActivation::Blocked
            | PhysicsActivation::Unsupported
            | PhysicsActivation::Unresolved,
        ) => PhysicsActivation::Blocked,
    }
}

fn current_activation(
    density: Option<[f64; 3]>,
    model: crate::CurrentTransportModel,
) -> PhysicsActivation {
    match model {
        crate::CurrentTransportModel::OhmicPoisson
        | crate::CurrentTransportModel::MagnetoresistivePoisson => PhysicsActivation::Active,
        crate::CurrentTransportModel::PrescribedDensity => match density {
            Some(values) if values.iter().all(|value| *value == 0.0) => PhysicsActivation::Inactive,
            Some(_) => PhysicsActivation::Active,
            None => PhysicsActivation::Configured,
        },
    }
}

fn presentation(family: &str, label: &str) -> PhysicsModulePresentation {
    PhysicsModulePresentation {
        family: family.to_string(),
        label: label.to_string(),
    }
}

fn unsupported_presentation() -> PhysicsModulePresentation {
    presentation("unsupported", "Unsupported physics record")
}

fn current_presentation(model: crate::CurrentTransportModel) -> PhysicsModulePresentation {
    match model {
        crate::CurrentTransportModel::PrescribedDensity => {
            presentation("prescribed_density", "Prescribed current density")
        }
        crate::CurrentTransportModel::OhmicPoisson => {
            presentation("ohmic_poisson", "Ohmic current transport")
        }
        crate::CurrentTransportModel::MagnetoresistivePoisson => presentation(
            "magnetoresistive_poisson",
            "Magnetoresistive current transport",
        ),
    }
}

fn spin_transport_presentation(mode: crate::SceneSpinTransportMode) -> PhysicsModulePresentation {
    match mode {
        crate::SceneSpinTransportMode::Steady => presentation("steady", "Steady spin transport"),
        crate::SceneSpinTransportMode::Transient => {
            presentation("transient", "Transient spin transport")
        }
    }
}

fn interface_presentation(interface: &SceneSpinInterface) -> PhysicsModulePresentation {
    match interface {
        SceneSpinInterface::Transparent { .. } => {
            presentation("transparent", "Transparent spin interface")
        }
        SceneSpinInterface::MixingConductance { .. } => {
            presentation("mixing_conductance", "Spin-mixing interface")
        }
    }
}

fn torque_presentation(torque: &KnownSceneSpinTorque) -> PhysicsModulePresentation {
    match torque {
        KnownSceneSpinTorque::Slonczewski { .. } => presentation("slonczewski", "Slonczewski STT"),
        KnownSceneSpinTorque::ZhangLi { .. } => presentation("zhang_li", "Zhang–Li STT"),
        KnownSceneSpinTorque::PrescribedSot { .. } => {
            presentation("prescribed_sot", "Prescribed SOT")
        }
        KnownSceneSpinTorque::DriftDiffusionSpinTorque { .. } => {
            presentation("drift_diffusion_spin_torque", "Drift-diffusion spin torque")
        }
    }
}

fn oersted_presentation(field: &KnownSceneOerstedField) -> PhysicsModulePresentation {
    match field {
        KnownSceneOerstedField::OerstedCylinder { .. } => {
            presentation("analytic_cylinder", "Analytic cylindrical Oersted field")
        }
        KnownSceneOerstedField::OerstedField { .. } => presentation(
            "from_current_solution",
            "Oersted field from current solution",
        ),
    }
}

fn scope_from_domain(domain: &[SceneRegionRef]) -> Vec<PhysicsScopeRef> {
    if domain.is_empty() {
        return vec![PhysicsScopeRef::Global];
    }
    let mut objects = BTreeSet::new();
    for region in domain {
        objects.insert(region.object_id.clone());
    }
    if objects.len() > 1 {
        return vec![PhysicsScopeRef::CrossObject {
            object_ids: objects.into_iter().collect(),
        }];
    }
    domain
        .iter()
        .map(|region| match &region.region_id {
            Some(region_id) => PhysicsScopeRef::Region {
                object_id: region.object_id.clone(),
                region_id: region_id.clone(),
            },
            None => PhysicsScopeRef::Object {
                object_id: region.object_id.clone(),
            },
        })
        .collect()
}

fn scope_domain(scope: &PhysicsScopeRef) -> Vec<SceneRegionRef> {
    match scope {
        PhysicsScopeRef::Object { object_id } => vec![SceneRegionRef {
            object_id: object_id.clone(),
            region_id: None,
        }],
        PhysicsScopeRef::Region {
            object_id,
            region_id,
        } => vec![SceneRegionRef {
            object_id: object_id.clone(),
            region_id: Some(region_id.clone()),
        }],
        PhysicsScopeRef::Interface { side_a, side_b } => vec![side_a.clone(), side_b.clone()],
        PhysicsScopeRef::CrossObject { object_ids } => object_ids
            .iter()
            .map(|object_id| SceneRegionRef {
                object_id: object_id.clone(),
                region_id: None,
            })
            .collect(),
        PhysicsScopeRef::Global | PhysicsScopeRef::Unresolved { .. } => Vec::new(),
    }
}

fn validate_domain(
    domain: &[SceneRegionRef],
    object_ids: &BTreeSet<&str>,
    scene: &SceneDocument,
    source_path: &str,
) -> Result<Vec<SceneRegionRef>, PhysicsGraphError> {
    for region in domain {
        validate_region(region, object_ids, scene, source_path)?;
    }
    Ok(domain.to_vec())
}

fn validate_region(
    region: &SceneRegionRef,
    object_ids: &BTreeSet<&str>,
    scene: &SceneDocument,
    source_path: &str,
) -> Result<(), PhysicsGraphError> {
    if !object_ids.contains(region.object_id.as_str()) {
        return Err(PhysicsGraphError::MissingObject {
            object_id: region.object_id.clone(),
            source_path: source_path.to_string(),
        });
    }
    if let Some(region_id) = &region.region_id {
        let object = scene
            .objects
            .iter()
            .find(|object| object.id == region.object_id)
            .unwrap();
        let exists = object
            .regions
            .iter()
            .any(|item| item.region_id == *region_id)
            || object
                .allocated_region_ids
                .iter()
                .any(|item| item == region_id);
        if !exists {
            return Err(PhysicsGraphError::MissingRegion {
                object_id: region.object_id.clone(),
                region_id: region_id.clone(),
                source_path: source_path.to_string(),
            });
        }
    }
    Ok(())
}

fn interface_module(
    interface: &SceneSpinInterface,
    object_ids: &BTreeSet<&str>,
    scene: &SceneDocument,
    source_path: &str,
) -> Result<(String, PhysicsScopeRef, Vec<SceneRegionRef>), PhysicsGraphError> {
    let (id, side_a, side_b) = match interface {
        SceneSpinInterface::Transparent {
            id, side_a, side_b, ..
        }
        | SceneSpinInterface::MixingConductance {
            id,
            normal_side: side_a,
            ferromagnet_side: side_b,
            ..
        } => (id.clone(), side_a.clone(), side_b.clone()),
    };
    validate_region(&side_a, object_ids, scene, source_path)?;
    validate_region(&side_b, object_ids, scene, source_path)?;
    let mut ids = BTreeSet::new();
    ids.insert(side_a.object_id.clone());
    ids.insert(side_b.object_id.clone());
    Ok((
        id,
        PhysicsScopeRef::CrossObject {
            object_ids: ids.into_iter().collect(),
        },
        vec![side_a, side_b],
    ))
}

fn field_scope(
    target: &FieldTargetIR,
    object_ids: &BTreeSet<&str>,
    scene: &SceneDocument,
    source_path: &str,
) -> Result<PhysicsScopeRef, PhysicsGraphError> {
    let scope = match target {
        FieldTargetIR::Global {} => PhysicsScopeRef::Global,
        FieldTargetIR::Object { object_id } => PhysicsScopeRef::Object {
            object_id: object_id.clone(),
        },
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => PhysicsScopeRef::Region {
            object_id: object_id.clone(),
            region_id: region_id.clone(),
        },
    };
    for region in scope_domain(&scope) {
        validate_region(&region, object_ids, scene, source_path)?;
    }
    Ok(scope)
}

fn torque_scope_and_source(torque: &KnownSceneSpinTorque) -> (PhysicsScopeRef, Option<String>) {
    match torque {
        KnownSceneSpinTorque::Slonczewski {
            target,
            current_source,
            ..
        } => (
            target
                .as_ref()
                .map(region_scope)
                .unwrap_or(PhysicsScopeRef::Global),
            current_source.clone(),
        ),
        KnownSceneSpinTorque::ZhangLi {
            target,
            current_source,
            ..
        } => (
            target
                .as_ref()
                .map(region_scope)
                .unwrap_or(PhysicsScopeRef::Global),
            current_source.clone(),
        ),
        KnownSceneSpinTorque::PrescribedSot { target, drive, .. } => {
            let source = match drive {
                crate::ScenePrescribedSotDrive::VectorCurrentSource {
                    current_source_id, ..
                }
                | crate::ScenePrescribedSotDrive::LegacyCurrentSourceNorm { current_source_id } => {
                    Some(current_source_id.clone())
                }
                _ => None,
            };
            (
                target
                    .as_ref()
                    .map(region_scope)
                    .unwrap_or(PhysicsScopeRef::Global),
                source,
            )
        }
        KnownSceneSpinTorque::DriftDiffusionSpinTorque {
            target, solve_id, ..
        } => (region_scope(target), Some(solve_id.clone())),
    }
}

fn region_scope(region: &SceneRegionRef) -> PhysicsScopeRef {
    match &region.region_id {
        Some(region_id) => PhysicsScopeRef::Region {
            object_id: region.object_id.clone(),
            region_id: region_id.clone(),
        },
        None => PhysicsScopeRef::Object {
            object_id: region.object_id.clone(),
        },
    }
}

fn oersted_details(
    field: &KnownSceneOerstedField,
) -> (String, Option<String>, PhysicsScopeRef, Value) {
    match field {
        KnownSceneOerstedField::OerstedCylinder { id, .. } => (
            id.clone(),
            None,
            PhysicsScopeRef::Global,
            serde_json::to_value(field).expect("Oersted cylinder payload"),
        ),
        KnownSceneOerstedField::OerstedField { id, source, .. } => (
            id.clone(),
            Some(source.clone()),
            PhysicsScopeRef::Global,
            serde_json::to_value(field).expect("Oersted payload"),
        ),
    }
}

fn unsupported_id(payload: &BTreeMap<String, Value>, prefix: &str, source_path: &str) -> String {
    payload
        .get("id")
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{prefix}:{source_path}"))
}

fn unsupported_module(
    id: String,
    kind: &str,
    source_path: String,
    payload: &BTreeMap<String, Value>,
) -> PhysicsModuleIR {
    PhysicsModuleIR {
        id,
        kind: kind.to_string(),
        applies_to: vec![PhysicsScopeRef::Unresolved {
            reason: "unknown authoring record".to_string(),
            source_path: source_path.clone(),
        }],
        solve_domain: Vec::new(),
        depends_on: Vec::new(),
        activation: PhysicsActivation::Unsupported,
        authored_state: "preserved".to_string(),
        capability: "semantic_only".to_string(),
        source_path,
        presentation: unsupported_presentation(),
        family_payload: Value::Object(payload.clone().into_iter().collect()),
    }
}

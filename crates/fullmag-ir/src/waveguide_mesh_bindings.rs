//! Borrowed registry bindings between a raw waveguide mesh and ProblemIR.
//!
//! This private fragment resolves explicit object, region, material, assignment,
//! and magnetization-module references. It does not validate world mapping,
//! boundary conditions, fields, equilibrium, provider readiness, or admission.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use crate::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionRegionIR};
use crate::waveguide_mesh_contours::{
    validate_waveguide_mesh_contours, WaveguideMeshContoursError,
};
use crate::{
    MagnetizationModuleIR, MaterialIR, ObjectMaterialAssignmentIR, ObjectRegionIR, PhysicsObjectIR,
    ProblemIRV04, RegionRefIR,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WaveguideRegistryBindingsError {
    InvalidProblem(Vec<String>),
    InvalidMeshContours(WaveguideMeshContoursError),
    RegionTargetKeys {
        missing: Vec<String>,
        extra: Vec<String>,
    },
    DuplicateMeshRegionId {
        region_id: String,
    },
    MeshRegionObjectMismatch {
        region_id: String,
        mesh_object_id: String,
        target_object_id: String,
    },
    MissingObject {
        region_id: String,
        object_id: String,
    },
    AmbiguousMeshRegionsForObject {
        object_id: String,
        mesh_region_ids: Vec<String>,
    },
    MissingObjectRegion {
        mesh_region_id: String,
        object_id: String,
        object_region_id: String,
    },
    ObjectRegionOwnerMismatch {
        mesh_region_id: String,
        object_id: String,
        object_region_id: String,
        actual_owner_object: String,
    },
    DisabledObjectRegion {
        mesh_region_id: String,
        object_id: String,
        object_region_id: String,
    },
    MissingMaterial {
        mesh_region_id: String,
        material_id: String,
    },
    MissingMagnetizationModule {
        mesh_region_id: String,
        object_id: String,
    },
    AmbiguousMagnetizationModules {
        mesh_region_id: String,
        object_id: String,
        module_ids: Vec<String>,
    },
    MagnetizationModuleTargetDoesNotCoverRegion {
        mesh_region_id: String,
        module_id: String,
    },
    MagnetizationModuleMaterialMismatch {
        mesh_region_id: String,
        module_id: String,
        expected_material_id: String,
        actual_material_id: String,
    },
    MissingMaterialAssignment {
        mesh_region_id: String,
        object_id: String,
    },
    UnlistedMaterialAssignment {
        mesh_region_id: String,
        object_id: String,
        assignment_id: String,
    },
    AmbiguousMaterialAssignments {
        mesh_region_id: String,
        object_id: String,
        assignment_ids: Vec<String>,
    },
    MaterialAssignmentTargetDoesNotCoverRegion {
        mesh_region_id: String,
        assignment_id: String,
    },
    MaterialAssignmentMaterialMismatch {
        mesh_region_id: String,
        assignment_id: String,
        expected_material_id: String,
        actual_material_id: String,
    },
    AirRegionHasMagnetizationModule {
        mesh_region_id: String,
        object_id: String,
        module_ids: Vec<String>,
    },
    AirRegionHasMaterialAssignment {
        mesh_region_id: String,
        object_id: String,
        assignment_ids: Vec<String>,
    },
    UnmappedMagnetizationModule {
        module_id: String,
    },
}

impl fmt::Display for WaveguideRegistryBindingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "waveguide registry binding error: {self:?}")
    }
}

impl Error for WaveguideRegistryBindingsError {}

/// A private, immutable view of registry identities resolved for this exact
/// ProblemIR/mesh/target-map borrow. It is not a mesh or provider certificate.
#[derive(Debug)]
pub(crate) struct ValidatedWaveguideRegistryBindings<'a> {
    problem: &'a ProblemIRV04,
    mesh: &'a WaveguideCrossSectionMeshIR,
    region_targets: &'a BTreeMap<String, RegionRefIR>,
    region_bindings: Vec<ResolvedWaveguideRegionBinding<'a>>,
}

impl<'a> ValidatedWaveguideRegistryBindings<'a> {
    pub(crate) fn problem(&self) -> &'a ProblemIRV04 {
        self.problem
    }

    pub(crate) fn mesh(&self) -> &'a WaveguideCrossSectionMeshIR {
        self.mesh
    }

    pub(crate) fn region_targets(&self) -> &'a BTreeMap<String, RegionRefIR> {
        self.region_targets
    }

    pub(crate) fn region_bindings(&self) -> &[ResolvedWaveguideRegionBinding<'a>] {
        &self.region_bindings
    }

    pub(crate) fn region_binding(
        &self,
        mesh_region_id: &str,
    ) -> Option<&ResolvedWaveguideRegionBinding<'a>> {
        self.region_bindings
            .iter()
            .find(|binding| mesh_region_id_for(binding.mesh_region) == mesh_region_id)
    }
}

/// One borrowed mesh-region to registry resolution. Fields stay private so
/// consumers can only use identities established by the binding validator.
#[derive(Debug)]
pub(crate) struct ResolvedWaveguideRegionBinding<'a> {
    mesh_region: &'a WaveguideCrossSectionRegionIR,
    target: &'a RegionRefIR,
    object: &'a PhysicsObjectIR,
    object_region: Option<&'a ObjectRegionIR>,
    material: Option<&'a MaterialIR>,
    material_assignment: Option<&'a ObjectMaterialAssignmentIR>,
    magnetization_module: Option<&'a MagnetizationModuleIR>,
}

impl<'a> ResolvedWaveguideRegionBinding<'a> {
    pub(crate) fn mesh_region(&self) -> &'a WaveguideCrossSectionRegionIR {
        self.mesh_region
    }

    pub(crate) fn target(&self) -> &'a RegionRefIR {
        self.target
    }

    pub(crate) fn object(&self) -> &'a PhysicsObjectIR {
        self.object
    }

    pub(crate) fn object_region(&self) -> Option<&'a ObjectRegionIR> {
        self.object_region
    }

    pub(crate) fn material(&self) -> Option<&'a MaterialIR> {
        self.material
    }

    pub(crate) fn material_assignment(&self) -> Option<&'a ObjectMaterialAssignmentIR> {
        self.material_assignment
    }

    pub(crate) fn magnetization_module(&self) -> Option<&'a MagnetizationModuleIR> {
        self.magnetization_module
    }
}

struct PendingRegionBinding<'a> {
    mesh_region: &'a WaveguideCrossSectionRegionIR,
    target: &'a RegionRefIR,
    object: &'a PhysicsObjectIR,
    object_region: Option<&'a ObjectRegionIR>,
}

/// Resolve explicit mesh region names to ProblemIR object and physics registries.
///
/// Whole-object module/assignment targets cover a regional mesh target. The
/// reverse is false. Distinct mesh regions for one object and competing
/// whole/regional providers are rejected because this fragment has no proof of
/// geometric precedence or non-overlap.
pub(crate) fn validate_waveguide_registry_bindings<'a>(
    problem: &'a ProblemIRV04,
    mesh: &'a WaveguideCrossSectionMeshIR,
    region_targets: &'a BTreeMap<String, RegionRefIR>,
) -> Result<ValidatedWaveguideRegistryBindings<'a>, WaveguideRegistryBindingsError> {
    problem
        .validate()
        .map_err(WaveguideRegistryBindingsError::InvalidProblem)?;
    validate_waveguide_registry_bindings_for_validated_problem(problem, mesh, region_targets)
}

/// Registry/mesh binding validation for callers that already passed the common
/// ProblemIRV04 object checks. This helper does not re-enter problem validation.
pub(crate) fn validate_waveguide_registry_bindings_for_validated_problem<'a>(
    problem: &'a ProblemIRV04,
    mesh: &'a WaveguideCrossSectionMeshIR,
    region_targets: &'a BTreeMap<String, RegionRefIR>,
) -> Result<ValidatedWaveguideRegistryBindings<'a>, WaveguideRegistryBindingsError> {
    validate_waveguide_mesh_contours(mesh)
        .map_err(WaveguideRegistryBindingsError::InvalidMeshContours)?;

    let mut mesh_region_ids = BTreeSet::<String>::new();
    for mesh_region in &mesh.regions {
        let region_id = mesh_region_id_for(mesh_region).to_string();
        if !mesh_region_ids.insert(region_id.clone()) {
            return Err(WaveguideRegistryBindingsError::DuplicateMeshRegionId { region_id });
        }
    }
    let target_region_ids = region_targets.keys().cloned().collect::<BTreeSet<_>>();
    let missing = mesh_region_ids
        .difference(&target_region_ids)
        .cloned()
        .collect::<Vec<_>>();
    let extra = target_region_ids
        .difference(&mesh_region_ids)
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() || !extra.is_empty() {
        return Err(WaveguideRegistryBindingsError::RegionTargetKeys { missing, extra });
    }

    let object_by_id = problem
        .objects
        .iter()
        .map(|object| (object.object_id.as_str(), object))
        .collect::<BTreeMap<_, _>>();
    let mut pending = Vec::with_capacity(mesh.regions.len());
    let mut mesh_region_ids_by_object = BTreeMap::<String, Vec<String>>::new();

    for mesh_region in &mesh.regions {
        let mesh_region_id = mesh_region_id_for(mesh_region);
        let (mesh_object_id, _) = mesh_region_identity(mesh_region);
        let target = region_targets
            .get(mesh_region_id)
            .expect("exact region target key set was checked");
        if target.object_id != mesh_object_id {
            return Err(WaveguideRegistryBindingsError::MeshRegionObjectMismatch {
                region_id: mesh_region_id.to_string(),
                mesh_object_id: mesh_object_id.to_string(),
                target_object_id: target.object_id.clone(),
            });
        }
        let Some(object) = object_by_id.get(target.object_id.as_str()).copied() else {
            return Err(WaveguideRegistryBindingsError::MissingObject {
                region_id: mesh_region_id.to_string(),
                object_id: target.object_id.clone(),
            });
        };

        mesh_region_ids_by_object
            .entry(target.object_id.clone())
            .or_default()
            .push(mesh_region_id.to_string());

        let object_region = match target.region_id.as_deref() {
            None => None,
            Some(object_region_id) => {
                let Some(object_region) = problem
                    .object_regions
                    .iter()
                    .find(|region| region.region_id == object_region_id)
                else {
                    return Err(WaveguideRegistryBindingsError::MissingObjectRegion {
                        mesh_region_id: mesh_region_id.to_string(),
                        object_id: target.object_id.clone(),
                        object_region_id: object_region_id.to_string(),
                    });
                };
                if object_region.owner_object != target.object_id {
                    return Err(WaveguideRegistryBindingsError::ObjectRegionOwnerMismatch {
                        mesh_region_id: mesh_region_id.to_string(),
                        object_id: target.object_id.clone(),
                        object_region_id: object_region_id.to_string(),
                        actual_owner_object: object_region.owner_object.clone(),
                    });
                }
                if !object_region.enabled {
                    return Err(WaveguideRegistryBindingsError::DisabledObjectRegion {
                        mesh_region_id: mesh_region_id.to_string(),
                        object_id: target.object_id.clone(),
                        object_region_id: object_region_id.to_string(),
                    });
                }
                Some(object_region)
            }
        };

        pending.push(PendingRegionBinding {
            mesh_region,
            target,
            object,
            object_region,
        });
    }

    if let Some((object_id, mesh_region_ids)) = mesh_region_ids_by_object
        .into_iter()
        .find(|(_, mesh_region_ids)| mesh_region_ids.len() > 1)
    {
        return Err(
            WaveguideRegistryBindingsError::AmbiguousMeshRegionsForObject {
                object_id,
                mesh_region_ids,
            },
        );
    }

    let mut matched_module_ids = BTreeSet::<&str>::new();
    let mut region_bindings = Vec::with_capacity(pending.len());
    for pending_region in pending {
        let mesh_region_id = mesh_region_id_for(pending_region.mesh_region);
        let object_id = pending_region.target.object_id.as_str();
        match pending_region.mesh_region {
            WaveguideCrossSectionRegionIR::Air { .. } => {
                let module_ids = problem
                    .magnetization_modules
                    .iter()
                    .filter(|module| module.target.object_id == object_id)
                    .map(|module| module.module_id.clone())
                    .collect::<Vec<_>>();
                if !module_ids.is_empty() {
                    return Err(
                        WaveguideRegistryBindingsError::AirRegionHasMagnetizationModule {
                            mesh_region_id: mesh_region_id.to_string(),
                            object_id: object_id.to_string(),
                            module_ids,
                        },
                    );
                }
                // Air is the explicitly tagged nonmagnetic vacuum region.
                // Inspect actual assignments by target, not only the object's
                // advertised ID list, so no assigned material intent is lost.
                let assignment_ids = problem
                    .material_assignments
                    .iter()
                    .filter(|assignment| assignment.target.object_id == object_id)
                    .map(|assignment| assignment.assignment_id.clone())
                    .collect::<BTreeSet<_>>();
                if !assignment_ids.is_empty() {
                    return Err(
                        WaveguideRegistryBindingsError::AirRegionHasMaterialAssignment {
                            mesh_region_id: mesh_region_id.to_string(),
                            object_id: object_id.to_string(),
                            assignment_ids: assignment_ids.into_iter().collect(),
                        },
                    );
                }
                region_bindings.push(ResolvedWaveguideRegionBinding {
                    mesh_region: pending_region.mesh_region,
                    target: pending_region.target,
                    object: pending_region.object,
                    object_region: pending_region.object_region,
                    material: None,
                    material_assignment: None,
                    magnetization_module: None,
                });
            }
            WaveguideCrossSectionRegionIR::Magnetic { material_id, .. } => {
                let Some(material) = problem
                    .materials
                    .iter()
                    .find(|material| material.name == *material_id)
                else {
                    return Err(WaveguideRegistryBindingsError::MissingMaterial {
                        mesh_region_id: mesh_region_id.to_string(),
                        material_id: material_id.clone(),
                    });
                };

                // With no geometric precedence proof, every provider scoped to
                // this object is potentially overlapping, including regional
                // targets with different region IDs.
                let modules = problem
                    .magnetization_modules
                    .iter()
                    .filter(|module| module.target.object_id == object_id)
                    .collect::<Vec<_>>();
                let module = match modules.as_slice() {
                    [] => {
                        return Err(WaveguideRegistryBindingsError::MissingMagnetizationModule {
                            mesh_region_id: mesh_region_id.to_string(),
                            object_id: object_id.to_string(),
                        })
                    }
                    [module] => *module,
                    _ => {
                        return Err(
                            WaveguideRegistryBindingsError::AmbiguousMagnetizationModules {
                                mesh_region_id: mesh_region_id.to_string(),
                                object_id: object_id.to_string(),
                                module_ids: modules
                                    .iter()
                                    .map(|module| module.module_id.clone())
                                    .collect(),
                            },
                        )
                    }
                };
                if !target_covers(&module.target, pending_region.target) {
                    return Err(WaveguideRegistryBindingsError::MagnetizationModuleTargetDoesNotCoverRegion {
                        mesh_region_id: mesh_region_id.to_string(),
                        module_id: module.module_id.clone(),
                    });
                }
                if module.material_id != *material_id {
                    return Err(
                        WaveguideRegistryBindingsError::MagnetizationModuleMaterialMismatch {
                            mesh_region_id: mesh_region_id.to_string(),
                            module_id: module.module_id.clone(),
                            expected_material_id: material_id.clone(),
                            actual_material_id: module.material_id.clone(),
                        },
                    );
                }

                let listed_assignment_ids = pending_region
                    .object
                    .material_assignment_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>();
                let object_assignments = problem
                    .material_assignments
                    .iter()
                    .filter(|assignment| assignment.target.object_id == object_id)
                    .collect::<Vec<_>>();
                if let Some(assignment) = object_assignments.iter().find(|assignment| {
                    !listed_assignment_ids.contains(assignment.assignment_id.as_str())
                }) {
                    return Err(WaveguideRegistryBindingsError::UnlistedMaterialAssignment {
                        mesh_region_id: mesh_region_id.to_string(),
                        object_id: object_id.to_string(),
                        assignment_id: assignment.assignment_id.clone(),
                    });
                }
                let assignment = match object_assignments.as_slice() {
                    [] => {
                        return Err(WaveguideRegistryBindingsError::MissingMaterialAssignment {
                            mesh_region_id: mesh_region_id.to_string(),
                            object_id: object_id.to_string(),
                        })
                    }
                    [assignment] => *assignment,
                    _ => {
                        return Err(
                            WaveguideRegistryBindingsError::AmbiguousMaterialAssignments {
                                mesh_region_id: mesh_region_id.to_string(),
                                object_id: object_id.to_string(),
                                assignment_ids: object_assignments
                                    .iter()
                                    .map(|assignment| assignment.assignment_id.clone())
                                    .collect(),
                            },
                        )
                    }
                };
                if !target_covers(&assignment.target, pending_region.target) {
                    return Err(WaveguideRegistryBindingsError::MaterialAssignmentTargetDoesNotCoverRegion {
                        mesh_region_id: mesh_region_id.to_string(),
                        assignment_id: assignment.assignment_id.clone(),
                    });
                }
                if assignment.material_id != *material_id {
                    return Err(
                        WaveguideRegistryBindingsError::MaterialAssignmentMaterialMismatch {
                            mesh_region_id: mesh_region_id.to_string(),
                            assignment_id: assignment.assignment_id.clone(),
                            expected_material_id: material_id.clone(),
                            actual_material_id: assignment.material_id.clone(),
                        },
                    );
                }

                matched_module_ids.insert(module.module_id.as_str());
                region_bindings.push(ResolvedWaveguideRegionBinding {
                    mesh_region: pending_region.mesh_region,
                    target: pending_region.target,
                    object: pending_region.object,
                    object_region: pending_region.object_region,
                    material: Some(material),
                    material_assignment: Some(assignment),
                    magnetization_module: Some(module),
                });
            }
        }
    }

    if let Some(module) = problem
        .magnetization_modules
        .iter()
        .find(|module| !matched_module_ids.contains(module.module_id.as_str()))
    {
        return Err(
            WaveguideRegistryBindingsError::UnmappedMagnetizationModule {
                module_id: module.module_id.clone(),
            },
        );
    }

    Ok(ValidatedWaveguideRegistryBindings {
        problem,
        mesh,
        region_targets,
        region_bindings,
    })
}

fn mesh_region_id_for(region: &WaveguideCrossSectionRegionIR) -> &str {
    match region {
        WaveguideCrossSectionRegionIR::Magnetic { region_id, .. }
        | WaveguideCrossSectionRegionIR::Air { region_id, .. } => region_id,
    }
}

fn mesh_region_identity(region: &WaveguideCrossSectionRegionIR) -> (&str, Option<&str>) {
    match region {
        WaveguideCrossSectionRegionIR::Magnetic {
            object_id,
            material_id,
            ..
        } => (object_id, Some(material_id)),
        WaveguideCrossSectionRegionIR::Air { object_id, .. } => (object_id, None),
    }
}

fn target_covers(coverage: &RegionRefIR, requested: &RegionRefIR) -> bool {
    if coverage.object_id != requested.object_id {
        return false;
    }
    match (
        coverage.region_id.as_deref(),
        requested.region_id.as_deref(),
    ) {
        (None, _) => true,
        (Some(coverage_region_id), Some(requested_region_id)) => {
            coverage_region_id == requested_region_id
        }
        (Some(_), None) => false,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{validate_waveguide_registry_bindings, WaveguideRegistryBindingsError};
    use crate::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionRegionIR};
    use crate::{
        GeometryEntryIR, InitialMagnetizationIR, MagnetizationModuleIR, ObjectMaterialAssignmentIR,
        ObjectRegionIR, PhysicsObjectIR, PhysicsObjectTypeIR, ProblemIRV04, RegionFrameIR,
        RegionIR, RegionRealizationPolicyIR, RegionRefIR, RegionShapeIR,
    };
    use std::collections::{BTreeMap, BTreeSet};

    const RAW_MESH_FIXTURE: &str =
        include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");
    const CORE_OBJECT_REGION_ID: &str = "object-region-core";
    const AIR_OBJECT_ID: &str = "object-waveguide-air";
    const AIR_GEOMETRY_ID: &str = "geometry-waveguide-air";

    pub(crate) fn valid_fixture() -> (
        ProblemIRV04,
        WaveguideCrossSectionMeshIR,
        BTreeMap<String, RegionRefIR>,
    ) {
        let mut problem = ProblemIRV04::bootstrap_example();
        let core_object_id = problem.objects[0].object_id.clone();
        let material_id = problem.materials[0].name.clone();

        problem.geometry.entries.push(GeometryEntryIR::Box {
            name: AIR_GEOMETRY_ID.to_string(),
            size: [1.0, 1.0, 1.0],
        });
        problem.regions.push(RegionIR {
            name: "waveguide-air".to_string(),
            geometry: AIR_GEOMETRY_ID.to_string(),
        });
        problem.objects.push(PhysicsObjectIR::new(
            AIR_OBJECT_ID,
            "waveguide-air",
            PhysicsObjectTypeIR::Geometry,
            AIR_GEOMETRY_ID,
        ));
        problem.object_regions.push(ObjectRegionIR {
            region_id: CORE_OBJECT_REGION_ID.to_string(),
            owner_object: core_object_id.clone(),
            name: "waveguide-core".to_string(),
            shape: RegionShapeIR::Box {
                size: [1.0, 1.0, 1.0],
                center: [0.0, 0.0, 0.0],
            },
            frame: RegionFrameIR::default(),
            enabled: true,
            priority: 0,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            realization_policy: RegionRealizationPolicyIR::default(),
            material_transition: None,
        });

        let mut mesh: WaveguideCrossSectionMeshIR =
            serde_json::from_str(RAW_MESH_FIXTURE).expect("raw mesh fixture must parse");
        for region in &mut mesh.regions {
            match region {
                WaveguideCrossSectionRegionIR::Magnetic {
                    object_id,
                    material_id: raw_material_id,
                    ..
                } => {
                    *object_id = core_object_id.clone();
                    *raw_material_id = material_id.clone();
                }
                WaveguideCrossSectionRegionIR::Air { object_id, .. } => {
                    *object_id = AIR_OBJECT_ID.to_string();
                }
            }
        }

        let region_targets = BTreeMap::from([
            (
                "region-magnetic".to_string(),
                RegionRefIR {
                    object_id: core_object_id,
                    region_id: Some(CORE_OBJECT_REGION_ID.to_string()),
                },
            ),
            (
                "region-air".to_string(),
                RegionRefIR {
                    object_id: AIR_OBJECT_ID.to_string(),
                    region_id: None,
                },
            ),
        ]);

        (problem, mesh, region_targets)
    }

    fn expect_binding_error(
        problem: &ProblemIRV04,
        mesh: &WaveguideCrossSectionMeshIR,
        region_targets: &BTreeMap<String, RegionRefIR>,
    ) -> WaveguideRegistryBindingsError {
        validate_waveguide_registry_bindings(problem, mesh, region_targets)
            .expect_err("invalid registry bindings must be rejected")
    }

    fn add_material_assignment(
        problem: &mut ProblemIRV04,
        object_id: &str,
        assignment_id: &str,
        target: RegionRefIR,
        material_id: &str,
    ) {
        problem
            .material_assignments
            .push(ObjectMaterialAssignmentIR::new(
                assignment_id,
                target,
                material_id,
            ));
        problem
            .objects
            .iter_mut()
            .find(|object| object.object_id == object_id)
            .expect("assignment owner object exists")
            .material_assignment_ids
            .push(assignment_id.to_string());
    }

    fn add_magnetization_module(
        problem: &mut ProblemIRV04,
        module_id: &str,
        target: RegionRefIR,
        material_id: &str,
    ) {
        problem
            .magnetization_modules
            .push(MagnetizationModuleIR::new(
                module_id,
                target,
                material_id,
                InitialMagnetizationIR::RandomSeeded { seed: 7 },
            ));
    }

    fn add_unmapped_object(problem: &mut ProblemIRV04, object_id: &str) {
        let geometry_id = format!("geometry-{object_id}");
        problem.geometry.entries.push(GeometryEntryIR::Box {
            name: geometry_id.clone(),
            size: [1.0, 1.0, 1.0],
        });
        problem.regions.push(RegionIR {
            name: format!("region-{object_id}"),
            geometry: geometry_id.clone(),
        });
        problem.objects.push(PhysicsObjectIR::new(
            object_id,
            object_id,
            PhysicsObjectTypeIR::Geometry,
            geometry_id,
        ));
    }

    #[test]
    fn binds_explicit_magnetic_registries_and_air_without_synthetic_material() {
        let (problem, mesh, region_targets) = valid_fixture();
        let bindings = validate_waveguide_registry_bindings(&problem, &mesh, &region_targets)
            .expect("explicit bootstrap registries must bind");

        let magnetic = bindings
            .region_binding("region-magnetic")
            .expect("magnetic mesh region is bound");
        assert_eq!(
            magnetic.object().object_id,
            region_targets["region-magnetic"].object_id
        );
        assert_eq!(
            magnetic
                .object_region()
                .map(|region| region.region_id.as_str()),
            Some(CORE_OBJECT_REGION_ID)
        );
        assert_eq!(
            magnetic.material().map(|material| material.name.as_str()),
            Some("Py")
        );
        assert!(magnetic.material_assignment().is_some());
        assert!(magnetic.magnetization_module().is_some());

        let air = bindings
            .region_binding("region-air")
            .expect("air mesh region is bound");
        assert!(air.material().is_none());
        assert!(air.material_assignment().is_none());
        assert!(air.magnetization_module().is_none());
    }

    #[test]
    fn ferromagnet_name_and_type_do_not_replace_an_explicit_module() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        assert_eq!(
            problem.objects[0].object_type,
            PhysicsObjectTypeIR::Ferromagnet
        );
        assert_eq!(problem.objects[0].name, "strip");
        problem.magnetization_modules.clear();

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MissingMagnetizationModule { .. }
        ));
    }

    #[test]
    fn mapping_keys_must_match_mesh_region_ids_exactly() {
        let (problem, mesh, mut region_targets) = valid_fixture();
        region_targets.remove("region-air");
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::RegionTargetKeys { missing, extra }
                if missing == vec!["region-air"] && extra.is_empty()
        ));

        let (problem, mesh, mut region_targets) = valid_fixture();
        region_targets.insert(
            "unreferenced-region".to_string(),
            RegionRefIR {
                object_id: AIR_OBJECT_ID.to_string(),
                region_id: None,
            },
        );
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::RegionTargetKeys { missing, extra }
                if missing.is_empty() && extra == vec!["unreferenced-region"]
        ));
    }

    #[test]
    fn missing_and_foreign_objects_are_rejected() {
        let (problem, mut mesh, mut region_targets) = valid_fixture();
        if let WaveguideCrossSectionRegionIR::Magnetic { object_id, .. } = &mut mesh.regions[0] {
            *object_id = "missing-object".to_string();
        }
        region_targets.get_mut("region-magnetic").unwrap().object_id = "missing-object".into();
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MissingObject { .. }
        ));

        let (problem, mesh, mut region_targets) = valid_fixture();
        region_targets.get_mut("region-magnetic").unwrap().object_id = AIR_OBJECT_ID.into();
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MeshRegionObjectMismatch { .. }
        ));
    }

    #[test]
    fn object_region_must_belong_to_target_object_and_be_enabled() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        problem.object_regions[0].owner_object = AIR_OBJECT_ID.to_string();
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::ObjectRegionOwnerMismatch { .. }
        ));

        let (mut problem, mesh, region_targets) = valid_fixture();
        problem.object_regions[0].enabled = false;
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::DisabledObjectRegion { .. }
        ));
    }

    #[test]
    fn material_lookup_uses_material_name_and_module_must_match_it() {
        let (problem, mut mesh, region_targets) = valid_fixture();
        if let WaveguideCrossSectionRegionIR::Magnetic { material_id, .. } = &mut mesh.regions[0] {
            *material_id = "missing-material".to_string();
        }
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MissingMaterial { .. }
        ));

        let (mut problem, mut mesh, region_targets) = valid_fixture();
        let mut alternate = problem.materials[0].clone();
        alternate.name = "CoFeB".to_string();
        problem.materials.push(alternate);
        if let WaveguideCrossSectionRegionIR::Magnetic { material_id, .. } = &mut mesh.regions[0] {
            *material_id = "CoFeB".to_string();
        }
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MagnetizationModuleMaterialMismatch { .. }
        ));
    }

    #[test]
    fn whole_object_module_and_assignment_cover_a_regional_target() {
        let (problem, mesh, region_targets) = valid_fixture();
        let magnetic_target = &region_targets["region-magnetic"];
        assert!(magnetic_target.region_id.is_some());
        assert!(problem.magnetization_modules[0].target.region_id.is_none());
        assert!(problem.material_assignments[0].target.region_id.is_none());
        assert!(validate_waveguide_registry_bindings(&problem, &mesh, &region_targets).is_ok());
    }

    #[test]
    fn regional_module_does_not_cover_a_whole_object_target() {
        let (mut problem, mesh, mut region_targets) = valid_fixture();
        let regional_target = region_targets["region-magnetic"].clone();
        problem.magnetization_modules[0].target = regional_target.clone();
        problem.material_assignments[0].target = regional_target;
        region_targets.get_mut("region-magnetic").unwrap().region_id = None;
        assert!(problem.validate().is_ok());
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MagnetizationModuleTargetDoesNotCoverRegion { .. }
        ));
    }

    #[test]
    fn distinct_regional_module_targets_do_not_imply_coverage() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let mut other_region = problem.object_regions[0].clone();
        other_region.region_id = "other-core-region".into();
        other_region.name = "other-core-region".into();
        problem.object_regions.push(other_region);
        let mut provider_target = region_targets["region-magnetic"].clone();
        provider_target.region_id = Some("other-core-region".into());
        problem.magnetization_modules[0].target = provider_target.clone();
        problem.material_assignments[0].target = provider_target;
        assert!(problem.validate().is_ok());
        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::MagnetizationModuleTargetDoesNotCoverRegion { .. }
        ));
    }

    #[test]
    fn competing_whole_and_regional_modules_are_rejected_as_ambiguous() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let target = region_targets["region-magnetic"].clone();
        let material_id = problem.materials[0].name.clone();
        add_material_assignment(
            &mut problem,
            &target.object_id,
            "assignment-core-region",
            target.clone(),
            &material_id,
        );
        add_magnetization_module(
            &mut problem,
            "magnetization-core-region",
            target,
            &material_id,
        );

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AmbiguousMagnetizationModules { .. }
        ));
    }

    #[test]
    fn competing_whole_and_regional_assignments_are_rejected_as_ambiguous() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let target = region_targets["region-magnetic"].clone();
        let material_id = problem.materials[0].name.clone();
        add_material_assignment(
            &mut problem,
            &target.object_id,
            "assignment-core-region",
            target.clone(),
            &material_id,
        );

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AmbiguousMaterialAssignments { .. }
        ));
    }

    #[test]
    fn unlisted_material_assignment_does_not_cover_a_magnetic_region() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        problem.objects[0].material_assignment_ids.clear();

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::UnlistedMaterialAssignment { .. }
        ));
    }

    #[test]
    fn air_rejects_a_magnetization_module_on_its_target_object() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let target = region_targets["region-air"].clone();
        let material_id = problem.materials[0].name.clone();
        add_material_assignment(
            &mut problem,
            &target.object_id,
            "assignment-air-magnetization",
            target.clone(),
            &material_id,
        );
        add_magnetization_module(&mut problem, "magnetization-air", target, &material_id);

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AirRegionHasMagnetizationModule { .. }
        ));
    }

    #[test]
    fn air_rejects_a_listed_material_assignment_without_a_magnetization_module() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let material_id = problem.materials[0].name.clone();
        add_material_assignment(
            &mut problem,
            AIR_OBJECT_ID,
            "assignment-air",
            region_targets["region-air"].clone(),
            &material_id,
        );
        assert!(problem.validate().is_ok());

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AirRegionHasMaterialAssignment {
                mesh_region_id,
                object_id,
                assignment_ids,
            }
                if mesh_region_id == "region-air"
                    && object_id == AIR_OBJECT_ID
                    && assignment_ids == vec!["assignment-air".to_string()]
        ));
    }

    #[test]
    fn air_rejects_sorted_whole_object_and_regional_material_assignments() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let material_id = problem.materials[0].name.clone();
        let mut air_object_region = problem.object_regions[0].clone();
        air_object_region.region_id = "object-region-air".to_string();
        air_object_region.owner_object = AIR_OBJECT_ID.to_string();
        air_object_region.name = "waveguide-air-region".to_string();
        problem.object_regions.push(air_object_region);

        add_material_assignment(
            &mut problem,
            AIR_OBJECT_ID,
            "z-assignment-air",
            region_targets["region-air"].clone(),
            &material_id,
        );
        // The common ProblemIR validator permits a material assignment which
        // is not listed on its owner. The waveguide binding must still observe
        // this actual regional assignment, irrespective of target scope.
        problem
            .material_assignments
            .push(ObjectMaterialAssignmentIR::new(
                "a-assignment-air",
                RegionRefIR {
                    object_id: AIR_OBJECT_ID.to_string(),
                    region_id: Some("object-region-air".to_string()),
                },
                material_id,
            ));
        assert!(problem.validate().is_ok());

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AirRegionHasMaterialAssignment {
                assignment_ids,
                ..
            } if assignment_ids
                == vec![
                    "a-assignment-air".to_string(),
                    "z-assignment-air".to_string(),
                ]
        ));
    }

    #[test]
    fn distinct_mesh_region_targets_for_one_object_fail_closed() {
        let (problem, mut mesh, mut region_targets) = valid_fixture();
        if let WaveguideCrossSectionRegionIR::Air { object_id, .. } = &mut mesh.regions[1] {
            *object_id = region_targets["region-magnetic"].object_id.clone();
        }
        let core_object_id = region_targets["region-magnetic"].object_id.clone();
        region_targets.get_mut("region-air").unwrap().object_id = core_object_id.clone();
        region_targets.get_mut("region-air").unwrap().region_id = Some("other-core-region".into());
        let mut other_region = problem.object_regions[0].clone();
        other_region.region_id = "other-core-region".into();
        other_region.name = "other-core-region".into();
        let mut problem = problem;
        problem.object_regions.push(other_region);

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::AmbiguousMeshRegionsForObject { .. }
        ));
    }

    #[test]
    fn magnetization_modules_without_a_bound_mesh_region_are_rejected() {
        let (mut problem, mesh, region_targets) = valid_fixture();
        let object_id = "object-unmapped";
        add_unmapped_object(&mut problem, object_id);
        let material_id = problem.materials[0].name.clone();
        let target = RegionRefIR {
            object_id: object_id.to_string(),
            region_id: None,
        };
        add_material_assignment(
            &mut problem,
            object_id,
            "assignment-unmapped",
            target.clone(),
            &material_id,
        );
        add_magnetization_module(&mut problem, "magnetization-unmapped", target, &material_id);

        assert!(matches!(
            expect_binding_error(&problem, &mesh, &region_targets),
            WaveguideRegistryBindingsError::UnmappedMagnetizationModule { .. }
        ));
    }
    #[test]
    fn dirichlet_binds_only_explicit_outer_air_nodes() {
        use crate::waveguide_mesh_dirichlet::validate_finite_air_dirichlet_bindings;
        let (problem, mesh, targets) = valid_fixture();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &targets).unwrap();
        let bound =
            validate_finite_air_dirichlet_bindings(&registry, &["boundary-air-outer".into()])
                .unwrap();
        assert!(std::ptr::eq(bound.registry(), &registry));
        assert_eq!(bound.selected_edge_counts_by_component(), &[12]);
        assert_eq!(bound.essential_node_counts_by_component(), &[12]);
        let boundary = &mesh.boundary_components[bound.boundary_component_indices()[0]];
        let mut expected = BTreeSet::new();
        for side in &boundary.half_edges {
            let nodes = mesh.triangles[side.triangle_index as usize].nodes;
            let i = usize::from(side.local_edge_index.as_u8());
            expected.extend([nodes[i], nodes[(i + 1) % 3]]);
        }
        assert_eq!(
            bound.essential_node_indices(),
            expected.into_iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn dirichlet_rejects_empty_duplicate_missing_magnetic_and_hole_selections() {
        use crate::waveguide_mesh_dirichlet::{
            validate_finite_air_dirichlet_bindings as validate,
            FiniteAirDirichletBindingsError as E,
        };
        let (problem, mesh, targets) = valid_fixture();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &targets).unwrap();
        assert!(matches!(validate(&registry, &[]), Err(E::EmptySelection)));
        assert!(matches!(
            validate(&registry, &[" ".into()]),
            Err(E::EmptyBoundaryId)
        ));
        assert!(matches!(
            validate(
                &registry,
                &["boundary-air-outer".into(), "boundary-air-outer".into()]
            ),
            Err(E::DuplicateBoundaryId(_))
        ));
        assert!(matches!(
            validate(&registry, &[" boundary-air-outer".into()]),
            Err(E::MissingBoundaryId(_))
        ));
        assert!(matches!(
            validate(&registry, &["unknown".into()]),
            Err(E::MissingBoundaryId(_))
        ));
        let magnetic = mesh
            .boundary_components
            .iter()
            .find(|b| b.region_id == "region-magnetic")
            .unwrap()
            .boundary_component_id
            .clone();
        assert!(matches!(
            validate(&registry, &[magnetic]),
            Err(E::NonAirBoundary(_))
        ));
        assert!(matches!(
            validate(&registry, &["boundary-air-hole".into()]),
            Err(E::AirHoleBoundary(_))
        ));
    }

    #[test]
    fn dirichlet_rejects_air_outer_contour_on_an_internal_interface() {
        use crate::waveguide_mesh_dirichlet::{
            validate_finite_air_dirichlet_bindings as validate,
            FiniteAirDirichletBindingsError as E,
        };
        let (mut problem, mut mesh, targets) = valid_fixture();
        problem.magnetization_modules.clear();
        let original = mesh.regions[0].clone();
        if let WaveguideCrossSectionRegionIR::Magnetic {
            region_id,
            object_id,
            ..
        } = original
        {
            mesh.regions[0] = WaveguideCrossSectionRegionIR::Air {
                region_id,
                object_id,
            };
        } else {
            panic!("fixture core must start magnetic");
        }
        let inner = mesh
            .boundary_components
            .iter()
            .find(|b| b.region_id == "region-magnetic")
            .unwrap()
            .boundary_component_id
            .clone();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &targets).unwrap();
        assert!(matches!(
            validate(&registry, &[inner]),
            Err(E::InterfaceBoundary { .. })
        ));
    }

    fn disconnected_dirichlet_fixture() -> (
        ProblemIRV04,
        WaveguideCrossSectionMeshIR,
        BTreeMap<String, RegionRefIR>,
    ) {
        let (mut problem, mut mesh, mut targets) = valid_fixture();
        let mut second = mesh.clone();
        let node_offset = mesh.nodes_uv_m.len() as u64;
        let triangle_offset = mesh.triangles.len() as u64;
        let min_x = mesh
            .nodes_uv_m
            .iter()
            .map(|p| p[0])
            .fold(f64::INFINITY, f64::min);
        let max_x = mesh
            .nodes_uv_m
            .iter()
            .map(|p| p[0])
            .fold(f64::NEG_INFINITY, f64::max);
        for node in &mut second.nodes_uv_m {
            node[0] += 2.0 * (max_x - min_x);
        }
        for triangle in &mut second.triangles {
            for node in &mut triangle.nodes {
                *node += node_offset;
            }
            triangle.region_id.push_str("-second");
        }
        for edge in &mut second.edges {
            for node in &mut edge.nodes {
                *node += node_offset;
            }
            for side in &mut edge.incidences {
                side.triangle_index += triangle_offset;
            }
        }
        for region in &mut second.regions {
            match region {
                WaveguideCrossSectionRegionIR::Magnetic {
                    region_id,
                    object_id,
                    ..
                }
                | WaveguideCrossSectionRegionIR::Air {
                    region_id,
                    object_id,
                } => {
                    region_id.push_str("-second");
                    object_id.push_str("-second");
                }
            }
        }
        for boundary in &mut second.boundary_components {
            boundary.boundary_component_id.push_str("-second");
            boundary.region_id.push_str("-second");
            for side in &mut boundary.half_edges {
                side.triangle_index += triangle_offset;
            }
        }
        for mut object in problem.objects.clone() {
            object.object_id.push_str("-second");
            object.name.push_str("-second");
            for id in &mut object.material_assignment_ids {
                id.push_str("-second");
            }
            problem.objects.push(object);
        }
        for mut region in problem.object_regions.clone() {
            region.region_id.push_str("-second");
            region.owner_object.push_str("-second");
            region.name.push_str("-second");
            problem.object_regions.push(region);
        }
        for mut assignment in problem.material_assignments.clone() {
            assignment.assignment_id.push_str("-second");
            assignment.target.object_id.push_str("-second");
            if let Some(id) = &mut assignment.target.region_id {
                id.push_str("-second");
            }
            problem.material_assignments.push(assignment);
        }
        for mut module in problem.magnetization_modules.clone() {
            module.module_id.push_str("-second");
            module.target.object_id.push_str("-second");
            if let Some(id) = &mut module.target.region_id {
                id.push_str("-second");
            }
            problem.magnetization_modules.push(module);
        }
        for (id, mut target) in targets.clone() {
            target.object_id.push_str("-second");
            if let Some(region) = &mut target.region_id {
                region.push_str("-second");
            }
            targets.insert(format!("{id}-second"), target);
        }
        mesh.nodes_uv_m.extend(second.nodes_uv_m);
        mesh.triangles.extend(second.triangles);
        mesh.edges.extend(second.edges);
        mesh.regions.extend(second.regions);
        mesh.boundary_components.extend(second.boundary_components);
        (problem, mesh, targets)
    }

    #[test]
    fn dirichlet_requires_selected_anchors_on_every_scalar_component() {
        use crate::waveguide_mesh_dirichlet::{
            validate_finite_air_dirichlet_bindings as validate,
            FiniteAirDirichletBindingsError as E,
        };
        let (problem, mesh, targets) = disconnected_dirichlet_fixture();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &targets).unwrap();
        assert!(matches!(
            validate(&registry, &["boundary-air-outer".into()]),
            Err(E::UnanchoredScalarComponent { component_index: 1 })
        ));
        let ids = vec![
            "boundary-air-outer".into(),
            "boundary-air-outer-second".into(),
        ];
        let forward = validate(&registry, &ids).unwrap();
        let mut reverse_ids = ids;
        reverse_ids.reverse();
        let reverse = validate(&registry, &reverse_ids).unwrap();
        assert_eq!(forward.selected_edge_counts_by_component(), &[12, 12]);
        assert_eq!(forward.essential_node_counts_by_component(), &[12, 12]);
        assert_eq!(
            forward.essential_node_indices(),
            reverse.essential_node_indices()
        );
        assert_eq!(
            forward.boundary_component_indices(),
            reverse.boundary_component_indices()
        );
    }
}

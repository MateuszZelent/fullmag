use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR, DomainFrameIR,
    EnergyTermIR, ExchangeBoundaryCondition, ExecutionPlanIR, ExecutionPrecision, FemEigenPlanIR,
    FemMagnetoelasticPlanIR, FemMechanicalModeIR, FemMechanicalPlanIR, FemPlanIR, GeometryEntryIR,
    MagnetostrictionLawIR, MechanicalLoadIR, OutputPlanIR, ProblemIR, ProvenancePlanIR,
    TimeDependenceIR, IR_VERSION,
};
use std::collections::BTreeMap;

use crate::current_transport::{
    has_antenna_field_source, resolve_current_transports, CurrentTransportExecutableLane,
};
use crate::error::PlanError;
use crate::mesh::{
    build_air_box_config, build_mesh_parts_from_segments, compatible_fem_material,
    initial_vectors_for_magnet, load_mesh_from_source, merge_fem_meshes, mesh_bounds,
    resolve_fem_domain_mesh_asset, resolved_domain_mesh_mode, study_universe_planner_note,
    MagnetPlanningEntry, AIR_OBJECT_SEGMENT_ID,
};
use crate::oersted::{resolve_fem_oersted_term, ResolvedOerstedTerm};
use crate::spin_torque::{resolve_legacy_spin_torque, SpinTorqueExecutableLane};
use crate::util::{problem_domain_frame, runtime_requests_cuda, shared_domain_mesh_requested, MU0};
use crate::validate::{
    planned_study_controls, validate_eigen_outputs, validate_executable_outputs,
};

const FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE: &str =
    "FEM demag requires a conformal shared-domain mesh with air and a Poisson airbox realization (Robin or Dirichlet).";
const CUBIC_AXIS_ORTHOGONALITY_DOT_TOL: f64 = 1e-3;
const CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM: f64 = 1e-6;
const CUBIC_AXIS_VALIDATION_ERROR: &str =
    "cubic anisotropy axes must be finite, normalized and mutually orthogonal";

fn requested_fem_demag_realization(problem: &ProblemIR) -> fullmag_ir::RequestedFemDemagIR {
    problem
        .energy_terms
        .iter()
        .find_map(|term| match term {
            EnergyTermIR::Demag { realization } => Some(realization.normalized()),
            _ => None,
        })
        .unwrap_or(fullmag_ir::RequestedFemDemagIR::Auto)
}

fn fem_single_precision_rejection(requested_cuda: bool, context: &str) -> String {
    if requested_cuda {
        format!(
            "execution_precision='single' is not executable in the {context} GPU path; single-precision CUDA kernels are not yet implemented"
        )
    } else {
        format!(
            "execution_precision='single' is not executable in the {context} CPU path; current FEM CPU execution supports only 'double'"
        )
    }
}

fn study_mechanics(problem: &ProblemIR) -> Option<&fullmag_ir::MechanicsIR> {
    match &problem.study {
        fullmag_ir::StudyIR::TimeEvolution { dynamics, .. }
        | fullmag_ir::StudyIR::Relaxation { dynamics, .. }
        | fullmag_ir::StudyIR::Eigenmodes { dynamics, .. }
        | fullmag_ir::StudyIR::FrequencyResponse { dynamics, .. } => match dynamics {
            fullmag_ir::DynamicsIR::Llg { mechanics, .. } => mechanics.as_ref(),
        },
    }
}

fn resolve_fem_magnetoelastic_plan(
    problem: &ProblemIR,
) -> Result<Option<(FemMagnetoelasticPlanIR, FemMechanicalPlanIR)>, PlanError> {
    let mut terms = problem.energy_terms.iter().filter_map(|term| {
        if let EnergyTermIR::Magnetoelastic { body, law, .. } = term {
            Some((body.as_str(), law.as_str()))
        } else {
            None
        }
    });
    let Some((body_name, law_name)) = terms.next() else {
        return Ok(None);
    };
    if terms.next().is_some() {
        return Err(PlanError {
            reasons: vec![
                "current native FEM prescribed-strain magnetoelastic path supports exactly one Magnetoelastic energy term"
                    .to_string(),
            ],
        });
    }

    match study_mechanics(problem) {
        Some(fullmag_ir::MechanicsIR::QuasistaticElasticity { .. }) => {
            return Err(PlanError {
                reasons: vec![
                    "FEM quasistatic magnetoelasticity is not executable yet; current native FEM supports only prescribed-strain magnetoelastic coupling"
                        .to_string(),
                ],
            });
        }
        Some(fullmag_ir::MechanicsIR::Elastodynamics { .. }) => {
            return Err(PlanError {
                reasons: vec![
                    "FEM elastodynamic magnetoelasticity is not executable yet; current native FEM supports only prescribed-strain magnetoelastic coupling"
                        .to_string(),
                ],
            });
        }
        Some(fullmag_ir::MechanicsIR::PrescribedStrain) | None => {}
    }

    let prescribed_strain = problem.mechanical_loads.iter().find_map(|load| {
        if let MechanicalLoadIR::PrescribedStrain { strain } = load {
            Some(*strain)
        } else {
            None
        }
    });
    let Some(prescribed_strain) = prescribed_strain else {
        return Err(PlanError {
            reasons: vec![
                "current native FEM magnetoelastic execution requires MechanicalLoadIR::PrescribedStrain; quasistatic/dynamic mechanics are not executable yet"
                    .to_string(),
            ],
        });
    };

    let Some(body) = problem
        .elastic_bodies
        .iter()
        .find(|candidate| candidate.name == body_name)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic references unknown elastic body '{body_name}'"
            )],
        });
    };
    let Some(elastic_material) = problem
        .elastic_materials
        .iter()
        .find(|candidate| candidate.name == body.elastic_material)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic elastic body '{}' references unknown elastic material '{}'",
                body.name, body.elastic_material
            )],
        });
    };
    let Some(law_ir) = problem
        .magnetostriction_laws
        .iter()
        .find(|law| law.name() == law_name)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic references unknown magnetostriction law '{law_name}'"
            )],
        });
    };
    let (b1, b2) = match &law_ir {
        MagnetostrictionLawIR::Cubic { b1, b2, .. } => (*b1, *b2),
        MagnetostrictionLawIR::Isotropic { lambda_s, .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "isotropic magnetostriction (lambda_s={lambda_s}) is not executable for FEM without a physically justified B1/B2 mapping; refusing lossy fallback"
                )],
            });
        }
    };
    Ok(Some((
        FemMagnetoelasticPlanIR {
            b1,
            b2,
            prescribed_strain: Some(prescribed_strain),
        },
        FemMechanicalPlanIR {
            mode: FemMechanicalModeIR::PrescribedStrain,
            body,
            elastic_material,
            magnetostriction_law: law_ir,
            boundary_conditions: problem.mechanical_bcs.clone(),
            loads: problem.mechanical_loads.clone(),
            same_mesh_only: true,
            max_picard_iterations: None,
            picard_tolerance: None,
            mechanical_dt: None,
        },
    )))
}

fn geometry_to_object_id_map(
    magnet_entries: &[crate::mesh::MagnetPlanningEntry],
) -> BTreeMap<&str, &str> {
    magnet_entries
        .iter()
        .map(|entry| (entry.geometry_name.as_str(), entry.magnet_name.as_str()))
        .collect()
}

fn plan_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn remap_segment_object_ids(
    segments: &[fullmag_ir::FemObjectSegmentIR],
    geometry_to_object_id: &BTreeMap<&str, &str>,
) -> Result<Vec<fullmag_ir::FemObjectSegmentIR>, PlanError> {
    segments
        .iter()
        .map(|segment| {
            if segment.object_id == AIR_OBJECT_SEGMENT_ID {
                return Ok(segment.clone());
            }
            let seg_id = segment.object_id.as_str();
            let mut mapped_object_id = geometry_to_object_id.get(seg_id).copied();
            if mapped_object_id.is_none() && seg_id.ends_with("_geom") {
                mapped_object_id = geometry_to_object_id.get(&seg_id[..seg_id.len() - 5]).copied();
            }
            let Some(mapped_object_id) = mapped_object_id
            else {
                return Err(PlanError {
                    reasons: vec![format!(
                        "FEM object segment '{}' does not map to any magnet/object id",
                        segment.object_id
                    )],
                });
            };
            Ok(fullmag_ir::FemObjectSegmentIR {
                object_id: mapped_object_id.to_string(),
                geometry_id: segment
                    .geometry_id
                    .clone()
                    .or_else(|| Some(segment.object_id.clone())),
                node_start: segment.node_start,
                node_count: segment.node_count,
                element_start: segment.element_start,
                element_count: segment.element_count,
                boundary_face_start: segment.boundary_face_start,
                boundary_face_count: segment.boundary_face_count,
            })
        })
        .collect()
}

fn segment_node_indices_from_parts(
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Option<Vec<usize>> {
    mesh_parts
        .iter()
        .find(|part| {
            part.role == fullmag_ir::FemMeshPartRole::MagneticObject
                && (part.object_id.as_deref().map(|id| plan_object_ids_match(id, segment.object_id.as_str())).unwrap_or(false)
                    || part.geometry_id.as_deref().map(|id| segment.geometry_id.as_deref().map(|g_id| plan_object_ids_match(id, g_id)).unwrap_or(false)).unwrap_or(false))
                && !part.node_indices.is_empty()
        })
        .map(|part| {
            part.node_indices
                .iter()
                .map(|index| *index as usize)
                .collect()
        })
}

fn segment_node_indices(
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
    total_nodes: usize,
) -> Result<Vec<usize>, PlanError> {
    if let Some(indices) = segment_node_indices_from_parts(mesh_parts, segment) {
        if let Some(index) = indices.iter().copied().find(|index| *index >= total_nodes) {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM object segment '{}' references node index {} outside mesh node count {}",
                    segment.object_id, index, total_nodes
                )],
            });
        }
        return Ok(indices);
    }

    let start = segment.node_start as usize;
    let end = start.saturating_add(segment.node_count as usize);
    if end > total_nodes {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM object segment '{}' node range {}..{} exceeds mesh node count {}",
                segment.object_id, start, end, total_nodes
            )],
        });
    }
    Ok((start..end).collect())
}

pub(crate) fn assign_domain_initial_for_segment(
    target: &mut [[f64; 3]],
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
    entry: &MagnetPlanningEntry,
) -> Result<(), PlanError> {
    let node_indices = segment_node_indices(mesh_parts, segment, mesh.nodes.len())?;
    if let Some(fullmag_ir::InitialMagnetizationIR::SampledField { values }) =
        entry.initial_magnetization.as_ref()
    {
        if values.len() == mesh.nodes.len() {
            for node_index in node_indices {
                target[node_index] = values[node_index];
            }
            return Ok(());
        }
    }

    let sample_points = node_indices
        .iter()
        .map(|index| mesh.nodes[*index])
        .collect::<Vec<_>>();
    let values = initial_vectors_for_magnet(
        &entry.magnet_name,
        &mesh.mesh_name,
        entry.initial_magnetization.as_ref(),
        sample_points.len(),
        Some(&sample_points),
        Some(&sample_points),
    )
    .map_err(|message| PlanError {
        reasons: vec![message],
    })?;
    for (node_index, value) in node_indices.into_iter().zip(values.into_iter()) {
        target[node_index] = value;
    }
    Ok(())
}

fn assign_material_ids_to_mesh_parts(
    mesh_parts: &mut [fullmag_ir::FemMeshPartIR],
    magnet_entries: &[MagnetPlanningEntry],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) {
    let geometry_to_magnet = magnet_entries
        .iter()
        .map(|entry| (entry.geometry_name.as_str(), entry.magnet_name.as_str()))
        .collect::<BTreeMap<_, _>>();

    for part in mesh_parts {
        let Some(candidate_object_id) = part.object_id.as_deref() else {
            continue;
        };
        let matches_object = magnet_entries
            .iter()
            .any(|entry| plan_object_ids_match(&entry.magnet_name, candidate_object_id));
        let matches_geometry = part
            .geometry_id
            .as_deref()
            .and_then(|geometry_id| {
                geometry_to_magnet.get(geometry_id)
                    .copied()
                    .or_else(|| {
                        let clean_geo = geometry_id.strip_suffix("_geom").unwrap_or(geometry_id);
                        geometry_to_magnet.get(clean_geo).copied()
                    })
            })
            .is_some();
        if matches_object || matches_geometry {
            let material_name = magnet_materials
                .get(candidate_object_id)
                .or_else(|| {
                    let clean_candidate = candidate_object_id.strip_suffix("_geom").unwrap_or(candidate_object_id);
                    magnet_materials.get(clean_candidate)
                })
                .map(|material| material.name.clone())
                .or_else(|| {
                    part.geometry_id
                        .as_deref()
                        .and_then(|geometry_id| {
                            geometry_to_magnet.get(geometry_id)
                                .copied()
                                .or_else(|| {
                                    let clean_geo = geometry_id.strip_suffix("_geom").unwrap_or(geometry_id);
                                    geometry_to_magnet.get(clean_geo).copied()
                                })
                        })
                        .and_then(|magnet_name| magnet_materials.get(magnet_name))
                        .map(|material| material.name.clone())
                });
            part.material_id = material_name;
        }
    }
}

fn heterogeneous_fem_material_shape_supported(
    reference: &fullmag_ir::MaterialIR,
    candidate: &fullmag_ir::MaterialIR,
) -> bool {
    reference.anisotropy_axis == candidate.anisotropy_axis
        && reference.cubic_anisotropy_axis1 == candidate.cubic_anisotropy_axis1
        && reference.cubic_anisotropy_axis2 == candidate.cubic_anisotropy_axis2
}

fn segment_element_marker(
    mesh: &fullmag_ir::MeshIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> u32 {
    if segment.element_count == 0 {
        return 0;
    }
    mesh.element_markers
        .get(segment.element_start as usize)
        .copied()
        .unwrap_or(0)
}

fn build_region_materials(
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) -> Vec<fullmag_ir::FemRegionMaterialIR> {
    object_segments
        .iter()
        .filter(|segment| segment.object_id != AIR_OBJECT_SEGMENT_ID)
        .filter_map(|segment| {
            magnet_materials.get(&segment.object_id).map(|material| {
                fullmag_ir::FemRegionMaterialIR {
                    object_id: segment.object_id.clone(),
                    material: material.clone(),
                    element_marker: segment_element_marker(mesh, segment),
                }
            })
        })
        .collect()
}

fn values_differ(values: &[f64], reference: f64) -> bool {
    values
        .iter()
        .any(|value| (*value - reference).abs() > 1e-18)
}

fn has_cubic_anisotropy(material: &fullmag_ir::MaterialIR) -> bool {
    material.cubic_anisotropy_kc1.is_some()
        || material.cubic_anisotropy_kc2.is_some()
        || material.cubic_anisotropy_kc3.is_some()
        || material.kc1_field.is_some()
        || material.kc2_field.is_some()
        || material.kc3_field.is_some()
}

fn validate_cubic_anisotropy_axes(material: &fullmag_ir::MaterialIR) -> Option<String> {
    if !has_cubic_anisotropy(material) {
        return None;
    }

    let axis1 = material.cubic_anisotropy_axis1.unwrap_or([1.0, 0.0, 0.0]);
    let axis2 = material.cubic_anisotropy_axis2.unwrap_or([0.0, 1.0, 0.0]);
    if !axis1.iter().all(|component| component.is_finite())
        || !axis2.iter().all(|component| component.is_finite())
    {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    let norm1 = (axis1[0] * axis1[0] + axis1[1] * axis1[1] + axis1[2] * axis1[2]).sqrt();
    let norm2 = (axis2[0] * axis2[0] + axis2[1] * axis2[1] + axis2[2] * axis2[2]).sqrt();
    if !(norm1 > 1e-30 && norm1.is_finite() && norm2 > 1e-30 && norm2.is_finite()) {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    let c1 = [axis1[0] / norm1, axis1[1] / norm1, axis1[2] / norm1];
    let c2 = [axis2[0] / norm2, axis2[1] / norm2, axis2[2] / norm2];
    let dot = c1[0] * c2[0] + c1[1] * c2[1] + c1[2] * c2[2];
    let cross = [
        c1[1] * c2[2] - c1[2] * c2[1],
        c1[2] * c2[0] - c1[0] * c2[2],
        c1[0] * c2[1] - c1[1] * c2[0],
    ];
    let cross_norm = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    if !dot.is_finite()
        || !cross_norm.is_finite()
        || dot.abs() > CUBIC_AXIS_ORTHOGONALITY_DOT_TOL
        || cross_norm < CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM
    {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    None
}

fn normalize_nonzero_vector3(value: [f64; 3], field_name: &str) -> Result<[f64; 3], String> {
    if value.iter().any(|component| !component.is_finite()) {
        return Err(format!("{field_name} must contain finite values"));
    }
    let norm_sq = value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
    if norm_sq <= 1e-30 {
        return Err(format!("{field_name} must be non-zero"));
    }
    let inv_norm = norm_sq.sqrt().recip();
    Ok([
        value[0] * inv_norm,
        value[1] * inv_norm,
        value[2] * inv_norm,
    ])
}

fn resolve_interfacial_dmi_normal(
    requested_normal: Option<[f64; 3]>,
) -> Result<Option<[f64; 3]>, String> {
    let Some(raw_normal) = requested_normal else {
        return Ok(Some([0.0, 0.0, 1.0]));
    };
    normalize_nonzero_vector3(raw_normal, "InterfacialDmi.interface_normal").map(Some)
}

fn build_region_material_fields(
    base_material: &fullmag_ir::MaterialIR,
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) -> fullmag_ir::MaterialIR {
    let node_count = mesh.nodes.len();
    if node_count == 0 {
        return base_material.clone();
    }

    let mut material = base_material.clone();
    let mut ms_values = vec![base_material.saturation_magnetisation; node_count];
    let mut a_values = vec![base_material.exchange_stiffness; node_count];
    let mut alpha_values = vec![base_material.damping; node_count];
    let mut ku_values = vec![base_material.uniaxial_anisotropy.unwrap_or(0.0); node_count];
    let mut ku2_values = vec![base_material.uniaxial_anisotropy_k2.unwrap_or(0.0); node_count];
    let mut kc1_values = vec![base_material.cubic_anisotropy_kc1.unwrap_or(0.0); node_count];
    let mut kc2_values = vec![base_material.cubic_anisotropy_kc2.unwrap_or(0.0); node_count];
    let mut kc3_values = vec![base_material.cubic_anisotropy_kc3.unwrap_or(0.0); node_count];
    let mut dind_values = vec![base_material.interfacial_dmi.unwrap_or(0.0); node_count];
    let mut dbulk_values = vec![base_material.bulk_dmi.unwrap_or(0.0); node_count];

    for segment in object_segments {
        if segment.object_id == AIR_OBJECT_SEGMENT_ID {
            continue;
        }
        let Some(region_material) = magnet_materials.get(&segment.object_id) else {
            continue;
        };
        let start = segment.node_start as usize;
        let end = start
            .saturating_add(segment.node_count as usize)
            .min(node_count);
        for index in start..end {
            ms_values[index] = region_material.saturation_magnetisation;
            a_values[index] = region_material.exchange_stiffness;
            alpha_values[index] = region_material.damping;
            ku_values[index] = region_material.uniaxial_anisotropy.unwrap_or(0.0);
            ku2_values[index] = region_material.uniaxial_anisotropy_k2.unwrap_or(0.0);
            kc1_values[index] = region_material.cubic_anisotropy_kc1.unwrap_or(0.0);
            kc2_values[index] = region_material.cubic_anisotropy_kc2.unwrap_or(0.0);
            kc3_values[index] = region_material.cubic_anisotropy_kc3.unwrap_or(0.0);
            dind_values[index] = region_material.interfacial_dmi.unwrap_or(0.0);
            dbulk_values[index] = region_material.bulk_dmi.unwrap_or(0.0);
        }
    }

    material.ms_field =
        values_differ(&ms_values, base_material.saturation_magnetisation).then_some(ms_values);
    material.a_field =
        values_differ(&a_values, base_material.exchange_stiffness).then_some(a_values);
    material.alpha_field =
        values_differ(&alpha_values, base_material.damping).then_some(alpha_values);
    material.ku_field = values_differ(&ku_values, base_material.uniaxial_anisotropy.unwrap_or(0.0))
        .then_some(ku_values);
    material.ku2_field = values_differ(
        &ku2_values,
        base_material.uniaxial_anisotropy_k2.unwrap_or(0.0),
    )
    .then_some(ku2_values);
    material.kc1_field = values_differ(
        &kc1_values,
        base_material.cubic_anisotropy_kc1.unwrap_or(0.0),
    )
    .then_some(kc1_values);
    material.kc2_field = values_differ(
        &kc2_values,
        base_material.cubic_anisotropy_kc2.unwrap_or(0.0),
    )
    .then_some(kc2_values);
    material.kc3_field = values_differ(
        &kc3_values,
        base_material.cubic_anisotropy_kc3.unwrap_or(0.0),
    )
    .then_some(kc3_values);
    material.dind_field = values_differ(&dind_values, base_material.interfacial_dmi.unwrap_or(0.0))
        .then_some(dind_values);
    material.dbulk_field =
        values_differ(&dbulk_values, base_material.bulk_dmi.unwrap_or(0.0)).then_some(dbulk_values);
    material
}

pub(crate) fn plan_fem(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            errors.push(
                "FEM discretization hints (order + hmax) are required for backend='fem'"
                    .to_string(),
            );
            if !errors.is_empty() {
                return Err(PlanError { reasons: errors });
            }
            unreachable!();
        }
    };

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let resolved_domain_mesh_asset =
        resolve_fem_domain_mesh_asset(problem, runtime_requests_cuda(problem)).map_err(
            |message| PlanError {
                reasons: vec![message],
            },
        )?;
    let requested_demag_realization = requested_fem_demag_realization(problem);
    // Commit 4: fail early when study_universe requires a shared domain mesh
    // but no fem_domain_mesh_asset was provided.
    if resolved_domain_mesh_asset.is_none()
        && shared_domain_mesh_requested(problem, requested_demag_realization)
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM mesh (fem_domain_mesh_asset) was not provided. \
                     Call study.build_domain_mesh() or study.domain_mesh(...) before solving.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    if resolved_domain_mesh_asset.is_none()
        && problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, EnergyTermIR::Demag { .. }))
        && requested_demag_realization.requires_airbox()
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Missing shared-domain FEM mesh with air.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut merged_initial_magnetization = Vec::new();
    let mut mesh_parts = Vec::with_capacity(problem.magnets.len());
    let mut mesh_sources = Vec::with_capacity(problem.magnets.len());
    let mut selected_material: Option<fullmag_ir::MaterialIR> = None;
    let mut has_heterogeneous_materials = false;
    let mut magnet_materials = BTreeMap::<String, fullmag_ir::MaterialIR>::new();
    let mut magnet_entries = Vec::with_capacity(problem.magnets.len());

    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(_geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };
        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
            .cloned()
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };
        if let Some(reason) = validate_cubic_anisotropy_axes(&material) {
            errors.push(reason);
        }
        if let Some(reference_material) = selected_material.as_ref() {
            if !compatible_fem_material(reference_material, &material) {
                if !heterogeneous_fem_material_shape_supported(reference_material, &material) {
                    errors.push(format!(
                        "current multi-body FEM baseline requires shared anisotropy axes/material-law shape across magnets; '{}' is incompatible with '{}'",
                        magnet.name,
                        problem.magnets[0].name
                    ));
                } else {
                    has_heterogeneous_materials = true;
                }
            }
        } else {
            selected_material = Some(material.clone());
        }
        magnet_materials.insert(magnet.name.clone(), material.clone());

        magnet_entries.push(MagnetPlanningEntry {
            magnet_name: magnet.name.clone(),
            geometry_name: geometry_name.to_string(),
            initial_magnetization: magnet.initial_magnetization.clone(),
        });

        if resolved_domain_mesh_asset.is_some() {
            continue;
        }

        let mesh_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .fem_mesh_assets
                    .iter()
                    .find(|asset| asset.geometry_name == geometry_name)
            })
            .cloned();

        let mesh_asset = match mesh_asset {
            Some(asset) => asset,
            None => {
                errors.push(format!(
                    "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                    geometry_name
                ));
                continue;
            }
        };

        let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
            (Some(mesh), _) => mesh.clone(),
            (None, Some(source)) => match load_mesh_from_source(source) {
                Ok(mesh) => mesh,
                Err(message) => {
                    errors.push(message);
                    continue;
                }
            },
            (None, None) => {
                errors.push(format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry_name
                ));
                continue;
            }
        };

        match initial_vectors_for_magnet(
            &magnet.name,
            &mesh.mesh_name,
            magnet.initial_magnetization.as_ref(),
            mesh.nodes.len(),
            Some(&mesh.nodes),
            Some(&mesh.nodes),
        ) {
            Ok(initial_magnetization) => merged_initial_magnetization.extend(initial_magnetization),
            Err(message) => errors.push(message),
        }
        mesh_parts.push((geometry_name.to_string(), mesh));
        mesh_sources.push(mesh_asset.mesh_source);
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut demag_realization = fullmag_ir::RequestedFemDemagIR::Auto;
    let mut interfacial_dmi: Option<f64> = None;
    let mut interfacial_dmi_normal: Option<[f64; 3]> = None;
    let mut bulk_dmi: Option<f64> = None;
    let mut has_magnetoelastic = false;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { realization } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
                demag_realization = *realization;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                interfacial_dmi = Some(*d);
                interfacial_dmi_normal = *interface_normal;
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
            | fullmag_ir::EnergyTermIR::OerstedField { .. } => {
                // Oersted field: extracted separately below.
            }
            fullmag_ir::EnergyTermIR::Magnetoelastic { .. } => {
                if has_magnetoelastic {
                    errors.push("Magnetoelastic is declared more than once".to_string());
                }
                has_magnetoelastic = true;
            }
        }
    }
    if interfacial_dmi.is_some() {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => errors.push(reason),
        }
    } else {
        interfacial_dmi_normal = None;
    }
    let has_material_interfacial_dmi = problem.materials.iter().any(|material| {
        material.interfacial_dmi.is_some()
            || material
                .dind_field
                .as_ref()
                .is_some_and(|values: &Vec<f64>| !values.is_empty())
    });
    let has_material_bulk_dmi = problem.materials.iter().any(|material| {
        material.bulk_dmi.is_some()
            || material
                .dbulk_field
                .as_ref()
                .is_some_and(|values: &Vec<f64>| !values.is_empty())
    });
    if !(enable_exchange
        || enable_demag
        || external_field.is_some()
        || interfacial_dmi.is_some()
        || bulk_dmi.is_some()
        || has_material_interfacial_dmi
        || has_material_bulk_dmi
        || has_magnetoelastic)
    {
        errors.push(
            "the current FEM planning baseline requires at least one of Exchange, Demag, Zeeman, InterfacialDmi, BulkDmi, or Magnetoelastic"
                .to_string(),
        );
    }

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
                    | fullmag_ir::EnergyTermIR::OerstedField { .. }
            )
        }),
        interfacial_dmi.is_some() || has_material_interfacial_dmi,
        bulk_dmi.is_some() || has_material_bulk_dmi,
        true,
        has_magnetoelastic,
        has_antenna_field_source(problem),
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(fem_single_precision_rejection(
            runtime_requests_cuda(problem),
            "native FEM time-domain",
        ));
    }

    let (
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
        field_refresh,
    ) = planned_study_controls(problem, &mut errors);

    let requested_static_pbc = problem
        .pbc
        .as_ref()
        .is_some_and(|pbc| pbc.has_any_periodic());

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let (magnetoelastic, mechanics) = resolve_fem_magnetoelastic_plan(problem)?
        .map(|(magnetoelastic, mechanics)| (Some(magnetoelastic), Some(mechanics)))
        .unwrap_or((None, None));
    let current_transports =
        resolve_current_transports(problem, CurrentTransportExecutableLane::Fem)?;
    let spin_torque =
        resolve_legacy_spin_torque(problem, SpinTorqueExecutableLane::Fem, &current_transports)?;

    if has_heterogeneous_materials && !runtime_requests_cuda(problem) {
        return Err(PlanError {
            reasons: vec![
                "heterogeneous multi-body FEM materials currently require the native GPU FEM path; request a CUDA runtime or keep identical material coefficients on CPU".to_string(),
            ],
        });
    }

    let base_material =
        selected_material.expect("validation should have caught missing FEM material");
    let geometry_to_object_id = geometry_to_object_id_map(&magnet_entries);
    let (mesh, raw_object_segments, mesh_source, initial_magnetization) =
        if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
            let mut initial = vec![[0.0, 0.0, 0.0]; domain_asset.mesh.nodes.len()];
            for entry in &magnet_entries {
                let Some(segment) = domain_asset
                    .object_segments
                    .iter()
                    .find(|segment| plan_object_ids_match(&segment.object_id, &entry.geometry_name))
                else {
                    return Err(PlanError {
                        reasons: vec![format!(
                            "shared-domain FEM mesh asset is missing a segment for geometry '{}'",
                            entry.geometry_name
                        )],
                    });
                };
                assign_domain_initial_for_segment(
                    &mut initial,
                    &domain_asset.mesh,
                    &domain_asset.mesh_parts,
                    segment,
                    entry,
                )?;
            }
            (
                domain_asset.mesh.clone(),
                domain_asset.object_segments.clone(),
                domain_asset.mesh_source.clone(),
                initial,
            )
        } else {
            let (mesh, object_segments) =
                merge_fem_meshes(&mesh_parts).map_err(|message| PlanError {
                    reasons: vec![message],
                })?;
            let mesh_source = if mesh_parts.len() == 1 {
                mesh_sources.first().cloned().flatten()
            } else {
                None
            };
            (
                mesh,
                object_segments,
                mesh_source,
                merged_initial_magnetization,
            )
        };
    let object_segments = remap_segment_object_ids(&raw_object_segments, &geometry_to_object_id)?;
    let n_nodes = mesh.nodes.len();
    let n_elements = mesh.elements.len();
    let mesh_name = mesh.mesh_name.clone();
    let domain_mesh_mode = resolved_domain_mesh_mode(&mesh);
    if requested_static_pbc && mesh.periodic_node_pairs.is_empty() {
        return Err(PlanError {
            reasons: vec![
                "FEM static/time-domain PBC requires mesh.periodic_node_pairs metadata; provide a \
                 periodic FEM mesh or use the FEM eigen solver with spin_wave_bc='periodic'/'floquet'."
                    .to_string(),
            ],
        });
    }
    if !mesh.periodic_node_pairs.is_empty() && enable_demag {
        if mesh.periodic_boundary_pairs.is_empty() {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM demag PBC requires mesh.periodic_boundary_pairs metadata (needed to \
                     identify open vs periodic seam faces for Robin boundary assembly); mesh '{}' \
                     has {} periodic_node_pairs but no periodic_boundary_pairs. Regenerate the \
                     mesh with periodic boundary pair metadata.",
                    mesh_name,
                    mesh.periodic_node_pairs.len()
                )],
            });
        }
        // Demag PBC with open boundary: allowed (P^T A P reduction via Rust reference path).
        // Fully 3D periodic demag is not supported in v1.
    }
    if shared_domain_mesh_requested(problem, demag_realization)
        && domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM was requested, but the resolved final FEM mesh has no air region. Materialize a conformal domain mesh with air via study.build_domain_mesh() / study.domain_mesh(...).",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut resolved_mesh_parts = if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
        let mut parts = domain_asset.mesh_parts.clone();
        // Remap geometry-name object_ids to magnet/object-name object_ids so that
        // the frontend can match them against the selected object id (e.g. "nanoflower_left"
        // instead of "nanoflower_left_geom").
        for part in &mut parts {
            if let Some(ref geo_id) = part.object_id.clone() {
                let mut mapped = geometry_to_object_id.get(geo_id.as_str()).copied();
                if mapped.is_none() && geo_id.ends_with("_geom") {
                    mapped = geometry_to_object_id.get(&geo_id[..geo_id.len() - 5]).copied();
                }
                if let Some(mapped) = mapped {
                    part.object_id = Some(mapped.to_string());
                }
            }
        }
        parts
    } else {
        build_mesh_parts_from_segments(&mesh, &object_segments, domain_mesh_mode)
    };
    assign_material_ids_to_mesh_parts(&mut resolved_mesh_parts, &magnet_entries, &magnet_materials);
    // Populate region_materials whenever multiple magnetic bodies are present (not only for
    // heterogeneous materials), because the runner uses region_materials to resolve which
    // element markers are magnetic vs. air when multiple non-zero markers exist.
    let needs_region_materials = has_heterogeneous_materials || magnet_entries.len() > 1;
    let region_materials = if needs_region_materials {
        build_region_materials(&mesh, &object_segments, &magnet_materials)
    } else {
        Vec::new()
    };
    let material = if has_heterogeneous_materials {
        build_region_material_fields(&base_material, &mesh, &object_segments, &magnet_materials)
    } else {
        base_material.clone()
    };
    if interfacial_dmi.is_none() {
        interfacial_dmi = material.interfacial_dmi;
    }
    if bulk_dmi.is_none() {
        bulk_dmi = material.bulk_dmi;
    }
    if interfacial_dmi.is_some()
        || material
            .dind_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
    {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => {
                return Err(PlanError {
                    reasons: vec![reason],
                })
            }
        }
    }
    let domain_frame = problem_domain_frame(problem)
        .map(|frame| frame.with_mesh_bounds(mesh_bounds(&mesh)))
        .and_then(DomainFrameIR::finalized);

    // S07: Auto-resolve demag realization.
    // Phase-1A: normalize legacy variants and reject unimplemented models.
    let demag_realization = demag_realization.normalized();
    if !demag_realization.is_implemented() {
        return Err(PlanError {
            reasons: vec![format!(
                "Demag model '{}' is not yet implemented. Currently supported: airbox and fredkin_koehler.",
                demag_realization.model_name(),
            )],
        });
    }

    let resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR> = if enable_demag {
        let has_air_elements = mesh.element_markers.iter().any(|&m| m == 0);
        if demag_realization.requires_airbox() && !has_air_elements {
            return Err(PlanError {
                reasons: vec![format!(
                    "{} The resolved FEM mesh has no air elements.",
                    FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
                )],
            });
        }
        Some(match demag_realization {
            fullmag_ir::RequestedFemDemagIR::PoissonDirichlet => {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet
            }
            fullmag_ir::RequestedFemDemagIR::PoissonRobin => {
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin
            }
            fullmag_ir::RequestedFemDemagIR::Auto => fullmag_ir::ResolvedFemDemagIR::PoissonRobin,
            // Unimplemented models are already rejected above.
            fullmag_ir::RequestedFemDemagIR::Bem => fullmag_ir::ResolvedFemDemagIR::Bem,
            fullmag_ir::RequestedFemDemagIR::FredkinKoehler => {
                fullmag_ir::ResolvedFemDemagIR::FredkinKoehler
            }
            fullmag_ir::RequestedFemDemagIR::Fmm => fullmag_ir::ResolvedFemDemagIR::Fmm,
        })
    } else {
        None
    };
    let air_box_config =
        build_air_box_config(problem, &mesh, resolved_demag_realization).map_err(|reason| {
            PlanError {
                reasons: vec![reason],
            }
        })?;
    let universe_note = study_universe_planner_note(
        problem,
        &mesh,
        resolved_demag_realization,
        air_box_config.as_ref(),
    );

    // Phase-0C: enforce P1-only constraint.
    // The native FEM backend currently supports only first-order (P1) H1
    // finite elements (it asserts GetNDofs() == n_nodes).  Reject higher
    // orders at the planner level with a clear error.
    if fem_hints.order != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM backend currently supports only first-order (P1) elements \
                 (fe_order = 1). Requested fe_order = {}. Higher-order support is \
                 planned but not yet implemented.",
                fem_hints.order,
            )],
        });
    }

    let dind_field = material.dind_field.clone();
    let dbulk_field = material.dbulk_field.clone();

    let mut fem_plan = FemPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source,
        mesh,
        object_segments,
        mesh_parts: resolved_mesh_parts,
        domain_mesh_mode,
        domain_frame,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        initial_magnetization,
        material,
        region_materials,
        enable_exchange,
        enable_demag,
        external_field,
        current_modules: problem.current_modules.clone(),
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
        adaptive_timestep,
        field_refresh,
        relaxation,
        demag_realization: resolved_demag_realization,
        air_box_config,
        interfacial_dmi,
        dmi_interface_normal: interfacial_dmi_normal,
        bulk_dmi,
        dind_field,
        dbulk_field,
        temperature: problem.temperature,
        current_density: spin_torque.current_density,
        stt_degree: spin_torque.stt_degree,
        stt_beta: spin_torque.stt_beta,
        stt_spin_polarization: spin_torque.stt_spin_polarization,
        stt_lambda: spin_torque.stt_lambda,
        stt_epsilon_prime: spin_torque.stt_epsilon_prime,
        stt_thickness: spin_torque.stt_thickness,
        stt_fixed_layer_position: spin_torque.stt_fixed_layer_position.clone(),
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        magnetoelastic,
        mechanics,
        demag_solver_policy: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|hints| hints.fem.as_ref())
            .and_then(|fem| fem.demag_solver_policy.clone()),
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        use_consistent_mass: None,
    };

    // ── Extract Oersted realizations from energy terms ──
    for (term_index, term) in problem.energy_terms.iter().enumerate() {
        if let Some(oersted) = resolve_fem_oersted_term(
            problem,
            term_index,
            term,
            &current_transports,
            &fem_plan.mesh,
            &fem_plan.object_segments,
            &fem_plan.mesh_parts,
        )? {
            match oersted {
                ResolvedOerstedTerm::Cylinder(oersted) => {
                    fem_plan.has_oersted_cylinder = true;
                    fem_plan.oersted_current = Some(oersted.current);
                    fem_plan.oersted_radius = Some(oersted.radius);
                    fem_plan.oersted_center = Some(oersted.center);
                    fem_plan.oersted_axis = Some(oersted.axis);
                    fem_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::InfiniteCylinder);
                    if let Some(td) = &oersted.time_dependence {
                        match td {
                            TimeDependenceIR::Constant => {
                                fem_plan.oersted_time_dep_kind = 0;
                            }
                            TimeDependenceIR::Sinusoidal {
                                frequency_hz,
                                phase_rad,
                                offset,
                            } => {
                                fem_plan.oersted_time_dep_kind = 1;
                                fem_plan.oersted_time_dep_freq = *frequency_hz;
                                fem_plan.oersted_time_dep_phase = *phase_rad;
                                fem_plan.oersted_time_dep_offset = *offset;
                            }
                            TimeDependenceIR::Pulse { t_on, t_off } => {
                                fem_plan.oersted_time_dep_kind = 2;
                                fem_plan.oersted_time_dep_t_on = *t_on;
                                fem_plan.oersted_time_dep_t_off = *t_off;
                            }
                            TimeDependenceIR::PiecewiseLinear { .. } => {
                                return Err(PlanError {
                                    reasons: vec![
                                        "Oersted time dependence 'PiecewiseLinear' is not yet supported \
                                         by the FEM backend; use 'Constant', 'Sinusoidal', or 'Pulse' instead"
                                            .to_string(),
                                    ],
                                });
                            }
                        }
                    }
                }
                ResolvedOerstedTerm::Field(field) => {
                    fem_plan.oersted_field_xyz = Some(field.field_xyz);
                    fem_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
                }
            }
            break;
        }
    }

    let study_note = if let Some(control) = fem_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };
    let mut provenance_notes = vec![
        if resolved_domain_mesh_asset.is_some() {
            "Bootstrap FEM planner using study-level shared-domain mesh asset".to_string()
        } else if mesh_parts.len() == 1 {
            "Bootstrap FEM planner with precomputed MeshIR asset".to_string()
        } else {
            format!(
                "Bootstrap multi-body FEM planner merged {} disjoint mesh assets into one FEM plan",
                mesh_parts.len()
            )
        },
        format!("mesh asset: {mesh_name} ({n_nodes} nodes, {n_elements} elements)"),
        format!(
            "active terms: exchange={}, demag={}, zeeman={}",
            enable_exchange,
            enable_demag,
            external_field.is_some()
        ),
        study_note,
        "Executable time-domain FEM requires the native MFEM/libCEED/hypre backend; the Rust FEM baseline remains internal-only for preview and validation helpers"
            .to_string(),
    ];
    if let Some(note) = universe_note {
        provenance_notes.push(note);
    }

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
        },
        backend_plan: BackendPlanIR::Fem(fem_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: provenance_notes,
        },
    })
}

pub(crate) fn plan_fem_eigen(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            return Err(PlanError {
                reasons: vec![
                    "FEM discretization hints (order + hmax) are required for backend='fem'"
                        .to_string(),
                ],
            });
        }
    };

    let fullmag_ir::StudyIR::Eigenmodes {
        dynamics,
        operator,
        count,
        target,
        equilibrium,
        k_sampling,
        normalization,
        damping_policy,
        spin_wave_bc,
        mode_tracking,
        ..
    } = &problem.study
    else {
        unreachable!("plan_fem_eigen is only called for StudyIR::Eigenmodes");
    };

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let resolved_domain_mesh_asset =
        resolve_fem_domain_mesh_asset(problem, false).map_err(|message| PlanError {
            reasons: vec![message],
        })?;
    let requested_demag_realization = requested_fem_demag_realization(problem);
    // Commit 4: fail early when study_universe requires a shared domain mesh
    // but no fem_domain_mesh_asset was provided (eigen path).
    if resolved_domain_mesh_asset.is_none()
        && shared_domain_mesh_requested(problem, requested_demag_realization)
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM mesh (fem_domain_mesh_asset) was not provided. \
                     Call study.build_domain_mesh() or study.domain_mesh(...) before solving.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    if resolved_domain_mesh_asset.is_none()
        && problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, EnergyTermIR::Demag { .. }))
        && requested_demag_realization.requires_airbox()
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Missing shared-domain FEM mesh with air.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut merged_equilibrium = Vec::new();
    let mut mesh_parts = Vec::with_capacity(problem.magnets.len());
    let mut mesh_sources = Vec::with_capacity(problem.magnets.len());
    let mut selected_material: Option<fullmag_ir::MaterialIR> = None;
    let mut magnet_entries = Vec::with_capacity(problem.magnets.len());

    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(_geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };
        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
            .cloned()
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };
        if let Some(reference_material) = selected_material.as_ref() {
            if !compatible_fem_material(reference_material, &material) {
                errors.push(format!(
                    "current multi-body FEM eigen baseline requires identical material law across magnets; '{}' is incompatible with '{}'",
                    magnet.name,
                    problem.magnets[0].name
                ));
            }
        } else {
            selected_material = Some(material.clone());
        }

        magnet_entries.push(MagnetPlanningEntry {
            magnet_name: magnet.name.clone(),
            geometry_name: geometry_name.to_string(),
            initial_magnetization: magnet.initial_magnetization.clone(),
        });

        if resolved_domain_mesh_asset.is_some() {
            continue;
        }

        let mesh_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .fem_mesh_assets
                    .iter()
                    .find(|asset| asset.geometry_name == geometry_name)
            })
            .cloned();

        let mesh_asset = match mesh_asset {
            Some(asset) => asset,
            None => {
                errors.push(format!(
                    "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                    geometry_name
                ));
                continue;
            }
        };

        let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
            (Some(mesh), _) => mesh.clone(),
            (None, Some(source)) => match load_mesh_from_source(source) {
                Ok(mesh) => mesh,
                Err(message) => {
                    errors.push(message);
                    continue;
                }
            },
            (None, None) => {
                errors.push(format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry_name
                ));
                continue;
            }
        };

        match initial_vectors_for_magnet(
            &magnet.name,
            &mesh.mesh_name,
            magnet.initial_magnetization.as_ref(),
            mesh.nodes.len(),
            Some(&mesh.nodes),
            Some(&mesh.nodes),
        ) {
            Ok(values) => merged_equilibrium.extend(values),
            Err(message) => errors.push(message),
        }
        mesh_parts.push((geometry_name.to_string(), mesh));
        mesh_sources.push(mesh_asset.mesh_source);
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut demag_realization = fullmag_ir::RequestedFemDemagIR::Auto;
    let mut interfacial_dmi: Option<f64> = None;
    let mut interfacial_dmi_normal: Option<[f64; 3]> = None;
    let mut bulk_dmi: Option<f64> = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { realization } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
                demag_realization = *realization;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                interfacial_dmi = Some(*d);
                interfacial_dmi_normal = *interface_normal;
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is not yet executable in the FEM eigen baseline",
                    other
                ));
            }
        }
    }
    if interfacial_dmi.is_some() {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => errors.push(reason),
        }
    } else {
        interfacial_dmi_normal = None;
    }
    if !(enable_exchange
        || enable_demag
        || external_field.is_some()
        || interfacial_dmi.is_some()
        || bulk_dmi.is_some())
    {
        errors.push(
            "the current FEM eigen baseline requires at least one of Exchange, Demag, Zeeman, InterfacialDmi, or BulkDmi"
                .to_string(),
        );
    }
    if operator.include_demag && !enable_demag {
        errors.push(
            "eigen operator requested include_demag=true but the problem does not declare Demag()"
                .to_string(),
        );
    }
    if operator.include_demag
        && matches!(
            spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
    {
        errors.push(
            "dynamic demag for Floquet periodic FEM is not implemented yet. Disable demag or use k=0/free boundary."
                .to_string(),
        );
    }
    match spin_wave_bc.kind() {
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic => {
            let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
            let has_pairs = if requested_pair_ids.is_empty() {
                if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
                    !domain_asset.mesh.periodic_node_pairs.is_empty()
                } else {
                    mesh_parts
                        .iter()
                        .any(|(_, mesh)| !mesh.periodic_node_pairs.is_empty())
                }
            } else {
                requested_pair_ids.iter().all(|pair_id| {
                    mesh_parts.iter().any(|(_, mesh)| {
                        mesh.periodic_node_pairs
                            .iter()
                            .any(|pair| pair.pair_id == *pair_id)
                    }) || resolved_domain_mesh_asset
                        .as_ref()
                        .is_some_and(|domain_asset| {
                            domain_asset
                                .mesh
                                .periodic_node_pairs
                                .iter()
                                .any(|pair| pair.pair_id == *pair_id)
                        })
                })
            };
            if !has_pairs {
                errors.push(
                    "spin_wave_bc.kind='periodic' requires mesh.periodic_node_pairs metadata"
                        .to_string(),
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
            let has_pairs = if requested_pair_ids.is_empty() {
                if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
                    !domain_asset.mesh.periodic_node_pairs.is_empty()
                } else {
                    mesh_parts
                        .iter()
                        .any(|(_, mesh)| !mesh.periodic_node_pairs.is_empty())
                }
            } else {
                requested_pair_ids.iter().all(|pair_id| {
                    mesh_parts.iter().any(|(_, mesh)| {
                        mesh.periodic_node_pairs
                            .iter()
                            .any(|pair| pair.pair_id == *pair_id)
                    }) || resolved_domain_mesh_asset
                        .as_ref()
                        .is_some_and(|domain_asset| {
                            domain_asset
                                .mesh
                                .periodic_node_pairs
                                .iter()
                                .any(|pair| pair.pair_id == *pair_id)
                        })
                })
            };
            if !has_pairs {
                errors.push(
                    "spin_wave_bc.kind='floquet' requires mesh.periodic_node_pairs metadata"
                        .to_string(),
                );
            }
            if !matches!(
                k_sampling,
                Some(fullmag_ir::KSamplingIR::Single { .. })
                    | Some(fullmag_ir::KSamplingIR::Path { .. })
            ) {
                errors.push(
                    "spin_wave_bc.kind='floquet' requires k_sampling=Single{ k_vector = [...] }"
                        .to_string(),
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            if spin_wave_bc
                .surface_anisotropy_ks()
                .is_none_or(|ks| !ks.is_finite() || ks <= 0.0)
            {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' requires surface_anisotropy_ks > 0"
                        .to_string(),
                );
            }
            if spin_wave_bc
                .surface_anisotropy_axis()
                .is_none_or(|axis| axis.iter().all(|component| component.abs() <= 1e-30))
            {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' requires a non-zero surface_anisotropy_axis"
                        .to_string(),
                );
            }
            if mesh_parts.iter().any(|(_, mesh)| {
                mesh.element_markers.iter().any(|&marker| marker == 0)
                    && mesh.element_markers.iter().any(|&marker| marker != 0)
            }) || resolved_domain_mesh_asset.as_ref().is_some_and(|domain| {
                domain
                    .mesh
                    .element_markers
                    .iter()
                    .any(|&marker| marker == 0)
                    && domain
                        .mesh
                        .element_markers
                        .iter()
                        .any(|&marker| marker != 0)
            }) {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' currently requires a standalone magnetic mesh; shared-domain airbox meshes do not yet expose magnetic interface faces"
                        .to_string(),
                );
            }
        }
        _ => {}
    }

    validate_eigen_outputs(&problem.study.sampling().outputs, &mut errors);
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(fem_single_precision_rejection(
            runtime_requests_cuda(problem),
            "FEM eigen",
        ));
    }

    let gyromagnetic_ratio = match dynamics {
        fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio, ..
        } => *gyromagnetic_ratio,
    };

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let material =
        selected_material.expect("validation should have caught missing FEM eigen material");
    let geometry_to_object_id = geometry_to_object_id_map(&magnet_entries);
    let (mesh, raw_object_segments, mesh_source, equilibrium_magnetization) =
        if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
            let mut equilibrium = vec![[0.0, 0.0, 0.0]; domain_asset.mesh.nodes.len()];
            for entry in &magnet_entries {
                let Some(segment) = domain_asset
                    .object_segments
                    .iter()
                    .find(|segment| plan_object_ids_match(&segment.object_id, &entry.geometry_name))
                else {
                    return Err(PlanError {
                        reasons: vec![format!(
                            "shared-domain FEM mesh asset is missing a segment for geometry '{}'",
                            entry.geometry_name
                        )],
                    });
                };
                assign_domain_initial_for_segment(
                    &mut equilibrium,
                    &domain_asset.mesh,
                    &domain_asset.mesh_parts,
                    segment,
                    entry,
                )?;
            }
            (
                domain_asset.mesh.clone(),
                domain_asset.object_segments.clone(),
                domain_asset.mesh_source.clone(),
                equilibrium,
            )
        } else {
            let (mesh, object_segments) =
                merge_fem_meshes(&mesh_parts).map_err(|message| PlanError {
                    reasons: vec![message],
                })?;
            let mesh_source = if mesh_parts.len() == 1 {
                mesh_sources.first().cloned().flatten()
            } else {
                None
            };
            (mesh, object_segments, mesh_source, merged_equilibrium)
        };
    let object_segments = remap_segment_object_ids(&raw_object_segments, &geometry_to_object_id)?;
    let mesh_name = mesh.mesh_name.clone();
    let n_nodes = mesh.nodes.len();
    let n_elements = mesh.elements.len();
    let domain_mesh_mode = resolved_domain_mesh_mode(&mesh);
    if shared_domain_mesh_requested(problem, demag_realization)
        && domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM was requested, but the resolved final FEM mesh has no air region. Attach a conformal shared-domain mesh asset.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut resolved_mesh_parts = if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
        domain_asset.mesh_parts.clone()
    } else {
        build_mesh_parts_from_segments(&mesh, &object_segments, domain_mesh_mode)
    };
    let mesh_part_materials = magnet_entries
        .iter()
        .map(|entry| (entry.magnet_name.clone(), material.clone()))
        .collect::<BTreeMap<_, _>>();
    assign_material_ids_to_mesh_parts(
        &mut resolved_mesh_parts,
        &magnet_entries,
        &mesh_part_materials,
    );
    let domain_frame = problem_domain_frame(problem)
        .map(|frame| frame.with_mesh_bounds(mesh_bounds(&mesh)))
        .and_then(DomainFrameIR::finalized);

    // Phase-1A: normalize and reject unimplemented models (eigen path).
    let demag_realization = demag_realization.normalized();
    if !demag_realization.is_implemented() {
        return Err(PlanError {
            reasons: vec![format!(
                "Demag model '{}' is not yet implemented. Currently supported: airbox and fredkin_koehler.",
                demag_realization.model_name(),
            )],
        });
    }

    let resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR> = if enable_demag {
        let has_air_elements = mesh.element_markers.iter().any(|&m| m == 0);
        if demag_realization.requires_airbox() && !has_air_elements {
            return Err(PlanError {
                reasons: vec![format!(
                    "{} The resolved FEM mesh has no air elements.",
                    FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
                )],
            });
        }
        Some(match demag_realization {
            fullmag_ir::RequestedFemDemagIR::PoissonDirichlet => {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet
            }
            fullmag_ir::RequestedFemDemagIR::PoissonRobin => {
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin
            }
            fullmag_ir::RequestedFemDemagIR::Auto => fullmag_ir::ResolvedFemDemagIR::PoissonRobin,
            fullmag_ir::RequestedFemDemagIR::Bem => fullmag_ir::ResolvedFemDemagIR::Bem,
            fullmag_ir::RequestedFemDemagIR::FredkinKoehler => {
                fullmag_ir::ResolvedFemDemagIR::FredkinKoehler
            }
            fullmag_ir::RequestedFemDemagIR::Fmm => fullmag_ir::ResolvedFemDemagIR::Fmm,
        })
    } else {
        None
    };
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    // Phase-0C: enforce P1-only constraint (eigen path).
    if fem_hints.order != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM backend currently supports only first-order (P1) elements \
                 (fe_order = 1). Requested fe_order = {}. Higher-order support is \
                 planned but not yet implemented.",
                fem_hints.order,
            )],
        });
    }

    let fem_plan = FemEigenPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source,
        mesh,
        object_segments,
        mesh_parts: resolved_mesh_parts,
        domain_mesh_mode,
        domain_frame,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        equilibrium_magnetization,
        material,
        operator: operator.clone(),
        count: *count,
        target: target.clone(),
        equilibrium: equilibrium.clone(),
        k_sampling: k_sampling.clone(),
        normalization: *normalization,
        damping_policy: *damping_policy,
        enable_exchange,
        enable_demag: enable_demag && operator.include_demag,
        interfacial_dmi,
        dmi_interface_normal: interfacial_dmi_normal,
        bulk_dmi,
        external_field,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: spin_wave_bc.clone(),
        demag_realization: resolved_demag_realization,
        mode_tracking: mode_tracking.clone(),
    };

    let study_note = format!(
        "study: eigenmodes operator={:?} count={} normalization={:?} damping_policy={:?}",
        fem_plan.operator.kind, fem_plan.count, fem_plan.normalization, fem_plan.damping_policy
    );

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
        },
        backend_plan: BackendPlanIR::FemEigen(fem_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                if resolved_domain_mesh_asset.is_some() {
                    "Bootstrap FEM eigen planner using study-level shared-domain mesh asset"
                        .to_string()
                } else {
                    "Bootstrap FEM eigen planner with separate FemEigenPlanIR".to_string()
                },
                format!("mesh asset: {mesh_name} ({n_nodes} nodes, {n_elements} elements)"),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag && operator.include_demag,
                    external_field.is_some()
                ),
                study_note,
                "FEM eigen execution currently targets the transitional CPU FEM baseline; native MFEM/SLEPc integration remains future work"
                    .to_string(),
            ],
        },
    })
}

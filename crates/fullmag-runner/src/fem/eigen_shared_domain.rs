use super::eigen_certificate::{
    build_owned_modal_certificate_v6_binding, modal_v6_error, MODAL_CERTIFICATE_BINDING_ACCEPTED,
};
use super::eigen_constants::{
    MODAL_LINEARIZATION_TERM_DEMAG, MODAL_LINEARIZATION_TERM_EXCHANGE,
    MODAL_LINEARIZATION_TERM_FIELD, SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_DETAIL,
    SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON,
};
#[cfg(test)]
use super::eigen_digest::sha256_text;
use super::eigen_digest::{is_sha256_digest, shared_domain_content_digest};
use super::eigen_equilibrium_contract::{
    validate_certified_equilibrium_fields, AcceptedFemEigenEquilibriumHandoff,
    AcceptedFemRelaxStageHandoff, LoadedEquilibriumArtifactV7,
};
use super::eigen_math::vector_norm;
use super::eigen_policy::{
    k0_kittel_periodic_airbox_validation_requested, native_modal_target_frequency_hz,
    resolved_demag_realization,
};
use super::eigen_projection::tangent_bases;
use super::eigen_reduction::ReductionMap;
use super::eigen_shared_domain_geometry::{
    build_modal_certificate_map_binding, modal_shared_domain_equivalence_classes,
    pa_e4b_airbox_size_m, periodic_domain_pair_stats, shared_domain_robin_beta_m,
    OwnedModalEigenCsrMatrix, OwnedModalEigenPoissonAirboxBlockProblem,
};
use super::eigen_types::SharedDomainLinearizationState;
use crate::native_fem;
use crate::types::RunError;
use fullmag_engine::fem::FemLlgProblem;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::EffectiveFieldObservables;
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use nalgebra::DMatrix;
use num_complex::Complex64;

pub(super) fn reduced_shared_domain_tangent_mass(
    topology: &MeshTopology,
    full_mass: &DMatrix<f64>,
) -> Result<(DMatrix<f64>, Vec<usize>, Vec<u32>, usize), RunError> {
    let active_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    let active_count = active_nodes.len();
    if full_mass.nrows() != 2usize.saturating_mul(active_count)
        || full_mass.ncols() != full_mass.nrows()
    {
        return Err(RunError {
            message: "shared-domain modal full tangent mass dimensions do not match active nodes"
                .to_string(),
        });
    }
    let (_, _, magnetic_classes, magnetic_class_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let magnetic_class_count = usize::try_from(magnetic_class_count).map_err(|_| RunError {
        message: "shared-domain magnetic equivalence class count exceeds host dimensions"
            .to_string(),
    })?;
    let mut active_classes = Vec::with_capacity(active_count);
    for node in &active_nodes {
        let class = *magnetic_classes.get(*node).ok_or_else(|| RunError {
            message: "shared-domain magnetic class map is shorter than the mesh".to_string(),
        })?;
        if class == u32::MAX || class as usize >= magnetic_class_count {
            return Err(RunError {
                message: "shared-domain active node has no valid magnetic equivalence class"
                    .to_string(),
            });
        }
        active_classes.push(class as usize);
    }
    let reduced_dimension = 2usize
        .checked_mul(magnetic_class_count)
        .ok_or_else(|| RunError {
            message: "shared-domain reduced tangent mass dimensions overflow".to_string(),
        })?;
    let mut reduced_mass = DMatrix::<f64>::zeros(reduced_dimension, reduced_dimension);
    for row_component in 0..2usize {
        for column_component in 0..2usize {
            for (row_position, row_class) in active_classes.iter().copied().enumerate() {
                for (column_position, column_class) in active_classes.iter().copied().enumerate() {
                    reduced_mass[(
                        row_component * magnetic_class_count + row_class,
                        column_component * magnetic_class_count + column_class,
                    )] += full_mass[(
                        row_component * active_count + row_position,
                        column_component * active_count + column_position,
                    )];
                }
            }
        }
    }
    Ok((
        reduced_mass,
        active_nodes,
        magnetic_classes,
        magnetic_class_count,
    ))
}

/// Validation-only dense-reference oracle. Production shared-domain handoff
/// must never construct or transport runner-owned A_qq.
#[cfg(test)]
pub(super) fn validation_oracle_full_interleaved_modal_a_qq_csr(
    block_matrix: &DMatrix<f64>,
    active_nodes: &[usize],
    full_node_count: usize,
    energy_scale: f64,
) -> Result<(Vec<u32>, Vec<u32>, Vec<f64>), RunError> {
    let active_count = active_nodes.len();
    let block_dimension = active_count.checked_mul(2).ok_or_else(|| RunError {
        message: "shared-domain modal A_qq dimension overflow".to_string(),
    })?;
    if block_matrix.nrows() != block_dimension || block_matrix.ncols() != block_dimension {
        return Err(RunError {
            message: "shared-domain modal A_qq source has an unexpected dimension".to_string(),
        });
    }
    let full_dimension = full_node_count.checked_mul(2).ok_or_else(|| RunError {
        message: "shared-domain modal full A_qq dimension overflow".to_string(),
    })?;
    let mut active_position = vec![None; full_node_count];
    for (position, node) in active_nodes.iter().copied().enumerate() {
        if node >= full_node_count {
            return Err(RunError {
                message: "shared-domain modal active node is outside the mesh".to_string(),
            });
        }
        active_position[node] = Some(position);
    }
    let mut row_offsets = Vec::with_capacity(full_dimension + 1);
    let mut columns = Vec::new();
    let mut values = Vec::new();
    row_offsets.push(0);
    for node in 0..full_node_count {
        for component in 0..2 {
            if let Some(row_position) = active_position[node] {
                let row_block = component * active_count + row_position;
                for column_node in active_nodes.iter().copied() {
                    let Some(column_position) = active_position[column_node] else {
                        continue;
                    };
                    for column_component in 0..2 {
                        let column_block = column_component * active_count + column_position;
                        let value = block_matrix[(row_block, column_block)] * energy_scale;
                        if !value.is_finite() {
                            return Err(RunError {
                                message: "shared-domain modal A_qq contains a non-finite value"
                                    .to_string(),
                            });
                        }
                        if value != 0.0 {
                            columns.push((2 * column_node + column_component) as u32);
                            values.push(value);
                        }
                    }
                }
            }
            if values.len() > u32::MAX as usize {
                return Err(RunError {
                    message: "shared-domain modal A_qq CSR exceeds u32 index range".to_string(),
                });
            }
            row_offsets.push(values.len() as u32);
        }
    }
    Ok((row_offsets, columns, values))
}

pub(super) fn max_vector_field_difference(left: &[Vector3], right: &[Vector3]) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    Some(
        left.iter()
            .zip(right)
            .map(|(left, right)| {
                (0..3)
                    .map(|axis| (left[axis] - right[axis]).abs())
                    .fold(0.0, f64::max)
            })
            .fold(0.0, f64::max),
    )
}

fn max_scalar_field_difference(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    Some(
        left.iter()
            .zip(right)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0, f64::max),
    )
}

pub(super) fn extend_equilibrium_m0_to_air_nodes(
    topology: &MeshTopology,
    equilibrium: &[Vector3],
) -> Vec<Vector3> {
    equilibrium
        .iter()
        .zip(topology.magnetic_node_volumes.iter())
        .map(|(m, magnetic_volume)| {
            if *magnetic_volume > 0.0 {
                *m
            } else {
                [0.0, 0.0, 1.0]
            }
        })
        .collect()
}

pub(super) fn build_shared_domain_linearization_state(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    problem: &FemLlgProblem,
    source_artifact: Option<&LoadedEquilibriumArtifactV7>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
) -> Result<SharedDomainLinearizationState, RunError> {
    validate_shared_domain_modal_scope(plan, topology, equilibrium, observables)?;
    let recomputed_phi0 = problem
        .demag_potential_from_vectors(equilibrium)
        .map_err(|error| RunError {
            message: format!(
                "shared-domain modal equilibrium potential materialization failed: {error}"
            ),
        })?;
    let phi0 = if let Some(handoff) = source_relax_handoff {
        validate_certified_equilibrium_fields(&handoff.certified_fields, topology.n_nodes)?;
        // The Rust reference problem does not carry the native k=0 periodic
        // Poisson reduction. Its potential is therefore not an independent
        // recomputation of the same boundary-value problem. For the production
        // shared-domain lane consume the digest-bound native phi0; non-periodic
        // lanes may still compare the reference potential directly.
        if plan.mesh.periodic_node_pairs.is_empty() {
            let difference = max_scalar_field_difference(
                &handoff.certified_fields.phi_a,
                &recomputed_phi0,
            )
            .ok_or_else(|| RunError {
                message: "relax_stage_handoff_phi0_recompute_mismatch: accepted and recomputed potential shapes differ"
                    .to_string(),
            })?;
            if !difference.is_finite() || difference > 1.0e-10 {
                return Err(RunError {
                    message: format!(
                        "relax_stage_handoff_phi0_recompute_mismatch: accepted/recomputed maximum difference {difference:.3e} exceeds 1.000e-10 A"
                    ),
                });
            }
        }
        handoff.certified_fields.phi_a.clone()
    } else {
        recomputed_phi0
    };
    if phi0.len() != topology.n_nodes || phi0.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: format!(
                "shared-domain modal equilibrium potential is incomplete or non-finite (expected {} values, got {})",
                topology.n_nodes,
                phi0.len()
            ),
        });
    }

    let mesh_signature = plan.mesh.topology_fingerprint_v6();
    let material_signature = shared_domain_content_digest("material_signature", &plan.material)?;
    let physics_signature = shared_domain_content_digest(
        "physics_signature",
        &serde_json::json!({
            "enable_exchange": plan.enable_exchange,
            "enable_demag": plan.enable_demag,
            "external_field_a_per_m": plan.external_field,
            "gyromagnetic_ratio": plan.gyromagnetic_ratio,
            "damping": plan.material.damping,
            "operator": plan.operator,
            "demag_realization": resolved_demag_realization(plan)
                .map(|value| value.provenance_name()),
        }),
    )?;
    let boundary_signature = shared_domain_content_digest(
        "boundary_signature",
        &serde_json::json!({
            "spin_wave_bc": plan.spin_wave_bc,
            "air_box_config": plan.air_box_config,
            "periodic_node_pairs": plan.mesh.periodic_node_pairs,
            "periodic_boundary_pairs": plan.mesh.periodic_boundary_pairs,
        }),
    )?;
    let static_demag_signature = shared_domain_content_digest(
        "static_demag_signature",
        &serde_json::json!({
            "realization": resolved_demag_realization(plan)
                .map(|value| value.provenance_name()),
            "h_demag0_a_per_m": observables.demag_field,
            "phi0_a": phi0,
        }),
    )?;

    if let Some(source_artifact) = source_artifact {
        let compare = |label: &str, difference: Option<f64>, tolerance: f64| {
            let Some(difference) = difference else {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_comparison_failed: stored field shape does not match the requested mesh"
                    ),
                });
            };
            if !difference.is_finite() || difference > tolerance {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_comparison_failed: stored/recomputed maximum difference {difference:.3e} exceeds {tolerance:.3e}"
                    ),
                });
            }
            Ok(())
        };
        compare(
            "m0",
            max_vector_field_difference(&source_artifact.m0, equilibrium),
            1.0e-12,
        )?;
        compare(
            "h_eff0",
            max_vector_field_difference(&source_artifact.h_eff0, &observables.effective_field),
            1.0e-8,
        )?;
        compare(
            "h_demag0",
            max_vector_field_difference(&source_artifact.h_demag0, &observables.demag_field),
            1.0e-8,
        )?;
        compare(
            "phi0",
            max_scalar_field_difference(&source_artifact.phi0, &phi0),
            1.0e-10,
        )?;
        for (label, expected, actual) in [
            (
                "mesh_hash",
                &mesh_signature,
                &source_artifact.mesh_signature,
            ),
            (
                "material_hash",
                &material_signature,
                &source_artifact.material_signature,
            ),
            (
                "physics_hash",
                &physics_signature,
                &source_artifact.physics_signature,
            ),
            (
                "boundary_hash",
                &boundary_signature,
                &source_artifact.boundary_signature,
            ),
            (
                "static_demag_hash",
                &static_demag_signature,
                &source_artifact.static_demag_signature,
            ),
        ] {
            if expected != actual {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_mismatch: stored '{}' does not match recomputed '{}'",
                        actual, expected
                    ),
                });
            }
        }
    }

    let periodic_certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain modal equilibrium requires periodic_mesh_certificate.v6: {}",
                errors.join("; ")
            ),
        })?;
    if periodic_certificate.schema_version != "periodic_mesh_certificate.v6"
        || periodic_certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message:
                "shared-domain modal equilibrium requires an accepted periodic_mesh_certificate.v6"
                    .to_string(),
        });
    }
    let (scalar_classes, scalar_class_count, magnetic_classes, magnetic_class_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let (periodic_certificate_map_binding, periodic_certificate_map_binding_digest) =
        build_modal_certificate_map_binding(
            plan,
            topology,
            &periodic_certificate,
            &scalar_classes,
            scalar_class_count,
            &magnetic_classes,
            magnetic_class_count,
        )?;
    let periodic_certificate_payload =
        serde_json::to_value(&periodic_certificate).map_err(|error| RunError {
            message: format!(
                "failed to serialize periodic_mesh_certificate.v6 for equilibrium handoff: {error}"
            ),
        })?;
    let periodic_certificate_content_sha256 =
        shared_domain_content_digest("periodic_mesh_certificate", &periodic_certificate_payload)?;
    let periodic_certificate_id = format!(
        "periodic_mesh_certificate.v6:{}",
        periodic_certificate_content_sha256
            .strip_prefix("sha256:")
            .unwrap_or(&periodic_certificate_content_sha256)
    );
    let periodic_certificate_json = serde_json::json!({
        "schema_version": "periodic_mesh_certificate.v6",
        "certificate_id": periodic_certificate_id,
        "content_sha256": periodic_certificate_content_sha256,
        "certificate": periodic_certificate_payload,
        "modal_equivalence_map_binding": periodic_certificate_map_binding,
    });
    let periodic_mesh_certificate_digest =
        shared_domain_content_digest("periodic_mesh_certificate_v6", &periodic_certificate_json)?;
    let periodic_mesh_certificate_digest = if let Some(source_artifact) = source_artifact {
        let source_certificate = source_artifact
            .periodic_mesh_certificate
            .as_object()
            .ok_or_else(|| RunError {
                message: "equilibrium_periodic_certificate_missing_or_stale: certificate is not an object"
                    .to_string(),
            })?;
        for name in ["certificate_id", "content_sha256"] {
            if source_certificate.get(name) != periodic_certificate_json.get(name) {
                return Err(RunError {
                    message: format!(
                        "equilibrium_periodic_certificate_missing_or_stale: stored certificate '{}' does not match the current mesh certificate",
                        name
                    ),
                });
            }
        }
        if source_certificate.get("modal_equivalence_map_binding")
            != periodic_certificate_json.get("modal_equivalence_map_binding")
        {
            return Err(RunError {
                message:
                    "equilibrium_periodic_certificate_missing_or_stale: modal equivalence map binding does not match the current certificate"
                        .to_string(),
            });
        }
        source_certificate
            .get("content_sha256")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| RunError {
                message: "equilibrium_periodic_certificate_missing_or_stale: stored certificate hash is missing"
                    .to_string(),
            })?
            .to_string()
    } else {
        periodic_mesh_certificate_digest
    };

    let max_m0_norm_error = equilibrium
        .iter()
        .zip(topology.magnetic_node_volumes.iter())
        .filter(|(_, volume)| **volume > 0.0)
        .map(|(m, _)| (vector_norm(*m) - 1.0).abs())
        .fold(0.0, f64::max);
    let max_m0_cross_h_eff0_relative =
        observables.max_torque_Apm / observables.max_effective_field_amplitude.max(1.0);
    if !max_m0_norm_error.is_finite()
        || !max_m0_cross_h_eff0_relative.is_finite()
        || max_m0_norm_error > 1.0e-8
    {
        return Err(RunError {
            message: format!(
                "shared-domain modal equilibrium failed representation-integrity validation (m0_norm={max_m0_norm_error:.3e}, torque={max_m0_cross_h_eff0_relative:.3e})"
            ),
        });
    }

    let (
        equilibrium_artifact,
        equilibrium_artifact_digest,
        artifact_h_eff0,
        artifact_h_demag0,
        artifact_phi0,
        artifact_phi0_requirement,
        artifact_field_source,
    ) = if let Some(source_artifact) = source_artifact {
        (
            source_artifact.value.clone(),
            source_artifact.content_sha256.clone(),
            serde_json::json!(source_artifact.h_eff0),
            serde_json::json!(source_artifact.h_demag0),
            serde_json::json!(source_artifact.phi0),
            serde_json::json!(source_artifact.phi0_requirement),
            "stored_verified",
        )
    } else {
        let source_relax_handoff = source_relax_handoff.ok_or_else(|| {
            RunError {
                message: "equilibrium_artifact_v7_uncertified: accepted relaxation completion evidence is required"
                    .to_string(),
            }
        })?;
        let mut acceptance_certificate = source_relax_handoff.acceptance_json();
        acceptance_certificate
            .as_object_mut()
            .expect("accepted equilibrium criterion serializes as an object")
            .insert(
                "completion_sha256".to_string(),
                serde_json::json!(source_relax_handoff.completion_sha256),
            );
        let mut artifact = serde_json::json!({
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": true,
            "acceptance_certificate": acceptance_certificate,
            "completion_sha256": source_relax_handoff.completion_sha256,
            "external_field_a_per_m": plan.external_field,
            "m0": equilibrium,
            "h_eff0_a_per_m": observables.effective_field,
            "h_demag0_a_per_m": observables.demag_field,
            "phi0_requirement": "required_for_restart_or_provenance",
            "phi0_a": phi0,
            "mesh_signature": mesh_signature,
            "material_signature": material_signature,
            "physics_signature": physics_signature,
            "boundary_signature": boundary_signature,
            "static_demag_signature": static_demag_signature,
            "observables": {
                "max_torque_Apm": observables.max_torque_Apm,
                "max_torque_T": observables.max_torque_Apm * MU0,
                "max_torque_relative": max_m0_cross_h_eff0_relative,
            },
            "representation_integrity": {
                "m0_norm_tolerance": 1.0e-8,
            },
            "max_m0_norm_error": max_m0_norm_error,
            "max_m0_cross_h_eff0_relative": max_m0_cross_h_eff0_relative,
            "producer_run_id": source_relax_handoff.source_run_id,
            "demag_model": resolved_demag_realization(plan)
                .map(|value| value.model_name())
                .unwrap_or("none"),
            "periodic_mesh_certificate": periodic_certificate_json,
        });
        let digest = shared_domain_content_digest("equilibrium_artifact_v7", &artifact)?;
        if let Some(object) = artifact.as_object_mut() {
            object.insert("content_sha256".to_string(), serde_json::json!(digest));
            object.insert(
                "equilibrium_id".to_string(),
                serde_json::json!(format!(
                    "equilibrium_artifact.v7:{}",
                    digest.strip_prefix("sha256:").unwrap_or(&digest)
                )),
            );
        }
        (
            artifact,
            digest,
            serde_json::json!(observables.effective_field),
            serde_json::json!(observables.demag_field),
            serde_json::json!(phi0),
            serde_json::json!("required_for_restart_or_provenance"),
            "certified_native_relax_handoff",
        )
    };

    let required_artifact_string = |name: &str| -> Result<String, RunError> {
        equilibrium_artifact
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| RunError {
                message: format!(
                    "accepted equilibrium artifact is missing required identity field '{name}'"
                ),
            })
    };
    let equilibrium_id = source_artifact
        .map(|artifact| artifact.equilibrium_id.clone())
        .unwrap_or(required_artifact_string("equilibrium_id")?);
    let producer_run_id = source_artifact
        .map(|artifact| artifact.producer_run_id.clone())
        .unwrap_or(required_artifact_string("producer_run_id")?);
    let equilibrium_content_sha256 = required_artifact_string("content_sha256")?;
    let demag_model = source_artifact
        .map(|artifact| artifact.demag_model.clone())
        .or_else(|| {
            equilibrium_artifact
                .get("demag_model")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            resolved_demag_realization(plan)
                .map(|value| value.model_name().to_string())
                .unwrap_or_else(|| "none".to_string())
        });
    let m0_norm_tolerance = source_artifact
        .map(|artifact| artifact.m0_norm_tolerance)
        .unwrap_or(1.0e-8);
    let (acceptance_certificate, acceptance_certificate_sha256) = if let Some(artifact) =
        source_artifact
    {
        (
            artifact.acceptance_certificate.clone(),
            artifact.completion_sha256.clone(),
        )
    } else {
        let handoff = source_relax_handoff.ok_or_else(|| RunError {
                message: "equilibrium_artifact_v7_uncertified: accepted relaxation completion evidence is required"
                    .to_string(),
            })?;
        (
            handoff.acceptance.clone(),
            handoff.completion_sha256.clone(),
        )
    };
    if !is_sha256_digest(&acceptance_certificate_sha256) {
        return Err(RunError {
            message: "equilibrium_acceptance_certificate_digest_invalid".to_string(),
        });
    }

    let operator_m0 = extend_equilibrium_m0_to_air_nodes(topology, equilibrium);
    let mut linearization_state = serde_json::json!({
        "schema_version": "LinearizationState.v6",
        "source_equilibrium_artifact": equilibrium_artifact_digest,
        "source_equilibrium_id": equilibrium_id,
        "operator_dictionary": "FrequencyOperatorDictionary.v1",
        "accepted_for_frequency_operator": true,
        "external_field_a_per_m": plan.external_field,
        "m0": operator_m0,
        "m0_air_extension_policy": "fixed_unit_z_on_nonmagnetic_nodes_v1",
        "h_eff0_a_per_m": artifact_h_eff0,
        "h_demag0_a_per_m": artifact_h_demag0,
        "phi0_requirement": artifact_phi0_requirement,
        "phi0_a": artifact_phi0,
        "mesh_signature": mesh_signature,
        "material_signature": material_signature,
        "physics_signature": physics_signature,
        "boundary_signature": boundary_signature,
        "static_demag_signature": static_demag_signature,
        "periodic_mesh_certificate": periodic_mesh_certificate_digest,
        "periodic_modal_equivalence_map_binding": {
            "schema_version": "periodic_modal_equivalence_map_binding.v1",
            "content_sha256": periodic_certificate_map_binding_digest,
            "binding": periodic_certificate_json
                .get("modal_equivalence_map_binding")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        },
        "static_field_provenance": {
            "field_source": artifact_field_source,
            "comparison": if source_artifact.is_some() {
                "stored_vs_recomputed_passed"
            } else {
                "recomputed_from_equilibrium"
            },
        },
        "tangent_frame_policy": "orthonormal_right_handed_m0_v1",
        "equilibrium_acceptance_certificate": acceptance_certificate.clone(),
        "equilibrium_acceptance_certificate_sha256": acceptance_certificate_sha256.clone(),
        "acceptance": {
            "max_m0_norm_error": max_m0_norm_error,
            "max_m0_cross_h_eff0_relative": max_m0_cross_h_eff0_relative,
            "m0_norm_tolerance": m0_norm_tolerance,
        },
        "producer_run_id": producer_run_id,
        "demag_model": demag_model,
    });
    let linearization_state_digest =
        shared_domain_content_digest("linearization_state_v6", &linearization_state)?;
    if let Some(object) = linearization_state.as_object_mut() {
        object.insert(
            "content_sha256".to_string(),
            serde_json::json!(linearization_state_digest),
        );
        object.insert(
            "linearization_state_id".to_string(),
            serde_json::json!(format!(
                "LinearizationState.v6:{}",
                linearization_state_digest
                    .strip_prefix("sha256:")
                    .unwrap_or(&linearization_state_digest)
            )),
        );
    }

    let (linearization_m0, linearization_h_eff0, linearization_h_demag0) = source_artifact
        .map(|artifact| {
            (
                extend_equilibrium_m0_to_air_nodes(topology, &artifact.m0),
                artifact.h_eff0.clone(),
                artifact.h_demag0.clone(),
            )
        })
        .unwrap_or_else(|| {
            (
                operator_m0,
                observables.effective_field.clone(),
                observables.demag_field.clone(),
            )
        });

    Ok(SharedDomainLinearizationState {
        equilibrium_artifact,
        linearization_state,
        equilibrium_m0: linearization_m0,
        h_eff0: linearization_h_eff0,
        h_demag0: linearization_h_demag0,
        phi0,
        equilibrium_id,
        mesh_snapshot_id: mesh_signature,
        material_snapshot_id: material_signature,
        physics_snapshot_id: physics_signature,
        boundary_snapshot_id: boundary_signature,
        producer_run_id,
        equilibrium_content_sha256,
        demag_model,
        m0_norm_tolerance,
        acceptance_certificate,
        acceptance_certificate_sha256,
        equilibrium_artifact_digest,
        linearization_state_digest,
        periodic_mesh_certificate_digest,
        periodic_mesh_certificate_map_binding_digest: periodic_certificate_map_binding_digest,
    })
}

pub(super) fn build_native_shared_domain_modal_problem<'a>(
    plan: &'a FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
    linearization_state: Option<&SharedDomainLinearizationState>,
    bias_field_sample_index: usize,
) -> Result<native_fem::NativeModalEigenSharedDomainProblem<'a>, RunError> {
    if !plan.enable_demag || !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        return Err(RunError {
            message: "shared-domain modal payload requires full2x2 dynamic demag".to_string(),
        });
    }
    if plan.material.ms_field.is_some() {
        return Err(RunError {
            message: "shared-domain modal production scope currently requires uniform material Ms"
                .to_string(),
        });
    }
    validate_shared_domain_modal_scope(plan, topology, equilibrium, observables)?;
    let has_magnetic_region = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| is_magnetic);
    let has_airbox_region = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);
    if topology.magnetic_element_mask.len() != topology.n_elements
        || !has_magnetic_region
        || !has_airbox_region
    {
        return Err(RunError {
            message: "k0_poisson_airbox_requires_explicit_region_markers: shared-domain K0 requires distinct magnetic and airbox element markers".to_string(),
        });
    }
    let config = plan.air_box_config.as_ref().ok_or_else(|| RunError {
        message: "shared-domain modal production scope requires air_box_config".to_string(),
    })?;
    let pair_stats = periodic_domain_pair_stats(&plan.mesh)?;
    if pair_stats.magnetic_pair_count == 0 || pair_stats.airbox_pair_count == 0 {
        return Err(RunError {
            message:
                "shared-domain modal production scope requires magnetic and airbox periodic pairs"
                    .to_string(),
        });
    }
    let boundary_kind = match config.bc_kind.as_deref() {
        Some("dirichlet") => "dirichlet",
        Some("pure_neumann") => "pure_neumann",
        Some("robin") | None => "robin",
        Some(other) => {
            return Err(RunError {
                message: format!("unsupported shared-domain modal airbox boundary kind '{other}'"),
            });
        }
    };
    let robin_beta = if boundary_kind == "robin" {
        shared_domain_robin_beta_m(plan)?.ok_or_else(|| RunError {
            message: "shared-domain modal Robin beta is unavailable".to_string(),
        })?
    } else {
        0.0
    };
    let (scalar_classes, scalar_count, magnetic_classes, magnetic_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let mesh_certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain modal production requires an accepted periodic_mesh_certificate.v6: {}",
                errors.join("; ")
            ),
        })?;
    if mesh_certificate.schema_version != "periodic_mesh_certificate.v6"
        || mesh_certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message:
                "shared-domain modal production requires an accepted periodic_mesh_certificate.v6"
                    .to_string(),
        });
    }
    let (_map_binding, map_binding_digest) = build_modal_certificate_map_binding(
        plan,
        topology,
        &mesh_certificate,
        &scalar_classes,
        scalar_count,
        &magnetic_classes,
        magnetic_count,
    )?;
    let linearization_state = linearization_state.ok_or_else(|| RunError {
        message: "shared-domain modal descriptor requires an accepted linearization state"
            .to_string(),
    })?;
    if linearization_state.periodic_mesh_certificate_map_binding_digest != map_binding_digest {
        return Err(RunError {
            message: "shared-domain modal periodic certificate map binding is stale or mismatched"
                .to_string(),
        });
    }
    let mesh_certificate_digest = linearization_state.periodic_mesh_certificate_digest.clone();
    let ms_values = plan.material.ms_field.clone().unwrap_or_default();
    if !ms_values.is_empty() && ms_values.len() != topology.n_nodes {
        return Err(RunError {
            message: "shared-domain modal nodal Ms field does not match the mesh".to_string(),
        });
    }
    let pack_full_field = |field: &[Vector3], label: &str| -> Result<Vec<f64>, RunError> {
        if field.len() != topology.n_nodes {
            return Err(RunError {
                message: format!(
                    "shared-domain native {label} field length {} does not match mesh node count {}",
                    field.len(),
                    topology.n_nodes
                ),
            });
        }
        Ok(field.iter().flatten().copied().collect())
    };
    let linearization_m0_xyz = pack_full_field(&linearization_state.equilibrium_m0, "m0")?;
    let linearization_h_eff0_xyz = pack_full_field(&linearization_state.h_eff0, "h_eff0")?;
    let linearization_h_demag0_xyz = pack_full_field(&linearization_state.h_demag0, "h_demag0")?;
    let external_field_h_ext0_xyz = pack_full_field(&observables.external_field, "h_ext0")?;
    if linearization_state.phi0.len() != topology.n_nodes {
        return Err(RunError {
            message: format!(
                "shared-domain native phi0 length {} does not match mesh node count {}",
                linearization_state.phi0.len(),
                topology.n_nodes
            ),
        });
    }
    let tangent_frame_xyz = tangent_bases(&linearization_state.equilibrium_m0)
        .into_iter()
        .flat_map(|(e1, e2)| e1.into_iter().chain(e2))
        .collect::<Vec<_>>();
    let alpha_per_node = match plan.material.alpha_field.as_ref() {
        Some(alpha) if alpha.len() == topology.n_nodes => alpha.clone(),
        Some(alpha) => {
            return Err(RunError {
                message: format!(
                    "shared-domain native alpha field length {} does not match mesh node count {}",
                    alpha.len(),
                    topology.n_nodes
                ),
            });
        }
        None => vec![plan.material.damping; topology.n_nodes],
    };
    let demag_model = resolved_demag_realization(plan)
        .filter(|realization| realization.is_poisson())
        .ok_or_else(|| RunError {
            message: "shared-domain modal descriptor requires a real Poisson-airbox demag provider"
                .to_string(),
        })?
        .model_name()
        .to_string();
    let exchange_term_digest = plan
        .enable_exchange
        .then(|| {
            shared_domain_content_digest(
                "linearization_exchange_term",
                &(
                    plan.material.exchange_stiffness,
                    plan.material.saturation_magnetisation,
                ),
            )
        })
        .transpose()?;
    let field_term_digest = Some(shared_domain_content_digest(
        "linearization_field_term",
        &external_field_h_ext0_xyz,
    )?);
    let demag_term_digest = Some(shared_domain_content_digest(
        "linearization_demag_term",
        &(
            demag_model.as_str(),
            linearization_h_demag0_xyz.as_slice(),
            linearization_state.phi0.as_slice(),
        ),
    )?);
    let term_presence_mask = (if plan.enable_exchange {
        MODAL_LINEARIZATION_TERM_EXCHANGE
    } else {
        0
    }) | MODAL_LINEARIZATION_TERM_FIELD
        | MODAL_LINEARIZATION_TERM_DEMAG;
    let operator_input_digest = shared_domain_content_digest(
        "linearization_operator_input",
        &(
            linearization_state.linearization_state_digest.as_str(),
            linearization_state.equilibrium_artifact_digest.as_str(),
            term_presence_mask,
            exchange_term_digest.as_deref(),
            field_term_digest.as_deref(),
            demag_term_digest.as_deref(),
            tangent_frame_xyz.as_slice(),
            linearization_m0_xyz.as_slice(),
            linearization_h_eff0_xyz.as_slice(),
            external_field_h_ext0_xyz.as_slice(),
            alpha_per_node.as_slice(),
        ),
    )?;
    let certificate_binding_v6 = build_owned_modal_certificate_v6_binding(
        &plan.mesh,
        &mesh_certificate,
        &plan.mesh_parts,
        plan.material.ms_field.as_deref(),
        plan.material.a_field.as_deref(),
        &scalar_classes,
        scalar_count,
        &magnetic_classes,
        magnetic_count,
        boundary_kind,
        config.boundary_marker,
        robin_beta,
        bias_field_sample_index as u64,
        &external_field_h_ext0_xyz,
    )?;
    Ok(native_fem::NativeModalEigenSharedDomainProblem {
        mesh: &plan.mesh,
        equilibrium_m0_xyz: linearization_m0_xyz.clone(),
        linearization_m0_xyz,
        linearization_h_eff0_xyz,
        linearization_h_demag0_xyz,
        linearization_phi0: linearization_state.phi0.clone(),
        equilibrium_id: linearization_state.equilibrium_id.clone(),
        mesh_snapshot_id: linearization_state.mesh_snapshot_id.clone(),
        material_snapshot_id: linearization_state.material_snapshot_id.clone(),
        physics_snapshot_id: linearization_state.physics_snapshot_id.clone(),
        boundary_snapshot_id: linearization_state.boundary_snapshot_id.clone(),
        producer_run_id: linearization_state.producer_run_id.clone(),
        equilibrium_content_sha256: linearization_state.equilibrium_content_sha256.clone(),
        demag_model,
        m0_norm_tolerance: linearization_state.m0_norm_tolerance,
        acceptance_criterion: linearization_state.acceptance_certificate.criterion.clone(),
        acceptance_metric_kind: linearization_state
            .acceptance_certificate
            .metric_kind_name()
            .to_string(),
        acceptance_unit: linearization_state.acceptance_certificate.unit.clone(),
        acceptance_metric_value: linearization_state.acceptance_certificate.metric_value,
        acceptance_threshold: linearization_state.acceptance_certificate.threshold,
        acceptance_certificate_sha256: linearization_state.acceptance_certificate_sha256.clone(),
        saturation_magnetisation_a_per_m: ms_values,
        uniform_saturation_magnetisation_a_per_m: plan.material.saturation_magnetisation,
        gamma0_m_per_a_s: plan.gyromagnetic_ratio,
        tangent_frame_xyz,
        external_field_h_ext0_xyz,
        alpha_per_node,
        term_presence_mask,
        exchange_term_digest,
        field_term_digest,
        demag_term_digest,
        operator_input_digest: operator_input_digest.clone(),
        demag_provider_signature: Some(operator_input_digest),
        exchange_stiffness_j_per_m: plan
            .enable_exchange
            .then_some(plan.material.exchange_stiffness),
        scalar_reduced_node: scalar_classes,
        scalar_reduced_node_count: scalar_count,
        magnetic_reduced_node: magnetic_classes,
        magnetic_reduced_node_count: magnetic_count,
        magnetic_pair_count: pair_stats.magnetic_pair_count,
        airbox_pair_count: pair_stats.airbox_pair_count,
        boundary_kind: boundary_kind.to_string(),
        robin_beta,
        boundary_marker: config.boundary_marker,
        equilibrium_digest: linearization_state.equilibrium_artifact_digest.clone(),
        mesh_certificate_digest,
        mesh_certificate_schema: "periodic_mesh_certificate.v6".to_string(),
        mesh_certificate_map_binding_digest: certificate_binding_v6
            .shared_domain_map_binding_sha256
            .clone(),
        linearization_state_digest: linearization_state.linearization_state_digest.clone(),
        mesh_generation_identity: certificate_binding_v6.mesh_generation_identity.clone(),
        canonical_preimage: certificate_binding_v6.canonical_preimage.clone(),
        canonical_preimage_sha256: certificate_binding_v6.canonical_preimage_sha256.clone(),
        magnetic_class_digest_sha256: certificate_binding_v6.magnetic_class_digest_sha256.clone(),
        scalar_class_digest_sha256: certificate_binding_v6.scalar_class_digest_sha256.clone(),
        certificate_binding_status: MODAL_CERTIFICATE_BINDING_ACCEPTED,
        certificate_binding_reason: "none".to_string(),
        certificate_binding_v6,
        _marker: std::marker::PhantomData,
    })
}

fn validate_native_shared_domain_certificate_producer(
    plan: &FemEigenPlanIR,
) -> Result<(), RunError> {
    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("shared-domain v6 producer topology is invalid: {error}"),
    })?;
    let certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain v6 producer certificate is unavailable: {}",
                errors.join("; ")
            ),
        })?;
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology)?;
    let config = plan
        .air_box_config
        .as_ref()
        .ok_or_else(|| modal_v6_error("airbox_config_missing"))?;
    let boundary_kind = match config.bc_kind.as_deref() {
        Some("dirichlet") => "dirichlet",
        Some("pure_neumann") => "pure_neumann",
        Some("robin") | None => "robin",
        Some(_) => return Err(modal_v6_error("airbox_boundary_kind_unsupported")),
    };
    let robin_beta = if boundary_kind == "robin" {
        shared_domain_robin_beta_m(plan)
            .map_err(|_| modal_v6_error("airbox_robin_gauge_invalid"))?
            .ok_or_else(|| modal_v6_error("airbox_robin_gauge_invalid"))?
    } else {
        0.0
    };
    let bias_field = plan.external_field.unwrap_or([0.0, 0.0, 0.0]);
    build_owned_modal_certificate_v6_binding(
        &plan.mesh,
        &certificate,
        &plan.mesh_parts,
        plan.material.ms_field.as_deref(),
        plan.material.a_field.as_deref(),
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        boundary_kind,
        config.boundary_marker,
        robin_beta,
        0,
        &bias_field,
    )?;
    Ok(())
}

// Aggregate producer gate. Native MFEM owns A_qq assembly; availability is
// true only when this concrete plan can materialize and validate the complete
// accepted v6 certificate binding that will cross the FFI boundary.
pub(crate) fn native_shared_domain_magnetic_assembly_available(plan: &FemEigenPlanIR) -> bool {
    validate_native_shared_domain_certificate_producer(plan).is_ok()
}

pub(super) fn native_shared_domain_magnetic_assembly_error(
    plan: &FemEigenPlanIR,
) -> Option<String> {
    validate_native_shared_domain_certificate_producer(plan)
        .err()
        .map(|error| error.message)
}

pub(super) fn shared_domain_k0_runtime_unavailable_error() -> RunError {
    RunError {
        message: format!(
            "{SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON}: {SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_DETAIL}"
        ),
    }
}

pub(super) fn full_physical_magnetic_reduction_map(topology: &MeshTopology) -> ReductionMap {
    let active_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    let mut node_map = vec![None; topology.n_nodes];
    for (reduced, node) in active_nodes.iter().copied().enumerate() {
        node_map[node] = Some(reduced);
    }
    ReductionMap {
        active_nodes,
        node_map,
        node_phases: vec![Complex64::new(1.0, 0.0); topology.n_nodes],
        complex_reduction: false,
    }
}

pub(super) fn validate_shared_domain_modal_scope(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
) -> Result<(), RunError> {
    if equilibrium.len() != topology.n_nodes {
        return Err(RunError {
            message: "shared-domain modal linearization equilibrium length does not match the mesh"
                .to_string(),
        });
    }
    if observables.max_effective_field_amplitude <= 0.0
        || !observables.max_effective_field_amplitude.is_finite()
        || !observables.max_torque_Apm.is_finite()
    {
        return Err(RunError {
            message: "shared-domain modal linearization requires finite effective-field and torque diagnostics"
                .to_string(),
        });
    }
    let mut magnetic_node_count = 0usize;
    for (node, (volume, magnetization)) in topology
        .magnetic_node_volumes
        .iter()
        .zip(equilibrium.iter())
        .enumerate()
    {
        if *volume <= 0.0 {
            continue;
        }
        magnetic_node_count += 1;
        let norm_error = (vector_norm(*magnetization) - 1.0).abs();
        if !norm_error.is_finite() || norm_error > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "shared-domain modal production scope requires normalized equilibrium (node {node} has norm error {norm_error:.3e})"
                ),
            });
        }
    }
    if magnetic_node_count == 0 {
        return Err(RunError {
            message: "shared-domain modal linearization requires at least one magnetic node"
                .to_string(),
        });
    }
    // A k=0 periodic reduction identifies paired magnetic nodes.  The static
    // equilibrium may be textured inside the unit cell (for example around an
    // antidot), but it must be periodic across every identified pair.
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        let node_a = *node_a as usize;
        let node_b = *node_b as usize;
        if topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let a = equilibrium[node_a];
        let b = equilibrium[node_b];
        let mismatch = vector_norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
        if !mismatch.is_finite() || mismatch > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "shared-domain modal production scope requires periodic equilibrium across pair '{pair_id}' (nodes {node_a}/{node_b}, mismatch {mismatch:.3e})"
                ),
            });
        }
    }
    let unsupported_local_term = plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.anisotropy_axis.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan.material.cubic_anisotropy_axis1.is_some()
        || plan.material.cubic_anisotropy_axis2.is_some()
        || plan.material.a_field.is_some()
        || plan.material.ku_field.is_some()
        || plan.material.ku2_field.is_some()
        || plan.material.kc1_field.is_some()
        || plan.material.kc2_field.is_some()
        || plan.material.kc3_field.is_some()
        || plan.material.dind_field.is_some()
        || plan.material.dbulk_field.is_some()
        || plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.spin_wave_bc.surface_anisotropy_ks().is_some();
    if unsupported_local_term {
        return Err(RunError {
            message: "shared-domain modal production scope currently accepts exchange, Zeeman, and dynamic demag only; anisotropy and DMI tangent terms are not yet certified"
                .to_string(),
        });
    }
    Ok(())
}

impl OwnedModalEigenPoissonAirboxBlockProblem {
    pub(super) fn borrowed(&self) -> native_fem::NativeModalEigenPoissonAirboxBlockProblem<'_> {
        native_fem::NativeModalEigenPoissonAirboxBlockProblem {
            q_dof_count: self.q_dof_count,
            phi_dof_count: self.phi_dof_count,
            a_qq_csr: self.a_qq_csr.view(),
            a_qphi_csr: self.a_qphi_csr.view(),
            a_phiq_csr: self.a_phiq_csr.view(),
            a_phiphi_csr: self.a_phiphi_csr.view(),
            b_qq_csr: self.b_qq_csr.view(),
            phi_mean_weights: &self.phi_mean_weights,
            target_frequency_hz: self.target_frequency_hz,
            expected_reference_frequency_hz: self.expected_reference_frequency_hz,
            // Task 6 owns transport of the certificate ID through the C ABI.
            // The existing ABI can nevertheless advertise only v6 material.
            periodic_mesh_certificate_schema: "periodic_mesh_certificate.v6",
            magnetic_pair_count: self.magnetic_pair_count,
            airbox_pair_count: self.airbox_pair_count,
            outer_boundary_kind: self.outer_boundary_kind,
            robin_beta: self.robin_beta,
            gauge_policy: self.gauge_policy,
            gauge_reason: self.gauge_reason,
            assembly_kind: self.assembly_kind,
            shift_invert_action: None,
        }
    }
}

pub(super) fn build_pa_e4b_k0_kittel_poisson_airbox_payload(
    plan: &FemEigenPlanIR,
) -> Result<Option<OwnedModalEigenPoissonAirboxBlockProblem>, RunError> {
    if !k0_kittel_periodic_airbox_validation_requested(plan) {
        return Ok(None);
    }
    let validation = plan.k0_kittel_validation.as_ref().ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload requires K0-3 validation metadata".to_string(),
    })?;
    let sample = validation.samples.first().ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload requires at least one K0-3 field sample"
            .to_string(),
    })?;
    let h0 = plan
        .external_field
        .map(vector_norm)
        .or_else(|| {
            plan.bias_field_samples
                .first()
                .map(|sample| vector_norm(sample.field_a_per_m))
        })
        // This fallback is retained only for the standalone analytical Kittel
        // oracle builder.  It is never used by execute_cpu_fem_eigen or
        // execute_gpu_fem_eigen, which require BiasFieldSweepIR for physical
        // field scans.
        .unwrap_or_else(|| vector_norm(sample.bias_field));
    let m_eff = validation
        .material
        .effective_magnetisation
        .ok_or_else(|| RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires effective_magnetisation"
                .to_string(),
        })?;
    if !(h0 > 0.0) || !(m_eff > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive H0 and M_eff".to_string(),
        });
    }
    let pair_stats = periodic_domain_pair_stats(&plan.mesh)?;
    let magnetic_pair_count = pair_stats.magnetic_pair_count;
    let airbox_pair_count = pair_stats.airbox_pair_count;
    if magnetic_pair_count == 0 || airbox_pair_count == 0 {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive magnetic and airbox periodic pair counts".to_string(),
        });
    }
    let airbox_size_m = pa_e4b_airbox_size_m(plan)?;
    let omega0 = plan.gyromagnetic_ratio * h0;
    let demag_delta = plan.gyromagnetic_ratio * m_eff;
    let q_dof_count = magnetic_pair_count.checked_mul(2).ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload q DOF count overflow".to_string(),
    })?;
    let phi_dof_count = airbox_pair_count.checked_mul(2).ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload phi DOF count overflow".to_string(),
    })?;
    if q_dof_count > 128 || phi_dof_count > 128 {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 validation payload currently supports at most 128 q and 128 phi DOF".to_string(),
        });
    }
    let q_len = usize::try_from(q_dof_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload q DOF count overflow".to_string(),
    })?;
    let phi_len = usize::try_from(phi_dof_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload phi DOF count overflow".to_string(),
    })?;
    let mut a_qq = vec![0.0; q_len * q_len];
    let mut a_qphi = vec![0.0; q_len * phi_len];
    let mut a_phiq = vec![0.0; phi_len * q_len];
    let mut a_phiphi = vec![0.0; phi_len * phi_len];
    let mut b_qq = vec![0.0; q_len * q_len];
    let total_airbox_pair_length = pair_stats.airbox_pair_lengths_m.iter().sum::<f64>();
    if !(total_airbox_pair_length.is_finite() && total_airbox_pair_length > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive total airbox periodic pair length".to_string(),
        });
    }
    let reference_airbox_pair_length = airbox_size_m;
    for magnetic_pair in 0..usize::try_from(magnetic_pair_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload magnetic pair count overflow".to_string(),
    })? {
        let q0 = 2 * magnetic_pair;
        let q1 = q0 + 1;
        let mass = pair_stats.magnetic_pair_masses[magnetic_pair];
        a_qq[q0 * q_len + q1] = -omega0 * mass;
        a_qq[q1 * q_len + q0] = omega0 * mass;
        b_qq[q0 * q_len + q0] = mass;
        b_qq[q1 * q_len + q1] = mass;

        let phi0 = (2 * magnetic_pair) % phi_len;
        let phi1 = (phi0 + 1) % phi_len;
        let airbox_pair = magnetic_pair % pair_stats.airbox_pair_lengths_m.len();
        let poisson_conductance =
            reference_airbox_pair_length / pair_stats.airbox_pair_lengths_m[airbox_pair];
        let coupling_shape = poisson_conductance.sqrt();
        a_qphi[q0 * phi_len + phi0] -= demag_delta * mass * coupling_shape;
        a_qphi[q0 * phi_len + phi1] += demag_delta * mass * coupling_shape;
        a_phiq[phi0 * q_len + q1] -= coupling_shape;
        a_phiq[phi1 * q_len + q1] += coupling_shape;
    }
    if phi_len == 1 {
        a_phiphi[0] = 1.0;
    } else {
        let edge_count = if phi_len == 2 { 1 } else { phi_len };
        for index in 0..edge_count {
            let next = (index + 1) % phi_len;
            let airbox_pair = (index / 2).min(pair_stats.airbox_pair_lengths_m.len() - 1);
            let conductance =
                reference_airbox_pair_length / pair_stats.airbox_pair_lengths_m[airbox_pair];
            a_phiphi[index * phi_len + index] += conductance;
            a_phiphi[next * phi_len + next] += conductance;
            a_phiphi[index * phi_len + next] -= conductance;
            a_phiphi[next * phi_len + index] -= conductance;
        }
    }
    let mut phi_mean_weights = Vec::with_capacity(phi_len);
    for pair_length in &pair_stats.airbox_pair_lengths_m {
        let weight = *pair_length / (2.0 * total_airbox_pair_length);
        phi_mean_weights.push(weight);
        phi_mean_weights.push(weight);
    }
    Ok(Some(OwnedModalEigenPoissonAirboxBlockProblem {
        q_dof_count,
        phi_dof_count,
        a_qq_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, q_dof_count, &a_qq)?,
        a_qphi_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, phi_dof_count, &a_qphi)?,
        a_phiq_csr: OwnedModalEigenCsrMatrix::from_dense(phi_dof_count, q_dof_count, &a_phiq)?,
        a_phiphi_csr: OwnedModalEigenCsrMatrix::from_dense(
            phi_dof_count,
            phi_dof_count,
            &a_phiphi,
        )?,
        b_qq_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, q_dof_count, &b_qq)?,
        phi_mean_weights,
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        // Kittel is an independent postsolve validation oracle. Keep the
        // legacy ABI slot empty so it cannot influence selection or status.
        expected_reference_frequency_hz: 0.0,
        magnetic_pair_count,
        airbox_pair_count,
        outer_boundary_kind: "pure_neumann",
        robin_beta: 0.0,
        gauge_policy: "mean_zero_augmented",
        gauge_reason: "pure_neumann_nullspace",
        assembly_kind: "synthetic_algebraic_oracle",
    }))
}

pub(super) fn validate_eigen_equilibrium_certificate(
    plan: &FemEigenPlanIR,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
) -> Result<(), RunError> {
    match &plan.equilibrium {
        EquilibriumSourceIR::RelaxedInitialState if source_relax_handoff.is_none() => {
            return Err(RunError {
                message: "accepted relaxation handoff is required before FEM eigensolve"
                    .to_string(),
            });
        }
        EquilibriumSourceIR::Provided
            if source_relax_handoff.is_none() && expected_handoff.is_none() =>
        {
            return Err(RunError {
                message: "uncertified_provided_equilibrium: provide equilibrium_artifact.v7 or an accepted relaxation handoff"
                    .to_string(),
            });
        }
        _ => {}
    }
    if let Some(handoff) = expected_handoff {
        if !matches!(plan.equilibrium, EquilibriumSourceIR::Provided) {
            return Err(RunError {
                message: "relax_to_eigen_handoff_requires_provided_equilibrium_target".to_string(),
            });
        }
        handoff.validate_target_plan(plan)?;
    }
    Ok(())
}

/// Explicit validation-only adapter for unit fixtures that need to exercise
/// post-certificate solver code with a raw `Provided` vector. Production code
/// cannot name this function and must supply a real artifact or relax handoff.
#[cfg(test)]
pub(super) fn validation_only_raw_provided_fixture_handoff(
    plan: &FemEigenPlanIR,
) -> Result<AcceptedFemEigenEquilibriumHandoff, RunError> {
    if !matches!(plan.equilibrium, EquilibriumSourceIR::Provided) {
        return Err(RunError {
            message: "validation_only_raw_provided_requires_provided_equilibrium".to_string(),
        });
    }
    AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        plan,
        plan.equilibrium_magnetization.clone(),
        sha256_text("validation-only raw provided equilibrium artifact"),
        sha256_text("validation-only raw provided linearization state"),
    )
}

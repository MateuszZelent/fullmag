use super::eigen_digest::{is_sha256_digest, shared_domain_content_digest};
use super::eigen_types::{AcceptedEquilibriumCriterion, SharedDomainLinearizationState};
use crate::types::ExecutedRun;
use crate::types::RunError;
use crate::types::StageFemMeshIdentity;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::Vector3;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::KSamplingIR;
use sha2::{Digest, Sha256};

/// Immutable execution input produced by an accepted FEM relaxation stage and
/// consumed by one following single-k eigen stage.
///
/// This is intentionally distinct from [`AcceptedFemEigenEquilibriumHandoff`],
/// which carries a post-linearization state between samples of one k path.
pub(super) const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2: &str = "AcceptedFemRelaxStageHandoff.v2";
#[allow(dead_code)] // Wired by the next migration slice; defined here to freeze the namespace now.
pub(super) const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3: &str = "AcceptedFemRelaxStageHandoff.v3";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptedFemRelaxStageHandoffV2Record {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) content_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Wired by the next migration slice.
pub(super) struct AcceptedFemRelaxStageHandoffV3HashPreimage {
    pub(super) schema_version: String,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) certified_fields_content_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptedFemRelaxStageHandoffV3Record {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) certified_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) certified_fields_content_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) content_sha256: String,
}

impl AcceptedEquilibriumCriterion {
    pub(super) fn metric_kind_name(&self) -> &'static str {
        match self.metric_kind {
            fullmag_ir::StageMetricKind::MaxTorqueApm => "max_torque_apm",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ => "total_energy_plateau_range_j",
            _ => unreachable!("accepted equilibrium uses only torque or energy"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AcceptedFemRelaxStageHandoff {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) certified_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) content_sha256: String,
}

impl AcceptedFemRelaxStageHandoff {
    pub fn from_completed_relax(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
    ) -> Result<Self, RunError> {
        if source_run_id.trim().is_empty()
            || source_stage_id.trim().is_empty()
            || source_stage_kind.trim().is_empty()
            || !source_stage_is_relaxation
        {
            return Err(RunError {
                message: "relax_stage_handoff_invalid_source_stage: source run/stage identity must name an executed relaxation stage"
                    .to_string(),
            });
        }
        let acceptance = accepted_equilibrium_criterion(completion)?;
        if equilibrium_magnetization.len() != source_mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    source_mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        validate_certified_equilibrium_fields(&certified_fields, source_mesh.nodes.len())?;
        let source_plan_mesh = crate::types::FemMeshPayload::from(source_plan);
        if crate::types::fem_mesh_topology_fingerprint(&source_plan_mesh)
            != crate::types::fem_mesh_topology_fingerprint(source_mesh)
        {
            return Err(RunError {
                message: "relax_stage_handoff_source_plan_mesh_identity_mismatch".to_string(),
            });
        }
        let source_topology =
            MeshTopology::from_ir(&source_plan.mesh).map_err(|error| RunError {
                message: format!("relax_stage_handoff_source_mesh_topology_invalid: {error}"),
            })?;
        validate_handoff_m0_norms(
            &equilibrium_magnetization,
            &source_topology.magnetic_node_volumes,
        )?;
        let source_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(
                source_plan,
            )?;

        let source_mesh_topology_sha256 = crate::types::fem_mesh_topology_fingerprint(source_mesh);
        let stage_fem_mesh_generation_id = source_mesh
            .generation_id
            .as_deref()
            .ok_or_else(|| RunError {
                message: "relax_stage_handoff_missing_mesh_generation_id".to_string(),
            })?
            .to_string();
        // `generation_id` is the cache-invalidating stage identity.  Since the
        // current master carries a payload/cache identity (rather than the
        // topology SHA itself), bind both identities independently.  Accept
        // the historical topology-SHA form during migration, but reject an
        // identity which does not come from the source plan/payload.
        let expected_generation_id = crate::types::FemMeshPayload::from(source_plan)
            .generation_id
            .unwrap_or_default();
        if (stage_fem_mesh_generation_id != expected_generation_id
            && stage_fem_mesh_generation_id != source_mesh_topology_sha256)
            || !is_sha256_digest(&source_mesh_topology_sha256)
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_generation_or_topology_identity_mismatch"
                    .to_string(),
            });
        }

        let indexing_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": source_mesh.cells,
                "element_markers": source_mesh.element_markers,
                "facets": source_mesh.facets,
                "boundary_markers": source_mesh.boundary_markers,
                "periodic_boundary_pairs": source_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": source_mesh.periodic_node_pairs,
            }),
        )?;
        let part_registry_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": source_mesh.object_segments,
                "mesh_parts": source_mesh.mesh_parts,
                "domain_mesh_mode": source_mesh.domain_mesh_mode,
                "domain_frame": source_mesh.domain_frame,
            }),
        )?;
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        let equilibrium_content_sha256 = vector_field_content_sha256(&equilibrium_magnetization);
        let node_count = source_mesh.nodes.len();
        let v2_record = AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id: stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: source_mesh_topology_sha256.clone(),
            node_count,
            indexing_sha256: indexing_sha256.clone(),
            part_registry_sha256: part_registry_sha256.clone(),
            completion_sha256: completion_sha256.clone(),
            completion: completion.clone(),
            acceptance: acceptance.clone(),
            equilibrium_content_sha256: equilibrium_content_sha256.clone(),
            content_sha256: String::new(),
        };
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&v2_record)?;
        let v3_preimage = AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            legacy_v2_content_sha256: legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: certified_fields.content_sha256.clone(),
            equilibrium_material_signature: source_signatures
                .equilibrium_material_signature
                .clone(),
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature
                .clone(),
            equilibrium_boundary_signature: source_signatures
                .equilibrium_boundary_signature
                .clone(),
        };
        let content_sha256 = relax_stage_handoff_v3_content_sha256(&v3_preimage)?;
        Ok(Self {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id,
            source_mesh_topology_sha256,
            node_count,
            indexing_sha256,
            part_registry_sha256,
            completion_sha256,
            completion: completion.clone(),
            acceptance,
            equilibrium_content_sha256,
            equilibrium_magnetization,
            certified_fields,
            legacy_v2_content_sha256,
            acceptance_certificate_sha256,
            equilibrium_material_signature: source_signatures.equilibrium_material_signature,
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature,
            equilibrium_boundary_signature: source_signatures.equilibrium_boundary_signature,
            content_sha256,
        })
    }

    pub(super) fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        if self.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
            return Err(RunError {
                message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
            });
        }
        let accepted = accepted_equilibrium_criterion(&self.completion)?;
        if accepted != self.acceptance {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_mismatch".to_string(),
            });
        }
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(&self.completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        if completion_sha256 != self.completion_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_completion_sha256_mismatch".to_string(),
            });
        }
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&self.acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        if acceptance_certificate_sha256 != self.acceptance_certificate_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_sha256_mismatch".to_string(),
            });
        }
        validate_certified_equilibrium_fields(&self.certified_fields, self.node_count)?;
        let target_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_eigen_plan(
                plan,
            )?;
        if target_signatures.equilibrium_material_signature != self.equilibrium_material_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_material_signature_mismatch".to_string(),
            });
        }
        if target_signatures.equilibrium_static_physics_signature
            != self.equilibrium_static_physics_signature
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_static_physics_signature_mismatch"
                    .to_string(),
            });
        }
        if target_signatures.equilibrium_boundary_signature != self.equilibrium_boundary_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_boundary_signature_mismatch".to_string(),
            });
        }
        if !matches!(plan.equilibrium, EquilibriumSourceIR::RelaxedInitialState) {
            return Err(RunError {
                message: "relax_stage_handoff_requires_relaxed_initial_state_target".to_string(),
            });
        }
        if matches!(plan.k_sampling, Some(KSamplingIR::Path { .. }))
            || !plan.bias_field_samples.is_empty()
        {
            return Err(RunError {
                message: "relax_stage_handoff_requires_single_k_target".to_string(),
            });
        }
        let target_mesh = crate::types::FemMeshPayload::from(plan);
        let target_topology = crate::types::fem_mesh_topology_fingerprint(&target_mesh);
        let target_generation = target_mesh.generation_id.as_deref().unwrap_or_default();
        let target_indexing = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": target_mesh.cells,
                "element_markers": target_mesh.element_markers,
                "facets": target_mesh.facets,
                "boundary_markers": target_mesh.boundary_markers,
                "periodic_boundary_pairs": target_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": target_mesh.periodic_node_pairs,
            }),
        )?;
        let target_parts = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": target_mesh.object_segments,
                "mesh_parts": target_mesh.mesh_parts,
                "domain_mesh_mode": target_mesh.domain_mesh_mode,
                "domain_frame": target_mesh.domain_frame,
            }),
        )?;
        let generation_matches = target_generation == self.stage_fem_mesh_generation_id
            // Historical handoffs used the topology SHA as generation ID;
            // their target still proves identity through the explicit
            // topology field below.
            || (self.stage_fem_mesh_generation_id == self.source_mesh_topology_sha256
                && target_topology == self.source_mesh_topology_sha256);
        if !generation_matches
            || target_topology != self.source_mesh_topology_sha256
            || target_mesh.nodes.len() != self.node_count
            || target_indexing != self.indexing_sha256
            || target_parts != self.part_registry_sha256
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_identity_mismatch: generation/topology/node indexing/part registry must match exactly"
                    .to_string(),
            });
        }
        let target_equilibrium_sha256 =
            vector_field_content_sha256(&plan.equilibrium_magnetization);
        let target_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
            message: format!("relax_stage_handoff_target_mesh_topology_invalid: {error}"),
        })?;
        validate_handoff_m0_norms(
            &plan.equilibrium_magnetization,
            &target_topology.magnetic_node_volumes,
        )?;
        if target_equilibrium_sha256 != self.equilibrium_content_sha256
            || plan.equilibrium_magnetization != self.equilibrium_magnetization
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_content_mismatch".to_string(),
            });
        }
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&self.v2_record())?;
        if legacy_v2_content_sha256 != self.legacy_v2_content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_v2_content_sha256_mismatch".to_string(),
            });
        }
        let recomputed = relax_stage_handoff_v3_content_sha256(&self.v3_hash_preimage())?;
        if recomputed != self.content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_content_sha256_mismatch".to_string(),
            });
        }
        Ok(())
    }

    pub(super) fn v3_hash_preimage(&self) -> AcceptedFemRelaxStageHandoffV3HashPreimage {
        AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: self.schema_version.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
        }
    }

    #[cfg(test)]
    pub(super) fn legacy_v2_provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v2_record()).expect("frozen v2 handoff must serialize")
    }

    pub(super) fn provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v3_record()).expect("typed v3 handoff must serialize")
    }

    pub fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub fn equilibrium_content_sha256(&self) -> &str {
        &self.equilibrium_content_sha256
    }

    pub(super) fn acceptance_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.acceptance)
            .expect("accepted equilibrium criterion must serialize")
    }

    pub(super) fn v2_record(&self) -> AcceptedFemRelaxStageHandoffV2Record {
        AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            content_sha256: self.legacy_v2_content_sha256.clone(),
        }
    }

    pub(super) fn v3_record(&self) -> AcceptedFemRelaxStageHandoffV3Record {
        AcceptedFemRelaxStageHandoffV3Record {
            schema_version: self.schema_version.clone(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            equilibrium_magnetization: self.equilibrium_magnetization.clone(),
            certified_fields: self.certified_fields.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
            content_sha256: self.content_sha256.clone(),
        }
    }
}

fn validate_handoff_m0_norms(
    equilibrium: &[Vector3],
    magnetic_node_volumes: &[f64],
) -> Result<(), RunError> {
    if equilibrium.len() != magnetic_node_volumes.len() {
        return Err(RunError {
            message: format!(
                "relax_stage_handoff_m0_norm_mismatch: topology has {} nodes, equilibrium has {}",
                magnetic_node_volumes.len(),
                equilibrium.len()
            ),
        });
    }
    for (node, magnetization) in equilibrium.iter().enumerate() {
        let norm = magnetization
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        if !norm.is_finite() {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has non-finite norm"
                ),
            });
        }
        if magnetic_node_volumes[node] <= 0.0 {
            continue;
        }
        let norm_error = (norm - 1.0).abs();
        if norm_error > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has norm error {norm_error:.3e}"
                ),
            });
        }
    }
    Ok(())
}

fn accepted_equilibrium_criterion(
    completion: &fullmag_ir::StageCompletionIR,
) -> Result<AcceptedEquilibriumCriterion, RunError> {
    let accepted_metric = match (completion.reason, completion.metric) {
        (
            Some(fullmag_ir::StageStopReason::Torque),
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
        ) => Some(("torque", fullmag_ir::StageMetricKind::MaxTorqueApm)),
        (
            Some(fullmag_ir::StageStopReason::Energy),
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
        ) => Some((
            "energy",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ,
        )),
        _ => None,
    };
    let accepted_values = match (completion.metric_value, completion.threshold) {
        (Some(value), Some(threshold))
            if value.is_finite()
                && threshold.is_finite()
                && threshold >= 0.0
                && value <= threshold =>
        {
            Some((value, threshold))
        }
        _ => None,
    };
    let (Some((criterion, metric_kind)), Some((metric_value, threshold))) =
        (accepted_metric, accepted_values)
    else {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    };
    if completion.status != "completed" || !completion.converged {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    }
    Ok(AcceptedEquilibriumCriterion {
        criterion: criterion.to_string(),
        metric_kind,
        metric_value,
        threshold,
        unit: metric_kind.unit().to_string(),
        status: completion.status.clone(),
        converged: completion.converged,
        stop_reason: completion
            .reason
            .expect("accepted completion has a stop reason"),
    })
}

fn vector_field_content_sha256(values: &[Vector3]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.m0.v1\0");
    hash.update((values.len() as u64).to_le_bytes());
    for vector in values {
        for value in vector {
            hash.update(value.to_bits().to_le_bytes());
        }
    }
    format!("sha256:{:x}", hash.finalize())
}

pub(super) fn relax_stage_handoff_v2_content_sha256(
    record: &AcceptedFemRelaxStageHandoffV2Record,
) -> Result<String, RunError> {
    if record.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2 {
        return Err(RunError {
            message: "relax_stage_handoff_v2_schema_version_mismatch".to_string(),
        });
    }
    let completion_json = serde_json::to_vec(&record.completion).map_err(|error| RunError {
        message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
    })?;
    let acceptance_json = serde_json::to_vec(&record.acceptance).map_err(|error| RunError {
        message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
    })?;
    let node_count = (record.node_count as u64).to_le_bytes();
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v2\0");
    for field in [
        record.source_run_id.as_bytes(),
        record.source_stage_id.as_bytes(),
        record.source_stage_kind.as_bytes(),
        record.stage_fem_mesh_generation_id.as_bytes(),
        record.source_mesh_topology_sha256.as_bytes(),
        node_count.as_slice(),
        record.indexing_sha256.as_bytes(),
        record.part_registry_sha256.as_bytes(),
        record.completion_sha256.as_bytes(),
        completion_json.as_slice(),
        acceptance_json.as_slice(),
        record.equilibrium_content_sha256.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[allow(dead_code)] // Wired by the next migration slice.
pub(super) fn relax_stage_handoff_v3_content_sha256(
    preimage: &AcceptedFemRelaxStageHandoffV3HashPreimage,
) -> Result<String, RunError> {
    if preimage.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
        return Err(RunError {
            message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
        });
    }
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v3\0");
    for field in [
        preimage.legacy_v2_content_sha256.as_bytes(),
        preimage.acceptance_certificate_sha256.as_bytes(),
        preimage.certified_fields_content_sha256.as_bytes(),
        preimage.equilibrium_material_signature.as_bytes(),
        preimage.equilibrium_static_physics_signature.as_bytes(),
        preimage.equilibrium_boundary_signature.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub(super) fn validate_certified_equilibrium_fields(
    fields: &crate::types::CertifiedFemEquilibriumFields,
    expected_node_count: usize,
) -> Result<(), RunError> {
    let valid_shape = expected_node_count > 0
        && fields.schema_version == "CertifiedFemEquilibriumFields.v1"
        && fields.h_ex_a_per_m.len() == expected_node_count
        && fields.h_demag_a_per_m.len() == expected_node_count
        && fields.h_ext_a_per_m.len() == expected_node_count
        && fields.h_eff_a_per_m.len() == expected_node_count
        && fields.phi_a.len() == expected_node_count;
    let finite = [
        &fields.h_ex_a_per_m,
        &fields.h_demag_a_per_m,
        &fields.h_ext_a_per_m,
        &fields.h_eff_a_per_m,
    ]
    .into_iter()
    .flat_map(|values| values.iter())
    .flat_map(|value| value.iter())
    .all(|value| value.is_finite())
        && fields.phi_a.iter().all(|value| value.is_finite());
    let digest = crate::types::certified_equilibrium_fields_sha256(fields);
    if !valid_shape || !finite || fields.content_sha256 != digest {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_invalid: native static fields must be finite, complete, and digest-bound"
                .to_string(),
        });
    }
    let decomposes_exactly = fields
        .h_ex_a_per_m
        .iter()
        .zip(&fields.h_demag_a_per_m)
        .zip(&fields.h_ext_a_per_m)
        .zip(&fields.h_eff_a_per_m)
        .all(|(((h_ex, h_demag), h_ext), h_eff)| {
            (0..3).all(|component| {
                h_eff[component] == (h_ex[component] + h_demag[component]) + h_ext[component]
            })
        });
    if !decomposes_exactly {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_decomposition_mismatch: H_eff must equal H_ex + H_demag + H_ext exactly"
                .to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct AcceptedFemEigenEquilibriumHandoff {
    pub(super) stage_mesh_identity: StageFemMeshIdentity,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) equilibrium_artifact_sha256: String,
    pub(super) linearization_state_sha256: String,
    pub(super) content_sha256: String,
}

impl AcceptedFemEigenEquilibriumHandoff {
    pub(crate) fn from_accepted_linearization(
        plan: &FemEigenPlanIR,
        equilibrium_magnetization: Vec<Vector3>,
        equilibrium_artifact_sha256: String,
        linearization_state_sha256: String,
    ) -> Result<Self, RunError> {
        if equilibrium_magnetization.len() != plan.mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    plan.mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        if !is_sha256_digest(&equilibrium_artifact_sha256)
            || !is_sha256_digest(&linearization_state_sha256)
        {
            return Err(RunError {
                message: "relax_to_eigen_handoff_invalid_digest: equilibrium and linearization identities must be sha256 digests"
                    .to_string(),
            });
        }
        let stage_mesh_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let source_mesh_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if !is_sha256_digest(&source_mesh_topology_sha256)
            || stage_mesh_identity.generation_id().trim().is_empty()
        {
            return Err(RunError {
                message: "relax_to_eigen_stage_mesh_identity_or_topology_invalid".to_string(),
            });
        }
        let payload = serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": &source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": &equilibrium_artifact_sha256,
            "linearization_state_sha256": &linearization_state_sha256,
        });
        let content_sha256 = shared_domain_content_digest("relax_to_eigen_handoff", &payload)?;
        Ok(Self {
            stage_mesh_identity,
            source_mesh_topology_sha256,
            equilibrium_magnetization,
            equilibrium_artifact_sha256,
            linearization_state_sha256,
            content_sha256,
        })
    }

    pub(crate) fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        let target_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let target_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if target_identity != self.stage_mesh_identity
            || !is_sha256_digest(&target_topology_sha256)
            || target_topology_sha256 != self.source_mesh_topology_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_mesh_identity_mismatch: source generation/topology='{}'/'{}', target generation/topology='{}'/'{}'",
                    self.stage_mesh_identity.generation_id(),
                    self.source_mesh_topology_sha256,
                    target_identity.generation_id(),
                    target_topology_sha256,
                ),
            });
        }
        Ok(())
    }

    pub(super) fn validate_consumed_linearization(
        &self,
        plan: &FemEigenPlanIR,
        equilibrium: &[Vector3],
        state: &SharedDomainLinearizationState,
    ) -> Result<(), RunError> {
        self.validate_target_plan(plan)?;
        if equilibrium != self.equilibrium_magnetization {
            return Err(RunError {
                message:
                    "relax_to_eigen_equilibrium_mismatch: provided state differs from accepted relax state"
                        .to_string(),
            });
        }
        if state.equilibrium_artifact_digest != self.equilibrium_artifact_sha256
            || state.linearization_state_digest != self.linearization_state_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_linearization_mismatch: accepted equilibrium/linearization='{}/{}', consumed='{}/{}'",
                    self.equilibrium_artifact_sha256,
                    self.linearization_state_sha256,
                    state.equilibrium_artifact_digest,
                    state.linearization_state_digest,
                ),
            });
        }
        Ok(())
    }

    pub(crate) fn equilibrium_magnetization(&self) -> &[Vector3] {
        &self.equilibrium_magnetization
    }

    pub(crate) fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub(crate) fn source_mesh_topology_sha256(&self) -> &str {
        &self.source_mesh_topology_sha256
    }

    pub(super) fn provenance_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": self.stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": self.source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": self.equilibrium_artifact_sha256,
            "linearization_state_sha256": self.linearization_state_sha256,
            "content_sha256": self.content_sha256,
        })
    }
}

pub(crate) fn accepted_relax_to_eigen_handoff_from_run(
    plan: &FemEigenPlanIR,
    run: &ExecutedRun,
) -> Result<AcceptedFemEigenEquilibriumHandoff, RunError> {
    let summary = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_summary".to_string(),
        })
        .and_then(|artifact| {
            serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| RunError {
                message: format!("invalid_relax_to_eigen_handoff_summary: {error}"),
            })
        })?;
    let diagnostics = summary
        .get("solver_diagnostics")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_diagnostics".to_string(),
        })?;
    let handoff_json = diagnostics
        .get("relax_to_eigen_handoff")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_binding".to_string(),
        })?;
    let required = |field: &str| -> Result<String, RunError> {
        handoff_json
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| RunError {
                message: format!("missing_relax_to_eigen_handoff_field: {field}"),
            })
    };
    let source_topology = required("source_mesh_topology_sha256")?;
    let equilibrium_artifact = required("equilibrium_artifact_sha256")?;
    let linearization_state = required("linearization_state_sha256")?;
    let declared_content = required("content_sha256")?;
    let handoff = AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        plan,
        run.result.final_magnetization.clone(),
        equilibrium_artifact.clone(),
        linearization_state.clone(),
    )?;
    let diagnostic_string =
        |field: &str| diagnostics.get(field).and_then(serde_json::Value::as_str);
    if source_topology != handoff.source_mesh_topology_sha256()
        || declared_content != handoff.content_sha256()
        || diagnostic_string("source_mesh_topology_sha256") != Some(source_topology.as_str())
        || diagnostic_string("relax_to_eigen_handoff_sha256") != Some(declared_content.as_str())
        || diagnostic_string("equilibrium_artifact_sha256") != Some(equilibrium_artifact.as_str())
        || diagnostic_string("linearization_state_sha256") != Some(linearization_state.as_str())
    {
        return Err(RunError {
            message: "relax_to_eigen_handoff_summary_identity_mismatch".to_string(),
        });
    }
    Ok(handoff)
}

#[derive(Debug, Clone)]
pub(super) struct LoadedEquilibriumArtifactV7 {
    pub(super) value: serde_json::Value,
    pub(super) m0: Vec<Vector3>,
    pub(super) h_eff0: Vec<Vector3>,
    pub(super) h_demag0: Vec<Vector3>,
    pub(super) phi0: Vec<f64>,
    pub(super) equilibrium_id: String,
    pub(super) producer_run_id: String,
    pub(super) content_sha256: String,
    pub(super) mesh_signature: String,
    pub(super) material_signature: String,
    pub(super) physics_signature: String,
    pub(super) boundary_signature: String,
    pub(super) static_demag_signature: String,
    pub(super) demag_model: String,
    pub(super) m0_norm_tolerance: f64,
    pub(super) phi0_requirement: String,
    pub(super) periodic_mesh_certificate: serde_json::Value,
    pub(super) acceptance_certificate: AcceptedEquilibriumCriterion,
    pub(super) completion_sha256: String,
}

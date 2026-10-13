//! Read published antenna inspection outputs from immutable accepted Study state.
//! No filesystem discovery, Live solve, magnetic state, or drive-basis promotion.

use std::path::Path;

use fullmag_application::{ProjectId, RunId};
use fullmag_authoring::{StudyPortDataKind, StudyPrimitiveStageKind, StudyStepKind};
use fullmag_ir::BackendPlanIR;
use fullmag_session::{FmsArtifactStatus, FmsTaskLifecycle, SessionStore};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedAntennaPublicationPin {
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub package_object_ref: String,
}

/// The Study step and native antenna stage are deliberately separate identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct AcceptedAntennaInspectionIdentity {
    pub run_id: String,
    pub task_id: String,
    pub study_step_id: String,
    pub native_stage_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub manifest_artifact_id: String,
    pub manifest_object_ref: String,
    pub artifact_id: String,
    pub package_object_ref: String,
    pub case_id: String,
}

pub(crate) struct LoadedAcceptedAntennaInspection {
    pub identity: AcceptedAntennaInspectionIdentity,
    pub loaded: fullmag_runner::LoadedAntennaExternalLeadSolution,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::internal(message.into())
}

fn read_bounded_cas(
    store: &SessionStore,
    object_ref: &str,
    limit: u64,
) -> Result<Vec<u8>, ApiError> {
    let length = store
        .cas()
        .verified_length(object_ref)
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| invalid("accepted antenna CAS object is missing"))?;
    if length == 0 || length > limit {
        return Err(invalid(
            "accepted antenna CAS object exceeds its read budget",
        ));
    }
    let range = store
        .cas()
        .get_verified_range(object_ref, 0, length, limit)
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| invalid("accepted antenna CAS object disappeared during read"))?;
    if range.object_length != length {
        return Err(invalid(
            "accepted antenna CAS object changed length during read",
        ));
    }
    Ok(range.bytes)
}

/// Both discovery and numerical reads use the same accepted publication checks.
/// Catalogs are fenced after the visitor, including any numerical payload reads.
fn with_accepted_antenna_publications<T>(
    store_root: &Path,
    run_id: &RunId,
    project_id: &ProjectId,
    selected_step: Option<&str>,
    mut visit: impl FnMut(
        &SessionStore,
        &fullmag_ir::ExecutionPlanIR,
        AcceptedAntennaInspectionIdentity,
        &fullmag_session::FmsStudyOutputManifestEntry,
    ) -> Result<T, ApiError>,
) -> Result<Vec<T>, ApiError> {
    let store = SessionStore::open_existing(store_root).map_err(|e| invalid(e.to_string()))?;
    let intent = store
        .read_run_intent(run_id.as_str())
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| ApiError::not_found("accepted antenna run intent is missing"))?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)
            .map_err(|e| invalid(format!("invalid accepted antenna RunSpec: {e}")))?;
    if specification.snapshot.project_id != *project_id {
        return Err(ApiError::conflict("run belongs to another project"));
    }
    let accepted =
        fullmag_runtime_control::load_accepted_study_snapshot(&store, run_id, project_id)
            .map_err(|e| invalid(format!("invalid accepted antenna Study snapshot: {e}")))?;
    let run = store
        .read_run_catalog(run_id.as_str())
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| ApiError::not_found("accepted antenna run catalog is missing"))?;
    run.validate().map_err(|e| invalid(e.to_string()))?;
    let catalog = store
        .read_artifact_catalog(run_id.as_str())
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| ApiError::not_found("accepted antenna artifact catalog is missing"))?;
    catalog.validate().map_err(|e| invalid(e.to_string()))?;
    if run.run_id != run_id.as_str() || catalog.run_id != run_id.as_str() {
        return Err(invalid("antenna catalogs belong to another run"));
    }

    let mut results = Vec::new();
    for lowered in &accepted.lowered.steps {
        // Never decode another step's numerical arrays to serve this resource.
        if selected_step.is_some_and(|step| lowered.step_id != step) {
            continue;
        }
        if selected_step.is_some() && !results.is_empty() {
            return Err(invalid("accepted antenna Study step identity is ambiguous"));
        }
        let Some(plan) = &lowered.execution_plan else {
            continue;
        };
        let BackendPlanIR::AntennaExternalLeadInspection(inspection) = &plan.backend_plan else {
            continue;
        };
        if !lowered.enabled
            || !matches!(
                &lowered.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            )
        {
            continue;
        }
        let step = accepted
            .study
            .steps
            .iter()
            .find(|step| step.step_id == lowered.step_id)
            .ok_or_else(|| invalid("antenna execution plan has no accepted Study step"))?;
        if !matches!(
            &step.kind,
            StudyStepKind::Primitive {
                stage_kind: StudyPrimitiveStageKind::AntennaFieldSolve
            }
        ) || step.outputs.len() != 1
            || step.outputs[0].port_id != fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID
            || step.outputs[0].data_kind != StudyPortDataKind::Artifact
            || !step.inputs.is_empty()
            || step.until_seconds.is_some()
        {
            return Err(invalid(
                "accepted antenna step has incompatible controls or outputs",
            ));
        }
        let task_id = fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id)
            .map_err(|e| invalid(e.to_string()))?;
        let task = run
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .ok_or_else(|| invalid("accepted antenna task is missing"))?;
        if task.lifecycle != FmsTaskLifecycle::Succeeded {
            continue;
        }
        let (Some(attempt_id), Some(epoch)) = (task.attempt_id.as_deref(), task.ownership_epoch)
        else {
            return Err(invalid(
                "successful antenna task has no complete attempt identity",
            ));
        };
        let current_entries: Vec<_> = catalog
            .entries
            .iter()
            .filter(|entry| {
                entry.task_id == task_id
                    && entry.attempt_id == attempt_id
                    && entry.ownership_epoch == epoch
                    && entry.status == FmsArtifactStatus::Published
                    && task.artifact_ids.contains(&entry.artifact_id)
            })
            .collect();
        let mut manifests = current_entries
            .iter()
            .copied()
            .filter(|entry| entry.artifact_type == "study_output_manifest");
        let manifest_entry = manifests
            .next()
            .ok_or_else(|| invalid("successful antenna task has no published output manifest"))?;
        if manifests.next().is_some() || manifest_entry.study_output.is_some() {
            return Err(invalid(
                "antenna output manifest is ambiguous or carries an output identity",
            ));
        }
        let manifest_ref = manifest_entry
            .object_ref
            .as_deref()
            .ok_or_else(|| invalid("antenna output manifest has no CAS reference"))?;
        if manifest_ref != manifest_entry.content_sha256 {
            return Err(invalid(
                "antenna output manifest digest differs from CAS reference",
            ));
        }
        // A single-output control-plane manifest is bounded separately from numerical payloads.
        let manifest_bytes = read_bounded_cas(&store, manifest_ref, 1024 * 1024)?;
        let unambiguous: fullmag_antenna_artifacts::artifact_json::UnambiguousJson =
            serde_json::from_slice(&manifest_bytes)
                .map_err(|e| invalid(format!("ambiguous antenna output manifest: {e}")))?;
        let manifest: fullmag_session::FmsStudyOutputManifest =
            serde_json::from_value(unambiguous.0)
                .map_err(|e| invalid(format!("invalid antenna output manifest: {e}")))?;
        manifest.validate().map_err(|e| invalid(e.to_string()))?;
        validate_manifest_attempt(
            &manifest,
            run_id.as_str(),
            &task_id,
            &step.step_id,
            attempt_id,
            epoch,
        )?;
        let output = &manifest.outputs[0];
        validate_output_codec(output)?;
        let logical_identity = fullmag_session::FmsStudyArtifactOutput {
            step_id: step.step_id.clone(),
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
        };
        let mut entries = current_entries
            .iter()
            .copied()
            .filter(|entry| entry.artifact_id == output.artifact_id);
        let entry = entries
            .next()
            .ok_or_else(|| invalid("antenna package is not a current published task artifact"))?;
        if entries.next().is_some()
            || entry.study_output.as_ref() != Some(&logical_identity)
            || entry.artifact_type != output.data_kind
            || entry.object_ref.as_deref() != Some(output.object_ref.as_str())
            || entry.content_sha256 != output.content_sha256
            || output.content_sha256 != output.object_ref
        {
            return Err(invalid(
                "antenna package catalog identity differs from output manifest",
            ));
        }
        // Reject extra current Study outputs, even if the manifest omitted them.
        if current_entries
            .iter()
            .filter(|entry| entry.study_output.is_some())
            .count()
            != 1
        {
            return Err(invalid(
                "antenna task has undeclared or ambiguous published Study outputs",
            ));
        }
        results.push(visit(
            &store,
            plan,
            AcceptedAntennaInspectionIdentity {
                run_id: run_id.as_str().into(),
                task_id,
                study_step_id: step.step_id.clone(),
                native_stage_id: inspection.input.stage.id.clone(),
                attempt_id: attempt_id.into(),
                ownership_epoch: epoch,
                manifest_artifact_id: manifest_entry.artifact_id.clone(),
                manifest_object_ref: manifest_ref.into(),
                artifact_id: output.artifact_id.clone(),
                package_object_ref: output.object_ref.clone(),
                case_id: output.case_id.clone(),
            },
            output,
        )?);
    }
    if store
        .read_run_catalog(run_id.as_str())
        .map_err(|e| invalid(e.to_string()))?
        .as_ref()
        != Some(&run)
        || store
            .read_artifact_catalog(run_id.as_str())
            .map_err(|e| invalid(e.to_string()))?
            .as_ref()
            != Some(&catalog)
    {
        return Err(ApiError::conflict_with_code(
            "antenna_source_conflict",
            "accepted antenna catalogs changed while loading",
        ));
    }
    Ok(results)
}

/// Discovery verifies publication metadata; it deliberately does not read field packages.
pub(crate) fn discover_accepted_antenna_inspections(
    store_root: &Path,
    run_id: &RunId,
    project_id: &ProjectId,
) -> Result<Vec<AcceptedAntennaInspectionIdentity>, ApiError> {
    with_accepted_antenna_publications(store_root, run_id, project_id, None, |_, _, identity, _| {
        Ok(identity)
    })
}

pub(crate) fn load_accepted_antenna_inspection(
    store_root: &Path,
    run_id: &RunId,
    project_id: &ProjectId,
    study_step_id: &str,
    pin: &AcceptedAntennaPublicationPin,
) -> Result<LoadedAcceptedAntennaInspection, ApiError> {
    let mut results = with_accepted_antenna_publications(
        store_root,
        run_id,
        project_id,
        Some(study_step_id),
        |store, plan, identity, output| {
            if identity.attempt_id != pin.attempt_id
                || identity.ownership_epoch != pin.ownership_epoch
                || identity.package_object_ref != pin.package_object_ref
            {
                return Err(ApiError::conflict_with_code(
                    "antenna_source_conflict",
                    "requested antenna publication is no longer current",
                ));
            }
            let bytes = read_bounded_cas(
                store,
                &output.object_ref,
                fullmag_antenna_artifacts::package::ANTENNA_INSPECTION_PACKAGE_MAX_BYTES as u64,
            )?;
            let decoded = fullmag_application::decode_study_artifact_bytes(
                &output.data_kind,
                &output.codec_id,
                &output.codec_version,
                &bytes,
            )
            .map_err(|e| invalid(e.to_string()))?;
            let fullmag_application::DecodedStudyArtifact::AntennaInspection(artifact) = decoded
            else {
                return Err(invalid("antenna codec returned a magnetic artifact"));
            };
            // Drop neutral payload copies before full accepted-plan binding.
            let reference = artifact.reference.clone();
            drop(artifact);
            let loaded = fullmag_runner::load_antenna_inspection_package_for_execution_plan(
                &bytes, &reference, plan,
            )
            .map_err(|e| {
                invalid(format!(
                    "antenna package differs from accepted execution plan: {e}"
                ))
            })?;
            if loaded.manifest.current_display.is_none() {
                return Err(invalid(
                    "accepted antenna package does not retain V/J/H display data",
                ));
            }
            Ok(LoadedAcceptedAntennaInspection { identity, loaded })
        },
    )?;
    results
        .pop()
        .ok_or_else(|| ApiError::not_found("selected antenna step has no published inspection"))
}

fn validate_output_codec(
    output: &fullmag_session::FmsStudyOutputManifestEntry,
) -> Result<(), ApiError> {
    if output.port_id != fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID
        || output.data_kind != "artifact"
        || output.codec_id != fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_ID
        || output.codec_version != fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_VERSION
    {
        return Err(invalid(
            "accepted antenna output has an unsupported port/data-kind/codec tuple",
        ));
    }
    Ok(())
}

fn validate_manifest_attempt(
    manifest: &fullmag_session::FmsStudyOutputManifest,
    run_id: &str,
    task_id: &str,
    step_id: &str,
    attempt_id: &str,
    ownership_epoch: u64,
) -> Result<(), ApiError> {
    if manifest.run_id != run_id
        || manifest.task_id != task_id
        || manifest.step_id != step_id
        || manifest.attempt_id != attempt_id
        || manifest.ownership_epoch != ownership_epoch
        || manifest.accepted_state_ref.is_some()
        || manifest.observation_source.is_some()
        || manifest.outputs.len() != 1
    {
        return Err(invalid(
            "antenna output manifest differs from its accepted attempt or contains magnetic state",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_reader_rejects_magnetic_and_unknown_output_contracts() {
        let output = fullmag_session::FmsStudyOutputManifestEntry {
            port_id: "inspection".into(),
            case_id: "default".into(),
            data_kind: "artifact".into(),
            codec_id: fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_ID.into(),
            codec_version: "v1".into(),
            artifact_id: "artifact".into(),
            object_ref: "a".repeat(64),
            content_sha256: "a".repeat(64),
        };
        assert!(validate_output_codec(&output).is_ok());
        for (port, kind, codec, version) in [
            ("final_state", "artifact", output.codec_id.as_str(), "v1"),
            ("inspection", "state", output.codec_id.as_str(), "v1"),
            ("inspection", "artifact", "fullmag.runner.field_json", "v1"),
            ("inspection", "artifact", output.codec_id.as_str(), "v2"),
        ] {
            let changed = fullmag_session::FmsStudyOutputManifestEntry {
                port_id: port.into(),
                data_kind: kind.into(),
                codec_id: codec.into(),
                codec_version: version.into(),
                ..output.clone()
            };
            assert!(validate_output_codec(&changed).is_err());
        }
        let manifest = fullmag_session::FmsStudyOutputManifest {
            schema_version: fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id: "run".into(),
            task_id: "task".into(),
            step_id: "study-node".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 2,
            accepted_state_ref: None,
            observation_source: None,
            outputs: vec![output],
        };
        assert!(
            validate_manifest_attempt(&manifest, "run", "task", "study-node", "attempt", 2).is_ok()
        );
        for (run, task, step, attempt, epoch) in [
            ("another-run", "task", "study-node", "attempt", 2),
            ("run", "another-task", "study-node", "attempt", 2),
            ("run", "task", "native-stage", "attempt", 2),
            ("run", "task", "study-node", "old-attempt", 2),
            ("run", "task", "study-node", "attempt", 1),
        ] {
            assert!(validate_manifest_attempt(&manifest, run, task, step, attempt, epoch).is_err());
        }
        let empty = fullmag_session::FmsStudyOutputManifest {
            outputs: vec![],
            ..manifest
        };
        assert!(
            validate_manifest_attempt(&empty, "run", "task", "study-node", "attempt", 2).is_err()
        );
    }
}

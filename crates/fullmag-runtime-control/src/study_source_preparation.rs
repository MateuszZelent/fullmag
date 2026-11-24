//! Input-only projection of a fully authenticated closed-loop source, without solver outputs.
use anyhow::{bail, Context, Result};
use fullmag_antenna_artifacts::source_preparation::{
    AntennaSourcePreparationAssetDocument, ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA,
};
use fullmag_antenna_artifacts::retained_current::{ParentCurrentDigests, ParentInspectionOwner, RetainedCurrentParent};
use fullmag_application::{AcceptedPreparationReceipt, ProjectId};
use fullmag_ir::{AntennaRetainedCurrentSourceIR, AntennaSourcePreparationReceiptPinsIR};
use fullmag_session::{SessionStore, accepted_provenance::AcceptedStoreProvenanceContext};
use serde::Serialize;
use crate::{LoadedSavedRetainedCurrentEvidence, study_retained_current as parent_reader};
use crate::study_inspection_integrity::{acquire_inspection_read_transaction, SavedInspectionReadContext};

#[derive(Debug, Serialize)]
pub struct AntennaSourcePreparationExportReceipt {
    pub schema_version: String,
    pub parent_owner: ParentInspectionOwner,
    pub byte_count: u64,
    pub content_sha256: String,
}

pub struct AntennaSourcePreparationExport {
    pub bytes: Vec<u8>,
    pub receipt: AntennaSourcePreparationExportReceipt,
}

/// Complete the original durable/physical source gate once, then encode only its inputs.
/// The explicit output file belongs to the CLI; no CAS or history is written here.
pub fn encode_saved_antenna_source_preparation(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
) -> Result<AntennaSourcePreparationExport> {
    parent_reader::validate_locator_project(project, source)?;
    let transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
    let document = parent_reader::read_saved_retained_current(store, &transaction, project, source,
        |loaded, read| project_source_preparation(store, loaded.owner(), loaded.source_digests(), &read))?;
    drop(transaction);
    let bytes = document.encode().map_err(|error| anyhow::anyhow!(error.message))?;
    let receipt = AntennaSourcePreparationExportReceipt {
        schema_version: "antenna_source_preparation_export.v1".into(),
        parent_owner: document.parent_owner, byte_count: bytes.len() as u64,
        content_sha256: fullmag_session::hex_sha256(&bytes),
    };
    Ok(AntennaSourcePreparationExport { bytes, receipt })
}

/// New asset consumers verify outside SH and recheck the exact captured authority before return.
/// Existing readers keep their previous allocation/validation contract.
pub fn load_saved_retained_current_source_preparation_with_store_evidence(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
) -> Result<(LoadedSavedRetainedCurrentEvidence, AntennaSourcePreparationAssetDocument)> {
    parent_reader::validate_locator_project(project, source)?;
    let AntennaRetainedCurrentSourceIR::PublishedInspection { run_id, .. } = source;
    let binding = crate::accepted_store::store_binding(store.root()).context("source preparation store has no stable binding")?;
    let context = AcceptedStoreProvenanceContext {
        source_store_binding: format!("sha256:{binding}"), accepted_run_id: run_id.clone(),
    };
    context.validate()?;
    crate::study_inspection_integrity::with_deferred_source_inspection(store, run_id, |fence| {
        let (evidence, document) = parent_reader::read_saved_retained_current(store, fence, project, source, |loaded, read| {
            let document = project_source_preparation(store, loaded.owner(), loaded.source_digests(), &read)?;
            let evidence = parent_reader::capture_parent_evidence(store, loaded,
                parent_reader::ParentCaptureContext::Store(&context), &read)?;
            Ok((evidence, document))
        })?;
        fence.require_captured_source_records(evidence.provenance().records())?;
        let objects = evidence.provenance().cas_objects().to_vec();
        Ok(((evidence, document), objects))
    })
}

pub fn load_saved_retained_current_source_preparation_with_pinned_evidence(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
    expected_parent: &RetainedCurrentParent,
) -> Result<(LoadedSavedRetainedCurrentEvidence, AntennaSourcePreparationAssetDocument)> {
    parent_reader::validate_pinned_parent_locator(project, source, expected_parent)?;
    let AntennaRetainedCurrentSourceIR::PublishedInspection { run_id, .. } = source;
    crate::study_inspection_integrity::with_deferred_source_inspection(store, run_id, |fence| {
        let (evidence, document) = parent_reader::read_pinned_retained_current_with(store, fence, project, source, expected_parent,
            |evidence, read| {
                let document = project_source_preparation(store, &evidence.parent().owner, evidence.parent().source.clone(), &read)?;
                Ok((evidence, document))
            })?;
        let mut objects = evidence.provenance().cas_objects().to_vec();
        objects.extend(evidence.metadata_objects().iter().map(|(object_ref, bytes)|
            fullmag_session::accepted_provenance::AcceptedProvenanceCasObject {
                object_ref: object_ref.clone(), byte_count: bytes.len() as u64,
            }));
        Ok(((evidence, document), objects))
    })
}

/// Reuse the publication owner's reentrant EX; never acquire SH beneath it.
pub(crate) fn load_pinned_retained_current_source_preparation_for_publication(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
    expected_parent: &RetainedCurrentParent,
) -> Result<(LoadedSavedRetainedCurrentEvidence, AntennaSourcePreparationAssetDocument)> {
    parent_reader::validate_pinned_parent_locator(project, source, expected_parent)?;
    let transaction = store.write_transaction()?;
    let result = parent_reader::read_pinned_retained_current_with(store, &transaction, project, source, expected_parent,
        |evidence, read| {
            let document = project_source_preparation(store, &evidence.parent().owner, evidence.parent().source.clone(), &read)?;
            Ok((evidence, document))
        })?;
    drop(transaction);
    Ok(result)
}

fn project_source_preparation(
    store: &SessionStore, owner: &ParentInspectionOwner, source_pins: ParentCurrentDigests,
    read: &SavedInspectionReadContext<'_>,
) -> Result<AntennaSourcePreparationAssetDocument> {
    let fullmag_authoring::StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id } = &read.step.kind
        else { bail!("source preparation export requires the original closed-loop operation"); };
    let AcceptedPreparationReceipt::ClosedLoop(preparation) = read.preparation
        else { bail!("source preparation export requires its actual closed-loop receipt"); };
    let problem = read.accepted.catalog.entries().iter().find(|entry| entry.step_id() == read.step.step_id)
        .context("source preparation export has no immutable ProblemIR")?.problem();
    let operation = fullmag_plan::validate_closed_loop_operation(problem, stage_id, port_mode_id, output_id)?;
    let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, .. } = operation
        else { bail!("source preparation export selected another source family"); };
    let durable = store.read_task_preparation_receipt(&owner.run_id, &owner.task_id)?
        .context("source preparation export receipt is missing")?;
    if durable.run_id != owner.run_id || durable.task_id != owner.task_id || durable.step_id != owner.study_step_id
        || durable.preparation_id != preparation.preparation_id || durable.plan_fingerprint != preparation.plan_fingerprint
        || durable.input_fingerprint != read.task.input_fingerprint
        || durable.payload != read.preparation.payload()? {
        bail!("source preparation export receipt differs from its authenticated source");
    }
    let raw = fullmag_session::repository_path::read_bounded_regular_file(store.root(), &durable.relative_path()?,
        fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES as usize)?;
    let document = AntennaSourcePreparationAssetDocument {
        schema_version: ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA.into(), parent_owner: owner.clone(), source_pins,
        source_mesh: input.source_mesh, source_object_segments: input.source_object_segments,
        prepared_source: input.source, authored_input_preimage: input.authored_input_preimage,
        source_preparation: AntennaSourcePreparationReceiptPinsIR {
            receipt_schema_version: durable.schema_version, run_id: durable.run_id, task_id: durable.task_id,
            step_id: durable.step_id, input_fingerprint: durable.input_fingerprint,
            preparation_id: durable.preparation_id, plan_fingerprint: durable.plan_fingerprint,
            payload_sha256: durable.payload_sha256, receipt_sha256: fullmag_session::hex_sha256(&raw),
        },
    };
    document.validate().map_err(|error| anyhow::anyhow!(error.message))?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_projection_rejects_foreign_locator_before_reading_corrupt_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        std::fs::write(store.root().join("WRITER.lock"), b"invalid").unwrap();
        let source = AntennaRetainedCurrentSourceIR::PublishedInspection {
            project_id: "project-other".into(), run_id: "run-parent".into(), task_id: "task-parent".into(),
            attempt_id: "attempt-parent".into(), ownership_epoch: "1".into(), artifact_id: "artifact-parent".into(),
            object_ref: "a".repeat(64),
        };
        let error = encode_saved_antenna_source_preparation(&store, &ProjectId::parse("project-child").unwrap(), &source)
            .err().unwrap();
        assert!(error.to_string().contains("another project"));
    }
}

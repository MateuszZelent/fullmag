//! Read-only modal projection for portable accepted exports/imports.
//! Solver evidence comes exclusively from the detached, catalog-pinned CAS
//! bundle. The live artifact root selects a generation, never supplies bytes.

use crate::accepted_modal_publication::ModalPublicationCandidate;
use crate::error::ApiError;
use crate::types::SessionStateResponse;
use fullmag_session::accepted_provenance::{
    AcceptedProvenanceManifest, AcceptedProvenancePlan, AcceptedProvenanceRecordKind,
};
use fullmag_session::frequency_domain_artifact_generation::{self as generation, GenerationCommit};
use fullmag_session::{
    FmsArtifactCatalog, FmsArtifactStatus, FmsRunCatalog, FmsStagedPreflight, FmsTaskLifecycle,
    SessionStore,
};
use serde::de::DeserializeOwned;

fn invalid(message: impl std::fmt::Display) -> ApiError {
    ApiError::conflict_with_code(
        "accepted_modal_archive_invalid",
        format!("accepted modal archive: {message}"),
    )
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(invalid)
}

fn candidate(
    run_id: &str,
    session_id: &str,
    commit: &GenerationCommit,
    tasks: &FmsRunCatalog,
    artifacts: &FmsArtifactCatalog,
    mut read: impl FnMut(&str) -> Result<Vec<u8>, ApiError>,
) -> Result<ModalPublicationCandidate, ApiError> {
    tasks.validate().map_err(invalid)?;
    artifacts.validate().map_err(invalid)?;
    if tasks.run_id != run_id || artifacts.run_id != run_id {
        return Err(invalid("catalog owner differs from accepted run"));
    }
    let owner = commit
        .content
        .producer
        .as_ref()
        .ok_or_else(|| invalid("generation has no producer"))?;
    if owner.run_id != run_id {
        return Err(invalid("generation belongs to another run"));
    }
    let mut selected = None;
    for entry in &artifacts.entries {
        let Some(output) = entry.study_output.as_ref() else {
            continue;
        };
        if entry.artifact_type != "artifact"
            || entry.status != FmsArtifactStatus::Published
            || output.step_id != owner.stage_id
            || output.port_id != fullmag_application::MODAL_EIGEN_OUTPUT_PORT
            || output.case_id != "default"
        {
            continue;
        }
        let Some(task) = tasks
            .tasks
            .iter()
            .find(|task| task.task_id == entry.task_id)
        else {
            continue;
        };
        if task.lifecycle != FmsTaskLifecycle::Succeeded
            || task.attempt_id.as_deref() != Some(entry.attempt_id.as_str())
            || task.ownership_epoch != Some(entry.ownership_epoch)
            || !task.artifact_ids.contains(&entry.artifact_id)
        {
            continue;
        }
        let object_ref = entry
            .object_ref
            .as_ref()
            .ok_or_else(|| invalid("modal artifact has no CAS reference"))?;
        if entry.content_sha256 != *object_ref {
            return Err(invalid("modal artifact digest differs from CAS identity"));
        }
        let bytes = read(object_ref)?;
        if fullmag_session::hex_sha256(&bytes) != *object_ref {
            return Err(invalid("modal CAS bytes changed"));
        }
        let bundle = fullmag_application::decode_modal_eigen_bundle(
            &bytes,
            fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES,
        )
        .map_err(invalid)?;
        if bundle.generation_id != commit.generation_id {
            continue;
        }
        let value = ModalPublicationCandidate {
            task_order: 0,
            task_id: entry.task_id.clone(),
            attempt_id: entry.attempt_id.clone(),
            ownership_epoch: entry.ownership_epoch,
            step_id: output.step_id.clone(),
            object_ref: object_ref.clone(),
            bundle,
        };
        crate::accepted_modal_publication::validate_candidate_identity(session_id, run_id, &value)?;
        let (verified, _) =
            crate::accepted_modal_publication::validate_bundle_payload(session_id, run_id, &value)?;
        if verified != *commit {
            return Err(invalid(
                "selected commit differs from accepted CAS generation",
            ));
        }
        if selected.replace(value).is_some() {
            return Err(invalid("modal generation has ambiguous catalog lineage"));
        }
    }
    selected.ok_or_else(|| {
        invalid("no succeeded catalog-pinned CAS bundle owns the projected generation")
    })
}

/// Rebuild into the export store through the existing immutable publisher.
/// No file from the live UI directory is copied or used as solver evidence.
pub(super) fn capture(
    store: &SessionStore,
    snapshot: &SessionStateResponse,
    plan: &AcceptedProvenancePlan,
) -> Result<(), ApiError> {
    let Some(source) = crate::session::current_artifact_dir(snapshot) else {
        return Ok(());
    };
    let Some(current) = generation::capture(&source).map_err(invalid)? else {
        return Ok(());
    };
    if !current.is_immutable() {
        return Err(invalid("accepted projection must be immutable"));
    }
    let record = |kind| -> Result<Vec<u8>, ApiError> {
        let records = plan
            .records
            .iter()
            .filter(|record| record.kind == kind)
            .collect::<Vec<_>>();
        if records.len() != 1 {
            return Err(invalid("accepted catalog record missing or ambiguous"));
        }
        plan.read_record(records[0]).map_err(invalid)
    };
    let tasks = decode(&record(AcceptedProvenanceRecordKind::RunCatalog)?)?;
    let artifacts = decode(&record(AcceptedProvenanceRecordKind::ArtifactCatalog)?)?;
    let accepted = SessionStore::open_existing(&plan.source_root).map_err(invalid)?;
    let value = candidate(
        &snapshot.session.run_id,
        &snapshot.session.session_id,
        &current.commit,
        &tasks,
        &artifacts,
        |object_ref| {
            if !plan
                .cas_objects
                .iter()
                .any(|object| object.object_ref == object_ref)
            {
                return Err(invalid(
                    "modal CAS is outside the captured accepted closure",
                ));
            }
            accepted
                .cas()
                .get_bounded(
                    object_ref,
                    fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES as u64,
                )
                .map_err(invalid)?
                .ok_or_else(|| invalid("accepted modal CAS is missing"))
        },
    )?;
    current.ensure_current(&source).map_err(invalid)?;
    let target = store
        .root()
        .join("runs")
        .join(&snapshot.session.run_id)
        .join("artifacts");
    crate::accepted_modal_publication::publish_modal_bundle(
        &target,
        &snapshot.session.session_id,
        &snapshot.session.run_id,
        &value,
    )
}

/// Cross-check projected archive files against the detached accepted bundle
/// before any import normalization, destination publication or live replacement.
pub(super) fn validate_import(
    staged: &FmsStagedPreflight,
    snapshot: &super::PersistedCurrentLiveSnapshot,
) -> Result<(), ApiError> {
    let Some(reference) = staged.session.accepted_provenance_ref.as_ref() else {
        return Ok(());
    };
    let prefix = format!("runs/{}/artifacts/", reference.accepted_run_id);
    let marker = format!("{prefix}{}", generation::IMMUTABLE_COMMIT_PATH);
    if !staged.contains_document(&marker) {
        return Ok(());
    }
    let marker_bytes = staged.read_document(&marker).map_err(invalid)?;
    let commit: GenerationCommit = decode(&marker_bytes)?;
    let plan: AcceptedProvenanceManifest = decode(
        &staged
            .read_document(&reference.manifest_ref)
            .map_err(invalid)?,
    )?;
    let record = |kind| -> Result<Vec<u8>, ApiError> {
        let records = plan
            .records
            .iter()
            .filter(|record| record.kind == kind)
            .collect::<Vec<_>>();
        if records.len() != 1 {
            return Err(invalid("detached catalog missing or ambiguous"));
        }
        staged
            .read_document(&records[0].archive_path)
            .map_err(invalid)
    };
    let tasks = decode(&record(AcceptedProvenanceRecordKind::RunCatalog)?)?;
    let artifacts = decode(&record(AcceptedProvenanceRecordKind::ArtifactCatalog)?)?;
    let value = candidate(
        &reference.accepted_run_id,
        &snapshot.session.session_id,
        &commit,
        &tasks,
        &artifacts,
        |object_ref| {
            if !plan
                .cas_objects
                .iter()
                .any(|object| object.object_ref == object_ref)
            {
                return Err(invalid("modal CAS is outside detached closure"));
            }
            staged
                .read_payload_bounded(
                    &format!("objects/sha256/{object_ref}"),
                    fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES as u64,
                )
                .map_err(invalid)
        },
    )?;
    if value.bundle.commit_bytes != marker_bytes {
        return Err(invalid("archive marker differs from accepted bundle"));
    }
    let generation_id = commit
        .generation_id
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("invalid generation digest"))?;
    for (path, expected) in &value.bundle.payloads {
        let name = format!(
            "{prefix}{}/{generation_id}/{path}",
            generation::GENERATION_DIRECTORY
        );
        let actual = staged
            .read_payload_bounded(&name, expected.len() as u64)
            .map_err(invalid)?;
        if actual != *expected {
            return Err(invalid(
                "projected archive member differs from accepted CAS",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_session::frequency_domain_artifact_generation::{
        GenerationBody, GenerationMember, PublicationOwner,
    };
    use std::collections::BTreeMap;

    // A transport fixture with a nonempty complex field, not a solver or
    // scientific qualification fixture. Every referenced Zarr member is real.
    fn fixture() -> (
        GenerationCommit,
        FmsRunCatalog,
        FmsArtifactCatalog,
        Vec<u8>,
        BTreeMap<String, Vec<u8>>,
    ) {
        let store = "eigen/mode_fields.zarr";
        let array = format!("{store}/sample_0000/mode_0000/vector_xyz_complex");
        let chunk = format!("{array}/0.0.0");
        let compatibility = "eigen/mode_fields/sample_0000/mode_0000/vector.bin";
        let metadata = "eigen/modes/sample_0000/mode_0000.json";
        let vector = [1.0_f64, 0.0, 0.0, 1.0, 0.0, 0.0]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>();
        let json = |value: serde_json::Value| serde_json::to_vec(&value).unwrap();
        let mut payloads = BTreeMap::from([
            (
                "metadata.json".into(),
                json(serde_json::json!({
                    "problem_meta": {"runtime_metadata": {"producer_run_id": "run-modal",
                        "producer_stage_id": "eigen", "producer_stage_kind": "eigenmodes"}},
                    "material_field_assets": []
                })),
            ),
            (
                "frequency_domain/manifest.v1.json".into(),
                json(serde_json::json!({
                    "schema_version": "frequency_domain_manifest.v1", "analysis_family": "magnetic_frequency_domain",
                    "study_product": "modal_eigen", "session_id": "session-modal", "run_id": "run-modal",
                    "stage_id": "eigen", "stage_kind": "eigenmodes", "runtime_id": "runtime-fixture",
                    "artifacts": {"spectrum_v2_path": "eigen/spectrum.v2.json",
                        "mode_field_zarr_store_path": store, "mode_metadata_paths": [metadata]}
                })),
            ),
            (
                "eigen/spectrum.v2.json".into(),
                json(serde_json::json!({
                    "schema_version": "eigen_spectrum.v2", "modes": [{"sample_index": 0,
                        "raw_mode_index": 0, "frequency_real_hz": 9.3e9}]
                })),
            ),
            (
                metadata.into(),
                json(serde_json::json!({
                    "storage_format": "zarr", "zarr_store_path": store, "zarr_array_path": array,
                    "zarr_chunk_path": chunk, "compatibility_binary_payload_path": compatibility
                })),
            ),
            (
                format!("{array}/.zarray"),
                json(serde_json::json!({
                    "zarr_format": 2, "shape": [1,3,2], "chunks": [1,3,2], "dtype": "<f8",
                    "compressor": null, "fill_value": 0, "order": "C", "filters": null
                })),
            ),
            (format!("{array}/.zattrs"), b"{}".to_vec()),
            (chunk.clone(), vector.clone()),
            (compatibility.into(), vector),
        ]);
        for group in [
            store.to_string(),
            format!("{store}/sample_0000"),
            format!("{store}/sample_0000/mode_0000"),
        ] {
            payloads.insert(format!("{group}/.zgroup"), br#"{"zarr_format":2}"#.to_vec());
        }
        payloads.insert(format!("{store}/.zattrs"), b"{}".to_vec());
        let body = GenerationBody {
            schema_version: generation::IMMUTABLE_SCHEMA.into(),
            producer: Some(PublicationOwner {
                run_id: "run-modal".into(),
                stage_id: "eigen".into(),
                stage_kind: "eigenmodes".into(),
            }),
            members: payloads
                .iter()
                .map(|(path, bytes)| {
                    (
                        path.clone(),
                        GenerationMember {
                            byte_length: bytes.len() as u64,
                            sha256: generation::digest(bytes),
                        },
                    )
                })
                .collect(),
        };
        let commit = GenerationCommit {
            generation_id: generation::generation_id(&body).unwrap(),
            content: body,
        };
        let bytes = fullmag_application::encode_modal_eigen_bundle(
            &serde_json::to_vec_pretty(&commit).unwrap(),
            &payloads,
            fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES,
        )
        .unwrap();
        let object = fullmag_session::hex_sha256(&bytes);
        let task_id = fullmag_session::task_id_for_study_step("run-modal", "eigen").unwrap();
        let tasks = decode(&json(serde_json::json!({
            "schema_version": fullmag_session::FMS_RUN_CATALOG_SCHEMA, "run_id": "run-modal", "revision": 1,
            "updated_at": chrono::Utc::now(), "tasks": [{"task_id": task_id, "input_fingerprint": "a".repeat(64),
                "lifecycle": "succeeded", "attempt_id": "attempt-modal", "ownership_epoch": 1,
                "artifact_ids": ["artifact-modal"]}]
        }))).unwrap();
        let artifacts = decode(&json(serde_json::json!({
            "schema_version": fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA, "run_id": "run-modal", "revision": 1,
            "updated_at": chrono::Utc::now(), "entries": [{"artifact_id": "artifact-modal", "task_id": task_id,
                "attempt_id": "attempt-modal", "ownership_epoch": 1, "logical_path": "eigen/bundle.bin",
                "artifact_type": "artifact", "content_sha256": object, "object_ref": object,
                "status": "published", "required": true,
                "study_output": {"step_id": "eigen", "port_id": fullmag_application::MODAL_EIGEN_OUTPUT_PORT, "case_id": "default"}}]
        }))).unwrap();
        (commit, tasks, artifacts, bytes, payloads)
    }

    #[test]
    fn selects_and_publishes_exact_nonempty_complex_bundle() {
        let (commit, tasks, artifacts, bytes, payloads) = fixture();
        let value = candidate(
            "run-modal",
            "session-modal",
            &commit,
            &tasks,
            &artifacts,
            |_| Ok(bytes.clone()),
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        crate::accepted_modal_publication::publish_modal_bundle(
            root.path(),
            "session-modal",
            "run-modal",
            &value,
        )
        .unwrap();
        let captured = generation::capture(root.path()).unwrap().unwrap();
        assert_eq!(captured.commit, commit);
        for (path, expected) in payloads {
            assert_eq!(
                captured
                    .read_member_bounded(root.path(), &path, expected.len() as u64)
                    .unwrap(),
                expected
            );
        }
        // Idempotent replay is permitted; it does not create another generation.
        crate::accepted_modal_publication::publish_modal_bundle(
            root.path(),
            "session-modal",
            "run-modal",
            &value,
        )
        .unwrap();
    }

    #[test]
    fn rejects_unowned_stale_ambiguous_and_corrupt_bundles() {
        let (commit, tasks, artifacts, bytes, _) = fixture();
        let check = |tasks: &FmsRunCatalog, artifacts: &FmsArtifactCatalog, bytes: &[u8]| {
            candidate(
                "run-modal",
                "session-modal",
                &commit,
                tasks,
                artifacts,
                |_| Ok(bytes.to_vec()),
            )
            .is_err()
        };
        let mut stale = tasks.clone();
        stale.tasks[0].ownership_epoch = Some(2);
        assert!(check(&stale, &artifacts, &bytes));
        let mut failed = tasks.clone();
        failed.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        assert!(check(&failed, &artifacts, &bytes));
        let mut foreign = artifacts.clone();
        foreign.run_id = "another-run".into();
        assert!(check(&tasks, &foreign, &bytes));
        let mut unlisted = tasks.clone();
        unlisted.tasks[0].artifact_ids.clear();
        assert!(check(&unlisted, &artifacts, &bytes));
        let mut corrupt = bytes.clone();
        corrupt[0] ^= 1;
        assert!(check(&tasks, &artifacts, &corrupt));
        let mut ambiguous = artifacts.clone();
        let mut duplicate = artifacts.entries[0].clone();
        duplicate.artifact_id = "second-modal".into();
        ambiguous.entries.push(duplicate);
        let mut both_tasks = tasks.clone();
        both_tasks.tasks[0].artifact_ids.push("second-modal".into());
        assert!(check(&both_tasks, &ambiguous, &bytes));
        assert!(
            candidate(
                "run-modal",
                "foreign-session",
                &commit,
                &tasks,
                &artifacts,
                |_| Ok(bytes.clone())
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_missing_zarr_chunk_even_when_new_digest_and_commit_match() {
        let (_, tasks, mut artifacts, _, mut payloads) = fixture();
        payloads
            .remove("eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0")
            .unwrap();
        let body = GenerationBody {
            schema_version: generation::IMMUTABLE_SCHEMA.into(),
            producer: Some(PublicationOwner {
                run_id: "run-modal".into(),
                stage_id: "eigen".into(),
                stage_kind: "eigenmodes".into(),
            }),
            members: payloads
                .iter()
                .map(|(path, bytes)| {
                    (
                        path.clone(),
                        GenerationMember {
                            byte_length: bytes.len() as u64,
                            sha256: generation::digest(bytes),
                        },
                    )
                })
                .collect(),
        };
        let commit = GenerationCommit {
            generation_id: generation::generation_id(&body).unwrap(),
            content: body,
        };
        let bytes = fullmag_application::encode_modal_eigen_bundle(
            &serde_json::to_vec_pretty(&commit).unwrap(),
            &payloads,
            fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES,
        )
        .unwrap();
        let digest = fullmag_session::hex_sha256(&bytes);
        artifacts.entries[0].content_sha256 = digest.clone();
        artifacts.entries[0].object_ref = Some(digest);
        assert!(
            candidate(
                "run-modal",
                "session-modal",
                &commit,
                &tasks,
                &artifacts,
                |_| Ok(bytes.clone())
            )
            .is_err()
        );
    }
}

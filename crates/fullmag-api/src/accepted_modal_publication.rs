//! Publish one verified accepted modal generation into the current UI root.
//!
//! Accepted workers publish their output as a CAS object, while the existing
//! frequency-domain handlers read the immutable generation rooted at the
//! active live session.  This bridge is deliberately the last, narrow hop
//! between those two stores: it consumes only the already catalog-pinned
//! modal bundle and never discovers or extracts arbitrary bundle paths.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use crate::error::ApiError;
use crate::types::SessionStateResponse;
use fullmag_application::ModalEigenBundle;
use fullmag_session::frequency_domain_artifact_generation as generation_core;
use fullmag_session::frequency_domain_artifact_generation::{GenerationCommit, PublicationOwner};

const MODAL_STAGE_KIND: &str = "eigenmodes";
const MODAL_MANIFEST_PATH: &str = "frequency_domain/manifest.v1.json";
const MODAL_METADATA_PATH: &str = "metadata.json";

/// One output that was verified against the accepted RunCatalog and artifact
/// catalog before it reached this bridge.  The bridge repeats the owner and
/// byte-closure checks because the target root is a separate publication
/// boundary.
#[derive(Debug, Clone)]
pub(crate) struct ModalPublicationCandidate {
    pub(crate) task_order: usize,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) ownership_epoch: u64,
    pub(crate) step_id: String,
    pub(crate) object_ref: String,
    pub(crate) bundle: ModalEigenBundle,
}

/// Publish the newest verified modal output for the current accepted run.
///
/// The caller holds the current-live transition guard while invoking this
/// function.  The context and root checks below therefore form a coherent
/// point-in-time observation for this API instance; they are not a
/// cross-process compare-and-swap claim over a later filesystem mutation.
pub(crate) fn publish_verified_modal_outputs(
    snapshot: &SessionStateResponse,
    expected_run_id: &str,
    candidates: &[ModalPublicationCandidate],
) -> Result<(), ApiError> {
    if candidates.is_empty() {
        return Ok(());
    }
    validate_snapshot_context(snapshot, expected_run_id)?;
    let candidate = candidates
        .iter()
        .max_by_key(|candidate| candidate.task_order)
        .ok_or_else(|| stale_context("modal publication candidate disappeared"))?;
    if candidates
        .iter()
        .filter(|other| other.task_order == candidate.task_order)
        .count()
        != 1
    {
        return Err(stale_context(
            "multiple modal outputs have the same accepted task order",
        ));
    }
    let artifact_root = crate::session::current_artifact_dir(snapshot)
        .ok_or_else(|| stale_context("current live session has no authoritative artifact root"))?;
    if artifact_root.as_os_str().is_empty() {
        return Err(stale_context(
            "current live session has an empty artifact root",
        ));
    }
    publish_modal_bundle(
        &artifact_root,
        snapshot.session.session_id.as_str(),
        expected_run_id,
        candidate,
    )
}

fn publish_modal_bundle(
    artifact_root: &Path,
    session_id: &str,
    expected_run_id: &str,
    candidate: &ModalPublicationCandidate,
) -> Result<(), ApiError> {
    validate_candidate_identity(session_id, expected_run_id, candidate)?;
    let (commit, owner) = validate_bundle_payload(session_id, expected_run_id, candidate)?;

    // A current v2 marker is immutable.  A v1 marker is also a conflict: the
    // bridge must not shadow an existing UI generation with a different
    // ownership contract.  The same exact generation is the only idempotent
    // replay accepted here.
    if let Some(current) = capture_generation(artifact_root)? {
        if !current.is_immutable() {
            return Err(publication_conflict(
                "active artifact root already contains a mutable generation",
            ));
        }
        if current.commit != commit || current.commit.content.producer.as_ref() != Some(&owner) {
            return Err(publication_conflict(
                "active artifact root contains a conflicting modal generation",
            ));
        }
        verify_capture_members(artifact_root, &current.commit, &candidate.bundle.payloads)?;
        current
            .ensure_current(artifact_root)
            .map_err(|error| publication_conflict(format!("modal generation changed: {error}")))?;
        return Ok(());
    }

    let published = fullmag_runner::artifact_generation::publish_immutable(
        artifact_root,
        Some(owner.clone()),
        candidate.bundle.payloads.clone().into_iter(),
    )
    .map_err(|error| publication_failed(format!("publish modal generation: {error}")))?;
    if published != commit {
        return Err(publication_conflict(
            "modal publication returned a different generation identity",
        ));
    }
    let capture = capture_generation(artifact_root)?.ok_or_else(|| {
        publication_failed("modal publication did not leave a current generation")
    })?;
    if !capture.is_immutable() || capture.commit != commit {
        return Err(publication_conflict(
            "modal publication was superseded by another generation",
        ));
    }
    verify_capture_members(artifact_root, &capture.commit, &candidate.bundle.payloads)?;
    capture
        .ensure_current(artifact_root)
        .map_err(|error| publication_conflict(format!("modal generation changed: {error}")))?;
    Ok(())
}

fn validate_snapshot_context(
    snapshot: &SessionStateResponse,
    expected_run_id: &str,
) -> Result<(), ApiError> {
    if expected_run_id.trim().is_empty()
        || snapshot.session.session_id.trim().is_empty()
        || snapshot.session.run_id != expected_run_id
    {
        return Err(stale_context(
            "modal publication no longer belongs to the current session",
        ));
    }
    let run = snapshot
        .run
        .as_ref()
        .ok_or_else(|| stale_context("modal publication lost its current live run"))?;
    if run.run_id != expected_run_id || run.session_id != snapshot.session.session_id {
        return Err(stale_context(
            "modal publication run/session identity changed",
        ));
    }
    Ok(())
}

fn validate_candidate_identity(
    session_id: &str,
    expected_run_id: &str,
    candidate: &ModalPublicationCandidate,
) -> Result<(), ApiError> {
    let expected_task_id =
        fullmag_session::task_id_for_study_step(expected_run_id, &candidate.step_id)
            .map_err(|error| stale_context(format!("modal task identity is invalid: {error}")))?;
    if candidate.task_id != expected_task_id
        || candidate.attempt_id.trim().is_empty()
        || candidate.ownership_epoch == 0
        || !valid_content_digest(&candidate.object_ref)
    {
        return Err(stale_context(
            "modal publication candidate does not match the accepted task identity",
        ));
    }
    if candidate.bundle.run_id != expected_run_id || candidate.bundle.stage_id != candidate.step_id
    {
        return Err(stale_context(
            "modal bundle owner differs from the accepted task identity",
        ));
    }
    if session_id.trim().is_empty() {
        return Err(stale_context(
            "modal publication has no current session identity",
        ));
    }
    Ok(())
}

fn validate_bundle_payload(
    session_id: &str,
    expected_run_id: &str,
    candidate: &ModalPublicationCandidate,
) -> Result<(GenerationCommit, PublicationOwner), ApiError> {
    let commit: GenerationCommit = serde_json::from_slice(&candidate.bundle.commit_bytes)
        .map_err(|error| stale_context(format!("modal generation commit is invalid: {error}")))?;
    let canonical = serde_json::to_vec_pretty(&commit).map_err(|error| {
        publication_failed(format!("serialize modal generation commit: {error}"))
    })?;
    if canonical != candidate.bundle.commit_bytes
        || commit.content.schema_version != generation_core::IMMUTABLE_SCHEMA
        || generation_core::generation_id(&commit.content)
            .map_err(|error| publication_failed(format!("hash modal generation commit: {error}")))?
            != commit.generation_id
        || commit.generation_id != candidate.bundle.generation_id
    {
        return Err(stale_context(
            "modal bundle does not carry its canonical immutable generation",
        ));
    }
    let owner = commit
        .content
        .producer
        .clone()
        .ok_or_else(|| stale_context("modal generation commit has no authoritative owner"))?;
    if owner.run_id != expected_run_id
        || owner.stage_id != candidate.step_id
        || owner.stage_kind != MODAL_STAGE_KIND
    {
        return Err(stale_context(
            "modal generation commit owner differs from the accepted task",
        ));
    }
    if commit.content.members.len() != candidate.bundle.payloads.len()
        || commit
            .content
            .members
            .keys()
            .ne(candidate.bundle.payloads.keys())
    {
        return Err(publication_conflict(
            "modal bundle member closure differs from its generation commit",
        ));
    }
    for (path, member) in &commit.content.members {
        generation_core::validate_member_path(path).map_err(|error| {
            publication_conflict(format!("modal generation member path is invalid: {error}"))
        })?;
        let bytes = candidate.bundle.payloads.get(path).ok_or_else(|| {
            publication_conflict("modal generation member is missing from the bundle")
        })?;
        if member.byte_length != bytes.len() as u64
            || generation_core::digest(bytes) != member.sha256
        {
            return Err(publication_conflict(
                "modal generation member digest differs from its commit",
            ));
        }
    }

    // The accepted worker and codec have already checked this closure.  Keep
    // the check at the publication boundary so restored CAS bytes cannot be
    // published solely because a transport decoder accepted their framing.
    fullmag_runner::validate_modal_artifact_closure(&candidate.bundle.payloads).map_err(
        |error| publication_conflict(format!("modal artifact closure is invalid: {error}")),
    )?;
    validate_modal_manifest(
        session_id,
        expected_run_id,
        &owner,
        &candidate.bundle.payloads,
    )?;
    Ok((commit, owner))
}

fn validate_modal_manifest(
    session_id: &str,
    expected_run_id: &str,
    owner: &PublicationOwner,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ApiError> {
    let manifest_bytes = payloads
        .get(MODAL_MANIFEST_PATH)
        .ok_or_else(|| publication_conflict("modal generation has no manifest member"))?;
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|error| publication_conflict(format!("modal manifest is invalid: {error}")))?;
    for (key, expected) in [
        ("schema_version", "frequency_domain_manifest.v1"),
        ("analysis_family", "magnetic_frequency_domain"),
        ("study_product", "modal_eigen"),
        ("run_id", expected_run_id),
        ("stage_id", owner.stage_id.as_str()),
    ] {
        if manifest.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(publication_conflict(format!(
                "modal manifest {key} differs from the accepted owner"
            )));
        }
    }
    if let Some(stage_kind) = manifest.get("stage_kind") {
        if stage_kind.as_str() != Some(owner.stage_kind.as_str()) {
            return Err(publication_conflict(
                "modal manifest stage kind differs from the generation owner",
            ));
        }
    }
    if let Some(manifest_session_id) = manifest.get("session_id") {
        if manifest_session_id.as_str() != Some(session_id) {
            return Err(stale_context(
                "modal manifest session differs from the current live session",
            ));
        }
    }
    if let Some(runtime_id) = manifest.get("runtime_id") {
        let runtime_id = runtime_id.as_str().ok_or_else(|| {
            publication_conflict("modal manifest runtime identity is not a string")
        })?;
        if runtime_id.trim().is_empty()
            || runtime_id.chars().any(char::is_control)
            || matches!(
                runtime_id,
                "current" | "run:current" | "runtime:not_provided"
            )
            || runtime_id.ends_with(":current")
        {
            return Err(publication_conflict(
                "modal manifest runtime identity is not exact",
            ));
        }
    }

    let metadata_bytes = payloads
        .get(MODAL_METADATA_PATH)
        .ok_or_else(|| publication_conflict("modal generation has no metadata member"))?;
    let metadata: Value = serde_json::from_slice(metadata_bytes)
        .map_err(|error| publication_conflict(format!("modal metadata is invalid: {error}")))?;
    let runtime_metadata = metadata
        .pointer("/problem_meta/runtime_metadata")
        .and_then(Value::as_object)
        .ok_or_else(|| publication_conflict("modal metadata has no runtime owner metadata"))?;
    for (key, expected) in [
        ("producer_run_id", expected_run_id),
        ("producer_stage_id", owner.stage_id.as_str()),
        ("producer_stage_kind", owner.stage_kind.as_str()),
    ] {
        if runtime_metadata.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(publication_conflict(format!(
                "modal metadata {key} differs from the accepted owner"
            )));
        }
    }
    if let (Some(manifest_runtime), Some(metadata_runtime)) = (
        manifest.get("runtime_id").and_then(Value::as_str),
        runtime_metadata.get("runtime_id").and_then(Value::as_str),
    ) {
        if manifest_runtime != metadata_runtime {
            return Err(publication_conflict(
                "modal manifest and metadata runtime identities differ",
            ));
        }
    }
    Ok(())
}

fn verify_capture_members(
    artifact_root: &Path,
    commit: &GenerationCommit,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ApiError> {
    let capture = fullmag_runner::artifact_generation::capture(artifact_root)
        .map_err(|error| publication_failed(format!("capture modal generation: {error}")))?
        .ok_or_else(|| publication_failed("modal generation disappeared during verification"))?;
    if capture.commit != *commit {
        return Err(publication_conflict(
            "active modal generation commit changed during verification",
        ));
    }
    for (path, expected) in payloads {
        let bytes = capture
            .read_member_bounded(artifact_root, path, expected.len() as u64)
            .map_err(|error| {
                publication_conflict(format!("read published modal member {path}: {error}"))
            })?;
        if &bytes != expected {
            return Err(publication_conflict(format!(
                "published modal member {path} differs from the accepted bundle"
            )));
        }
    }
    Ok(())
}

fn capture_generation(
    artifact_root: &Path,
) -> Result<Option<fullmag_runner::artifact_generation::GenerationCapture>, ApiError> {
    fullmag_runner::artifact_generation::capture(artifact_root)
        .map_err(|error| publication_conflict(format!("capture active artifact root: {error}")))
}

fn valid_content_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn stale_context(message: impl Into<String>) -> ApiError {
    ApiError::conflict_with_code("accepted_modal_publication_stale_context", message)
}

fn publication_conflict(message: impl Into<String>) -> ApiError {
    ApiError::conflict_with_code("accepted_modal_publication_conflict", message)
}

fn publication_failed(message: impl Into<String>) -> ApiError {
    ApiError::with_status_and_code(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "accepted_modal_publication_failed",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_session::frequency_domain_artifact_generation::{
        digest, generation_id, GenerationBody, GenerationMember,
    };

    struct TempRoot(tempfile::TempDir);

    impl TempRoot {
        fn new() -> Self {
            Self(tempfile::tempdir().expect("temporary modal root"))
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
    }

    fn candidate(session_id: &str, run_id: &str, stage_id: &str) -> ModalPublicationCandidate {
        let payloads: BTreeMap<String, Vec<u8>> = BTreeMap::from([
            (
                MODAL_METADATA_PATH.into(),
                serde_json::to_vec(&serde_json::json!({
                    "problem_meta": {"runtime_metadata": {
                        "producer_run_id": run_id,
                        "producer_stage_id": stage_id,
                        "producer_stage_kind": MODAL_STAGE_KIND
                    }},
                    "material_field_assets": []
                }))
                .unwrap(),
            ),
            (
                MODAL_MANIFEST_PATH.into(),
                serde_json::to_vec(&serde_json::json!({
                    "schema_version": "frequency_domain_manifest.v1",
                    "analysis_family": "magnetic_frequency_domain",
                    "study_product": "modal_eigen",
                    "session_id": session_id,
                    "run_id": run_id,
                    "stage_id": stage_id,
                    "runtime_id": "runtime-exact",
                    "stage_kind": MODAL_STAGE_KIND,
                    "artifacts": {"spectrum_v2_path": "eigen/spectrum.v2.json"}
                }))
                .unwrap(),
            ),
            (
                "eigen/spectrum.v2.json".into(),
                br#"{"schema_version":"eigen_spectrum.v2","modes":[]}"#.to_vec(),
            ),
        ]);
        let content = GenerationBody {
            schema_version: generation_core::IMMUTABLE_SCHEMA.into(),
            producer: Some(PublicationOwner {
                run_id: run_id.into(),
                stage_id: stage_id.into(),
                stage_kind: MODAL_STAGE_KIND.into(),
            }),
            members: payloads
                .iter()
                .map(|(path, bytes)| {
                    (
                        path.clone(),
                        GenerationMember {
                            byte_length: bytes.len() as u64,
                            sha256: digest(bytes),
                        },
                    )
                })
                .collect(),
        };
        let commit = GenerationCommit {
            generation_id: generation_id(&content).unwrap(),
            content,
        };
        ModalPublicationCandidate {
            task_order: 0,
            task_id: fullmag_session::task_id_for_study_step(run_id, stage_id).unwrap(),
            attempt_id: "attempt-exact".into(),
            ownership_epoch: 1,
            step_id: stage_id.into(),
            object_ref: "a".repeat(64),
            bundle: ModalEigenBundle {
                commit_bytes: serde_json::to_vec_pretty(&commit).unwrap(),
                generation_id: commit.generation_id,
                run_id: run_id.into(),
                stage_id: stage_id.into(),
                payloads,
            },
        }
    }

    #[test]
    fn publication_is_idempotent_for_the_same_generation() {
        let root = TempRoot::new();
        let candidate = candidate("session-exact", "run-exact", "eigen");
        publish_modal_bundle(root.path(), "session-exact", "run-exact", &candidate).unwrap();
        let marker =
            std::fs::read(root.path().join("frequency_domain/generation.v2.json")).unwrap();
        publish_modal_bundle(root.path(), "session-exact", "run-exact", &candidate).unwrap();
        assert_eq!(
            marker,
            std::fs::read(root.path().join("frequency_domain/generation.v2.json")).unwrap()
        );
    }

    #[test]
    fn publication_rejects_wrong_owner_and_stale_session_without_marker() {
        let wrong_owner = TempRoot::new();
        let candidate = candidate("session-exact", "run-exact", "eigen");
        let error = publish_modal_bundle(
            wrong_owner.path(),
            "session-exact",
            "run-foreign",
            &candidate,
        )
        .unwrap_err();
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_modal_publication_stale_context")
        );
        assert!(!wrong_owner
            .path()
            .join("frequency_domain/generation.v2.json")
            .exists());

        let stale_session = TempRoot::new();
        let error = publish_modal_bundle(
            stale_session.path(),
            "session-current",
            "run-exact",
            &candidate,
        )
        .unwrap_err();
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_modal_publication_stale_context")
        );
        assert!(!stale_session
            .path()
            .join("frequency_domain/generation.v2.json")
            .exists());
    }

    #[test]
    fn publication_rejects_conflicting_root_and_member_digest() {
        let root = TempRoot::new();
        let first = candidate("session-exact", "run-exact", "eigen");
        publish_modal_bundle(root.path(), "session-exact", "run-exact", &first).unwrap();
        let mut conflicting = candidate("session-exact", "run-exact", "eigen");
        conflicting
            .bundle
            .payloads
            .get_mut("eigen/spectrum.v2.json")
            .unwrap()
            .push(1);
        assert_eq!(
            publish_modal_bundle(root.path(), "session-exact", "run-exact", &conflicting)
                .unwrap_err()
                .code
                .as_deref(),
            Some("accepted_modal_publication_conflict")
        );
        let root_conflict = TempRoot::new();
        publish_modal_bundle(root_conflict.path(), "session-exact", "run-exact", &first).unwrap();
        let mut second = candidate("session-exact", "run-exact", "eigen");
        second
            .bundle
            .payloads
            .get_mut("eigen/spectrum.v2.json")
            .unwrap()
            .push(2);
        let content = GenerationBody {
            schema_version: generation_core::IMMUTABLE_SCHEMA.into(),
            producer: Some(PublicationOwner {
                run_id: "run-exact".into(),
                stage_id: "eigen".into(),
                stage_kind: MODAL_STAGE_KIND.into(),
            }),
            members: second
                .bundle
                .payloads
                .iter()
                .map(|(path, bytes)| {
                    (
                        path.clone(),
                        GenerationMember {
                            byte_length: bytes.len() as u64,
                            sha256: digest(bytes),
                        },
                    )
                })
                .collect(),
        };
        let commit = GenerationCommit {
            generation_id: generation_id(&content).unwrap(),
            content,
        };
        second.bundle.generation_id = commit.generation_id.clone();
        second.bundle.commit_bytes = serde_json::to_vec_pretty(&commit).unwrap();
        assert_eq!(
            publish_modal_bundle(root_conflict.path(), "session-exact", "run-exact", &second)
                .unwrap_err()
                .code
                .as_deref(),
            Some("accepted_modal_publication_conflict")
        );
    }
}

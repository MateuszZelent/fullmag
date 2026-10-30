//! Archive document revisions and immutable execution revisions have different
//! roles. Presentation-only edits may advance the former, but only a typed,
//! versioned accepted input binding can prove that physics stayed unchanged.
use crate::error::ApiError;
use fullmag_authoring::SceneDocument;
use fullmag_session::accepted_provenance::{
    AcceptedProvenanceManifest, AcceptedProvenanceRecordKind,
};
use fullmag_session::{FmsRunIntent, FmsStagedPreflight};

fn invalid(message: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request(format!("invalid_fms_accepted_provenance: {message}"))
}

pub(super) fn validate_intent_scene(
    intent: &FmsRunIntent,
    accepted_run: &str,
    scene: &SceneDocument,
    startup_revision: u64,
) -> Result<(), ApiError> {
    intent.validate().map_err(invalid)?;
    if intent.run_id != accepted_run {
        return Err(invalid(
            "startup scene binding belongs to another accepted run",
        ));
    }
    if intent
        .specification
        .pointer("/parameters/live_workspace/scene_revision")
        .and_then(serde_json::Value::as_u64)
        != Some(startup_revision)
    {
        return Err(invalid(
            "startup scene revision differs from the immutable accepted input",
        ));
    }
    let identity = crate::live_execution_binding::input_identity(scene).map_err(invalid)?;
    // Passing the current document revision is intentional: historical intents
    // without a versioned hash retain the existing exact-revision requirement.
    crate::live_execution_binding::validate_input_binding(
        &intent.specification,
        &identity,
        scene.revision,
    )
    .map_err(invalid)
}

pub(super) fn validate_startup_revision(
    staged: &FmsStagedPreflight,
    manifest: &AcceptedProvenanceManifest,
    scene: &SceneDocument,
    marked_revision: &serde_json::Value,
) -> Result<(), ApiError> {
    let revision = marked_revision
        .as_u64()
        .ok_or_else(|| invalid("startup scene revision is not an unsigned integer"))?;
    if revision == scene.revision {
        return Ok(());
    }
    let mut records = manifest
        .records
        .iter()
        .filter(|record| record.kind == AcceptedProvenanceRecordKind::RunIntent);
    let record = records
        .next()
        .ok_or_else(|| invalid("startup scene binding has no detached RunIntent"))?;
    if records.next().is_some() {
        return Err(invalid(
            "startup scene binding has ambiguous RunIntent records",
        ));
    }
    let bytes = staged
        .read_document(&record.archive_path)
        .map_err(invalid)?;
    let intent: FmsRunIntent = serde_json::from_slice(&bytes).map_err(invalid)?;
    validate_intent_scene(&intent, &manifest.accepted_run_id, scene, revision)
}

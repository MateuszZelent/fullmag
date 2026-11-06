//! Compatibility between an authored document and immutable accepted input.

use crate::error::ApiError;
use crate::study_execution_contract::{parse_study_history_parent, StudyHistoryParent};
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};
use fullmag_application::RunSpecification;
use fullmag_authoring::{
    scene_execution_input_identity, SceneDocument, SceneExecutionInputIdentity,
    SCENE_EXECUTION_INPUT_SCHEMA,
};
use fullmag_session::{FmsRunIntent, SessionStore};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MAX_STUDY_HISTORY_PROJECTS: usize = 64;

pub(crate) fn verified_history_run_spec(
    intent: &FmsRunIntent,
) -> Result<RunSpecification, ApiError> {
    let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
        .map_err(|error| ApiError::conflict(format!("invalid accepted RunSpec: {error}")))?;
    if specification.run_id.as_str() != intent.run_id
        || specification
            .fingerprint()
            .map_err(|error| ApiError::conflict(error.to_string()))?
            != intent.payload_sha256
    {
        return Err(ApiError::conflict(
            "Study history RunSpec identity mismatch",
        ));
    }
    Ok(specification)
}

fn live_owner_matches(specification: &Value, session_id: &str, session_epoch: u64) -> bool {
    specification
        .pointer("/parameters/live_workspace")
        .is_some_and(|live| {
            live["session_id"].as_str() == Some(session_id)
                && live["session_epoch"].as_u64() == Some(session_epoch)
        })
}

fn study_history_parent(
    specification: &RunSpecification,
) -> Result<Option<StudyHistoryParent>, ApiError> {
    specification
        .parameters
        .pointer("/live_workspace/study_history_parent")
        .map(parse_study_history_parent)
        .transpose()
        .map_err(|error| ApiError::conflict(format!("invalid Study history lineage: {error}")))
}

/// A run accepted in a different API project may link only to the actual
/// durable run of the captured workspace. Runs in the same project inherit
/// the prior cross-project link, so ordinary Compute does not grow the chain.
pub(crate) fn next_study_history_parent(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    project_id: &str,
) -> Result<Option<StudyHistoryParent>, ApiError> {
    let Some(previous_run) = context.run_id.as_deref() else {
        return Ok(None);
    };
    let Some(intent) = store
        .read_run_intent(previous_run)
        .map_err(|error| ApiError::internal(format!("read current Study history: {error}")))?
    else {
        return Ok(None);
    };
    if !live_owner_matches(
        &intent.specification,
        &context.session_id,
        context.session_epoch,
    ) {
        return Ok(None);
    }
    let specification = verified_history_run_spec(&intent)?;
    if specification.snapshot.project_id.as_str() == project_id {
        return study_history_parent(&specification);
    }
    Ok(Some(StudyHistoryParent::V1 {
        run_id: intent.run_id,
        specification_sha256: intent.payload_sha256,
    }))
}

/// Only verified links from the active accepted run can add another project
/// to the current history. A missing retained parent ends the chain.
pub(crate) fn study_history_projects(
    store: &SessionStore,
    current: &RunSpecification,
    session_id: &str,
    session_epoch: u64,
) -> Result<BTreeSet<String>, ApiError> {
    let mut projects = BTreeSet::from([current.snapshot.project_id.as_str().to_owned()]);
    let mut parent = study_history_parent(current)?;
    while projects.len() < MAX_STUDY_HISTORY_PROJECTS {
        let Some(StudyHistoryParent::V1 {
            run_id,
            specification_sha256,
        }) = parent
        else {
            break;
        };
        let Some(intent) = store
            .read_run_intent(&run_id)
            .map_err(|error| ApiError::internal(format!("read retained Study history: {error}")))?
        else {
            break;
        };
        if intent.payload_sha256 != specification_sha256
            || !live_owner_matches(&intent.specification, session_id, session_epoch)
        {
            return Err(ApiError::conflict(
                "Study history parent differs from its workspace or digest",
            ));
        }
        let specification = verified_history_run_spec(&intent)?;
        if !projects.insert(specification.snapshot.project_id.as_str().to_owned()) {
            return Err(ApiError::conflict(
                "Study history project lineage repeats a project",
            ));
        }
        parent = study_history_parent(&specification)?;
    }
    Ok(projects)
}

pub(crate) struct WorkspaceStudyHistory {
    pub(crate) project_id: String,
    pub(crate) project_ids: BTreeSet<String>,
}

impl WorkspaceStudyHistory {
    pub(crate) fn owns(
        &self,
        intent: &FmsRunIntent,
        context: &CurrentLiveRequestContext,
    ) -> bool {
        live_owner_matches(&intent.specification, &context.session_id, context.session_epoch)
            && intent.specification.pointer("/snapshot/project_id").and_then(Value::as_str)
                .is_some_and(|project| self.project_ids.contains(project))
    }
}

/// Use the committed current run as the only anchor for cross-project
/// history. A source named by the client cannot add its own project.
pub(crate) fn current_study_history(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
) -> Result<Option<WorkspaceStudyHistory>, ApiError> {
    let Some(run_id) = context.run_id.as_deref() else {
        return Ok(None);
    };
    let Some(intent) = store.read_run_intent(run_id)
        .map_err(|error| ApiError::internal(format!("read current Study history: {error}")))?
    else {
        return Ok(None);
    };
    if !live_owner_matches(&intent.specification, &context.session_id, context.session_epoch) {
        return Ok(None);
    }
    let specification = verified_history_run_spec(&intent)?;
    let project_id = specification.snapshot.project_id.as_str().to_owned();
    let project_ids = study_history_projects(
        store, &specification, &context.session_id, context.session_epoch,
    )?;
    Ok(Some(WorkspaceStudyHistory { project_id, project_ids }))
}

pub(crate) fn input_identity(
    scene: &SceneDocument,
) -> Result<SceneExecutionInputIdentity, ApiError> {
    scene_execution_input_identity(scene)
        .map_err(|error| ApiError::internal(format!("encode authored execution identity: {error}")))
}

/// New intents declare the complete authored configuration identity. Old
/// intents keep exact scene-revision binding; never retrofit a current scene
/// digest onto an immutable historical run.
pub(crate) fn validate_input_binding(
    specification: &Value,
    current_identity: &SceneExecutionInputIdentity,
    scene_revision: u64,
) -> Result<(), ApiError> {
    let live = specification
        .pointer("/parameters/live_workspace")
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_execution_input_unavailable",
                "accepted run has no live workspace binding",
            )
        })?;
    match live.get("execution_input") {
        Some(value) => {
            let identity: SceneExecutionInputIdentity = serde_json::from_value(value.clone())
                .map_err(|error| ApiError::conflict_with_code(
                    "accepted_execution_input_invalid",
                    format!("accepted execution input identity is invalid: {error}"),
                ))?;
            if identity.schema_version != SCENE_EXECUTION_INPUT_SCHEMA
                || identity.sha256.len() != 64
                || !identity.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ApiError::conflict_with_code(
                    "accepted_execution_input_invalid",
                    "accepted execution input identity has an unsupported schema or malformed digest",
                ));
            }
            if &identity != current_identity {
                return Err(ApiError::conflict_with_code(
                    "accepted_execution_input_mismatch",
                    "current authored input differs from the immutable accepted run",
                ));
            }
        }
        None if live.get("scene_revision").and_then(Value::as_u64) == Some(scene_revision) => {}
        None => return Err(ApiError::conflict_with_code(
            "accepted_execution_input_legacy_revision",
            "this accepted run has no versioned input identity and requires its exact scene revision",
        )),
    }
    Ok(())
}

/// Reconstruct the authored scene projection from an accepted immutable
/// definition. Historical acceptance may have injected the legacy default
/// profile into the stored effective scene after pinning authored input. Only
/// that exact profile may be projected away, and only when the complete
/// versioned input identity then matches the immutable RunSpecification.
pub(crate) fn recover_scene_projection(
    scene: SceneDocument,
    specification: &RunSpecification,
) -> Result<SceneDocument, ApiError> {
    let binding = json!({ "parameters": specification.parameters.clone() });
    let current_identity = input_identity(&scene)?;
    let mismatch = match validate_input_binding(&binding, &current_identity, scene.revision) {
        Ok(()) => return Ok(scene),
        Err(error) if error.code.as_deref() == Some("accepted_execution_input_mismatch") => error,
        Err(error) => return Err(error),
    };

    let legacy_profile = fullmag_application::legacy_live_execution_profile();
    if scene.study.execution_profile.as_ref() != Some(&legacy_profile) {
        return Err(mismatch);
    }

    let mut authored_projection = scene;
    authored_projection.study.execution_profile = None;
    let projected_identity = input_identity(&authored_projection)?;
    validate_input_binding(&binding, &projected_identity, authored_projection.revision)?;
    Ok(authored_projection)
}

/// Called under the live transition fence and scene write lock, before the
/// authoring commit changes any resource. Store access runs on the blocking
/// pool and never reads or writes the live state itself.
pub(crate) async fn validate_active_scene_mutation(
    state: &AppState,
    snapshot: &SessionStateResponse,
    next: &SceneDocument,
    explicit_magnetization_apply: bool,
) -> Result<bool, ApiError> {
    if !crate::live_accepted_execution::docker_api_only_runtime() {
        return Ok(false);
    }
    let Some(run) = snapshot.run.as_ref() else {
        return Ok(false);
    };
    if matches!(
        run.status.as_str(),
        "completed" | "succeeded" | "failed" | "cancelled" | "stopped" | "closed"
    ) {
        return Ok(false);
    }
    let current = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::conflict("active accepted run has no authored document"))?;
    let current_identity = input_identity(current)?;
    let next_identity = input_identity(next)?;
    if explicit_magnetization_apply || next_identity != current_identity {
        if matches!(
            run.status.as_str(),
            "waiting_for_compute" | "waiting_for_solve"
        ) {
            let digest = fullmag_session::canonical_json_sha256(&json!({
                "schema": "live-held-scene-edit.v1",
                "run_id": run.run_id,
                "input": next_identity,
                "base_revision": current.revision,
            }));
            crate::live_accepted_execution::retire_superseded_live_start(
                state,
                &snapshot.session.session_id,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
                &run.run_id,
                &format!("replace-live-{digest}"),
            )
            .await?;
            return Ok(true);
        }
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_locked",
            "finish or stop the accepted run before changing geometry, materials, initial state, stages, runtime, or outputs; your draft has not been applied",
        ));
    }
    let store_root = state
        .submit_store_root
        .clone()
        .ok_or_else(|| ApiError::conflict("accepted input binding store is unavailable"))?;
    let run_id = run.run_id.clone();
    let specification = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root)
            .map_err(|error| ApiError::conflict(format!("open accepted input store: {error}")))?;
        let intent = store
            .read_run_intent(&run_id)
            .map_err(|error| ApiError::conflict(format!("read accepted input binding: {error}")))?
            .ok_or_else(|| ApiError::conflict("accepted input binding is unavailable"))?;
        intent.validate().map_err(|error| {
            ApiError::conflict(format!("invalid accepted input binding: {error}"))
        })?;
        Ok::<_, ApiError>(intent.specification)
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted input lookup failed: {error}")))??;
    let live = specification.pointer("/parameters/live_workspace");
    if live
        .and_then(|value| value.get("api_instance_id"))
        .and_then(Value::as_str)
        != Some(state.request_scope_instance_id.as_str())
        || live
            .and_then(|value| value.get("session_id"))
            .and_then(Value::as_str)
            != Some(snapshot.session.session_id.as_str())
        || live
            .and_then(|value| value.get("session_epoch"))
            .and_then(Value::as_u64)
            != Some(
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )
    {
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_owner_mismatch",
            "accepted input is not bound to the current live session owner",
        ));
    }
    validate_input_binding(&specification, &current_identity, current.revision)?;
    if specification
        .pointer("/parameters/live_workspace/execution_input")
        .is_none()
    {
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_legacy_revision",
            "this accepted run predates metadata-independent input binding; finish or stop it before editing the document",
        ));
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, StudyId,
        StudyReference,
    };
    use serde_json::json;

    fn specification(parameters: Value) -> fullmag_application::RunSpecification {
        fullmag_application::RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-binding-test").unwrap(),
                definition_revision: 7,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-binding-test").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            parameters,
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        )
    }

    fn versioned_specification(identity: Value) -> fullmag_application::RunSpecification {
        specification(json!({
            "live_workspace": { "execution_input": identity }
        }))
    }

    #[test]
    fn study_history_links_only_verified_projects_in_the_same_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let mut context = CurrentLiveRequestContext {
            session_id: "session-lineage".into(),
            run_id: None,
            session_epoch: 7,
            request_scope_epoch: "api:7".into(),
        };
        let make_run = |run_id: &str, project_id: &str, parent: Option<StudyHistoryParent>| {
            let mut run = specification(json!({"live_workspace": {
                "session_id": "session-lineage", "session_epoch": 7,
            }}));
            run.run_id = fullmag_application::RunId::parse(run_id).unwrap();
            run.snapshot.project_id = ProjectId::parse(project_id).unwrap();
            if let Some(parent) = parent {
                run.parameters["live_workspace"]["study_history_parent"] = json!(parent);
            }
            store
                .commit_run_intent(&FmsRunIntent::new(
                    run_id,
                    format!("intent-{run_id}"),
                    serde_json::to_value(&run).unwrap(),
                ))
                .unwrap();
            run
        };

        make_run("run-first", "project-first", None);
        context.run_id = Some("run-first".into());
        let from_first = next_study_history_parent(&store, &context, "project-second")
            .unwrap()
            .unwrap();
        make_run("run-second", "project-second", Some(from_first.clone()));
        context.run_id = Some("run-second".into());
        assert_eq!(
            next_study_history_parent(&store, &context, "project-second").unwrap(),
            Some(from_first),
        );
        let from_second = next_study_history_parent(&store, &context, "project-third")
            .unwrap()
            .unwrap();
        let mut third = make_run("run-third", "project-third", Some(from_second));
        assert_eq!(
            study_history_projects(&store, &third, "session-lineage", 7).unwrap(),
            ["project-first", "project-second", "project-third"]
                .into_iter()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>(),
        );

        make_run("run-unlinked", "project-unlinked", None);
        context.run_id = Some("run-third".into());
        let history = current_study_history(&store, &context).unwrap().unwrap();
        assert_eq!(history.project_id, "project-third");
        for run in ["run-first", "run-second", "run-third"] {
            let intent = store.read_run_intent(run).unwrap().unwrap();
            assert!(history.owns(&intent, &context));
        }
        let unlinked = store.read_run_intent("run-unlinked").unwrap().unwrap();
        assert!(!history.owns(&unlinked, &context));
        context.session_epoch += 1;
        assert!(!history.owns(&store.read_run_intent("run-first").unwrap().unwrap(), &context));
        assert!(current_study_history(&store, &context).unwrap().is_none());

        assert!(study_history_projects(&store, &third, "session-lineage", 8).is_err());
        third.parameters["live_workspace"]["study_history_parent"]["specification_sha256"] =
            json!("f".repeat(64));
        assert!(study_history_projects(&store, &third, "session-lineage", 7).is_err());
    }

    #[test]
    fn exact_authored_input_is_restored_unchanged() {
        let scene = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&scene).unwrap()).unwrap();
        let restored =
            recover_scene_projection(scene.clone(), &versioned_specification(identity)).unwrap();

        assert_eq!(restored, scene);
        assert!(restored.study.execution_profile.is_none());
    }

    #[test]
    fn historical_injected_legacy_profile_is_removed_for_authored_projection() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut stored = authored;
        stored.study.execution_profile = Some(fullmag_application::legacy_live_execution_profile());

        let restored =
            recover_scene_projection(stored.clone(), &versioned_specification(identity)).unwrap();

        stored.study.execution_profile = None;
        assert_eq!(restored, stored);
    }

    #[test]
    fn explicitly_authored_legacy_profile_is_preserved_when_exactly_pinned() {
        let mut scene = SceneDocument::default();
        scene.study.execution_profile = Some(fullmag_application::legacy_live_execution_profile());
        let identity = serde_json::to_value(input_identity(&scene).unwrap()).unwrap();

        let restored =
            recover_scene_projection(scene.clone(), &versioned_specification(identity)).unwrap();

        assert_eq!(restored, scene);
    }

    #[test]
    fn custom_profile_mismatch_is_not_reconstructed_as_legacy_absence() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut candidate = authored;
        let mut custom = fullmag_application::legacy_live_execution_profile();
        custom.profile_id = "exec:custom".into();
        candidate.study.execution_profile = Some(custom);

        let error =
            recover_scene_projection(candidate, &versioned_specification(identity)).unwrap_err();

        assert_eq!(
            error.code.as_deref(),
            Some("accepted_execution_input_mismatch")
        );
    }

    #[test]
    fn physics_change_still_mismatches_after_legacy_profile_projection() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut candidate = authored;
        candidate.study.external_field = Some([0.0, 0.0, 1.0]);
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());

        let error =
            recover_scene_projection(candidate, &versioned_specification(identity)).unwrap_err();

        assert_eq!(
            error.code.as_deref(),
            Some("accepted_execution_input_mismatch")
        );
    }

    #[test]
    fn malformed_versioned_identity_is_rejected_without_projection_guessing() {
        let mut candidate = SceneDocument::default();
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        for identity in [
            json!({
                "schema_version": "fullmag.scene_execution_input.v0",
                "sha256": "a".repeat(64)
            }),
            json!({
                "schema_version": SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "not-a-digest"
            }),
        ] {
            let error =
                recover_scene_projection(candidate.clone(), &versioned_specification(identity))
                    .unwrap_err();
            assert_eq!(
                error.code.as_deref(),
                Some("accepted_execution_input_invalid")
            );
        }
    }

    #[test]
    fn legacy_revision_binding_preserves_the_candidate_without_profile_guessing() {
        let mut candidate = SceneDocument::default();
        candidate.revision = 7;
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        let specification = specification(json!({
            "live_workspace": { "scene_revision": 7 }
        }));

        let restored = recover_scene_projection(candidate.clone(), &specification).unwrap();

        assert_eq!(restored, candidate);
    }

    #[test]
    fn stale_legacy_revision_binding_is_rejected() {
        let mut candidate = SceneDocument::default();
        candidate.revision = 7;
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        let specification = specification(json!({
            "live_workspace": { "scene_revision": 6 }
        }));

        let error = recover_scene_projection(candidate, &specification).unwrap_err();

        assert_eq!(
            error.code.as_deref(),
            Some("accepted_execution_input_legacy_revision")
        );
    }
}

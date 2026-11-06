//! Magnetization continuation between live accepted commands (ADR 0068 F5).
//!
//! Every live `run`/`relax` command is its own accepted run. The selected
//! step publishes its final magnetization on the `final_state` port, and the
//! next command pins that exact CAS object as its initial state when the
//! accepted execution plan has the same magnetization layout. The decision is
//! taken here, before the RunIntent is published, with the same predicate the
//! worker applies (`fullmag_runner::materialize_study_magnetization_input`),
//! so a layout mismatch selects the authored state instead of failing the
//! command. Semantics: docs/physics/0925-live-session-magnetization-continuation.md.

use fullmag_application::{DecodedStudyArtifact, ResolvedStudyArtifact};
use fullmag_authoring::{
    StudyInputSource, StudyOutputPort, StudyPortDataKind, StudyStep,
};
use fullmag_session::{FmsArtifactStatus, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle, SessionStore};
use serde_json::Value;

/// Output port carrying the final state of a live command (FEM requires this id).
pub(crate) const FINAL_STATE_PORT: &str = "final_state";
/// Input port pinning the previous command's final state.
pub(crate) const INITIAL_STATE_PORT: &str = "initial_state";
const OUTPUT_CASE_ID: &str = "default";

/// The verified final state of a previous live command.
#[derive(Debug, Clone)]
pub(crate) struct ContinuationSource {
    pub run_id: String,
    pub step_id: String,
    pub case_id: String,
    pub artifact_id: String,
    pub content_sha256: String,
    pub layout: Value,
    pub values: Vec<[f64; 3]>,
}

/// Whether a live command starts from the previous final state or the authored one.
#[derive(Debug, Clone)]
pub(crate) enum InitialStateDecision {
    Continuation(ContinuationSource),
    Prepared(crate::live_stage_initial_state::PreparedStateArtifact),
    Authored { reason: String },
}

/// Make the selected step publish its final magnetization.
pub(crate) fn declare_final_state_output(step: &mut StudyStep) {
    if !step.outputs.iter().any(|port| port.port_id == FINAL_STATE_PORT) {
        step.outputs.push(StudyOutputPort {
            port_id: FINAL_STATE_PORT.to_string(),
            data_kind: StudyPortDataKind::State,
        });
    }
}

/// Pin the continuation artifact while preserving the caller's authored port.
pub(crate) fn pinned_initial_state_source(source: &ContinuationSource) -> StudyInputSource {
    StudyInputSource::PinnedArtifact {
        artifact_id: source.artifact_id.clone(),
        content_sha256: source.content_sha256.clone(),
    }
}

/// Decide the initial state of a command whose accepted plan is `plan`.
///
/// `previous_run_id` is the session's latest live run as seen by the API; it is
/// only a hint and is verified durably (same session and epoch, every task
/// succeeded, published and decodable `final_state`).
pub(crate) fn decide_initial_state(
    store: &SessionStore,
    previous_run_id: Option<&str>,
    session_id: &str,
    session_epoch: u64,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> InitialStateDecision {
    let Some(previous_run_id) = previous_run_id else {
        return authored("no previous live command in this session");
    };
    let source = match load_final_state(store, previous_run_id, session_id, session_epoch) {
        Ok(Some(source)) => source,
        Ok(None) => return authored("previous live command published no final state"),
        Err(reason) => return authored(&reason),
    };
    match fullmag_runner::materialize_study_magnetization_input(plan, &source.layout, &source.values) {
        Ok(_) => InitialStateDecision::Continuation(source),
        Err(error) => authored(&format!("discretization changed: {}", error.message)),
    }
}

fn authored(reason: &str) -> InitialStateDecision {
    InitialStateDecision::Authored {
        reason: reason.to_string(),
    }
}

struct AcceptedRunScope {
    catalog: FmsRunCatalog,
}

fn load_accepted_run_scope(
    store: &SessionStore,
    run_id: &str,
    session_id: &str,
    session_epoch: u64,
) -> Result<AcceptedRunScope, String> {
    let intent = store
        .read_run_intent(run_id)
        .map_err(|error| format!("previous run intent unreadable: {error}"))?
        .ok_or_else(|| "previous run intent is missing".to_string())?;
    let live = intent
        .specification
        .pointer("/parameters/live_workspace")
        .ok_or_else(|| "previous run is not a live command".to_string())?;
    if live.get("session_id").and_then(Value::as_str) != Some(session_id)
        || live.get("session_epoch").and_then(Value::as_u64) != Some(session_epoch)
    {
        return Err("previous run belongs to another session or epoch".into());
    }
    let catalog = store
        .read_run_catalog(run_id)
        .map_err(|error| format!("previous run catalog unreadable: {error}"))?
        .ok_or_else(|| "previous run catalog is missing".to_string())?;
    Ok(AcceptedRunScope { catalog })
}

fn load_artifact_catalog(store: &SessionStore, run_id: &str) -> Result<fullmag_session::FmsArtifactCatalog, String> {
    store
        .read_artifact_catalog(run_id)
        .map_err(|error| format!("previous artifact catalog unreadable: {error}"))?
        .ok_or_else(|| "previous artifact catalog is missing".to_string())
}

fn task_attempt_identity(task: &FmsTaskCatalogEntry) -> Result<(&str, u64), String> {
    let (Some(attempt_id), Some(ownership_epoch)) = (task.attempt_id.as_deref(), task.ownership_epoch)
    else {
        return Err("previous live task has no attempt identity".into());
    };
    Ok((attempt_id, ownership_epoch))
}

fn load_final_state(
    store: &SessionStore,
    run_id: &str,
    session_id: &str,
    session_epoch: u64,
) -> Result<Option<ContinuationSource>, String> {
    let scope = load_accepted_run_scope(store, run_id, session_id, session_epoch)?;
    let mut succeeded = scope.catalog
        .tasks
        .iter()
        .filter(|task| task.lifecycle == FmsTaskLifecycle::Succeeded);
    let Some(task) = succeeded.next() else {
        return Err("previous live command did not succeed".into());
    };
    if succeeded.next().is_some() {
        return Err("previous live run has more than one completed task".into());
    }
    let (attempt_id, ownership_epoch) = task_attempt_identity(task)?;
    let artifacts = load_artifact_catalog(store, run_id)?;
    let mut manifests = artifacts.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task.task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
            && entry.status == FmsArtifactStatus::Published
    });
    let Some(manifest_entry) = manifests.next() else {
        return Ok(None);
    };
    if manifests.next().is_some() {
        return Err("previous live task has ambiguous output manifests".into());
    }
    let manifest_ref = manifest_entry
        .object_ref
        .as_deref()
        .filter(|object_ref| *object_ref == manifest_entry.content_sha256)
        .ok_or_else(|| "previous output manifest digest is not pinned".to_string())?;
    let manifest_bytes = store
        .cas()
        .get(manifest_ref)
        .map_err(|error| format!("previous output manifest unreadable: {error}"))?
        .ok_or_else(|| "previous output manifest is missing from CAS".to_string())?;
    let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("previous output manifest is invalid: {error}"))?;
    manifest
        .validate()
        .map_err(|error| format!("previous output manifest failed validation: {error}"))?;
    if manifest.run_id != run_id
        || manifest.task_id != task.task_id
        || manifest.attempt_id != attempt_id
        || manifest.ownership_epoch != ownership_epoch
    {
        return Err("previous output manifest ownership identity mismatch".into());
    }
    let Some(output) = manifest
        .outputs
        .iter()
        .find(|output| output.port_id == FINAL_STATE_PORT && output.case_id == OUTPUT_CASE_ID && output.data_kind == "state")
    else {
        return Ok(None);
    };
    let pinned = artifacts.entries.iter().any(|entry| {
        entry.artifact_id == output.artifact_id
            && entry.status == FmsArtifactStatus::Published
            && entry.object_ref.as_deref() == Some(output.object_ref.as_str())
            && entry.content_sha256 == output.content_sha256
    });
    if !pinned || output.object_ref != output.content_sha256 {
        return Err("previous final state is not pinned by the artifact catalog".into());
    }
    let bytes = store
        .cas()
        .get(&output.object_ref)
        .map_err(|error| format!("previous final state unreadable: {error}"))?
        .ok_or_else(|| "previous final state is missing from CAS".to_string())?;
    let decoded = fullmag_application::decode_study_artifact(
        &ResolvedStudyArtifact {
            artifact_id: output.artifact_id.clone(),
            object_ref: output.object_ref.clone(),
            data_kind: output.data_kind.clone(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
        },
        &bytes,
    )
    .map_err(|error| format!("previous final state decode failed: {error}"))?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        return Err("previous final state is not a magnetization state".into());
    };
    Ok(Some(ContinuationSource {
        run_id: run_id.to_string(),
        step_id: manifest.step_id.clone(),
        case_id: OUTPUT_CASE_ID.into(),
        artifact_id: output.artifact_id.clone(),
        content_sha256: output.content_sha256.clone(),
        layout: state.layout,
        values: state.values,
    }))
}

pub(crate) struct ExactStepFinalStateBinding {
    pub identity: crate::schemas::scalars::ScalarSeriesIdentity,
    pub artifact_catalog: fullmag_session::FmsArtifactCatalog,
    pub task: FmsTaskCatalogEntry,
    pub accepted_state_ref: Option<fullmag_quantities::AcceptedStateRef>,
    pub output: fullmag_session::FmsStudyOutputManifestEntry,
}

pub(crate) struct PublishedFinalState {
    pub identity: crate::schemas::scalars::ScalarSeriesIdentity,
    pub output: fullmag_session::FmsStudyOutputManifestEntry,
    pub accepted_state_ref: Option<fullmag_quantities::AcceptedStateRef>,
}

pub(crate) fn load_exact_step_final_state_binding(
    store: &SessionStore,
    run_id: &str,
    session_id: &str,
    session_epoch: u64,
    step_id: &str,
    case_id: &str,
) -> Result<ExactStepFinalStateBinding, String> {
    let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)
        .map_err(|error| format!("requested study step identity is invalid: {error}"))?;
    let scope = load_accepted_run_scope(store, run_id, session_id, session_epoch)?;
    let task = scope.catalog.tasks.iter().find(|task| task.task_id == task_id)
        .ok_or_else(|| "requested study step task is missing from the run catalog".to_string())?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded {
        return Err("requested study step task did not succeed".into());
    }
    let artifacts = load_artifact_catalog(store, run_id)?;
    let found = read_published_final_states(store, run_id, &artifacts, task, Some(case_id))?
        .into_iter().next()
        .ok_or_else(|| "requested study step has no exact final_state output for this case".to_string())?;
    if found.identity.step_id != step_id {
        return Err("requested output manifest belongs to another study step".into());
    }
    Ok(ExactStepFinalStateBinding {
        identity: found.identity,
        artifact_catalog: artifacts,
        task: task.clone(),
        output: found.output,
        accepted_state_ref: found.accepted_state_ref,
    })
}

pub(crate) struct PublishedFinalStates {
    pub outputs: Vec<PublishedFinalState>,
    pub run_catalog: FmsRunCatalog,
    pub artifact_catalog: fullmag_session::FmsArtifactCatalog,
}

/// Verify the current completed attempts and their output links without
/// opening numerical samples. The caller must already own the durable run.
pub(crate) fn list_published_final_states(
    store: &SessionStore,
    run_id: &str,
    step_ids: &[&str],
) -> Result<Option<PublishedFinalStates>, String> {
    let Some(catalog) = store.read_run_catalog(run_id)
        .map_err(|error| format!("run catalog unreadable: {error}"))?
    else {
        return Ok(None);
    };
    let task_ids = step_ids
        .iter()
        .map(|step_id| fullmag_session::task_id_for_study_step(run_id, step_id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("invalid study step identity: {error}"))?;
    let mut tasks = catalog.tasks.iter().filter(|task| {
        task.lifecycle == FmsTaskLifecycle::Succeeded
            && (task_ids.is_empty() || task_ids.contains(&task.task_id))
    }).peekable();
    if tasks.peek().is_none() {
        return Ok(None);
    }
    let artifacts = load_artifact_catalog(store, run_id)?;
    let mut results = Vec::new();
    for task in tasks {
        results.extend(read_published_final_states(store, run_id, &artifacts, task, None)?);
    }
    results.sort_unstable_by(|left, right| {
        (&left.identity.step_id, &left.identity.case_id, &left.output.artifact_id)
            .cmp(&(&right.identity.step_id, &right.identity.case_id, &right.output.artifact_id))
    });
    Ok(Some(PublishedFinalStates {
        outputs: results,
        run_catalog: catalog,
        artifact_catalog: artifacts,
    }))
}

/// Resolve a particular immutable state within a run whose ownership has
/// already been verified. An artifact from an earlier attempt cannot reopen
/// its result using the current task identity.
pub(crate) fn find_published_final_state(
    store: &SessionStore,
    run_id: &str,
    artifact_id: &str,
) -> Result<Option<ExactStepFinalStateBinding>, String> {
    let artifacts = load_artifact_catalog(store, run_id)?;
    let Some(record) = artifacts.entries.iter().find(|entry| entry.artifact_id == artifact_id) else {
        return Ok(None);
    };
    let Some(link) = record.study_output.as_ref().filter(|link| link.port_id == FINAL_STATE_PORT) else {
        return Ok(None);
    };
    let task_id = fullmag_session::task_id_for_study_step(run_id, &link.step_id)
        .map_err(|error| format!("invalid result step: {error}"))?;
    let Some(catalog) = store.read_run_catalog(run_id)
        .map_err(|error| format!("result run catalog unreadable: {error}"))?
    else {
        return Ok(None);
    };
    let Some(task) = catalog.tasks.iter().find(|task| {
        task.task_id == task_id && task.lifecycle == FmsTaskLifecycle::Succeeded
    }) else {
        return Ok(None);
    };
    let result = read_published_final_states(store, run_id, &artifacts, task, Some(&link.case_id))?
        .into_iter().find(|result| result.output.artifact_id == artifact_id);
    Ok(result.map(|result| ExactStepFinalStateBinding {
        identity: result.identity,
        artifact_catalog: artifacts,
        task: task.clone(),
        output: result.output,
        accepted_state_ref: result.accepted_state_ref,
    }))
}

fn read_published_final_states(
    store: &SessionStore,
    run_id: &str,
    artifacts: &fullmag_session::FmsArtifactCatalog,
    task: &FmsTaskCatalogEntry,
    case_id: Option<&str>,
) -> Result<Vec<PublishedFinalState>, String> {
    let (attempt_id, ownership_epoch) = task_attempt_identity(task)?;
    let mut manifests = artifacts.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task.task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
            && entry.status == FmsArtifactStatus::Published
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    let Some(manifest_entry) = manifests.next() else {
        return Ok(Vec::new());
    };
    if manifests.next().is_some() {
        return Err("requested study step has ambiguous published output manifests".into());
    }
    let manifest_ref = manifest_entry.object_ref.as_deref()
        .filter(|object_ref| *object_ref == manifest_entry.content_sha256)
        .ok_or_else(|| "requested output manifest digest is not pinned".to_string())?;
    let manifest_bytes = store.cas()
        .get_bounded(manifest_ref, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
        .map_err(|error| format!("requested output manifest unreadable: {error}"))?
        .ok_or_else(|| "requested output manifest is missing from CAS".to_string())?;
    let manifest = fullmag_runtime_control::read_study_output_manifest_projection(&manifest_bytes)
        .map_err(|error| format!("requested output manifest is invalid: {error}"))?;
    let canonical_task = fullmag_session::task_id_for_study_step(run_id, &manifest.step_id)
        .map_err(|error| format!("invalid published step identity: {error}"))?;
    if manifest.run_id != run_id
        || manifest.task_id != task.task_id
        || manifest.task_id != canonical_task
        || manifest.attempt_id != attempt_id
        || manifest.ownership_epoch != ownership_epoch
    {
        return Err("requested output manifest ownership identity mismatch".into());
    }
    let mut results = Vec::new();
    let mut cases = std::collections::BTreeSet::new();
    for output in manifest.outputs.into_iter().filter(|output| {
        output.port_id == FINAL_STATE_PORT && case_id.is_none_or(|case| case == output.case_id)
    }) {
        if !cases.insert(output.case_id.clone()) || output.data_kind != "state" {
            return Err("requested final_state output is ambiguous or has the wrong data kind".into());
        }
        if output.object_ref != output.content_sha256 {
            return Err("requested final_state output digest is not pinned".into());
        }
        let mut records = artifacts.entries.iter()
            .filter(|entry| entry.artifact_id == output.artifact_id);
        let record = records.next()
            .ok_or_else(|| "requested final_state artifact is missing from the catalog".to_string())?;
        if records.next().is_some()
            || !task.artifact_ids.contains(&record.artifact_id)
            || record.task_id != task.task_id
            || record.attempt_id != attempt_id
            || record.ownership_epoch != ownership_epoch
            || record.status != FmsArtifactStatus::Published
            || record.artifact_type != "state"
            || record.content_sha256 != output.content_sha256
            || record.object_ref.as_deref() != Some(output.object_ref.as_str())
            || record.study_output.as_ref()
                != Some(&fullmag_session::FmsStudyArtifactOutput {
                    step_id: manifest.step_id.clone(),
                    port_id: FINAL_STATE_PORT.to_string(),
                    case_id: output.case_id.clone(),
                })
        {
            return Err("requested final_state artifact catalog identity mismatch".into());
        }
        results.push(PublishedFinalState {
            identity: crate::schemas::scalars::ScalarSeriesIdentity {
                run_id: run_id.into(),
                task_id: task.task_id.clone(),
                step_id: manifest.step_id.clone(),
                case_id: output.case_id.clone(),
                attempt_id: attempt_id.into(),
                ownership_epoch,
            },
            output,
            accepted_state_ref: manifest.accepted_state_ref.clone(),
        });
    }
    Ok(results)
}

pub(crate) fn load_exact_step_final_state(
    store: &SessionStore,
    run_id: &str,
    session_id: &str,
    session_epoch: u64,
    step_id: &str,
    case_id: &str,
) -> Result<ContinuationSource, String> {
    let binding = load_exact_step_final_state_binding(store, run_id, session_id, session_epoch, step_id, case_id)?;
    let output = &binding.output;
    if output.codec_id != fullmag_application::STUDY_MAGNETIZATION_CODEC_ID
        || output.codec_version != fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION
    {
        return Err("requested final_state output has an unsupported magnetization codec".into());
    }
    let bytes = store
        .cas()
        .get(&output.object_ref)
        .map_err(|error| format!("requested final_state unreadable: {error}"))?
        .ok_or_else(|| "requested final_state is missing from CAS".to_string())?;
    let decoded = fullmag_application::decode_study_artifact(
        &ResolvedStudyArtifact {
            artifact_id: output.artifact_id.clone(),
            object_ref: output.object_ref.clone(),
            data_kind: output.data_kind.clone(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
        },
        &bytes,
    )
    .map_err(|error| format!("requested final_state decode failed: {error}"))?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        return Err("requested final_state is not a magnetization state".into());
    };
    Ok(ContinuationSource {
        run_id: run_id.to_string(),
        step_id: step_id.to_string(),
        case_id: case_id.to_string(),
        artifact_id: output.artifact_id.clone(),
        content_sha256: output.content_sha256.clone(),
        layout: state.layout,
        values: state.values,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use fullmag_session::{
        FmsArtifactCatalog, FmsArtifactCatalogEntry, FmsArtifactStatus, FmsRunCatalog,
        FmsRunIntent, FmsStudyArtifactOutput, FmsStudyOutputManifest,
        FmsStudyOutputManifestEntry, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness,
        FMS_ARTIFACT_CATALOG_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
        FMS_STUDY_OUTPUT_MANIFEST_SCHEMA,
    };
    use serde_json::json;

    fn state_bytes() -> Vec<u8> {
        let layout = json!({
            "backend": "fdm",
            "origin_m": [0.0, 0.0, 0.0],
            "grid_cells": [1, 1, 2],
            "cell_size": [1.0e-9, 1.0e-9, 1.0e-9],
            "total_cell_count": 2,
            "grid_fingerprint": "a".repeat(64),
        });
        let layout_sha256 = fullmag_application::study_state_layout_sha256(&layout).unwrap();
        serde_json::to_vec(&json!({
            "observable": "m",
            "unit": "1",
            "step": 4,
            "time": 4.0e-12,
            "solver_dt": 1.0e-12,
            "layout": layout,
            "provenance": {"execution_resolution": {"requested": "fdm"}},
            "state_identity": {
                "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
                "backend": "fdm",
                "layout_sha256": layout_sha256,
                "sample_count": 2,
            },
            "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        }))
        .unwrap()
    }

    fn task_entry(task_id: String, attempt_id: &str) -> FmsTaskCatalogEntry {
        FmsTaskCatalogEntry {
            task_id,
            input_fingerprint: "b".repeat(64),
            lifecycle: FmsTaskLifecycle::Succeeded,
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: Some(attempt_id.into()),
            ownership_epoch: Some(1),
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    #[tokio::test]
    async fn exact_step_final_state_ignores_other_succeeded_steps_and_pins_full_identity() {
        assert_step_final_state_routes(false).await;
    }

    #[tokio::test]
    async fn authored_script_stage_filter_finds_the_compiled_result_identity() {
        assert_step_final_state_routes(true).await;
    }

    async fn assert_step_final_state_routes(compiled_script: bool) {
        use axum::{body::Body, http::{Request, StatusCode}};
        use fullmag_application::{ProjectId, ProjectSnapshot, RequestedExecution, RunId, RunSpecification, StudyId, StudyReference};
        use tower::ServiceExt;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = "run-exact-final-state";
        let session_id = "session-exact-final-state";
        let session_epoch = 7;
        let authored_stage_id = "relax-target";
        let compiled_step_id = fullmag_application::script_execution_id(authored_stage_id, 0).unwrap();
        let step_id = if compiled_script { compiled_step_id.as_str() } else { authored_stage_id };
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id).unwrap();
        let other_task_id = fullmag_session::task_id_for_study_step(run_id, "relax-other").unwrap();

        let project_id = "project-exact-final-state";
        let specification_for = |run: &str, project: &str| {
            let mut specification = RunSpecification::new(
                ProjectSnapshot {
                    project_id: ProjectId::parse(project.to_owned()).unwrap(),
                    definition_revision: 1,
                    definition_sha256: "a".repeat(64),
                },
                StudyReference {
                    study_id: StudyId::parse("study-exact-final-state".to_owned()).unwrap(),
                    plan_version: if compiled_script {
                        fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into()
                    } else {
                        "study_plan.v1".into()
                    },
                    plan_sha256: "b".repeat(64),
                },
                "c".repeat(64),
                json!({"live_workspace": {"session_id": session_id, "session_epoch": session_epoch}}),
                RequestedExecution {
                    backend: "fdm".into(), device: "cpu".into(),
                    precision: "double".into(), mode: "strict".into(), minimum_resources: None,
                },
            );
            specification.run_id = RunId::parse(run.to_owned()).unwrap();
            serde_json::to_value(specification).unwrap()
        };
        store.commit_run_intent(&FmsRunIntent::new(
            run_id, "intent-exact-final-state", specification_for(run_id, project_id),
        )).unwrap();
        store.commit_run_intent(&FmsRunIntent::new(
            "run-foreign", "intent-foreign", specification_for("run-foreign", "project-foreign"),
        )).unwrap();
        let artifact_id = "artifact-exact-final-state";
        let manifest_id = "artifact-exact-final-state-manifest";
        let mut target = task_entry(task_id.clone(), "attempt-target");
        target.artifact_ids = vec![artifact_id.into(), manifest_id.into()];
        let state_object_ref = store.cas().put(&state_bytes()).unwrap();
        let completion = compiled_script.then(|| {
            use crate::accepted_field_materialization_worker::completion_tests::{entry_for, fixture};
            let (mut record, _) = fixture(fullmag_ir::StageStopReason::MaxSteps, false);
            record.run_id = run_id.into();
            record.task_id = task_id.clone();
            record.step_id = step_id.into();
            record.attempt_id = "attempt-target".into();
            record.input_fingerprint = target.input_fingerprint.clone();
            record.resolved_input_fingerprint = target.resolved_input_fingerprint.clone();
            record.state_object_ref = state_object_ref.clone();
            record.clock = fullmag_quantities::ObservationClock {
                accepted_step: 4, time_seconds: 4e-12, dt_seconds: Some(1e-12),
            };
            record.solver_dt_s = 1e-12;
            record.source.id.run_id = record.run_id.clone();
            record.source.id.stage_id = Some(record.step_id.clone());
            record.source.id.accepted_step = record.clock.accepted_step;
            record.source.id.clock_digest = record.clock.digest().unwrap();
            record.source.generation.accepted_revision = 4;
            record.completion.metric_value = Some(4.0);
            record.completion.threshold = Some(4.0);
            let entry = entry_for(&record);
            assert_eq!(store.cas().put(&serde_json::to_vec(&record).unwrap()).unwrap(), entry.content_sha256);
            target.artifact_ids.push(entry.artifact_id.clone());
            (record.source, entry)
        });
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![
                    target,
                    task_entry(other_task_id, "attempt-other"),
                ],
            })
            .unwrap();

        let manifest = FmsStudyOutputManifest {
            schema_version: FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            step_id: step_id.into(),
            attempt_id: "attempt-target".into(),
            ownership_epoch: 1,
            accepted_state_ref: completion.as_ref().map(|(source, _)| source.clone()),
            observation_source: None,
            outputs: vec![FmsStudyOutputManifestEntry {
                port_id: FINAL_STATE_PORT.into(),
                case_id: OUTPUT_CASE_ID.into(),
                data_kind: "state".into(),
                codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
                artifact_id: artifact_id.into(),
                object_ref: state_object_ref.clone(),
                content_sha256: state_object_ref.clone(),
            }],
        };
        let manifest_object_ref = store
            .cas()
            .put(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        let mut artifact_catalog = FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: Utc::now(),
            entries: vec![
                FmsArtifactCatalogEntry {
                    artifact_id: artifact_id.into(),
                    task_id: task_id.clone(),
                    attempt_id: "attempt-target".into(),
                    ownership_epoch: 1,
                    logical_path: format!("outputs/{task_id}/attempt-target/final_state/default.bin"),
                    artifact_type: "state".into(),
                    content_sha256: state_object_ref.clone(),
                    object_ref: Some(state_object_ref.clone()),
                    status: FmsArtifactStatus::Published,
                    required: true,
                    study_output: Some(FmsStudyArtifactOutput {
                        step_id: step_id.into(),
                        port_id: FINAL_STATE_PORT.into(),
                        case_id: OUTPUT_CASE_ID.into(),
                    }),
                },
                FmsArtifactCatalogEntry {
                    artifact_id: manifest_id.into(),
                    task_id,
                    attempt_id: "attempt-target".into(),
                    ownership_epoch: 1,
                    logical_path: "outputs/target/study-output-manifest.v3.json".into(),
                    artifact_type: "study_output_manifest".into(),
                    content_sha256: manifest_object_ref.clone(),
                    object_ref: Some(manifest_object_ref),
                    status: FmsArtifactStatus::Published,
                    required: true,
                    study_output: None,
                },
            ],
        };
        if let Some((_, entry)) = completion {
            artifact_catalog.entries.push(entry);
        }
        let catalog_path = store
            .root()
            .join(format!("runs/{run_id}/artifact_catalog.json"));
        std::fs::write(catalog_path, serde_json::to_vec(&artifact_catalog).unwrap()).unwrap();

        let source = load_exact_step_final_state(
            &store,
            run_id,
            session_id,
            session_epoch,
            step_id,
            OUTPUT_CASE_ID,
        )
        .unwrap();

        assert_eq!(source.run_id, run_id);
        assert_eq!(source.step_id, step_id);
        assert_eq!(source.artifact_id, artifact_id);
        assert_eq!(source.content_sha256, state_object_ref);
        let listed = list_published_final_states(&store, run_id, &[]).unwrap().unwrap().outputs;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].identity.step_id, step_id);
        assert_eq!(listed[0].identity.attempt_id, "attempt-target");
        assert_eq!(listed[0].output.content_sha256, state_object_ref);
        let other = list_published_final_states(&store, run_id, &["relax-other"]).unwrap().unwrap();
        assert!(other.outputs.is_empty());
        let found = find_published_final_state(&store, run_id, artifact_id).unwrap().unwrap();
        assert_eq!(found.identity, listed[0].identity);
        assert!(find_published_final_state(&store, run_id, manifest_id).unwrap().is_none());

        let mut app_state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let test_state = std::sync::Arc::get_mut(&mut app_state).unwrap();
        test_state.submit_store_root = Some(store.root().to_owned());
        test_state.current_live_session_epoch.store(session_epoch, std::sync::atomic::Ordering::Release);
        {
            let mut current = test_state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.session_id = session_id.into();
            snapshot.session.run_id = run_id.into();
        }
        let app = crate::router_v2::build_v2_router().with_state(app_state.clone());
        let path = "/v2/sessions/current/simulation/stages/results";
        let response = app.clone().oneshot(Request::builder()
            .uri(format!("{path}?stage_id={authored_stage_id}&limit=1")).body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let page: crate::schemas::stage_results::StudyStageResultsResource =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page.project_id, project_id);
        assert_eq!(page.results.len(), 1);
        assert_eq!(page.results[0].source, listed[0].identity);
        assert_eq!(page.results[0].artifact_sha256, state_object_ref);
        assert!(page.results[0].supports_magnetization_input);
        assert!(page.next_cursor.is_none());
        assert_eq!(page.results[0].authored_stage_id.as_deref(), Some(authored_stage_id));
        if compiled_script {
            let evidence = page.results[0].completion.as_ref().unwrap();
            assert_eq!(evidence.converged, Some(false));
            assert_eq!(evidence.reason, Some(crate::schemas::relaxation::StageStopReason::MaxSteps));
            assert_eq!(evidence.metric_unit, Some(crate::schemas::relaxation::StageMetricUnit::Dimensionless));
            assert_eq!(evidence.metric_value, Some(4.0));
            assert_eq!(evidence.threshold, Some(4.0));
        } else {
            assert!(page.results[0].completion.is_none());
        }
        let exact = app.clone().oneshot(Request::builder()
            .uri(format!("{path}?stage_id={step_id}&limit=1")).body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(exact.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(exact.into_body(), 64 * 1024).await.unwrap();
        let exact_page: crate::schemas::stage_results::StudyStageResultsResource =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(exact_page.results.len(), 1);
        assert_eq!(exact_page.results[0].source, page.results[0].source);

        let foreign = app.clone().oneshot(Request::builder()
            .uri(format!("{path}?run_id=run-foreign")).body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
        let context = crate::capture_current_live_read_context(&app_state).await.unwrap();
        let next_project = "project-live-after-api-restart";
        let next_run = "run-live-after-api-restart";
        let parent = crate::live_execution_binding::next_study_history_parent(
            &store, &context, next_project,
        ).unwrap().unwrap();
        let mut next_spec = specification_for(next_run, next_project);
        next_spec["parameters"]["live_workspace"]["study_history_parent"] =
            serde_json::to_value(parent).unwrap();
        store.commit_run_intent(&FmsRunIntent::new(next_run, "intent-after-restart", next_spec)).unwrap();
        {
            let mut current = app_state.current_live_state.write().await;
            current.as_mut().unwrap().session.run_id = next_run.into();
        }
        let retained = app.clone().oneshot(Request::builder()
            .uri(format!("{path}?run_id={run_id}")).body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(retained.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(retained.into_body(), 64 * 1024).await.unwrap();
        let retained: crate::schemas::stage_results::StudyStageResultsResource =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(retained.project_id, next_project);
        assert_eq!(retained.results.len(), 1);
        assert_eq!(retained.results[0].project_id, project_id);
        assert_eq!(retained.results[0].source, page.results[0].source);
        let unrelated = app.clone().oneshot(Request::builder()
            .uri(format!("{path}?run_id=run-foreign")).body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(unrelated.status(), StatusCode::NOT_FOUND);

        let historical = app.clone().oneshot(Request::builder()
            .uri(format!("/v2/persistence/projects/{project_id}/runs/{run_id}/study-results"))
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(historical.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(historical.into_body(), 64 * 1024).await.unwrap();
        let historical: crate::schemas::stage_results::StudyStageResultsResource =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(historical.results[0].source, page.results[0].source);
        assert_eq!(historical.results[0].artifact_id, artifact_id);
        assert_eq!(
            serde_json::to_value(&historical.results[0].completion).unwrap(),
            serde_json::to_value(&page.results[0].completion).unwrap(),
        );

        let wrong_project = app.oneshot(Request::builder()
            .uri(format!("/v2/persistence/projects/project-foreign/runs/{run_id}/study-results/{artifact_id}/magnetization"))
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(wrong_project.status(), StatusCode::CONFLICT);

        assert_eq!(source.values, vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
        assert!(load_final_state(&store, run_id, session_id, session_epoch).is_err());
        assert!(load_exact_step_final_state(
            &store,
            run_id,
            session_id,
            session_epoch,
            "relax-other",
            OUTPUT_CASE_ID,
        )
        .is_err());
    }
}

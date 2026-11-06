//! Immutable live initial-state provenance shared by acceptance and dispatch.

use fullmag_authoring::{StudyInputSource, StudyPlan, StudyStep};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    is_physical_stage, is_state_input, state_input, unresolved, validate_live_initial_state_request,
};
use crate::error::ApiError;
use crate::live_accepted_continuation::InitialStateDecision;
use crate::schemas::authoring::PreparedInitialStateResource;
use crate::schemas::commands::{RuntimeAuthoredInitialStateSource, RuntimeInitialStateRequest};
use crate::schemas::stage_results::{
    StudyResultInitialState, StudyResultInitialStateSource, StudyResultInputSelection,
    StudyResultResetScope,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ResolvedInitialState {
    Authored {
        reference: String,
        reason: String,
    },
    Artifact {
        run_id: String,
        step_id: String,
        case_id: String,
        artifact_id: String,
        content_sha256: String,
    },
    Prepared {
        publication: PreparedInitialStateResource,
        artifact_id: String,
        content_sha256: String,
    },
    Study {
        initial_step_id: Option<String>,
        authored_reference: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "schema_version", deny_unknown_fields)]
enum AcceptedInitialStateBinding {
    #[serde(rename = "fullmag.live-initial-state-binding.v1")]
    V1 {
        requested: Option<RuntimeInitialStateRequest>,
        resolved: ResolvedInitialState,
        overlay: Option<fullmag_authoring::StudyInitialStateOverlay>,
    },
}

fn encode_binding(binding: AcceptedInitialStateBinding) -> Result<Value, ApiError> {
    serde_json::to_value(binding)
        .map_err(|error| ApiError::internal(format!("encode accepted initial state: {error}")))
}

pub(crate) fn selected_initial_state_binding(
    step: &StudyStep,
    decision: &InitialStateDecision,
    requested: Option<&RuntimeInitialStateRequest>,
) -> Result<Value, ApiError> {
    let resolved = match decision {
        InitialStateDecision::Authored { reason } => {
            let Some(StudyInputSource::AuthoredInitialState { reference }) =
                state_input(step)?.map(|port| &port.source)
            else {
                return Err(unresolved(
                    "the selected stage has no bound authored reference",
                ));
            };
            ResolvedInitialState::Authored {
                reference: reference.clone(),
                reason: reason.clone(),
            }
        }
        InitialStateDecision::Prepared(state) => ResolvedInitialState::Prepared {
            publication: state.source.clone(),
            artifact_id: state.artifact_id.clone(),
            content_sha256: state.content_sha256.clone(),
        },
        InitialStateDecision::Continuation(source) => ResolvedInitialState::Artifact {
            run_id: source.run_id.clone(),
            step_id: source.step_id.clone(),
            case_id: source.case_id.clone(),
            artifact_id: source.artifact_id.clone(),
            content_sha256: source.content_sha256.clone(),
        },
    };
    encode_binding(AcceptedInitialStateBinding::V1 {
        requested: requested.cloned(),
        resolved,
        overlay: step.initial_state_overlay.clone(),
    })
}

fn study_initial_state(study: &StudyPlan) -> Result<ResolvedInitialState, ApiError> {
    let mut initial_step_id = None;
    let mut authored_reference = None;
    if let Some(step) = study.steps.iter().find(|step| is_physical_stage(step)) {
        initial_step_id = Some(step.step_id.clone());
        if let Some(port) = state_input(step)? {
            let StudyInputSource::AuthoredInitialState { reference } = &port.source else {
                return Err(unresolved(
                    "the full Study has no authored initial state at its first physical step",
                ));
            };
            authored_reference = Some(reference.clone());
        }
        if step.initial_state_overlay.is_some() {
            return Err(unresolved(
                "the first physical Study step cannot start from a scoped overlay",
            ));
        }
    }
    Ok(ResolvedInitialState::Study {
        initial_step_id,
        authored_reference,
    })
}

pub(crate) fn study_initial_state_binding(
    study: &StudyPlan,
    requested: &RuntimeInitialStateRequest,
) -> Result<Value, ApiError> {
    let resolved = study_initial_state(study)?;
    if matches!(
        requested,
        RuntimeInitialStateRequest::AuthoredInitialState { .. }
    ) && matches!(
        resolved,
        ResolvedInitialState::Study {
            initial_step_id: None,
            ..
        }
    ) {
        return Err(unresolved(
            "the full Study has no physical step with an authored initial state",
        ));
    }
    encode_binding(AcceptedInitialStateBinding::V1 {
        requested: Some(requested.clone()),
        resolved,
        overlay: None,
    })
}

pub(crate) fn validate_worker_initial_state_binding(
    specification: &fullmag_application::RunSpecification,
    study: &StudyPlan,
    step: &fullmag_runtime_control::AcceptedWorkerStep,
) -> anyhow::Result<()> {
    use anyhow::{ensure, Context as _};
    let Some(live) = specification.parameters.get("live_workspace") else {
        return Ok(());
    };
    let requested: Option<RuntimeInitialStateRequest> = live
        .pointer("/command/initial_state")
        .map(|request| serde_json::from_value(request.clone()))
        .transpose()
        .context("decode live command initial state request")?;
    let Some(binding) = live.get("initial_state_source") else {
        ensure!(
            requested.is_none(),
            "explicit initial state request has no accepted binding"
        );
        return Ok(());
    };
    if binding.get("schema_version").is_none() {
        ensure!(
            requested.is_none(),
            "explicit initial state request cannot use legacy provenance"
        );
        // Previously accepted immutable RunSpecs carried only a descriptive record.
        ensure!(
            matches!(
                binding.get("kind").and_then(Value::as_str),
                Some("continuation" | "authored")
            ),
            "unrecognized legacy initial state provenance"
        );
        return Ok(());
    }
    let AcceptedInitialStateBinding::V1 {
        requested: bound_request,
        resolved,
        overlay,
    } = serde_json::from_value(binding.clone()).context("decode accepted initial state binding")?;
    ensure!(
        requested == bound_request,
        "accepted initial state differs from the live command request"
    );
    if let Some(request) = requested.as_ref() {
        let revision = live
            .get("scene_revision")
            .and_then(Value::as_u64)
            .context("explicit initial state has no accepted scene revision")?;
        validate_live_initial_state_request(
            Some(request),
            revision,
            matches!(&resolved, ResolvedInitialState::Study { .. }),
        )
        .map_err(|error| anyhow::anyhow!(error.message))?;
    }
    match &resolved {
        ResolvedInitialState::Study { .. } => {
            ensure!(
                live.get("step_id").is_none_or(Value::is_null),
                "whole Study initial state binds a selected stage"
            );
            ensure!(
                overlay.is_none(),
                "whole Study initial state cannot carry a stage overlay"
            );
            let expected =
                study_initial_state(study).map_err(|error| anyhow::anyhow!(error.message))?;
            ensure!(
                expected == resolved,
                "whole Study initial state differs from the accepted plan"
            );
            return Ok(());
        }
        ResolvedInitialState::Authored { .. }
        | ResolvedInitialState::Artifact { .. }
        | ResolvedInitialState::Prepared { .. } => {
            ensure!(
                live.get("step_id").and_then(Value::as_str) == Some(step.step_id.as_str()),
                "accepted initial state belongs to a different selected stage"
            );
            ensure!(
                overlay == step.initial_state_overlay,
                "accepted initial state overlay differs from the accepted stage"
            );
        }
    }
    if let Some(RuntimeInitialStateRequest::AuthoredInitialState {
        source: RuntimeAuthoredInitialStateSource::Stage { stage_id, .. },
    }) = requested.as_ref()
    {
        ensure!(
            stage_id == &step.step_id,
            "authored initial state refers to another stage"
        );
    }
    let mut ports = step.study_inputs.iter().filter(|port| is_state_input(port));
    let port = ports
        .next()
        .context("accepted selected stage has no initial state port")?;
    ensure!(
        port.required && ports.next().is_none(),
        "accepted selected stage has an ambiguous initial state port"
    );
    let input = step.resolved_input.inputs.get(&port.port_id);
    match (resolved, &port.source) {
        (
            ResolvedInitialState::Authored { reference, .. },
            StudyInputSource::AuthoredInitialState {
                reference: expected,
            },
        ) => {
            ensure!(
                &reference == expected && input.is_none() && overlay.is_none(),
                "accepted authored initial state differs from the worker input"
            );
            ensure!(
                super::prepared_request(requested.as_ref()).is_none(),
                "requested prepared magnetization was replaced by authored initial state"
            );
            ensure!(
                !matches!(
                    requested,
                    Some(
                        RuntimeInitialStateRequest::StageResult { .. }
                            | RuntimeInitialStateRequest::LatestCompatibleState
                    )
                ),
                "requested final state was replaced by authored initial state"
            );
        }
        (
            ResolvedInitialState::Prepared {
                publication,
                artifact_id,
                content_sha256,
            },
            StudyInputSource::PinnedArtifact {
                artifact_id: expected_id,
                content_sha256: expected_digest,
            },
        ) => {
            let artifact = input
                .and_then(|input| input.study_artifact.as_ref())
                .context("prepared initial state has no typed CAS binding")?;
            ensure!(
                overlay.is_none()
                    && super::prepared_request(requested.as_ref()).is_some_and(|request| {
                        super::prepared::matches_request(&publication, request)
                    })
                    && &artifact_id == expected_id
                    && &content_sha256 == expected_digest
                    && artifact.artifact_id == artifact_id
                    && artifact.object_ref == content_sha256
                    && specification
                        .immutable_assets
                        .iter()
                        .any(|asset| asset.asset_id == artifact_id
                            && asset.content_sha256 == content_sha256),
                "accepted prepared magnetization differs from the worker artifact"
            );
        }
        (
            ResolvedInitialState::Artifact {
                run_id,
                step_id,
                case_id,
                artifact_id,
                content_sha256,
            },
            StudyInputSource::PinnedArtifact {
                artifact_id: expected_id,
                content_sha256: expected_digest,
            },
        ) => {
            let input = input.context("pinned initial state has no worker artifact")?;
            let artifact = input
                .study_artifact
                .as_ref()
                .context("pinned initial state has no typed CAS binding")?;
            ensure!(
                &artifact_id == expected_id
                    && &content_sha256 == expected_digest
                    && artifact.artifact_id == artifact_id
                    && artifact.object_ref == content_sha256,
                "accepted final state differs from the worker artifact"
            );
            match requested {
                Some(RuntimeInitialStateRequest::StageResult {
                    run_id: requested_run,
                    step_id: requested_step,
                    case_id: requested_case,
                    artifact_id: requested_artifact,
                    content_sha256: requested_digest,
                    ..
                }) => {
                    ensure!(
                        run_id == requested_run
                            && step_id == requested_step
                            && case_id == requested_case
                            && artifact_id == requested_artifact
                            && content_sha256 == requested_digest,
                        "accepted final state identity differs from the exact result request"
                    );
                }
                Some(RuntimeInitialStateRequest::AuthoredInitialState { source }) => {
                    ensure!(
                        matches!(source, RuntimeAuthoredInitialStateSource::Stage { .. })
                            && overlay.is_some(),
                        "authored initial state requires an authored port or a scoped overlay"
                    );
                }
                _ => {}
            }
        }
        _ => anyhow::bail!("accepted initial state source differs from the worker port"),
    }
    Ok(())
}

/// Describe the input of the successful attempt from its immutable plan and
/// admission. Prepare dispatch requires these exact resolved input bytes.
pub(crate) fn describe_result_initial_state(
    store: &fullmag_session::SessionStore,
    specification: &fullmag_application::RunSpecification,
    study: &StudyPlan,
    step_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
    catalog: &fullmag_session::FmsRunCatalog,
    artifacts: &fullmag_session::FmsArtifactCatalog,
) -> Option<StudyResultInitialState> {
    use fullmag_session::{FmsArtifactStatus, FmsTaskLifecycle};
    use StudyResultInitialStateSource as Source;

    let run_id = specification.run_id.as_str();
    let step = study.steps.iter().find(|step| step.step_id == step_id)?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded
        || !is_physical_stage(step)
        || catalog.run_id != run_id
        || artifacts.run_id != run_id
        || fullmag_session::task_id_for_study_step(run_id, &step.step_id).ok()? != task.task_id
    {
        return None;
    }
    let port = state_input(step).ok()??;
    if !port.required {
        return None;
    }
    let admitted = super::admitted_input_snapshot(store, run_id, task).ok()??;
    let source = if let StudyInputSource::AuthoredInitialState { reference } = &port.source {
        if admitted.inputs.get(&port.port_id).is_some() || step.initial_state_overlay.is_some() {
            return None;
        }
        Source::Authored {
            reference: reference.clone(),
        }
    } else {
        let resolved: fullmag_application::ResolvedInput =
            serde_json::from_value(admitted.inputs.get(&port.port_id)?.clone()).ok()?;
        resolved.validate().ok()?;
        let artifact = resolved.study_artifact?;
        let data_kind = match port.data_kind {
            fullmag_authoring::StudyPortDataKind::State => "state",
            fullmag_authoring::StudyPortDataKind::InitialState => "initial_state",
            _ => return None,
        };
        if artifact.data_kind != data_kind {
            return None;
        }
        match &port.source {
            StudyInputSource::StepOutput {
                step_id,
                port,
                case_id,
            } if port == super::live_accepted_continuation::FINAL_STATE_PORT => {
                let producer_id = fullmag_session::task_id_for_study_step(run_id, step_id).ok()?;
                let producer = catalog.tasks.iter().find(|candidate| {
                    candidate.task_id == producer_id
                        && candidate.lifecycle == FmsTaskLifecycle::Succeeded
                        && candidate.artifact_ids.contains(&artifact.artifact_id)
                })?;
                artifacts.entries.iter().find(|entry| {
                    entry.artifact_id == artifact.artifact_id
                        && entry.task_id == producer_id
                        && producer.attempt_id.as_deref() == Some(entry.attempt_id.as_str())
                        && producer.ownership_epoch == Some(entry.ownership_epoch)
                        && entry.artifact_type == "state"
                        && entry.status == FmsArtifactStatus::Published
                        && entry.object_ref.as_deref() == Some(artifact.object_ref.as_str())
                        && entry.content_sha256 == artifact.object_ref
                        && entry.study_output.as_ref().is_some_and(|output| {
                            output.step_id == *step_id
                                && output.port_id == *port
                                && output.case_id == *case_id
                        })
                })?;
                Source::StageResult {
                    run_id: run_id.into(),
                    step_id: step_id.clone(),
                    case_id: case_id.clone(),
                    artifact_id: artifact.artifact_id,
                    content_sha256: artifact.object_ref,
                    selection: StudyResultInputSelection::Predecessor,
                }
            }
            StudyInputSource::PinnedArtifact {
                artifact_id,
                content_sha256,
            } if *artifact_id == artifact.artifact_id && *content_sha256 == artifact.object_ref => {
                describe_pinned_result_state(
                    specification,
                    step,
                    study.source_pipeline_version.as_deref(),
                    artifact_id,
                    content_sha256,
                )?
            }
            _ => return None,
        }
    };
    let reset_scopes = step
        .initial_state_overlay
        .as_ref()
        .map_or_else(Vec::new, |overlay| {
            overlay
                .scopes()
                .iter()
                .map(|scope| StudyResultResetScope {
                    object_id: scope.object_id.clone(),
                    region_id: scope.region_id.clone(),
                })
                .collect()
        });
    Some(StudyResultInitialState {
        source,
        reset_scopes,
    })
}

fn describe_pinned_result_state(
    specification: &fullmag_application::RunSpecification,
    step: &StudyStep,
    source_pipeline_version: Option<&str>,
    expected_artifact: &str,
    expected_digest: &str,
) -> Option<StudyResultInitialStateSource> {
    use StudyResultInitialStateSource as Source;
    let live = specification.parameters.get("live_workspace")?;
    if live.get("step_id")?.as_str()? != step.step_id {
        return None;
    }
    let AcceptedInitialStateBinding::V1 {
        requested,
        resolved,
        overlay,
    } = serde_json::from_value(live.get("initial_state_source")?.clone()).ok()?;
    let command_request = live
        .pointer("/command/initial_state")
        .map(|value| serde_json::from_value::<RuntimeInitialStateRequest>(value.clone()))
        .transpose()
        .ok()?;
    if overlay != step.initial_state_overlay || requested != command_request {
        return None;
    }
    match resolved {
        ResolvedInitialState::Artifact {
            run_id,
            step_id,
            case_id,
            artifact_id,
            content_sha256,
        } if artifact_id == expected_artifact && content_sha256 == expected_digest => {
            let selection = match requested {
                Some(RuntimeInitialStateRequest::StageResult {
                    run_id: run,
                    step_id: stage,
                    case_id: case,
                    artifact_id: artifact,
                    content_sha256: digest,
                    ..
                }) => {
                    if run != run_id
                        || stage != step_id
                        || case != case_id
                        || artifact != artifact_id
                        || digest != content_sha256
                    {
                        return None;
                    }
                    StudyResultInputSelection::SelectedResult
                }
                Some(RuntimeInitialStateRequest::LatestCompatibleState) => {
                    StudyResultInputSelection::LatestCompatible
                }
                Some(RuntimeInitialStateRequest::DefaultForTarget) => {
                    StudyResultInputSelection::Predecessor
                }
                Some(RuntimeInitialStateRequest::AuthoredInitialState {
                    source: RuntimeAuthoredInitialStateSource::Stage { stage_id, .. },
                }) if stage_id == step.step_id && overlay.is_some() => {
                    StudyResultInputSelection::Predecessor
                }
                Some(RuntimeInitialStateRequest::AuthoredInitialState { .. }) => return None,
                None if source_pipeline_version == Some("study_pipeline.v2") => {
                    StudyResultInputSelection::Predecessor
                }
                None => StudyResultInputSelection::PinnedResult,
            };
            Some(Source::StageResult {
                run_id,
                step_id,
                case_id,
                artifact_id,
                content_sha256,
                selection,
            })
        }
        ResolvedInitialState::Prepared {
            publication,
            artifact_id,
            content_sha256,
        } if artifact_id == expected_artifact
            && content_sha256 == expected_digest
            && overlay.is_none()
            && super::prepared_request(requested.as_ref())
                .is_some_and(|request| super::prepared::matches_request(&publication, request))
            && specification.immutable_assets.iter().any(|asset| {
                asset.asset_id == artifact_id && asset.content_sha256 == content_sha256
            }) =>
        {
            Some(Source::Prepared {
                publication_id: publication.publication_id,
                artifact_id,
                content_sha256,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_provenance_version_or_fields() {
        let accepted = json!({
            "schema_version": "fullmag.live-initial-state-binding.v1",
            "requested": {"kind": "default_for_target"},
            "resolved": {"kind": "study", "initial_step_id": "first", "authored_reference": null},
            "overlay": null
        });
        let decoded: AcceptedInitialStateBinding =
            serde_json::from_value(accepted.clone()).unwrap();
        assert_eq!(encode_binding(decoded).unwrap(), accepted);
        let mut unknown_version = accepted.clone();
        unknown_version["schema_version"] = json!("fullmag.live-initial-state-binding.v2");
        assert!(serde_json::from_value::<AcceptedInitialStateBinding>(unknown_version).is_err());
        let mut unknown_field = accepted;
        unknown_field["resolved"]["path"] = json!("worker-file");
        assert!(serde_json::from_value::<AcceptedInitialStateBinding>(unknown_field).is_err());
    }
}

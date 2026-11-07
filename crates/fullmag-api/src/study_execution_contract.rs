//! Immutable Study execution contracts shared by the API and accepted worker.

use crate::error::ApiError;
use fullmag_authoring::{
    StudyInputPort, StudyInputSource, StudyPlan, StudyPortDataKind, StudyStep,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

pub(crate) const FINAL_STATE_PORT: &str = "final_state";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeInitialStateRequest {
    DefaultForTarget,
    AuthoredInitialState {
        source: RuntimeAuthoredInitialStateSource,
    },
    StageResult {
        run_id: String,
        step_id: String,
        case_id: String,
        artifact_id: String,
        content_sha256: String,
        #[serde(default)]
        allow_stale_model: bool,
    },
    LatestCompatibleState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeAuthoredInitialStateSource {
    Study {
        scene_revision: u64,
    },
    Stage {
        stage_id: String,
        scene_revision: u64,
    },
    Prepared {
        scene_revision: u64,
        initial_state_revision: u64,
        publication_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparedInitialStateResource {
    pub scene_revision: u64,
    pub initial_state_revision: u64,
    pub publication_id: String,
    pub observation_frame_id: String,
    pub domain_generation_id: String,
    pub values_sha256: String,
}

/// Run, authored execution step, case and worker attempt of one scalar series.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ScalarSeriesIdentity {
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub case_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
}

/// Archived physical samples read from one claim-qualified artifact.
#[derive(Debug, Serialize, ToSchema)]
pub struct HistoricalScalarWindow {
    pub series: ScalarSeriesIdentity,
    pub artifact_id: String,
    pub content_sha256: String,
    pub coverage: HistoricalScalarCoverage,
    pub total_rows: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_start: Option<u64>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalScalarCoverage {
    SolverSeries,
    TerminalSample,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "schema_version", deny_unknown_fields)]
pub(crate) enum StudyHistoryParent {
    #[serde(rename = "fullmag.live-study-history-parent.v1")]
    V1 {
        run_id: String,
        specification_sha256: String,
    },
}

pub(crate) fn parse_study_history_parent(value: &Value) -> anyhow::Result<StudyHistoryParent> {
    let link: StudyHistoryParent = serde_json::from_value(value.clone())?;
    let StudyHistoryParent::V1 {
        run_id,
        specification_sha256,
    } = &link;
    fullmag_session::repository_path::validate_store_id(run_id)?;
    anyhow::ensure!(
        specification_sha256.len() == 64
            && specification_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid Study history parent specification digest"
    );
    Ok(link)
}

pub(crate) struct ExactStepFinalStateBinding {
    pub identity: ScalarSeriesIdentity,
    pub artifact_catalog: fullmag_session::FmsArtifactCatalog,
    pub task: fullmag_session::FmsTaskCatalogEntry,
    pub accepted_state_ref: Option<fullmag_quantities::AcceptedStateRef>,
    pub output: fullmag_session::FmsStudyOutputManifestEntry,
}

pub(crate) fn unresolved(message: impl Into<String>) -> ApiError {
    ApiError::unprocessable_with_code("stage_state_source_unresolved", message)
}

pub(crate) fn is_state_input(input: &StudyInputPort) -> bool {
    matches!(
        input.data_kind,
        StudyPortDataKind::State | StudyPortDataKind::InitialState
    )
}

pub(crate) fn state_input(step: &StudyStep) -> Result<Option<&StudyInputPort>, ApiError> {
    let mut inputs = step.inputs.iter().filter(|input| is_state_input(input));
    let input = inputs.next();
    if inputs.next().is_some() {
        return Err(unresolved(format!(
            "stage '{}' has multiple magnetization inputs",
            step.step_id
        )));
    }
    Ok(input)
}

pub(crate) fn validate_live_initial_state_request(
    request: Option<&RuntimeInitialStateRequest>,
    scene_revision: u64,
    whole_study: bool,
) -> Result<(), ApiError> {
    use RuntimeAuthoredInitialStateSource::{Prepared, Stage, Study};
    use RuntimeInitialStateRequest::{AuthoredInitialState, DefaultForTarget};

    match request {
        None | Some(DefaultForTarget) => Ok(()),
        Some(AuthoredInitialState { source }) => {
            let revision = match source {
                Study { scene_revision }
                | Stage { scene_revision, .. }
                | Prepared { scene_revision, .. } => *scene_revision,
            };
            if revision != scene_revision {
                return Err(ApiError::conflict_with_code(
                    "initial_state_scene_revision_mismatch",
                    "the authored initial state refers to a different scene revision",
                ));
            }
            match source {
                Study { .. } => Ok(()),
                Prepared { .. } if whole_study => Err(unresolved(
                    "the full Study requires its own authored initial state",
                )),
                Prepared { publication_id, .. }
                    if publication_id.trim().is_empty() || publication_id.len() > 256 =>
                {
                    Err(ApiError::bad_request(
                        "prepared initial state requires a valid publication ID",
                    ))
                }
                Prepared { .. } => Ok(()),
                Stage { .. } if whole_study => Err(unresolved(
                    "the full Study requires its own authored initial state",
                )),
                Stage { .. } => Ok(()),
            }
        }
        Some(_) if whole_study => Err(unresolved(
            "the full Study starts from its authored initial state",
        )),
        Some(_) => Ok(()),
    }
}

pub(crate) fn is_physical_stage(step: &StudyStep) -> bool {
    use fullmag_authoring::{StudyPrimitiveStageKind, StudyStepKind};
    step.enabled
        && matches!(
            &step.kind,
            StudyStepKind::Primitive {
                stage_kind: StudyPrimitiveStageKind::Run | StudyPrimitiveStageKind::Relax,
            }
        )
}

pub(crate) fn prepared_request(
    request: Option<&RuntimeInitialStateRequest>,
) -> Option<&RuntimeAuthoredInitialStateSource> {
    match request {
        Some(RuntimeInitialStateRequest::AuthoredInitialState {
            source: source @ RuntimeAuthoredInitialStateSource::Prepared { .. },
        }) => Some(source),
        _ => None,
    }
}

pub(crate) fn matches_prepared_request(
    identity: &PreparedInitialStateResource,
    request: &RuntimeAuthoredInitialStateSource,
) -> bool {
    matches!(request, RuntimeAuthoredInitialStateSource::Prepared {
        scene_revision, initial_state_revision, publication_id,
    } if *scene_revision == identity.scene_revision
        && *initial_state_revision == identity.initial_state_revision
        && publication_id == &identity.publication_id)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ResolvedInitialState {
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
pub(crate) enum AcceptedInitialStateBinding {
    #[serde(rename = "fullmag.live-initial-state-binding.v1")]
    V1 {
        requested: Option<RuntimeInitialStateRequest>,
        resolved: ResolvedInitialState,
        overlay: Option<fullmag_authoring::StudyInitialStateOverlay>,
    },
}

pub(crate) fn study_initial_state(study: &StudyPlan) -> Result<ResolvedInitialState, ApiError> {
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
                prepared_request(requested.as_ref()).is_none(),
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
                    && prepared_request(requested.as_ref())
                        .is_some_and(|request| { matches_prepared_request(&publication, request) })
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

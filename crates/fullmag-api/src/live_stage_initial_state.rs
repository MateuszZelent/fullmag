//! Resolve an explicitly selected stage against the unchanged authored graph.

use std::collections::BTreeSet;

use fullmag_authoring::{
    StudyInputPort, StudyInputSource, StudyPlan, StudyPortDataKind, StudyStep,
};
use fullmag_plan::StudyProblemCatalogEntry;
use fullmag_session::{FmsRunIntent, FmsTaskLifecycle, SessionStore};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::live_accepted_continuation::{self, ContinuationSource, InitialStateDecision};
use crate::live_execution_binding::current_study_history;
use crate::schemas::commands::{RuntimeAuthoredInitialStateSource, RuntimeInitialStateRequest};
use crate::types::CurrentLiveRequestContext;

mod binding;
mod prepared;

pub(crate) use prepared::{
    describe_prepared_initial_state, prepared_request, PreparedStateArtifact, PreparedStateCapture,
};

pub(crate) use binding::{
    describe_result_initial_state, selected_initial_state_binding, study_initial_state_binding,
    validate_worker_initial_state_binding,
};

fn unresolved(message: impl Into<String>) -> ApiError {
    ApiError::unprocessable_with_code("stage_state_source_unresolved", message)
}

fn prepared_initial_state_unavailable() -> ApiError {
    ApiError::unprocessable_with_code(
        "initial_state_prepared_publication_unavailable",
        "the requested prepared initial-state publication is unavailable",
    )
}

fn is_state_input(input: &StudyInputPort) -> bool {
    matches!(
        input.data_kind,
        StudyPortDataKind::State | StudyPortDataKind::InitialState
    )
}

fn state_input(step: &StudyStep) -> Result<Option<&StudyInputPort>, ApiError> {
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

fn catalog_entry<'a>(
    catalog: &'a [StudyProblemCatalogEntry],
    step_id: &str,
) -> Result<&'a StudyProblemCatalogEntry, ApiError> {
    catalog
        .iter()
        .find(|entry| entry.step_id() == step_id)
        .ok_or_else(|| unresolved(format!("stage '{step_id}' has no immutable ProblemIR")))
}

/// Preserve legacy untargeted continuation only while its authored input
/// identity still matches. Explicit StageId/StageIndex use the graph recipe.
pub(crate) fn resolve_selected_live_initial_state(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    selected: usize,
    explicitly_targeted: bool,
    previous_run_id: Option<&str>,
) -> Result<InitialStateDecision, ApiError> {
    let step = &study.steps[selected];
    let entry = catalog_entry(catalog, &step.step_id)?;
    let input = state_input(step)?;
    if input.is_none()
        && study.steps[..selected].iter().any(|previous| {
            previous.enabled
                && matches!(
                    &previous.kind,
                    fullmag_authoring::StudyStepKind::Primitive {
                        stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run
                            | fullmag_authoring::StudyPrimitiveStageKind::Relax,
                    }
                )
        })
        && study.schema_version != fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION
    {
        return Err(unresolved(
            "selected stage has no qualified state flow in this mixed Study",
        ));
    }
    let source = match input.map(|port| &port.source) {
        Some(StudyInputSource::StepOutput { .. }) => Some(resolve_qualified_predecessor(
            store, context, study, catalog, step,
        )?),
        Some(StudyInputSource::AuthoredInitialState { .. }) => None,
        Some(_) => {
            return Err(unresolved(
                "selected stage has an unsupported authored state source",
            ))
        }
        None if !explicitly_targeted
            && study.source_pipeline_version.as_deref() != Some("study_pipeline.v2") =>
        {
            let identity = crate::live_execution_binding::input_identity(scene)?;
            let previous = previous_run_id.and_then(|run_id| {
                let intent = store.read_run_intent(run_id).ok().flatten()?;
                crate::live_execution_binding::validate_input_binding(
                    &intent.specification,
                    &identity,
                    scene.revision,
                )
                .ok()?;
                Some(run_id)
            });
            if previous.is_some() {
                let plan = fullmag_plan::plan(entry.problem())
                    .map_err(|error| unresolved(format!("cannot plan selected stage: {error}")))?;
                return Ok(live_accepted_continuation::decide_initial_state(
                    store,
                    previous,
                    &context.session_id,
                    context.session_epoch,
                    &plan,
                ));
            }
            None
        }
        None => None,
    };

    if let Some(source) = source {
        let plan = fullmag_plan::plan(entry.problem())
            .map_err(|error| unresolved(format!("cannot plan selected stage: {error}")))?;
        fullmag_runner::materialize_study_magnetization_input(
            &plan,
            &source.layout,
            &source.values,
        )
        .map_err(|error| {
            unresolved(format!(
                "predecessor layout is incompatible: {}",
                error.message
            ))
        })?;
        Ok(InitialStateDecision::Continuation(source))
    } else {
        Ok(InitialStateDecision::Authored {
            reason: "the selected stage uses its authored initial state".into(),
        })
    }
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
                    Err(ApiError::bad_request("prepared initial state requires a valid publication ID"))
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

pub(crate) fn resolve_requested_live_initial_state(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
    study: &mut StudyPlan,
    catalog: &mut [StudyProblemCatalogEntry],
    selected: usize,
    command: &crate::types::SessionCommand,
    explicitly_targeted: bool,
    previous_run_id: Option<&str>,
    prepared_capture: Option<&PreparedStateCapture>,
) -> Result<InitialStateDecision, ApiError> {
    use RuntimeAuthoredInitialStateSource::{Prepared, Stage, Study};
    use RuntimeInitialStateRequest::*;

    let step = &study.steps[selected];
    match command.initial_state.as_ref() {
        None | Some(DefaultForTarget) => resolve_selected_live_initial_state(
            store,
            context,
            scene,
            study,
            catalog,
            selected,
            explicitly_targeted || command.initial_state.is_some(),
            previous_run_id,
        ),
        Some(AuthoredInitialState {
            source: Stage { stage_id, .. },
        }) => {
            if stage_id != &step.step_id {
                return Err(unresolved(
                    "authored initial state does not belong to the selected stage",
                ));
            }
            if step.initial_state_overlay.is_some() {
                return resolve_selected_live_initial_state(
                    store, context, scene, study, catalog, selected, true, None,
                );
            }
            if study.source_pipeline_version.as_deref() == Some("study_pipeline.v2")
                && !state_input(step)?.is_some_and(|port| {
                    matches!(&port.source, StudyInputSource::AuthoredInitialState { .. })
                })
                && study.steps[..selected].iter().any(is_physical_stage)
            {
                return Err(unresolved(
                    "the selected stage has no authored texture reset",
                ));
            }
            Ok(InitialStateDecision::Authored {
                reason: "authored texture of the selected stage".into(),
            })
        }
        Some(AuthoredInitialState {
            source: Study { .. },
        }) => {
            bind_study_texture_to_selected_stage(study, catalog, selected)?;
            Ok(InitialStateDecision::Authored {
                reason: "authored texture of the Study".into(),
            })
        }
        Some(AuthoredInitialState {
            source: requested @ Prepared { .. },
        }) => {
            let capture = prepared_capture.ok_or_else(prepared_initial_state_unavailable)?;
            let state = capture.freeze(catalog_entry(catalog, &step.step_id)?, requested)?;
            Ok(InitialStateDecision::Prepared(state))
        }
        Some(StageResult {
            run_id,
            step_id,
            case_id,
            artifact_id,
            content_sha256,
            allow_stale_model,
        }) => {
            require_history_source(store, context, run_id)?;
            let source = live_accepted_continuation::load_exact_step_final_state(
                store,
                run_id,
                &context.session_id,
                context.session_epoch,
                step_id,
                case_id,
            )
            .map_err(unresolved)?;
            if &source.artifact_id != artifact_id || &source.content_sha256 != content_sha256 {
                return Err(unresolved(
                    "the requested artifact ID or digest differs from the final state",
                ));
            }
            if !*allow_stale_model {
                qualify_requested_result(store, context, study, catalog, &source)?;
            }
            validate_target_layout(catalog_entry(catalog, &step.step_id)?, &source)?;
            Ok(InitialStateDecision::Continuation(source))
        }
        Some(LatestCompatibleState) => {
            let source = resolve_latest_compatible_result(store, context, study, catalog, step)?;
            Ok(InitialStateDecision::Continuation(source))
        }
    }
}

fn is_physical_stage(step: &StudyStep) -> bool {
    use fullmag_authoring::{StudyPrimitiveStageKind, StudyStepKind};
    step.enabled
        && matches!(
            &step.kind,
            StudyStepKind::Primitive {
                stage_kind: StudyPrimitiveStageKind::Run | StudyPrimitiveStageKind::Relax,
            }
        )
}

fn bind_study_texture_to_selected_stage(
    study: &mut StudyPlan,
    catalog: &mut [StudyProblemCatalogEntry],
    selected: usize,
) -> Result<(), ApiError> {
    let first = study
        .steps
        .iter()
        .find(|step| is_physical_stage(step))
        .ok_or_else(|| unresolved("the Study has no authored physical initial state"))?;
    let mut step = study.steps[selected].clone();
    let source = catalog_entry(catalog, &first.step_id)?;
    let target = catalog_entry(catalog, &step.step_id)?;
    if plan_layout(source)? != plan_layout(target)? {
        return Err(unresolved(
            "Study initial state and selected stage have different layouts",
        ));
    }
    let mut problem = target.problem().clone();
    for magnet in &mut problem.magnets {
        let source_magnet = source
            .problem()
            .magnets
            .iter()
            .find(|candidate| {
                candidate.object_id == magnet.object_id
                    && candidate.region == magnet.region
                    && candidate.name == magnet.name
            })
            .ok_or_else(|| {
                unresolved("Study initial state belongs to different magnetic objects")
            })?;
        magnet.initial_magnetization = source_magnet.initial_magnetization.clone();
    }
    for region in &mut problem.object_regions {
        let source_region = source
            .problem()
            .object_regions
            .iter()
            .find(|candidate| {
                candidate.region_id == region.region_id
                    && candidate.owner_object == region.owner_object
                    && candidate.enabled == region.enabled
                    && candidate.shape == region.shape
                    && candidate.frame == region.frame
                    && candidate.priority == region.priority
            })
            .ok_or_else(|| {
                unresolved("Study initial state belongs to different magnetic regions")
            })?;
        region.texture_override = source_region.texture_override.clone();
    }
    if problem.magnets.len() != source.problem().magnets.len()
        || problem.object_regions.len() != source.problem().object_regions.len()
    {
        return Err(unresolved(
            "Study initial state belongs to different objects or regions",
        ));
    }
    let execution = target
        .execution_materialization()
        .cloned()
        .ok_or_else(|| unresolved("the selected stage has no execution materialization"))?;
    step.initial_state_overlay = None;
    let replacement = StudyProblemCatalogEntry::from_materialized_step(&step, problem, execution);
    let entry = catalog
        .iter_mut()
        .find(|entry| entry.step_id() == step.step_id)
        .ok_or_else(|| unresolved("the selected stage has no immutable ProblemIR"))?;
    *entry = replacement;
    study.steps[selected] = step;
    Ok(())
}

fn plan_layout(entry: &StudyProblemCatalogEntry) -> Result<Value, ApiError> {
    let plan =
        fullmag_plan::plan(entry.problem()).map_err(|error| unresolved(error.to_string()))?;
    fullmag_runner::study_magnetization_layout_for_plan(&plan)
        .map_err(|error| unresolved(error.message))
}

fn validate_target_layout(
    entry: &StudyProblemCatalogEntry,
    source: &ContinuationSource,
) -> Result<(), ApiError> {
    let plan =
        fullmag_plan::plan(entry.problem()).map_err(|error| unresolved(error.to_string()))?;
    fullmag_runner::materialize_study_magnetization_input(&plan, &source.layout, &source.values)
        .map(|_| ())
        .map_err(|error| {
            ApiError::unprocessable_with_code(
                "initial_state_incompatible_with_target",
                error.message,
            )
        })
}

pub(crate) fn restrict_live_study_to_selected_step(
    study: &mut StudyPlan,
    index: usize,
    problem: &fullmag_ir::ProblemIR,
    decision: &InitialStateDecision,
) -> Result<(), ApiError> {
    let selected = &mut study.steps[index];
    let existing = state_input(selected)?.map(|input| (input.port_id.clone(), input.data_kind));
    if selected.inputs.iter().any(|input| {
        !is_state_input(input)
            && (input.required || matches!(&input.source, StudyInputSource::StepOutput { .. }))
    }) {
        return Err(unresolved(
            "selected Run/Relax cannot bind another required input or predecessor port",
        ));
    }
    let (port_id, data_kind) = existing.clone().unwrap_or_else(|| {
        (
            live_accepted_continuation::INITIAL_STATE_PORT.into(),
            StudyPortDataKind::State,
        )
    });
    if existing.is_none() && selected.inputs.iter().any(|input| input.port_id == port_id) {
        return Err(unresolved(
            "selected stage's initial_state ID belongs to a different input",
        ));
    }
    let source = match decision {
        InitialStateDecision::Prepared(state) => {
            // The published carrier already includes any scoped reset.
            // An explicit source replaces the stage's automatic recipe.
            selected.initial_state_overlay = None;
            StudyInputSource::PinnedArtifact {
                artifact_id: state.artifact_id.clone(),
                content_sha256: state.content_sha256.clone(),
            }
        }
        InitialStateDecision::Continuation(source) => {
            if data_kind != StudyPortDataKind::State {
                return Err(unresolved("final_state artifact requires a State input"));
            }
            live_accepted_continuation::pinned_initial_state_source(source)
        }
        InitialStateDecision::Authored { .. } => {
            if selected.initial_state_overlay.is_some() {
                return Err(unresolved("scoped reset requires a qualified predecessor"));
            }
            StudyInputSource::AuthoredInitialState {
                reference: fullmag_plan::authored_initial_state_reference(
                    &selected.step_id,
                    problem,
                )
                .map_err(|error| unresolved(error.to_string()))?,
            }
        }
    };
    let bound = StudyInputPort {
        port_id,
        data_kind,
        required: true,
        source,
    };
    if let Some((port_id, _)) = existing {
        let port = selected
            .inputs
            .iter_mut()
            .find(|input| input.port_id == port_id)
            .expect("the selected input came from this stage");
        *port = bound;
    } else {
        selected.inputs.push(bound);
    }
    selected.completion_dependencies.clear();
    for (step_index, step) in study.steps.iter_mut().enumerate() {
        step.enabled = step_index == index;
    }
    study.validate_for_execution().map_err(|error| {
        ApiError::unprocessable_with_code("accepted_study_plan_invalid", error.to_string())
    })
}

fn owned_history(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
) -> Result<Vec<FmsRunIntent>, ApiError> {
    let Some(history) = current_study_history(store, context)? else {
        return Ok(Vec::new());
    };
    let mut runs = store
        .list_run_intents()
        .map_err(|error| unresolved(format!("live result history cannot be read: {error:#}")))?;
    runs.retain(|intent| history.owns(intent, context));
    Ok(runs)
}

fn require_history_source(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    run_id: &str,
) -> Result<(), ApiError> {
    let unavailable = || unresolved("the requested result is outside the current Study history");
    let history = current_study_history(store, context)?.ok_or_else(unavailable)?;
    let intent = store.read_run_intent(run_id)
        .map_err(|error| unresolved(format!("read requested Study result: {error:#}")))?
        .filter(|intent| history.owns(intent, context))
        .ok_or_else(unavailable)?;
    crate::live_execution_binding::verified_history_run_spec(&intent)?;
    Ok(())
}

fn resolve_qualified_predecessor(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    selected: &StudyStep,
) -> Result<ContinuationSource, ApiError> {
    let history = owned_history(store, context)?;
    qualified_predecessor(store, context, study, catalog, selected, &history)?
        .ok_or_else(|| unresolved("selected stage requires an unavailable current predecessor"))
}

fn qualified_predecessor(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    selected: &StudyStep,
    history: &[FmsRunIntent],
) -> Result<Option<ContinuationSource>, ApiError> {
    let mut chain = Vec::new();
    let mut seen = BTreeSet::new();
    let mut consumer = selected;
    while let Some(StudyInputSource::StepOutput {
        step_id,
        port,
        case_id,
    }) = state_input(consumer)?.map(|port| &port.source)
    {
        if port != live_accepted_continuation::FINAL_STATE_PORT || !seen.insert(step_id.as_str()) {
            return Err(unresolved(
                "selected stage has an unsupported predecessor state chain",
            ));
        }
        let predecessor = study
            .steps
            .iter()
            .find(|step| step.enabled && step.step_id == *step_id)
            .ok_or_else(|| {
                unresolved(format!("required predecessor '{step_id}' is unavailable"))
            })?;
        chain.push((predecessor, case_id.as_str()));
        consumer = predecessor;
    }

    let mut current = None;
    for (step, case_id) in chain.into_iter().rev() {
        let entry = catalog_entry(catalog, &step.step_id)?;
        let expected_plan = fullmag_plan::plan(entry.problem()).map_err(|error| {
            unresolved(format!(
                "cannot qualify predecessor '{}': {error}",
                step.step_id
            ))
        })?;
        let expected = physical_signature(step, entry, &expected_plan)?;
        current = latest_qualified_result(
            store,
            context,
            history,
            &step.step_id,
            case_id,
            &expected,
            current.as_ref(),
            None,
        )?;
        if current.is_none() {
            break;
        }
    }
    Ok(current)
}

/// Compare only the materialized physical step, with its exact discretization
/// and execution choice. Whole-scene revisions and output diagnostics do not
/// participate. The predecessor artifact is compared separately.
fn physical_signature(
    step: &StudyStep,
    entry: &StudyProblemCatalogEntry,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<String, ApiError> {
    let serialize_error =
        |error| ApiError::internal(format!("encode stage input identity: {error}"));
    let mut backend = serde_json::to_value(&plan.backend_plan).map_err(serialize_error)?;
    if let Some(object) = backend.as_object_mut() {
        object.remove("mesh_source");
        object.remove("mesh_build_report");
    }
    let inherited = state_input(step)?.is_some_and(|input| {
        matches!(
            &input.source,
            StudyInputSource::StepOutput { .. } | StudyInputSource::PinnedArtifact { .. }
        )
    });
    let mut authored_overlay_samples = Vec::new();
    if inherited {
        // The accepted binder replaces these authored samples with the
        // predecessor, except at the selected canonical overlay indices.
        let mut values = backend
            .as_object_mut()
            .and_then(|object| object.remove("initial_magnetization"))
            .and_then(|value| match value {
                Value::Array(values) => Some(values),
                _ => None,
            })
            .unwrap_or_default();
        if let Some(layers) = backend.get_mut("layers").and_then(Value::as_array_mut) {
            for layer in layers {
                if let Some(Value::Array(samples)) = layer
                    .as_object_mut()
                    .and_then(|layer| layer.remove("initial_magnetization"))
                {
                    values.extend(samples);
                }
            }
        }
        if let Some(overlay) = &step.initial_state_overlay {
            let mask = fullmag_plan::study_magnetization_overlay_mask(
                entry.problem(),
                plan,
                overlay.scopes(),
            )
            .map_err(|error| unresolved(error.to_string()))?;
            if mask.len() != values.len() {
                return Err(unresolved(
                    "overlay does not match the candidate's native state layout",
                ));
            }
            authored_overlay_samples.extend(
                values
                    .into_iter()
                    .zip(mask)
                    .enumerate()
                    .filter_map(|(index, (value, selected))| selected.then_some((index, value))),
            );
        }
    }
    let mut solver = serde_json::to_value(&entry.problem().study).map_err(serialize_error)?;
    if let Some(object) = solver.as_object_mut() {
        object.remove("sampling");
    }
    Ok(fullmag_session::canonical_json_sha256(&json!({
        "schema": "live-stage-physical-input.v1",
        "kind": step.kind,
        "until_seconds": step.until_seconds,
        "overlay": step.initial_state_overlay,
        "authored_overlay_samples": authored_overlay_samples,
        "solver": solver,
        "common": plan.common,
        "backend": backend,
        "execution": entry.execution_materialization().map(|materialized| &materialized.requested),
    })))
}

fn latest_qualified_result(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    history: &[FmsRunIntent],
    authored_step_id: &str,
    case_id: &str,
    expected_signature: &str,
    predecessor: Option<&ContinuationSource>,
    exact_step_id: Option<&str>,
) -> Result<Option<ContinuationSource>, ApiError> {
    let mut selected = None;
    for intent in history {
        if selected
            .as_ref()
            .is_some_and(|(date, _)| &intent.accepted_at < date)
        {
            break;
        }
        let Some(task_catalog) = store
            .read_run_catalog(&intent.run_id)
            .map_err(|error| unresolved(format!("read candidate run catalog: {error:#}")))?
        else {
            continue;
        };
        let direct_task_id =
            fullmag_session::task_id_for_study_step(&intent.run_id, authored_step_id)
                .map_err(|error| unresolved(error.to_string()))?;
        let compiled_source = intent
            .specification
            .pointer("/study/plan_version")
            .and_then(Value::as_str)
            == Some(fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4);
        if !task_catalog.tasks.iter().any(|task| {
            task.lifecycle == FmsTaskLifecycle::Succeeded
                && (compiled_source || task.task_id == direct_task_id)
        }) {
            continue;
        }
        let run_id = fullmag_application::RunId::parse(intent.run_id.clone())
            .map_err(|error| unresolved(error.to_string()))?;
        let project =
            crate::live_accepted_execution::accepted_project_id_from_intent(intent, &run_id)
                .map_err(|error| unresolved(format!("read candidate identity: {error:#}")))?;
        let historical =
            fullmag_runtime_control::load_accepted_study_snapshot(store, &run_id, &project)
                .map_err(|error| unresolved(format!("validate candidate Study: {error:#}")))?;
        for step in historical.study.steps.iter().filter(|step| {
            step.enabled && exact_step_id.is_none_or(|step_id| step.step_id == step_id)
        }) {
            let entry = catalog_entry(historical.catalog.entries(), &step.step_id)?;
            let exact_authored_id = step.step_id == authored_step_id
                || (historical.study.schema_version
                    == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4
                    && entry
                        .problem()
                        .problem_meta
                        .runtime_metadata
                        .get("active_stage_id")
                        .and_then(Value::as_str)
                        == Some(authored_step_id));
            if !exact_authored_id
                || !step.outputs.iter().any(|port| {
                    port.port_id == live_accepted_continuation::FINAL_STATE_PORT
                        && port.data_kind == StudyPortDataKind::State
                })
            {
                continue;
            }
            let task_id = fullmag_session::task_id_for_study_step(&intent.run_id, &step.step_id)
                .map_err(|error| unresolved(error.to_string()))?;
            let Some(task) = task_catalog.tasks.iter().find(|task| {
                task.task_id == task_id && task.lifecycle == FmsTaskLifecycle::Succeeded
            }) else {
                continue;
            };
            let Some(lowered) = historical
                .lowered
                .steps
                .iter()
                .find(|lowered| lowered.step_id == step.step_id)
            else {
                continue;
            };
            let Some(plan) = lowered.execution_plan.as_ref() else {
                continue;
            };
            let task_fingerprint = fullmag_application::study_task_input_fingerprint(
                &historical.run.specification,
                lowered,
            )
            .map_err(|error| unresolved(error.to_string()))?;
            if task.input_fingerprint != task_fingerprint {
                return Err(unresolved(
                    "candidate task differs from its accepted Study input",
                ));
            }
            if physical_signature(step, entry, plan)? != expected_signature
                || !matches_consumed_predecessor(store, &intent.run_id, task, step, predecessor)?
            {
                continue;
            }
            let source = live_accepted_continuation::load_exact_step_final_state(
                store,
                &intent.run_id,
                &context.session_id,
                context.session_epoch,
                &step.step_id,
                case_id,
            )
            .map_err(|error| {
                unresolved(format!(
                    "predecessor result '{authored_step_id}' is unavailable: {error}"
                ))
            })?;
            if selected.is_some() {
                return Err(unresolved(format!(
                    "multiple equally recent results for '{authored_step_id}'"
                )));
            }
            selected = Some((intent.accepted_at.clone(), source));
        }
    }
    Ok(selected.map(|(_, source)| source))
}

fn current_stage_result(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    step: &StudyStep,
    case_id: &str,
    history: &[FmsRunIntent],
    candidates: &[FmsRunIntent],
    exact_step_id: Option<&str>,
) -> Result<Option<ContinuationSource>, ApiError> {
    let predecessor = qualified_predecessor(store, context, study, catalog, step, history)?;
    if predecessor.is_none()
        && state_input(step)?
            .is_some_and(|port| matches!(&port.source, StudyInputSource::StepOutput { .. }))
    {
        return Ok(None);
    }
    let entry = catalog_entry(catalog, &step.step_id)?;
    let plan =
        fullmag_plan::plan(entry.problem()).map_err(|error| unresolved(error.to_string()))?;
    latest_qualified_result(
        store,
        context,
        candidates,
        &step.step_id,
        case_id,
        &physical_signature(step, entry, &plan)?,
        predecessor.as_ref(),
        exact_step_id,
    )
}

fn qualify_requested_result(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    source: &ContinuationSource,
) -> Result<(), ApiError> {
    let history = owned_history(store, context)?;
    let intent = history
        .iter()
        .find(|intent| intent.run_id == source.run_id)
        .ok_or_else(|| unresolved("the requested result does not belong to this session epoch"))?;
    let run_id = fullmag_application::RunId::parse(source.run_id.clone())
        .map_err(|error| unresolved(error.to_string()))?;
    let project = crate::live_accepted_execution::accepted_project_id_from_intent(intent, &run_id)
        .map_err(|error| unresolved(format!("read requested run identity: {error:#}")))?;
    let historical =
        fullmag_runtime_control::load_accepted_study_snapshot(store, &run_id, &project)
            .map_err(|error| unresolved(format!("validate requested Study: {error:#}")))?;
    let authored_step_id =
        if historical.study.schema_version == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4 {
            catalog_entry(historical.catalog.entries(), &source.step_id)?
                .problem()
                .problem_meta
                .runtime_metadata
                .get("active_stage_id")
                .and_then(Value::as_str)
                .unwrap_or(&source.step_id)
        } else {
            &source.step_id
        };
    let stale = || {
        ApiError::unprocessable_with_code(
            "initial_state_result_stale",
            "the requested result could not be verified for the current Study recipe and predecessor",
        )
    };
    let step = study
        .steps
        .iter()
        .find(|step| is_physical_stage(step) && step.step_id == authored_step_id)
        .ok_or_else(stale)?;
    let actual = current_stage_result(
        store,
        context,
        study,
        catalog,
        step,
        &source.case_id,
        &history,
        std::slice::from_ref(intent),
        Some(&source.step_id),
    )?
    .ok_or_else(stale)?;
    if actual.step_id != source.step_id
        || actual.artifact_id != source.artifact_id
        || actual.content_sha256 != source.content_sha256
    {
        return Err(stale());
    }
    Ok(())
}

fn resolve_latest_compatible_result(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    study: &StudyPlan,
    catalog: &[StudyProblemCatalogEntry],
    target: &StudyStep,
) -> Result<ContinuationSource, ApiError> {
    let history = owned_history(store, context)?;
    let target_entry = catalog_entry(catalog, &target.step_id)?;
    let layout = plan_layout(target_entry)?;
    let mut candidates = Vec::new();
    for step in study.steps.iter().filter(|step| is_physical_stage(step)) {
        let entry = catalog_entry(catalog, &step.step_id)?;
        if plan_layout(entry)? != layout {
            continue;
        }
        if let Some(source) = current_stage_result(
            store, context, study, catalog, step, "default", &history, &history, None,
        )? {
            validate_target_layout(target_entry, &source)?;
            let date = history
                .iter()
                .find(|intent| intent.run_id == source.run_id)
                .ok_or_else(|| unresolved("qualified result has no accepted run"))?
                .accepted_at;
            candidates.push((date, step.step_id.as_str(), source));
        }
    }
    let newest_date = candidates
        .iter()
        .map(|(date, _, _)| *date)
        .max()
        .ok_or_else(|| unresolved("no current compatible final state is available"))?;
    candidates.retain(|(date, _, _)| *date == newest_date);

    // Multiple steps from the same run have the same acceptance timestamp.
    // Select the one proved later by the accepted execution dependencies.
    let newest = candidates
        .iter()
        .position(|(_, candidate_step, candidate)| {
            candidates.iter().all(|(_, other_step, other)| {
                (candidate.run_id == other.run_id && candidate.step_id == other.step_id)
                    || (candidate.run_id == other.run_id
                        && study_step_depends_on(study, candidate_step, other_step))
            })
        })
        .ok_or_else(|| {
            unresolved("multiple equally recent compatible results; select one explicitly")
        })?;
    Ok(candidates.swap_remove(newest).2)
}

fn study_step_depends_on(study: &StudyPlan, stage: &str, dependency: &str) -> bool {
    let mut remaining = vec![stage];
    let mut seen = BTreeSet::new();
    while let Some(step_id) = remaining.pop() {
        if step_id == dependency {
            return true;
        }
        if seen.insert(step_id) {
            if let Some(step) = study.steps.iter().find(|step| step.step_id == step_id) {
                remaining.extend(step.completion_dependencies.iter().map(String::as_str));
                remaining.extend(step.inputs.iter().filter_map(|port| match &port.source {
                    StudyInputSource::StepOutput { step_id, .. } => Some(step_id.as_str()),
                    _ => None,
                }));
            }
        }
    }
    false
}

fn admitted_input_snapshot(
    store: &SessionStore,
    run_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
) -> Result<Option<fullmag_session::FmsResolvedInputsSnapshot>, ApiError> {
    let (Some(attempt_id), Some(ownership_epoch)) =
        (task.attempt_id.as_deref(), task.ownership_epoch)
    else {
        return Ok(None);
    };
    let Some(admission) = store
        .read_task_admission(run_id, &task.task_id, attempt_id)
        .map_err(|error| unresolved(format!("read stage input admission: {error:#}")))?
    else {
        return Ok(None);
    };
    if admission.lease.ownership_epoch != ownership_epoch
        || admission.task.input_fingerprint != task.input_fingerprint
    {
        return Ok(None);
    }
    Ok(admission.resolved_inputs_snapshot
        .filter(|snapshot| snapshot.frozen_stage_context.is_none()))
}

fn matches_consumed_predecessor(
    store: &SessionStore,
    run_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
    step: &StudyStep,
    predecessor: Option<&ContinuationSource>,
) -> Result<bool, ApiError> {
    let input = state_input(step)?;
    let Some(predecessor) = predecessor else {
        return Ok(input.is_none_or(|input| {
            matches!(&input.source, StudyInputSource::AuthoredInitialState { .. })
        }));
    };
    let Some(input) = input else { return Ok(false) };
    if !matches!(
        &input.source,
        StudyInputSource::StepOutput { .. } | StudyInputSource::PinnedArtifact { .. }
    ) {
        return Ok(false);
    }
    let Some(snapshot) = admitted_input_snapshot(store, run_id, task)? else {
        return Ok(false);
    };
    let Some(resolved) = snapshot.inputs.get(&input.port_id) else {
        return Ok(false);
    };
    let resolved: fullmag_application::ResolvedInput = serde_json::from_value(resolved.clone())
        .map_err(|error| unresolved(format!("decode predecessor admission: {error}")))?;
    resolved
        .validate()
        .map_err(|error| unresolved(error.to_string()))?;
    Ok(resolved.study_artifact.as_ref().is_some_and(|artifact| {
        artifact.artifact_id == predecessor.artifact_id
            && artifact.object_ref == predecessor.content_sha256
            && resolved.content_sha256 == predecessor.content_sha256
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> StudyPlan {
        let step = |id: &str| {
            json!({
                "step_id": id, "label": id,
                "kind": {"kind": "primitive", "stage_kind": "run"},
                "model": {"model_id": "model", "version": "1"},
                "solver_config": {"preset_id": "solver", "version": "1"},
                "discretization": {"recipe_id": "grid", "version": "1"},
                "execution_profile": {"profile_id": "profile", "version": "1"},
                "until_seconds": 1e-12,
                "completion_dependencies": [],
                "acceptance": {"kind": "any"}, "acquisition": "exclusive",
            })
        };
        let mut first = step("first");
        first["outputs"] = json!([{"port_id": "final_state", "data_kind": "state"}]);
        let mut second = step("second");
        second["completion_dependencies"] = json!(["first"]);
        second["inputs"] = json!([{
            "port_id": "incoming_m", "data_kind": "state", "required": true,
            "source": {"kind": "step_output", "step_id": "first", "port": "final_state", "case_id": "default"},
        }]);
        second["outputs"] = first["outputs"].clone();
        let mut third = step("third");
        third["inputs"] = second["inputs"].clone();
        third["inputs"][0]["source"]["step_id"] = json!("second");
        third["outputs"] = first["outputs"].clone();
        let mut fourth = step("fourth");
        fourth["inputs"] = second["inputs"].clone();
        fourth["inputs"][0]["source"]["step_id"] = json!("third");
        serde_json::from_value(json!({
            "schema_version": "study_plan.v3", "study_id": "study", "revision": 1,
            "steps": [first, second, third, fourth],
        }))
        .unwrap()
    }

    #[test]
    fn validates_explicit_request_before_a_study_can_start() {
        use RuntimeAuthoredInitialStateSource::{Prepared, Stage, Study};
        use RuntimeInitialStateRequest::{
            AuthoredInitialState, DefaultForTarget, LatestCompatibleState,
        };

        assert!(validate_live_initial_state_request(Some(&DefaultForTarget), 8, true).is_ok());
        assert!(
            validate_live_initial_state_request(Some(&LatestCompatibleState), 8, true).is_err()
        );
        let authored = AuthoredInitialState {
            source: Study { scene_revision: 7 },
        };
        let error = validate_live_initial_state_request(Some(&authored), 8, true).unwrap_err();
        assert_eq!(
            error.code.as_deref(),
            Some("initial_state_scene_revision_mismatch")
        );
        let stage = AuthoredInitialState {
            source: Stage {
                stage_id: "second".into(),
                scene_revision: 8,
            },
        };
        assert!(validate_live_initial_state_request(Some(&stage), 8, true).is_err());
        assert!(validate_live_initial_state_request(Some(&stage), 8, false).is_ok());
        let prepared = AuthoredInitialState {
            source: Prepared {
                scene_revision: 8,
                initial_state_revision: 3,
                publication_id: "prepared-1".into(),
            },
        };
        assert!(validate_live_initial_state_request(Some(&prepared), 8, true).is_err());
        assert!(validate_live_initial_state_request(Some(&prepared), 8, false).is_ok());
        assert!(validate_live_initial_state_request(Some(&prepared), 9, false).is_err());
    }

    #[test]
    fn serial_stage_order_survives_a_magnetization_reset() {
        let mut study = graph();
        study.steps[1].inputs.clear();
        assert!(study_step_depends_on(&study, "second", "first"));
        assert!(!study_step_depends_on(&study, "first", "second"));
        study.steps[1].completion_dependencies.clear();
        assert!(!study_step_depends_on(&study, "second", "first"));
    }

    #[test]
    fn pins_the_original_state_port_before_disabling_its_producer() {
        let mut study = graph();
        let mut invalid = study.clone();
        invalid.steps[0].enabled = false;
        invalid.steps[1].completion_dependencies.clear();
        assert!(invalid.validate_for_execution().is_err());

        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let decision = InitialStateDecision::Continuation(ContinuationSource {
            run_id: "old-run".into(),
            step_id: "first".into(),
            case_id: "default".into(),
            artifact_id: "final-m".into(),
            content_sha256: "a".repeat(64),
            layout: Value::Null,
            values: vec![],
        });
        restrict_live_study_to_selected_step(&mut study, 1, &problem, &decision).unwrap();
        assert!(!study.steps[0].enabled);
        assert!(study.steps[1].enabled);
        assert!(study.steps[1].completion_dependencies.is_empty());
        let lowered = fullmag_plan::lower_study_plan(&study, |_| Ok::<_, String>(problem.clone()))
            .expect("disabled definitions may retain their disabled predecessor edges");
        assert_eq!(
            lowered
                .steps
                .iter()
                .filter(|step| step.enabled)
                .map(|step| step.step_id.as_str())
                .collect::<Vec<_>>(),
            vec!["second"]
        );
        let input = &study.steps[1].inputs[0];
        assert_eq!(input.port_id, "incoming_m");
        assert!(
            matches!(&input.source, StudyInputSource::PinnedArtifact { artifact_id, .. }
            if artifact_id == "final-m")
        );
    }

    #[test]
    fn history_reports_the_admitted_predecessor_and_rejects_a_different_artifact() {
        use crate::schemas::stage_results::{StudyResultInitialStateSource, StudyResultInputSelection};
        use fullmag_application::{ProjectId, ProjectSnapshot, RequestedExecution, RunId, RunSpecification, StudyId, StudyReference};
        use fullmag_session::{FmsArtifactCatalog, FmsRunCatalog, FmsTaskAdmissionRecord};
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let run_id = "run-lineage";
        let first = fullmag_session::task_id_for_study_step(run_id, "first").unwrap();
        let second = fullmag_session::task_id_for_study_step(run_id, "second").unwrap();
        let digest = "d".repeat(64);
        let mut study = graph();
        let scope = fullmag_ir::RegionRefIR { object_id: "mag".into(), region_id: Some("left".into()) };
        study.steps[1].initial_state_overlay =
            Some(fullmag_authoring::StudyInitialStateOverlay::Scoped { scopes: vec![scope] });
        let step = &study.steps[1];
        let mut spec = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-lineage").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study").unwrap(),
                plan_version: study.schema_version.clone(),
                plan_sha256: study.canonical_sha256().unwrap(),
            },
            "c".repeat(64),
            Value::Null,
            RequestedExecution {
                backend: "fdm".into(), device: "cpu".into(), precision: "double".into(),
                mode: "strict".into(), minimum_resources: None,
            },
        );
        spec.run_id = RunId::parse(run_id).unwrap();
        let now = chrono::Utc::now();
        let mut catalog: FmsRunCatalog = serde_json::from_value(json!({
            "schema_version": fullmag_session::FMS_RUN_CATALOG_SCHEMA,
            "run_id": run_id, "revision": 1, "updated_at": now,
            "tasks": [
                {"task_id": first, "input_fingerprint": "a".repeat(64),
                 "lifecycle": "succeeded", "attempt_id": "first-attempt", "ownership_epoch": 1,
                 "artifact_ids": ["first-final"]},
                {"task_id": second, "input_fingerprint": "b".repeat(64),
                 "lifecycle": "succeeded", "attempt_id": "second-attempt", "ownership_epoch": 1,
                 "resource_id": "cpu-second"}
            ]
        })).unwrap();
        let artifacts: FmsArtifactCatalog = serde_json::from_value(json!({
            "schema_version": fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA,
            "run_id": run_id, "revision": 1, "updated_at": now,
            "entries": [
                {"artifact_id": "first-final", "task_id": first, "attempt_id": "first-attempt",
                 "ownership_epoch": 1, "logical_path": "outputs/first/final_state.bin",
                 "artifact_type": "state", "content_sha256": digest, "object_ref": digest,
                 "status": "published", "required": true,
                 "study_output": {"step_id": "first", "port_id": "final_state", "case_id": "default"}}
            ]
        })).unwrap();
        let make_snapshot = |digest: &str| fullmag_session::FmsResolvedInputsSnapshot::new(json!({
            "incoming_m": {"source": "first-final", "content_sha256": digest,
                "study_artifact": {"artifact_id": "first-final", "object_ref": digest,
                    "data_kind": "state", "codec_id": fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
                    "codec_version": fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION}}
        })).unwrap();
        let mut admission: FmsTaskAdmissionRecord = serde_json::from_value(json!({
            "schema_version": fullmag_session::FMS_TASK_ADMISSION_SCHEMA,
            "expected_catalog_revision": 1,
            "queued_task": {"task_id": second, "input_fingerprint": "b".repeat(64),
                            "lifecycle": "queued", "readiness": "ready"},
            "task": {"task_id": second, "input_fingerprint": "b".repeat(64), "lifecycle": "preparing",
                     "readiness": "ready", "attempt_id": "second-attempt", "ownership_epoch": 1,
                     "resource_id": "cpu-second"},
            "lease": {"schema_version": fullmag_session::FMS_RESOURCE_LEASE_SCHEMA, "resource_id": "cpu-second",
                      "kind": "cpu", "budget": {"cpu_millis": 100, "memory_bytes": 1024, "gpu_memory_bytes": 0,
                                               "storage_bytes": 1024},
                      "run_id": run_id, "task_id": second, "attempt_id": "second-attempt", "ownership_epoch": 1,
                      "lease_token": "lease-second", "state": "active", "acquired_at": now, "heartbeat_at": now,
                      "heartbeat_sequence": 0},
            "resolved_inputs_snapshot": make_snapshot(&digest),
        })).unwrap();
        let path = store.root().join(format!("runs/{run_id}/task_admissions/{second}/second-attempt.json"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let write = |record: &FmsTaskAdmissionRecord| {
            record.validate().unwrap();
            std::fs::write(&path, serde_json::to_vec(record).unwrap()).unwrap();
        };
        write(&admission);
        let read = |catalog: &FmsRunCatalog| describe_result_initial_state(
            &store, &spec, &study, &step.step_id, &catalog.tasks[1], catalog, &artifacts,
        );
        let result = read(&catalog).unwrap();
        assert_eq!(result.source, StudyResultInitialStateSource::StageResult {
            run_id: run_id.into(), step_id: "first".into(), case_id: "default".into(),
            artifact_id: "first-final".into(), content_sha256: digest.clone(),
            selection: StudyResultInputSelection::Predecessor,
        });
        assert_eq!(result.reset_scopes[0].region_id.as_deref(), Some("left"));

        let inherited = ContinuationSource {
            run_id: run_id.into(),
            step_id: "first".into(),
            case_id: "default".into(),
            artifact_id: "first-final".into(),
            content_sha256: digest.clone(),
            layout: Value::Null,
            values: Vec::new(),
        };
        let newer = ContinuationSource {
            run_id: "rerun-first".into(),
            artifact_id: "rerun-first-final".into(),
            content_sha256: "f".repeat(64),
            ..inherited.clone()
        };
        assert!(matches_consumed_predecessor(&store, run_id, &catalog.tasks[1], step, Some(&inherited)).unwrap());
        assert!(!matches_consumed_predecessor(&store, run_id, &catalog.tasks[1], step, Some(&newer)).unwrap());

        let decision = InitialStateDecision::Continuation(inherited.clone());
        let mut isolated = study.clone();
        restrict_live_study_to_selected_step(
            &mut isolated, 1, &fullmag_ir::ProblemIR::bootstrap_example(), &decision,
        ).unwrap();
        let mut isolated_spec = spec.clone();
        isolated_spec.study.plan_sha256 = isolated.canonical_sha256().unwrap();
        for (request, expected) in [
            (RuntimeInitialStateRequest::DefaultForTarget, StudyResultInputSelection::Predecessor),
            (RuntimeInitialStateRequest::LatestCompatibleState, StudyResultInputSelection::LatestCompatible),
            (RuntimeInitialStateRequest::StageResult {
                run_id: inherited.run_id.clone(),
                step_id: inherited.step_id.clone(),
                case_id: inherited.case_id.clone(),
                artifact_id: inherited.artifact_id.clone(),
                content_sha256: inherited.content_sha256.clone(),
                allow_stale_model: false,
            }, StudyResultInputSelection::SelectedResult),
        ] {
            isolated_spec.parameters = json!({"live_workspace": {
                "step_id": "second",
                "command": {"initial_state": &request},
                "initial_state_source": selected_initial_state_binding(
                    &isolated.steps[1], &decision, Some(&request),
                ).unwrap(),
            }});
            let selected = describe_result_initial_state(
                &store, &isolated_spec, &isolated, "second", &catalog.tasks[1], &catalog, &artifacts,
            ).unwrap();
            assert!(matches!(selected.source,
                StudyResultInitialStateSource::StageResult { selection, .. } if selection == expected
            ));
        }

        catalog.tasks[1].input_fingerprint = "f".repeat(64);
        assert!(read(&catalog).is_none());
        catalog.tasks[1].input_fingerprint = "b".repeat(64);
        admission.resolved_inputs_snapshot = Some(make_snapshot(&"e".repeat(64)));
        write(&admission);
        assert!(read(&catalog).is_none());
    }

    #[test]
    fn explicit_history_source_and_automatic_reuse_share_the_current_project_lineage() {
        use fullmag_application::{
            ProjectId, ProjectSnapshot, RequestedExecution, RunId, RunSpecification, StudyId,
            StudyReference,
        };
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let write_run = |run_id: &str, project: &str, parent: Option<Value>| {
            let mut specification = RunSpecification::new(
                ProjectSnapshot {
                    project_id: ProjectId::parse(project).unwrap(),
                    definition_revision: 1,
                    definition_sha256: "a".repeat(64),
                },
                StudyReference {
                    study_id: StudyId::parse("study").unwrap(),
                    plan_version: fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION.into(),
                    plan_sha256: "b".repeat(64),
                },
                "c".repeat(64),
                json!({"live_workspace": {"session_id": "session-reuse", "session_epoch": 3}}),
                RequestedExecution {
                    backend: "fdm".into(), device: "cpu".into(), precision: "double".into(),
                    mode: "strict".into(), minimum_resources: None,
                },
            );
            specification.run_id = RunId::parse(run_id).unwrap();
            if let Some(parent) = parent {
                specification.parameters["live_workspace"]["study_history_parent"] = parent;
            }
            store.commit_run_intent(&FmsRunIntent::new(
                run_id, format!("intent-{run_id}"), serde_json::to_value(&specification).unwrap(),
            )).unwrap();
        };
        write_run("run-origin", "project-origin", None);
        let mut context = CurrentLiveRequestContext {
            session_id: "session-reuse".into(),
            run_id: Some("run-origin".into()),
            session_epoch: 3,
            request_scope_epoch: "api:3".into(),
        };
        let parent = crate::live_execution_binding::next_study_history_parent(
            &store, &context, "project-restored",
        ).unwrap().unwrap();
        write_run("run-restored", "project-restored", Some(json!(parent)));
        write_run("run-unlinked", "project-unlinked", None);
        context.run_id = Some("run-restored".into());
        assert!(require_history_source(&store, &context, "run-origin").is_ok());
        assert!(require_history_source(&store, &context, "run-restored").is_ok());
        assert!(require_history_source(&store, &context, "run-unlinked").is_err());
        let automatic: BTreeSet<_> = owned_history(&store, &context).unwrap()
            .into_iter().map(|intent| intent.run_id).collect();
        assert_eq!(automatic, BTreeSet::from(["run-origin".into(), "run-restored".into()]));
        context.session_epoch = 4;
        assert!(require_history_source(&store, &context, "run-origin").is_err());
        assert!(owned_history(&store, &context).unwrap().is_empty());
    }

    #[test]
    fn predecessor_signature_uses_only_effective_initial_samples() {
        let study = graph();
        let original = fullmag_ir::ProblemIR::bootstrap_example();
        let signature = |index: usize, problem: &fullmag_ir::ProblemIR| {
            let step = &study.steps[index];
            let entry = StudyProblemCatalogEntry::from_step(step, problem.clone());
            let plan = fullmag_plan::plan(problem).unwrap();
            physical_signature(step, &entry, &plan).unwrap()
        };
        let mut edited = original.clone();
        edited.magnets[0].initial_magnetization =
            Some(fullmag_ir::InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            });
        assert_eq!(signature(1, &original), signature(1, &edited));
        assert_ne!(signature(0, &original), signature(0, &edited));
        edited.materials[0].damping *= 2.0;
        assert_ne!(signature(1, &original), signature(1, &edited));
    }

    #[test]
    fn refuses_to_drop_a_required_non_magnetic_predecessor() {
        let mut study = graph();
        study.steps[1].inputs.push(StudyInputPort {
            port_id: "operator".into(),
            data_kind: StudyPortDataKind::Artifact,
            required: true,
            source: StudyInputSource::StepOutput {
                step_id: "first".into(),
                port: "operator".into(),
                case_id: "default".into(),
            },
        });
        let unchanged = study.clone();
        assert!(restrict_live_study_to_selected_step(
            &mut study,
            1,
            &fullmag_ir::ProblemIR::bootstrap_example(),
            &InitialStateDecision::Authored {
                reason: "fixture".into()
            },
        )
        .is_err());
        assert_eq!(study, unchanged);
    }
}

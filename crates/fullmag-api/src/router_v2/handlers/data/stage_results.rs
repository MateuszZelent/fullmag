//! Current workspace discovery of durable Study results. No field decoding here.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fullmag_application::{RunId, RunSpecification};
use fullmag_authoring::{
    SceneDocument, SceneExecutionInputIdentity, StudyInputSource, StudyPipelineNode, StudyPlan,
    StudyPortDataKind, StudyPrimitiveStageKind, StudyStepKind,
};
use fullmag_session::{FmsRunIntent, SessionStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;
use crate::live_accepted_continuation::list_published_final_states;
use crate::live_execution_binding::{
    current_study_history, verified_history_run_spec as verified_run_spec, WorkspaceStudyHistory,
};
use crate::schemas::commands::{RuntimeAuthoredInitialStateSource, RuntimeInitialStateRequest};
use crate::schemas::stage_results::{
    StudyResultAuthoredRelation, StudyResultCompletion, StudyResultDomainRelation,
    StudyResultPredecessorRelation, StudyStageResult, StudyStageResultsQuery,
    StudyStageResultsResource,
};
use crate::shared_json::SharedJson;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

mod lineage;

const DEFAULT_LIMIT: usize = 25;
const MAX_LIMIT: usize = 100;
const MAX_CURSOR_BYTES: usize = 2048;
const MAX_AUTHORED_COMPARISON_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ACCEPTED_STUDY_BYTES_PER_PAGE: u64 = 32 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultsCursor {
    scope_sha256: String,
    run_id: String,
    artifact_id: String,
}

struct AuthoredStudy {
    revision: u64,
    input: SceneExecutionInputIdentity,
    stage_ids: BTreeSet<String>,
    compiled_stage_ids: BTreeMap<String, String>,
    recipe: StageRecipe,
}

struct StageRecipe {
    common: Value,
    stages: Vec<Value>,
    pipeline: bool,
}

impl StageRecipe {
    fn from_scene(scene: &SceneDocument) -> Option<Self> {
        let mut common = fullmag_authoring::scene_execution_input_view(scene).ok()?;
        let study = common.get_mut("study")?.as_object_mut()?;
        let flat_stages = study.remove("stages");
        let pipeline = study
            .get_mut("study_pipeline")
            .and_then(Value::as_object_mut);
        let (pipeline, stages) = match pipeline {
            Some(pipeline) => (true, pipeline.remove("nodes")),
            None => (false, flat_stages),
        };
        let stages = match stages {
            Some(Value::Array(stages)) => stages,
            None => Vec::new(),
            _ => return None,
        };
        Some(Self {
            common,
            stages,
            pipeline,
        })
    }

    fn prefix(&self, stage_id: &str) -> Option<Vec<Value>> {
        if self.pipeline {
            return pipeline_prefix(&self.stages, stage_id);
        }
        let index = self.stages.iter().enumerate().position(|(index, stage)| {
            flat_stage_id(stage.get("stage_id").and_then(Value::as_str), index) == stage_id
                && is_physical_kind(&stage["kind"])
        })?;
        Some(self.stages[..=index].to_vec())
    }
}

fn flat_stage_id(id: Option<&str>, index: usize) -> String {
    id.filter(|id| !id.trim().is_empty())
        .map_or_else(|| format!("scene-stage-{index}"), str::to_owned)
}

fn is_physical_kind(kind: &Value) -> bool {
    matches!(kind.as_str(), Some("relax" | "run"))
}

// The sequential materializer consumes preceding configuration and physical
// nodes. Preserve the ancestors and everything before the target at each level.
fn pipeline_prefix(nodes: &[Value], stage_id: &str) -> Option<Vec<Value>> {
    for (index, node) in nodes.iter().enumerate() {
        if node["node_kind"] == "primitive"
            && node["id"].as_str() == Some(stage_id)
            && is_physical_kind(&node["stage_kind"])
        {
            return Some(nodes[..=index].to_vec());
        }
        if let Some(prefix) = node["children"]
            .as_array()
            .and_then(|children| pipeline_prefix(children, stage_id))
        {
            let mut group = node.clone();
            group["children"] = Value::Array(prefix);
            let mut prefix = nodes[..index].to_vec();
            prefix.push(group);
            return Some(prefix);
        }
    }
    None
}

// These settings affect the cloned Relax ProblemIR only. Configuration
// nodes and the texture assignments on a Relax node can still affect later
// steps, so retain them on both sides of the comparison.
const RELAX_SOLVER_SETTINGS: &[&str] = &[
    "algorithm",
    "relax_algorithm",
    "integrator",
    "dt",
    "fixed_timestep",
    "adaptive_timestep",
    "max_error",
    "max_err",
    "dt_initial",
    "dt_min",
    "dt_max",
    "field_refresh",
    "demag_interval_s",
    "relax_alpha",
    "torque_tolerance",
    "torque_tolerance_apm",
    "energy_tolerance",
    "energy_tolerance_j",
    "max_steps",
    "max_relaxation_time_s",
    "max_pseudotime_s",
    "max_physical_time_s",
];

fn omit_prior_relax_settings(nodes: &mut [Value], boundary_id: &str) -> bool {
    for node in nodes {
        if node["id"].as_str() == Some(boundary_id) {
            return true;
        }
        if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
            if omit_prior_relax_settings(children, boundary_id) {
                return true;
            }
        }
        if node["node_kind"] != "primitive" || node["stage_kind"] != "relax" {
            continue;
        }
        let Some(node) = node.as_object_mut() else {
            continue;
        };
        if let Some(payload) = node.get_mut("payload").and_then(Value::as_object_mut) {
            for key in RELAX_SOLVER_SETTINGS {
                payload.remove(*key);
            }
            if payload.is_empty() {
                node.remove("payload");
            }
        }
    }
    false
}

fn follows_authored_state_flow(live: &Value, step_id: &str) -> bool {
    let Some(selected) = live.get("step_id").filter(|value| !value.is_null()) else {
        return true;
    };
    if selected.as_str() != Some(step_id) {
        return false;
    }
    let request = live.pointer("/command/initial_state").and_then(|request| {
        serde_json::from_value::<RuntimeInitialStateRequest>(request.clone()).ok()
    });
    match request {
        Some(RuntimeInitialStateRequest::DefaultForTarget) => true,
        Some(RuntimeInitialStateRequest::AuthoredInitialState {
            source: RuntimeAuthoredInitialStateSource::Stage { stage_id, .. },
        }) => stage_id == step_id,
        _ => false,
    }
}

/// The immutable state ports identify where the magnetization starts over.
/// Completion edges still enforce execution order. A pinned source or any
/// additional data input needs its own evidence.
fn authored_magnetization_root<'a>(study: &'a StudyPlan, step_id: &str) -> Option<&'a str> {
    if study.source_pipeline_version.as_deref() != Some("study_pipeline.v2") {
        return None;
    }
    let mut index = study
        .steps
        .iter()
        .position(|step| step.step_id == step_id)?;
    loop {
        let step = &study.steps[index];
        if !step.enabled
            || !matches!(
                &step.kind,
                StudyStepKind::Primitive {
                    stage_kind: StudyPrimitiveStageKind::Run | StudyPrimitiveStageKind::Relax,
                }
            )
        {
            return None;
        }
        let [input] = step.inputs.as_slice() else {
            return None;
        };
        if !input.required || input.data_kind != StudyPortDataKind::State {
            return None;
        }
        match &input.source {
            StudyInputSource::AuthoredInitialState { .. }
                if step.initial_state_overlay.is_none() =>
            {
                return Some(&step.step_id);
            }
            StudyInputSource::StepOutput {
                step_id,
                port,
                case_id,
            } if port == crate::live_accepted_continuation::FINAL_STATE_PORT
                && case_id == "default" =>
            {
                index = study.steps[..index]
                    .iter()
                    .position(|step| step.step_id == *step_id)?;
            }
            _ => return None,
        }
    }
}

enum AcceptedAuthoring {
    WholeStudyMatches,
    StageRecipes(StageRecipe),
    Unavailable,
}

impl AuthoredStudy {
    fn from_scene(scene: &SceneDocument) -> Result<Self, ApiError> {
        fn collect_pipeline_ids(nodes: &[StudyPipelineNode], ids: &mut BTreeSet<String>) {
            for node in nodes {
                match node {
                    StudyPipelineNode::Primitive(stage) => {
                        ids.insert(stage.id.clone());
                    }
                    StudyPipelineNode::Macro(stage) => {
                        ids.insert(stage.id.clone());
                    }
                    StudyPipelineNode::Group(group) => collect_pipeline_ids(&group.children, ids),
                }
            }
        }

        let mut stage_ids = BTreeSet::new();
        if let Some(pipeline) = scene.study.study_pipeline.as_ref() {
            collect_pipeline_ids(&pipeline.nodes, &mut stage_ids);
        } else {
            stage_ids.extend(scene.study.stages.iter().enumerate().map(|(index, stage)| {
                flat_stage_id(stage.extra.get("stage_id").and_then(Value::as_str), index)
            }));
        }
        let compiled_stage_ids = stage_ids
            .iter()
            .map(|id| {
                fullmag_application::script_execution_id(id, 0)
                    .map(|compiled| (compiled, id.clone()))
            })
            .collect::<Result<_, _>>()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(Self {
            revision: scene.revision,
            input: crate::live_execution_binding::input_identity(scene)?,
            stage_ids,
            compiled_stage_ids,
            recipe: StageRecipe::from_scene(scene)
                .ok_or_else(|| ApiError::internal("encode current authored stage recipes"))?,
        })
    }

    fn accepted_authoring(
        &self,
        store: &SessionStore,
        intent: &FmsRunIntent,
        specification: &RunSpecification,
        remaining_bytes: &mut u64,
    ) -> AcceptedAuthoring {
        if intent
            .specification
            .pointer("/parameters/live_workspace/execution_input")
            .is_some()
            && crate::live_execution_binding::validate_input_binding(
                &intent.specification,
                &self.input,
                self.revision,
            )
            .is_ok()
        {
            return AcceptedAuthoring::WholeStudyMatches;
        }
        let Some(object_ref) = intent.definition_object_ref.as_deref() else {
            return AcceptedAuthoring::Unavailable;
        };
        if *remaining_bytes == 0 || object_ref != specification.snapshot.definition_sha256 {
            return AcceptedAuthoring::Unavailable;
        }
        let Ok(Some(bytes)) = store.cas().get_bounded(object_ref, *remaining_bytes) else {
            return AcceptedAuthoring::Unavailable;
        };
        *remaining_bytes -= bytes.len() as u64;
        crate::development_accepted_restore::scene_from_definition(&bytes, specification)
            .ok()
            .and_then(|scene| StageRecipe::from_scene(&scene))
            .map_or(
                AcceptedAuthoring::Unavailable,
                AcceptedAuthoring::StageRecipes,
            )
    }

    fn relation(
        &self,
        stage_id: &str,
        accepted: &AcceptedAuthoring,
        magnetization_root_id: Option<&str>,
    ) -> StudyResultAuthoredRelation {
        use StudyResultAuthoredRelation::*;
        if !self.stage_ids.contains(stage_id) {
            return StageAbsent;
        }
        match accepted {
            AcceptedAuthoring::WholeStudyMatches => MatchingAuthoredInput,
            AcceptedAuthoring::Unavailable => AuthoringUnavailable,
            AcceptedAuthoring::StageRecipes(recipe) => {
                if self.recipe.common != recipe.common {
                    return AuthoredInputChanged;
                }
                let (Some(mut current), Some(mut accepted)) =
                    (self.recipe.prefix(stage_id), recipe.prefix(stage_id))
                else {
                    return AuthoringUnavailable;
                };
                if current == accepted {
                    return MatchingAuthoredInput;
                }
                if self.recipe.pipeline && recipe.pipeline {
                    if let Some(root) = magnetization_root_id {
                        if omit_prior_relax_settings(&mut current, root)
                            && omit_prior_relax_settings(&mut accepted, root)
                            && current == accepted
                        {
                            return MatchingAuthoredInput;
                        }
                    }
                }
                AuthoredInputChanged
            }
        }
    }
}

fn published_layout_field(snapshot: &SessionStateResponse) -> Option<SharedJson> {
    let bundle = snapshot.field_publication_bundles.get("m")?;
    let field = snapshot.latest_fields.get_shared("m")?;
    let frame: crate::schemas::common::AcceptedObservationFrameRef =
        serde_json::from_value(field.get("observation_frame")?.clone()).ok()?;
    if frame != bundle.observation_frame
        || !crate::session::accepted_m_frame_matches_current_domain(snapshot, &frame)
    {
        return None;
    }
    let layout = field.get("layout")?;
    let native = match layout["backend"].as_str()? {
        "fdm" => layout.get("active_mask").is_some() && layout["grid_cells"].is_array(),
        "fdm_multilayer" => layout["layers"]
            .as_array()
            .is_some_and(|layers| !layers.is_empty()),
        "fem" => {
            layout["fe_order"].as_u64() == Some(1)
                && layout["topology_fingerprint"].is_string()
                && layout["field_semantics"].is_object()
        }
        _ => false,
    };
    (native && layout.get("layout_error").is_none()).then(|| field.clone())
}

fn published_layout_sha256(field: &SharedJson) -> Option<String> {
    let layout = fullmag_application::study_state_layout_sha256(field.get("layout")?).ok()?;
    if field
        .pointer("/observation_frame/authored_initial_state")
        .is_some_and(Value::is_object)
        || field.get("carrier_fingerprint").and_then(Value::as_str) == Some(layout.as_str())
    {
        Some(layout)
    } else {
        None
    }
}

fn domain_relation(current: Option<&str>, saved: Option<&str>) -> StudyResultDomainRelation {
    match (current, saved) {
        (Some(current), Some(saved)) if current == saved => {
            StudyResultDomainRelation::MatchingPublishedLayout
        }
        (Some(_), Some(_)) => StudyResultDomainRelation::DifferentPublishedLayout,
        _ => StudyResultDomainRelation::Unavailable,
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/results",
    params(StudyStageResultsQuery),
    responses(
        (status = 200, description = "Bounded durable Study results and their current authored relation", body = StudyStageResultsResource),
        (status = 400, description = "Invalid filter, page size or cursor"),
        (status = 404, description = "Workspace or requested run is unavailable"),
        (status = 409, description = "Workspace changed or the result binding is inconsistent"),
    ),
    tag = "simulation"
)]
pub async fn get_study_stage_results(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StudyStageResultsQuery>,
) -> Result<Json<StudyStageResultsResource>, ApiError> {
    let limit = validate_query(&query)?;
    let context = crate::capture_current_live_read_context(&state).await?;
    let root = state
        .submit_store_root
        .clone()
        .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
    let api_instance = state.request_scope_instance_id.clone();
    let (scene, published_layout) = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.scene_document.clone(),
                published_layout_field(snapshot),
            )
        })
        .unwrap_or_default();
    let result = tokio::task::spawn_blocking({
        let context = context.clone();
        let published_layout = published_layout.clone();
        move || {
            let current_layout_sha256 = published_layout.as_ref().and_then(published_layout_sha256);
            let authored = scene.as_ref().map(AuthoredStudy::from_scene).transpose()?;
            if !root
                .try_exists()
                .map_err(|error| ApiError::internal(error.to_string()))?
            {
                if query.run_id.is_some() {
                    return Err(ApiError::not_found("Study result run was not found"));
                }
                if query.cursor.is_some() {
                    return Err(ApiError::bad_request(
                        "Study result cursor has no durable result store",
                    ));
                }
                return build_result_resource(
                    &new_workspace_project_id(&context, &api_instance),
                    authored.as_ref(),
                    Vec::new(),
                    None,
                );
            }
            let store = SessionStore::open_existing(root).map_err(|error| {
                ApiError::internal(format!("open Study result storage: {error}"))
            })?;
            load_study_stage_results(
                &store,
                &context,
                &api_instance,
                authored.as_ref(),
                current_layout_sha256.as_deref(),
                query,
                limit,
            )
        }
    })
    .await
    .map_err(|error| ApiError::internal(format!("Study result reader failed: {error}")))??;

    let current = crate::capture_current_live_read_context(&state).await?;
    let (current_scene_revision, current_layout) = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.scene_document.as_ref().map(|scene| scene.revision),
                published_layout_field(snapshot),
            )
        })
        .unwrap_or_default();
    let layout_changed = match (published_layout.as_ref(), current_layout.as_ref()) {
        (Some(previous), Some(current)) if previous.version() == current.version() => false,
        (Some(previous), Some(current)) => {
            previous.get("layout") != current.get("layout")
                || previous.get("carrier_fingerprint") != current.get("carrier_fingerprint")
                || previous
                    .pointer("/observation_frame/authored_initial_state")
                    .is_some_and(Value::is_object)
                    != current
                        .pointer("/observation_frame/authored_initial_state")
                        .is_some_and(Value::is_object)
        }
        (None, None) => false,
        _ => true,
    };
    if current.session_id != context.session_id
        || current.run_id != context.run_id
        || current.session_epoch != context.session_epoch
        || current.request_scope_epoch != context.request_scope_epoch
        || current_scene_revision != result.scene_revision
        || layout_changed
    {
        return Err(ApiError::conflict("request_context_stale"));
    }
    Ok(Json(result))
}

fn validate_query(query: &StudyStageResultsQuery) -> Result<usize, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::bad_request(
            "Study result limit must be between 1 and 100",
        ));
    }
    if query.stage_id.as_ref().is_some_and(|id| {
        id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control)
    }) {
        return Err(ApiError::bad_request("invalid Study stage ID"));
    }
    if let Some(run_id) = query.run_id.as_ref() {
        RunId::parse(run_id.clone()).map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    Ok(limit)
}

fn accepted_study_metadata(
    store: &SessionStore,
    intent: &FmsRunIntent,
    specification: &RunSpecification,
    remaining_bytes: &mut u64,
) -> Option<fullmag_authoring::StudyPlan> {
    let object_ref = intent.study_object_ref.as_deref()?;
    if object_ref != specification.study.plan_sha256 || *remaining_bytes == 0 {
        return None;
    }
    let limit = (*remaining_bytes).min(fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES);
    let bytes = store.cas().get_bounded(object_ref, limit).ok()??;
    *remaining_bytes -= bytes.len() as u64;
    let study: fullmag_authoring::StudyPlan = serde_json::from_slice(&bytes).ok()?;
    study.validate_for_execution().ok()?;
    if study.canonical_sha256().ok()? != object_ref
        || study.study_id != specification.study.study_id.as_str()
        || study.schema_version != specification.study.plan_version
    {
        return None;
    }
    Some(study)
}

fn workspace_run_scope(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    api_instance: &str,
) -> Result<WorkspaceStudyHistory, ApiError> {
    Ok(current_study_history(store, context)?.unwrap_or_else(|| {
        let project_id = new_workspace_project_id(context, api_instance);
        WorkspaceStudyHistory {
            project_ids: BTreeSet::from([project_id.clone()]),
            project_id,
        }
    }))
}

fn new_workspace_project_id(context: &CurrentLiveRequestContext, api_instance: &str) -> String {
    let digest =
        fullmag_session::hex_sha256(format!("{api_instance}\0{}", context.session_id).as_bytes());
    format!("project-live-{digest}")
}

fn load_study_stage_results(
    store: &SessionStore,
    context: &CurrentLiveRequestContext,
    api_instance: &str,
    authored: Option<&AuthoredStudy>,
    current_layout_sha256: Option<&str>,
    query: StudyStageResultsQuery,
    limit: usize,
) -> Result<StudyStageResultsResource, ApiError> {
    let workspace = workspace_run_scope(store, context, api_instance)?;
    let scope = fullmag_session::canonical_json_sha256(&serde_json::json!([
        workspace.project_id,
        workspace.project_ids,
        context.session_id,
        context.session_epoch,
        query.run_id,
        query.stage_id
    ]));
    let owned = |intent: &FmsRunIntent| workspace.owns(intent, context);
    let requested = query
        .run_id
        .as_deref()
        .map(|run_id| {
            store
                .read_run_intent(run_id)
                .map_err(|error| ApiError::internal(error.to_string()))?
                .filter(owned)
                .ok_or_else(|| ApiError::not_found("Study result run was not found"))
        })
        .transpose()?;
    let history = match store.list_run_intents() {
        Ok(mut intents) => {
            intents.retain(owned);
            Some(intents)
        }
        Err(_) if requested.is_some() => None,
        Err(error) => return Err(ApiError::internal(error.to_string())),
    };
    let result_intents = if requested.is_some() {
        requested.as_slice()
    } else {
        history.as_deref().unwrap_or_default()
    };
    read_results_page(
        store,
        &workspace.project_id,
        scope,
        authored,
        current_layout_sha256,
        query,
        limit,
        result_intents,
        history
            .as_deref()
            .map(|intents| lineage::HistoryLineage::new(store, intents)),
    )
}

pub(crate) fn load_project_study_results(
    store: &SessionStore,
    project_id: &str,
    run_id: &str,
    query: StudyStageResultsQuery,
) -> Result<StudyStageResultsResource, ApiError> {
    let limit = validate_query(&query)?;
    if query
        .run_id
        .as_deref()
        .is_some_and(|requested| requested != run_id)
    {
        return Err(ApiError::bad_request(
            "result filter differs from the requested run",
        ));
    }
    let intent = store
        .read_run_intent(run_id)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("Study result run was not found"))?;
    let specification = verified_run_spec(&intent)?;
    if specification.snapshot.project_id.as_str() != project_id {
        return Err(ApiError::conflict("run belongs to another project"));
    }
    let scope = fullmag_session::canonical_json_sha256(&serde_json::json!([
        "project_study_results",
        project_id,
        run_id,
        query.stage_id,
    ]));
    read_results_page(
        store,
        project_id,
        scope,
        None,
        None,
        query,
        limit,
        std::slice::from_ref(&intent),
        None,
    )
}

fn read_results_page(
    store: &SessionStore,
    project_id: &str,
    scope: String,
    authored: Option<&AuthoredStudy>,
    current_layout_sha256: Option<&str>,
    query: StudyStageResultsQuery,
    limit: usize,
    intents: &[FmsRunIntent],
    mut lineage: Option<lineage::HistoryLineage<'_>>,
) -> Result<StudyStageResultsResource, ApiError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(|cursor| decode_cursor(cursor, &scope))
        .transpose()?;
    let authored_filter = query.stage_id.as_deref();
    let compiled_stage_filter = authored_filter
        .map(|id| fullmag_application::script_execution_id(id, 0))
        .transpose()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut results = Vec::with_capacity(limit + 1);
    let mut cursor_seen = cursor.is_none();
    let mut remaining_authoring_bytes = MAX_AUTHORED_COMPARISON_BYTES;
    let mut remaining_study_bytes = MAX_ACCEPTED_STUDY_BYTES_PER_PAGE;
    for intent in intents {
        if !cursor_seen
            && cursor
                .as_ref()
                .is_some_and(|cursor| cursor.run_id != intent.run_id)
        {
            continue;
        }

        let spec = verified_run_spec(intent)?;
        let compiled = spec.study.plan_version == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4;
        // Accepted physical primitives have one execution at expansion index 0.
        // Keep exact durable IDs valid for existing result links and callers.
        let compiled_filter = compiled_stage_filter.as_deref().filter(|_| compiled);
        let step_ids: Vec<_> = authored_filter
            .into_iter()
            .filter(|id| !compiled || !id.contains(['/', '\\']))
            .chain(compiled_filter)
            .collect();
        let Some(published) = list_published_final_states(store, &intent.run_id, &step_ids)
            .map_err(|message| {
                ApiError::conflict_with_code("study_result_binding_invalid", message)
            })?
        else {
            continue;
        };
        let mut accepted_authoring = None;
        let mut accepted_study = None;
        for output in published.outputs {
            if !cursor_seen {
                if cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.artifact_id == output.output.artifact_id)
                {
                    cursor_seen = true;
                }
                continue;
            }
            if !store.cas().contains(&output.output.object_ref) {
                return Err(ApiError::conflict_with_code(
                    "study_result_artifact_missing",
                    "published Study final state is missing from CAS",
                ));
            }
            let step_id = output.identity.step_id.as_str();
            let authored_stage_id = if compiled {
                authored
                    .and_then(|authored| authored.compiled_stage_ids.get(step_id))
                    .map(String::as_str)
                    .or_else(|| authored_filter.filter(|_| compiled_filter == Some(step_id)))
            } else {
                Some(step_id)
            };
            // The extra row is only a pagination sentinel.
            let task = (results.len() < limit)
                .then(|| {
                    published
                        .run_catalog
                        .tasks
                        .iter()
                        .find(|task| task.task_id == output.identity.task_id)
                })
                .flatten();
            let study = if task.is_some() {
                accepted_study
                    .get_or_insert_with(|| {
                        accepted_study_metadata(store, intent, &spec, &mut remaining_study_bytes)
                    })
                    .as_ref()
            } else {
                None
            };
            let authored_relation = match (authored, authored_stage_id) {
                (Some(authored), Some(id)) if authored.stage_ids.contains(id) => {
                    let accepted = accepted_authoring.get_or_insert_with(|| {
                        authored.accepted_authoring(
                            store,
                            intent,
                            &spec,
                            &mut remaining_authoring_bytes,
                        )
                    });
                    let root = study
                        .filter(|_| {
                            spec.parameters
                                .get("live_workspace")
                                .is_some_and(|live| follows_authored_state_flow(live, step_id))
                        })
                        .and_then(|study| authored_magnetization_root(study, step_id))
                        .and_then(|root| {
                            if compiled {
                                authored.compiled_stage_ids.get(root).map(String::as_str)
                            } else {
                                Some(root)
                            }
                        });
                    authored.relation(id, accepted, root)
                }
                (Some(_), _) => StudyResultAuthoredRelation::StageAbsent,
                (None, _) => StudyResultAuthoredRelation::AuthoringUnavailable,
            };
            let authored_stage_id = authored_stage_id.map(str::to_owned);
            let completion = task.zip(output.accepted_state_ref.as_ref()).and_then(|(task, state)| {
                crate::accepted_field_materialization_worker::terminal_completion_for_final_state(
                    store,
                    &published.artifact_catalog,
                    task,
                    step_id,
                    state,
                    &output.output.object_ref,
                ).map(|record| StudyResultCompletion::from(record.completion))
            });
            let initial_state = task.zip(study).and_then(|(task, study)| {
                crate::live_stage_initial_state::describe_result_initial_state(
                    store,
                    &spec,
                    study,
                    step_id,
                    task,
                    &published.run_catalog,
                    &published.artifact_catalog,
                )
            });
            let predecessor_relation = match (lineage.as_mut(), authored, initial_state.as_ref()) {
                (Some(lineage), Some(authored), Some(initial)) => {
                    lineage.predecessor_relation(authored, initial)
                }
                _ => StudyResultPredecessorRelation::Unavailable,
            };
            let saved_layout = current_layout_sha256.and(task).and_then(|task| {
                crate::accepted_field_materialization_worker::terminal_evidence_for_final_state(
                    store,
                    &published.artifact_catalog,
                    task,
                    step_id,
                    &output.output.object_ref,
                )
            });
            results.push(StudyStageResult {
                project_id: spec.snapshot.project_id.as_str().to_owned(),
                study_id: spec.study.study_id.as_str().to_owned(),
                source: output.identity,
                authored_stage_id,
                supports_magnetization_input: output.output.codec_id
                    == fullmag_application::STUDY_MAGNETIZATION_CODEC_ID
                    && output.output.codec_version
                        == fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
                artifact_id: output.output.artifact_id,
                artifact_sha256: output.output.content_sha256,
                codec_id: output.output.codec_id,
                codec_version: output.output.codec_version,
                accepted_at: intent.accepted_at.to_rfc3339(),
                authored_relation,
                completion,
                initial_state,
                predecessor_relation,
                domain_relation: domain_relation(
                    current_layout_sha256,
                    saved_layout
                        .as_ref()
                        .map(|record| record.layout_sha256.as_str()),
                ),
            });
            if results.len() > limit {
                break;
            }
        }
        if results.len() > limit {
            break;
        }
    }
    if !cursor_seen {
        return Err(ApiError::bad_request(
            "Study result cursor no longer matches a published result",
        ));
    }

    let next_cursor = if results.len() > limit {
        results.pop();
        let last = &results[limit - 1];
        let cursor = ResultsCursor {
            scope_sha256: scope,
            run_id: last.source.run_id.clone(),
            artifact_id: last.artifact_id.clone(),
        };
        Some(URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&cursor).map_err(|error| ApiError::internal(error.to_string()))?,
        ))
    } else {
        None
    };
    build_result_resource(project_id, authored, results, next_cursor)
}

fn build_result_resource(
    project_id: &str,
    authored: Option<&AuthoredStudy>,
    results: Vec<StudyStageResult>,
    next_cursor: Option<String>,
) -> Result<StudyStageResultsResource, ApiError> {
    let mut resource = StudyStageResultsResource {
        revision: String::new(),
        project_id: project_id.to_owned(),
        scene_revision: authored.map(|authored| authored.revision),
        authored_input_sha256: authored.map(|authored| authored.input.sha256.clone()),
        authored_stage_ids: authored.map_or_else(Vec::new, |authored| {
            authored.stage_ids.iter().cloned().collect()
        }),
        results,
        next_cursor,
    };
    resource.revision = fullmag_session::canonical_json_sha256(
        &serde_json::to_value(&resource).map_err(|error| ApiError::internal(error.to_string()))?,
    );
    Ok(resource)
}

fn decode_cursor(encoded: &str, expected_scope: &str) -> Result<ResultsCursor, ApiError> {
    let invalid = || ApiError::bad_request("invalid or foreign Study result cursor");
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let cursor: ResultsCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.scope_sha256 != expected_scope {
        return Err(invalid());
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_size_fields_with_different_active_cells_have_distinct_layouts() {
        let layout = |mask| {
            fullmag_application::study_state_layout_sha256(&serde_json::json!({
                "backend": "fdm", "grid_cells": [2, 1, 1], "active_mask": mask
            }))
            .unwrap()
        };
        let left = layout([true, false]);
        let right = layout([false, true]);
        assert_eq!(
            domain_relation(Some(&left), Some(&left)),
            StudyResultDomainRelation::MatchingPublishedLayout
        );
        assert_eq!(
            domain_relation(Some(&left), Some(&right)),
            StudyResultDomainRelation::DifferentPublishedLayout
        );
        assert_eq!(
            domain_relation(Some(&left), None),
            StudyResultDomainRelation::Unavailable
        );
    }
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, StudyId, StudyReference,
    };
    use serde_json::json;

    fn pipeline_scene(run_seconds: f64, field_t: f64, group_enabled: bool) -> SceneDocument {
        let mut scene = SceneDocument::default();
        scene.revision = 7;
        scene.study.study_pipeline = Some(serde_json::from_value(json!({
            "version": "study_pipeline.v2",
            "nodes": [
                {"node_kind": "primitive", "id": "field", "label": "Field", "stage_kind": "set_field",
                 "payload": {"field_t": [field_t, 0.0, 0.0]}},
                {"node_kind": "group", "id": "cycle", "label": "Cycle", "enabled": group_enabled,
                 "children": [
                    {"node_kind": "primitive", "id": "relax", "label": "Relax", "stage_kind": "relax"},
                    {"node_kind": "primitive", "id": "run", "label": "Run", "stage_kind": "run",
                     "payload": {"until_seconds": run_seconds}}
                ]}
            ]
        })).unwrap());
        scene
    }

    fn stored_authoring(
        store: &SessionStore,
        scene: &SceneDocument,
    ) -> (FmsRunIntent, RunSpecification) {
        let project_id = ProjectId::parse("project-stage-recipe").unwrap();
        let bytes = serde_json::to_vec(&json!({
            "schema": "fullmag.project_definition.v1",
            "name": "Stage recipe",
            "project_id": project_id.as_str(),
            "revision": scene.revision,
            "scene": scene,
        }))
        .unwrap();
        let definition = store.cas().put(&bytes).unwrap();
        let mut spec = RunSpecification::new(
            ProjectSnapshot {
                project_id,
                definition_revision: scene.revision,
                definition_sha256: definition.clone(),
            },
            StudyReference {
                study_id: StudyId::parse("study-stage-recipe").unwrap(),
                plan_version: fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(),
                plan_sha256: "a".repeat(64),
            },
            "b".repeat(64),
            json!({"live_workspace": {
                "scene_revision": scene.revision,
                "execution_input": crate::live_execution_binding::input_identity(scene).unwrap(),
            }}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: None,
            },
        );
        spec.run_id = RunId::parse("run-stage-recipe").unwrap();
        let mut intent = FmsRunIntent::new(
            spec.run_id.as_str(),
            "stage-recipe-acceptance",
            serde_json::to_value(&spec).unwrap(),
        );
        intent.definition_object_ref = Some(definition);
        (intent, spec)
    }

    #[test]
    fn authored_history_ignores_a_later_run_edit_but_keeps_prior_inputs_and_group_state() {
        use StudyResultAuthoredRelation::*;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let historical = pipeline_scene(1e-12, 0.01, true);
        let (intent, spec) = stored_authoring(&store, &historical);

        for (seconds, field, enabled, stage, expected) in [
            (2e-12, 0.01, true, "relax", MatchingAuthoredInput),
            (2e-12, 0.01, true, "run", AuthoredInputChanged),
            (1e-12, 0.02, true, "relax", AuthoredInputChanged),
            (1e-12, 0.01, false, "relax", AuthoredInputChanged),
            (1e-12, 0.01, true, "removed", StageAbsent),
        ] {
            let mut scene = pipeline_scene(seconds, field, enabled);
            scene.revision += 1;
            let authored = AuthoredStudy::from_scene(&scene).unwrap();
            let mut remaining = MAX_AUTHORED_COMPARISON_BYTES;
            let accepted = authored.accepted_authoring(&store, &intent, &spec, &mut remaining);
            assert_eq!(authored.relation(stage, &accepted, None), expected);
        }

        let authored = AuthoredStudy::from_scene(&pipeline_scene(2e-12, 0.01, true)).unwrap();
        let mut budget = 1;
        let accepted = authored.accepted_authoring(&store, &intent, &spec, &mut budget);
        assert_eq!(
            authored.relation("relax", &accepted, None),
            AuthoringUnavailable
        );
        let mut unpinned = intent;
        unpinned.definition_object_ref = None;
        let mut remaining = MAX_AUTHORED_COMPARISON_BYTES;
        let accepted = authored.accepted_authoring(&store, &unpinned, &spec, &mut remaining);
        assert_eq!(
            authored.relation("relax", &accepted, None),
            AuthoringUnavailable
        );
    }

    #[test]
    fn result_authoring_uses_explicitly_bound_stage_flow_and_whole_study() {
        assert!(follows_authored_state_flow(
            &json!({"step_id": null}),
            "run"
        ));
        assert!(follows_authored_state_flow(
            &json!({
                "step_id": "run",
                "command": {"initial_state": {"kind": "default_for_target"}}
            }),
            "run"
        ));
        assert!(follows_authored_state_flow(
            &json!({
                "step_id": "run",
                "command": {"initial_state": {
                    "kind": "authored_initial_state",
                    "source": {"kind": "stage", "stage_id": "run", "scene_revision": 7}
                }}
            }),
            "run"
        ));
        assert!(!follows_authored_state_flow(
            &json!({
                "step_id": "run",
                "command": {"initial_state": {
                    "kind": "authored_initial_state",
                    "source": {"kind": "study", "scene_revision": 7}
                }}
            }),
            "run"
        ));
        assert!(!follows_authored_state_flow(
            &json!({
                "step_id": "other",
                "command": {"initial_state": {"kind": "default_for_target"}}
            }),
            "run"
        ));
    }

    #[test]
    fn authored_recipe_retains_prior_relax_settings_only_along_the_inherited_state_chain() {
        use fullmag_authoring::{
            StudyInitialStateOverlay, StudyInputPort, StudyPlanMigrationDefaults,
        };
        use StudyResultAuthoredRelation::*;

        let mut historical = pipeline_scene(1e-12, 0.01, true);
        let pipeline = historical.study.study_pipeline.as_mut().unwrap();
        let StudyPipelineNode::Group(group) = &mut pipeline.nodes[1] else {
            panic!("expected group")
        };
        let StudyPipelineNode::Primitive(relax) = &mut group.children[0] else {
            panic!("expected Relax")
        };
        relax.payload.insert("max_steps".into(), json!(20));
        let StudyPipelineNode::Primitive(run) = &mut group.children[1] else {
            panic!("expected Run")
        };
        run.payload.insert(
            "stage_magnetization_assignments".into(),
            json!({
                "schema_version": "fullmag.magnetization-assignments.v1",
                "assignments": [{
                    "object_id": "magnet",
                    "region_id": null,
                    "initializer": { "kind": "uniform", "value": [1, 0, 0] }
                }]
            }),
        );
        let mut child = run.clone();
        child.id = "after-reset".into();
        child.payload.remove("stage_magnetization_assignments");
        group.children.push(StudyPipelineNode::Primitive(child));

        let defaults: StudyPlanMigrationDefaults = StudyPlanMigrationDefaults {
            model: serde_json::from_value(json!({"model_id": "model", "version": "1"})).unwrap(),
            solver_config: serde_json::from_value(json!({"preset_id": "solver", "version": "1"}))
                .unwrap(),
            discretization: serde_json::from_value(json!({"recipe_id": "mesh", "version": "1"}))
                .unwrap(),
            execution_profile: serde_json::from_value(
                json!({"profile_id": "profile", "version": "1"}),
            )
            .unwrap(),
        };
        let mut study = StudyPlan::from_pipeline("study", 7, pipeline, &defaults).unwrap();
        let authored_input = || StudyInputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::State,
            required: true,
            source: StudyInputSource::AuthoredInitialState {
                reference: "authored".into(),
            },
        };
        let inherited_input = |step_id: &str| StudyInputPort {
            source: StudyInputSource::StepOutput {
                step_id: step_id.into(),
                port: crate::live_accepted_continuation::FINAL_STATE_PORT.into(),
                case_id: "default".into(),
            },
            ..authored_input()
        };
        let step_index = |id: &str| {
            study
                .steps
                .iter()
                .position(|step| step.step_id == id)
                .unwrap()
        };
        let (relax, run, after) = (
            step_index("relax"),
            step_index("run"),
            step_index("after-reset"),
        );
        study.schema_version = fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION.into();
        for index in [relax, run, after] {
            crate::live_accepted_continuation::declare_final_state_output(&mut study.steps[index]);
        }
        study.steps[relax].inputs.push(authored_input());
        study.steps[run].inputs.push(authored_input());
        study.steps[run]
            .completion_dependencies
            .push("relax".into());
        study.steps[after].inputs.push(inherited_input("run"));
        study.validate_for_execution().unwrap();
        let accepted =
            AcceptedAuthoring::StageRecipes(StageRecipe::from_scene(&historical).unwrap());

        let mut edited = historical.clone();
        let pipeline = edited.study.study_pipeline.as_mut().unwrap();
        let StudyPipelineNode::Group(group) = &mut pipeline.nodes[1] else {
            panic!("expected group")
        };
        let StudyPipelineNode::Primitive(relax) = &mut group.children[0] else {
            panic!("expected Relax")
        };
        relax.payload.insert("max_steps".into(), json!(40));
        relax
            .payload
            .insert("algorithm".into(), json!("nonlinear_cg"));
        let authored = AuthoredStudy::from_scene(&edited).unwrap();
        assert_eq!(
            authored_magnetization_root(&study, "after-reset"),
            Some("run")
        );
        for stage in ["run", "after-reset"] {
            assert_eq!(
                authored.relation(stage, &accepted, authored_magnetization_root(&study, stage)),
                MatchingAuthoredInput
            );
        }
        assert_eq!(
            authored.relation("relax", &accepted, Some("relax")),
            AuthoredInputChanged
        );
        assert_eq!(
            authored.relation("run", &accepted, None),
            AuthoredInputChanged
        );

        // A change to the actual reset must remain visible to its descendants.
        let pipeline = edited.study.study_pipeline.as_mut().unwrap();
        let StudyPipelineNode::Group(group) = &mut pipeline.nodes[1] else {
            panic!("expected group")
        };
        let StudyPipelineNode::Primitive(run_stage) = &mut group.children[1] else {
            panic!("expected Run")
        };
        run_stage
            .payload
            .get_mut("stage_magnetization_assignments")
            .unwrap()["assignments"][0]["initializer"]["value"] = json!([0, 1, 0]);
        let changed = AuthoredStudy::from_scene(&edited).unwrap();
        assert_eq!(
            changed.relation("after-reset", &accepted, Some("run")),
            AuthoredInputChanged
        );

        study.steps[run].inputs = vec![inherited_input("relax")];
        study.steps[run].initial_state_overlay = Some(StudyInitialStateOverlay::Scoped {
            scopes: vec![fullmag_ir::RegionRefIR {
                object_id: "magnet".into(),
                region_id: Some("left".into()),
            }],
        });
        study.validate_for_execution().unwrap();
        assert_eq!(
            authored_magnetization_root(&study, "after-reset"),
            Some("relax")
        );
        assert_eq!(
            authored.relation(
                "after-reset",
                &accepted,
                authored_magnetization_root(&study, "after-reset")
            ),
            AuthoredInputChanged
        );
    }

    #[test]
    fn flat_stage_recipe_uses_the_same_generated_id_as_the_study_projection() {
        use StudyResultAuthoredRelation::*;
        let mut scene = SceneDocument::default();
        scene.study.stages = serde_json::from_value(json!([
            {"kind": "relax", "entrypoint_kind": "flat_relax", "max_steps": 20},
            {"kind": "run", "entrypoint_kind": "flat_run", "until_seconds": 1e-12}
        ]))
        .unwrap();
        let accepted = AcceptedAuthoring::StageRecipes(StageRecipe::from_scene(&scene).unwrap());
        scene.study.stages[1].until_seconds = serde_json::from_value(json!(2e-12)).unwrap();
        let authored = AuthoredStudy::from_scene(&scene).unwrap();

        assert_eq!(
            authored.relation("scene-stage-0", &accepted, None),
            MatchingAuthoredInput
        );
        assert_eq!(
            authored.relation("scene-stage-1", &accepted, None),
            AuthoredInputChanged
        );
    }
}

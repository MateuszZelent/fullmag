//! Prepare a scoped authored reset on the published Live domain.

use std::path::Path;

use fullmag_application::{RequestedExecution, RunId, RunSpecification};
use fullmag_authoring::SceneDocument;
use fullmag_ir::{BackendPlanIR, GeometryAssetsIR, RegionRefIR};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::live_scene_preparation::{prepare_initial_magnetization, PreparedInitialMagnetization};
use crate::schemas::authoring::MagnetizationApplyStatus;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

use super::MagnetizationApply;

#[derive(PartialEq, Eq)]
struct ApplyFence {
    domain: crate::session::LiveFieldDomainIdentity,
    region_revisions: fullmag_authoring::RegionRealizationRevisions,
    magnetization_revision: Option<u64>,
    preparation_revision: u64,
    metadata_version: Option<u64>,
    terminal_generation: Option<crate::types::CurrentLiveFieldGeneration>,
}

impl ApplyFence {
    fn capture(snapshot: &SessionStateResponse) -> Self {
        Self {
            domain: crate::session::current_live_field_domain_identity(snapshot),
            region_revisions: snapshot.region_realization_revisions,
            magnetization_revision: snapshot.field_quantity_revisions.get("m").copied(),
            preparation_revision: snapshot.simulation_preparation_revision,
            metadata_version: snapshot
                .metadata
                .as_ref()
                .map(|metadata| metadata.version()),
            terminal_generation: snapshot.accepted_terminal_field_generation.clone(),
        }
    }
}

enum ApplyPreview {
    Pending(&'static str),
    Ready {
        carrier: PreparedInitialMagnetization,
        metadata: crate::shared_json::SharedJson,
        plan_fingerprint: String,
        provenance: Value,
    },
}

pub(crate) struct PreparedMagnetizationApply {
    fence: ApplyFence,
    preview: ApplyPreview,
}

impl PreparedMagnetizationApply {
    pub(crate) fn validate(&self, snapshot: &SessionStateResponse) -> Result<(), ApiError> {
        if self.fence != ApplyFence::capture(snapshot) {
            return Err(ApiError::conflict_with_code(
                "magnetization_apply_input_changed",
                "the domain or base magnetization changed during preparation",
            ));
        }
        Ok(())
    }

    pub(crate) fn publish(
        self,
        snapshot: &mut SessionStateResponse,
        apply: &MagnetizationApply,
        scene_revision: u64,
    ) -> Result<(MagnetizationApplyStatus, Option<&'static str>), ApiError> {
        match self.preview {
            ApplyPreview::Pending(reason) => {
                crate::session::invalidate_live_magnetization_preview(snapshot);
                Ok((MagnetizationApplyStatus::InitialStatePending, Some(reason)))
            }
            ApplyPreview::Ready {
                carrier,
                metadata,
                plan_fingerprint,
                provenance,
            } => {
                snapshot.metadata = Some(metadata);
                snapshot.simulation_preparation = None;
                snapshot.coupled_checkpoint = None;
                carrier.publish(
                    snapshot,
                    &apply.request.operation_id,
                    &plan_fingerprint,
                    scene_revision,
                    provenance,
                )?;
                Ok((MagnetizationApplyStatus::InitialStateReady, None))
            }
        }
    }
}

pub(crate) async fn prepare(
    state: &AppState,
    context: CurrentLiveRequestContext,
    snapshot: SessionStateResponse,
    scene: SceneDocument,
    apply: MagnetizationApply,
) -> Result<PreparedMagnetizationApply, ApiError> {
    let repo = state.repo_root.clone();
    let workspace = state.current_workspace_root.clone();
    let store = state.submit_store_root.clone();
    tokio::task::spawn_blocking(move || {
        let fence = ApplyFence::capture(&snapshot);
        let preview = prepare_preview(
            &repo,
            &workspace,
            store.as_deref(),
            &context,
            &snapshot,
            &scene,
            &apply,
        )?;
        Ok(PreparedMagnetizationApply { fence, preview })
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "magnetization apply preparation task failed: {error}",
        ))
    })?
}

fn prepare_preview(
    repo: &Path,
    workspace: &Path,
    store_root: Option<&Path>,
    context: &CurrentLiveRequestContext,
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
    apply: &MagnetizationApply,
) -> Result<ApplyPreview, ApiError> {
    let before = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::conflict("magnetization apply requires a committed scene"))?;
    if crate::scene_mesh_signature(before) != crate::scene_mesh_signature(scene) {
        return Ok(ApplyPreview::Pending("domain_requires_rebuild"));
    }
    let Some(metadata) = snapshot
        .metadata
        .as_ref()
        .filter(|meta| meta.get("execution_plan").is_some())
    else {
        return Ok(ApplyPreview::Pending("domain_not_prepared"));
    };
    let published = metadata
        .execution_plan()
        .ok_or_else(|| ApiError::conflict("invalid published domain plan"))?;
    let Ok(layout) = fullmag_runner::study_magnetization_layout_for_plan(&published) else {
        return Ok(ApplyPreview::Pending("domain_layout_unsupported"));
    };
    let geometry = match &published.backend_plan {
        BackendPlanIR::Fem(fem) => {
            let payload = fullmag_runner::FemMeshPayload::from(fem);
            let topology = fullmag_runner::fem_mesh_topology_fingerprint(&payload);
            if snapshot
                .fem_mesh
                .as_ref()
                .is_none_or(|mesh| mesh.topology_fingerprint() != topology)
            {
                return Ok(ApplyPreview::Pending("domain_layout_not_qualified"));
            }
            let Some(geometry) = verified_fem_geometry(store_root, context, snapshot, &layout)?
            else {
                return Ok(ApplyPreview::Pending("native_fem_domain_not_qualified"));
            };
            Some(geometry)
        }
        _ => {
            let published_layout = snapshot
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("artifact_layout"));
            if published_layout != Some(&layout) {
                return Ok(ApplyPreview::Pending("domain_layout_not_qualified"));
            }
            None
        }
    };
    let execution = RequestedExecution {
        backend: scene.study.requested_backend.clone(),
        device: scene.study.requested_device.clone(),
        precision: scene.study.requested_precision.clone(),
        mode: scene.study.requested_mode.clone(),
        minimum_resources: None,
    };
    let source = Path::new(&snapshot.session.script_path);
    let asset_root = source.is_absolute().then(|| source.parent()).flatten();
    let mut problem = crate::script::scene_document_to_authored_problem_ir_with_asset_root(
        repo, workspace, asset_root, scene, &execution,
    )?;
    if let Some(geometry) = geometry {
        problem.geometry_assets = Some(geometry);
    }
    let problem = fullmag_application::bind_declared_execution(&problem, vec![])
        .map_err(|error| ApiError::unprocessable(format!("bind magnetization apply: {error}")))?;
    let planned = fullmag_plan::plan(&problem).map_err(|error| {
        ApiError::unprocessable(format!("evaluate magnetization apply: {error}"))
    })?;
    let planned_layout = fullmag_runner::study_magnetization_layout_for_plan(&planned)
        .map_err(|error| ApiError::unprocessable(error.message))?;
    if planned_layout != layout {
        return Ok(ApplyPreview::Pending("domain_requires_rebuild"));
    }

    let scopes = apply
        .request
        .scopes
        .iter()
        .map(|scope| RegionRefIR {
            object_id: scope.object_id.clone(),
            region_id: scope.region_id.clone(),
        })
        .collect::<Vec<_>>();
    let full_reset = problem.magnets.iter().all(|magnet| {
        let id = magnet.object_id.as_deref().unwrap_or(&magnet.name);
        scopes
            .iter()
            .any(|scope| scope.object_id == id && scope.region_id.is_none())
    });
    let (plan, base) = if full_reset {
        (planned, Value::Null)
    } else {
        let Some((values, identity)) = qualified_base(snapshot, &layout)? else {
            return Ok(ApplyPreview::Pending("base_magnetization_unavailable"));
        };
        let overlaid = fullmag_runner::materialize_study_magnetization_input_with_overlay(
            &planned,
            &layout,
            &values,
            Some((&problem, &scopes)),
        )
        .map_err(|error| ApiError::unprocessable(error.message))?;
        (overlaid, identity)
    };
    let provenance = json!({
        "source_kind": "prepared_initial_state",
        "operation_id": apply.request.operation_id,
        "scopes": scopes,
        "base": base,
    });
    let plan_fingerprint = fullmag_session::canonical_json_sha256(&json!({
        "schema": "fullmag.live-magnetization-apply.v1",
        "operation": provenance,
        "layout": layout,
        "authored_scene": fullmag_authoring::scene_execution_input_identity(scene)
            .map_err(|error| ApiError::bad_request(error.to_string()))?,
    }));
    let carrier = prepare_initial_magnetization(&plan)?
        .ok_or_else(|| ApiError::unprocessable("prepared magnetization carrier is missing"))?;
    let mut next_metadata: serde_json::Map<String, Value> = metadata
        .as_object()
        .ok_or_else(|| ApiError::conflict("published domain metadata is not an object"))?
        .iter()
        .filter(|(key, _)| key.as_str() != "execution_plan")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let execution_plan = serde_json::to_value(plan)
        .map_err(|error| ApiError::internal(format!("encode magnetization apply plan: {error}")))?;
    next_metadata.insert("execution_plan".into(), execution_plan);
    Ok(ApplyPreview::Ready {
        carrier,
        plan_fingerprint,
        provenance,
        metadata: Value::Object(next_metadata).into(),
    })
}

fn qualified_base(
    snapshot: &SessionStateResponse,
    layout: &Value,
) -> Result<Option<(Vec<[f64; 3]>, Value)>, ApiError> {
    let Some(raw) = snapshot.latest_fields.get("m") else {
        return Ok(None);
    };
    let Some(bundle) = snapshot.field_publication_bundles.get("m") else {
        return Ok(None);
    };
    let frame = raw.get("observation_frame").and_then(|frame| {
        serde_json::from_value::<crate::schemas::common::AcceptedObservationFrameRef>(frame.clone())
            .ok()
    });
    if frame.as_ref() != Some(&bundle.observation_frame)
        || bundle.field.artifact_field_locator.is_some()
        || !crate::session::latest_field_source_is_qualified(snapshot, "m", raw)
        || (bundle.observation_frame.authored_initial_state.is_none()
            && raw.get("layout") != Some(layout))
    {
        return Ok(None);
    }
    let flat = crate::router_v2::handlers::data::field_resolution::flatten_current_field_values(
        snapshot, "m", raw,
    )?;
    let triples = flat.chunks_exact(3);
    if !triples.remainder().is_empty() {
        return Err(ApiError::conflict(
            "qualified base contains incomplete magnetization samples",
        ));
    }
    let values = triples.map(|item| [item[0], item[1], item[2]]).collect();
    Ok(Some((
        values,
        json!({
            "publication_id": bundle.publication_id,
            "carrier_fingerprint": bundle.field.carrier_fingerprint,
            "observation_frame_id": bundle.observation_frame.observation_frame_id,
        }),
    )))
}

fn verified_fem_geometry(
    store_root: Option<&Path>,
    context: &CurrentLiveRequestContext,
    snapshot: &SessionStateResponse,
    layout: &Value,
) -> Result<Option<GeometryAssetsIR>, ApiError> {
    let Some((store_root, workspace)) = store_root.zip(snapshot.mesh_workspace.as_ref()) else {
        return Ok(None);
    };
    let Some(run_id) = workspace["accepted_run_id"].as_str() else {
        return Ok(None);
    };
    let Some(step_id) = workspace["accepted_step_id"].as_str() else {
        return Ok(None);
    };
    if snapshot.fem_mesh.is_none()
        || snapshot.run.as_ref().map(|run| run.run_id.as_str()) != Some(run_id)
    {
        return Ok(None);
    }
    let invalid =
        |message| ApiError::conflict_with_code("magnetization_apply_fem_binding_invalid", message);
    let store = fullmag_session::SessionStore::open_existing(store_root)
        .map_err(|error| invalid(format!("open native FEM evidence: {error}")))?;
    let Some(intent) = store
        .read_run_intent(run_id)
        .map_err(|error| invalid(format!("read native FEM run: {error}")))?
    else {
        return Ok(None);
    };
    let live = intent
        .specification
        .pointer("/parameters/live_workspace")
        .unwrap_or(&Value::Null);
    if live["session_id"].as_str() != Some(context.session_id.as_str())
        || live["session_epoch"].as_u64() != Some(context.session_epoch)
    {
        return Err(invalid(
            "native FEM evidence belongs to another session".into(),
        ));
    }
    let specification: RunSpecification = serde_json::from_value(intent.specification)
        .map_err(|error| invalid(format!("decode native FEM run: {error}")))?;
    let run = RunId::parse(run_id.to_owned()).map_err(|error| invalid(error.to_string()))?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &run,
        &specification.snapshot.project_id,
    )
    .map_err(|error| invalid(format!("validate native FEM Study: {error:#}")))?;
    let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)
        .map_err(|error| invalid(error.to_string()))?;
    accepted
        .read_task_preparation(&store, &task_id)
        .map_err(|error| invalid(format!("verify native FEM preparation: {error:#}")))?;
    let Some(plan) = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .and_then(|step| step.execution_plan.as_ref())
    else {
        return Err(invalid("native FEM step has no execution plan".into()));
    };
    if fullmag_runner::study_magnetization_layout_for_plan(plan)
        .as_ref()
        .ok()
        != Some(layout)
    {
        return Err(invalid(
            "published FEM mesh differs from native preparation".into(),
        ));
    }
    let entry = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| entry.step_id() == step_id)
        .ok_or_else(|| invalid("native FEM step has no immutable geometry input".into()))?;
    Ok(entry
        .problem()
        .geometry_assets
        .clone()
        .filter(|geometry| geometry.fem_domain_mesh_asset.is_some()))
}

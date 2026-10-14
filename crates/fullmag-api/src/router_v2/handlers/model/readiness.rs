use std::collections::BTreeSet;
use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::types::{AppState, SessionStateResponse};

const TRANSFORM_CAPABILITY_REASON: &str =
    "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadinessCheckState {
    Complete,
    Blocked,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelReadinessCheck {
    pub id: String,
    pub state: ModelReadinessCheckState,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelAuthoringCapability {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelAuthoringCapabilities {
    #[serde(rename = "move")]
    pub move_object: ModelAuthoringCapability,
    pub rotate: ModelAuthoringCapability,
    pub scale: ModelAuthoringCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelReadinessResource {
    pub scene_revision: u64,
    pub ready_to_run: bool,
    pub ready_to_export: bool,
    pub checks: Vec<ModelReadinessCheck>,
    pub blockers: Vec<String>,
    pub capabilities: ModelAuthoringCapabilities,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/readiness",
    responses(
        (status = 200, description = "Derived readiness of the current canonical authoring model", body = ModelReadinessResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_model_readiness(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ModelReadinessResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let snapshot = state.current_live_state.read().await;
    let snapshot = snapshot
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local session"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene document"))?;
    Ok(Json(build_model_readiness(snapshot, scene)))
}

fn build_model_readiness(
    snapshot: &SessionStateResponse,
    scene: &fullmag_authoring::SceneDocument,
) -> ModelReadinessResource {
    let solve_objects = fullmag_authoring::scene_solve_objects(scene).collect::<Vec<_>>();
    let textures = scene
        .magnetization_assets
        .iter()
        .map(|texture| texture.id.as_str())
        .collect::<BTreeSet<_>>();

    let geometry = presence_check(
        "geometry",
        "Geometry",
        !solve_objects.is_empty(),
        "model/scene",
        "Add at least one magnetic object.",
    );
    let missing_material_object = solve_objects.iter().find(|object| {
        fullmag_authoring::resolve_scene_object_solve_material(scene, object).is_err()
    });
    let material_error = solve_objects.iter().find_map(|object| {
        fullmag_authoring::resolve_scene_object_solve_material(scene, object)
            .err()
            .map(|error| error.to_string())
    });
    let material = presence_check(
        "material",
        "Material",
        !solve_objects.is_empty() && material_error.is_none(),
        &missing_material_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/materials".into()),
        material_error
            .as_deref()
            .unwrap_or("Assign a material to every magnetic object."),
    );
    let missing_texture_object = solve_objects.iter().find(|object| {
        !object
            .magnetization_ref
            .as_deref()
            .is_some_and(|id| textures.contains(id))
    });
    let texture = presence_check(
        "texture",
        "Initial magnetization",
        !solve_objects.is_empty()
            && solve_objects.iter().all(|object| {
                object
                    .magnetization_ref
                    .as_deref()
                    .is_some_and(|id| textures.contains(id))
            }),
        &missing_texture_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/magnetization-assets".into()),
        "Assign initial magnetization to every magnetic object.",
    );
    let missing_interaction_object = solve_objects
        .iter()
        .find(|object| !object.physics_stack.iter().any(|entry| entry.enabled));
    let interactions = presence_check(
        "interactions",
        "Interactions",
        !solve_objects.is_empty()
            && solve_objects
                .iter()
                .all(|object| object.physics_stack.iter().any(|entry| entry.enabled)),
        &missing_interaction_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/objects/interactions".into()),
        "Enable at least one interaction for every magnetic object.",
    );
    let discretization = discretization_check(snapshot, scene);
    let study = presence_check(
        "study",
        "Study",
        !scene.study.stages.is_empty() || scene.study.study_pipeline.is_some(),
        "model/study",
        "Add at least one study stage.",
    );

    let method = presence_check(
        "method",
        "Simulation method",
        matches!(scene.study.requested_backend.as_str(), "fdm" | "fem"),
        "model/study",
        "Choose FEM or FDM in Study settings.",
    );
    let domain = domain_check(scene);
    let mut execution = presence_check(
        "execution",
        "Execution request",
        matches!(
            scene.study.requested_device.as_str(),
            "auto" | "cpu" | "gpu" | "cuda"
        ),
        "model/study",
        "Choose CPU, GPU or Auto for the next solver run in Study settings.",
    );
    if execution.state == ModelReadinessCheckState::Complete {
        execution.reason = Some("The requested device is configured; engine availability is checked during preparation for each run.".into());
    }
    let checks = vec![
        method,
        domain,
        geometry,
        material,
        texture,
        interactions,
        discretization,
        study,
        execution,
    ];
    let validation_error = fullmag_authoring::validate_scene_document(scene)
        .err()
        .map(|error| error.to_string());
    let mut blockers = checks
        .iter()
        .filter(|check| check.state != ModelReadinessCheckState::Complete)
        .filter_map(|check| check.reason.clone())
        .collect::<Vec<_>>();
    if let Some(error) = validation_error.as_ref() {
        blockers.push(error.clone());
    }
    let ready_to_run = blockers.is_empty();
    let export_checks_complete = checks
        .iter()
        .filter(|check| {
            matches!(
                check.id.as_str(),
                "geometry" | "material" | "texture" | "interactions"
            )
        })
        .all(|check| check.state == ModelReadinessCheckState::Complete);

    ModelReadinessResource {
        scene_revision: scene.revision,
        ready_to_run,
        ready_to_export: export_checks_complete && validation_error.is_none(),
        checks,
        blockers,
        capabilities: ModelAuthoringCapabilities {
            move_object: ModelAuthoringCapability {
                available: true,
                reason: None,
            },
            rotate: unavailable_transform_capability(),
            scale: unavailable_transform_capability(),
        },
    }
}

fn domain_check(scene: &fullmag_authoring::SceneDocument) -> ModelReadinessCheck {
    let target = if scene.study.requested_backend == "fem" {
        fullmag_authoring::GeometryBackendTarget::Fem
    } else {
        fullmag_authoring::GeometryBackendTarget::Fdm
    };
    let validation = fullmag_authoring::validate_geometry_scene(scene, target);
    let outside = validation.diagnostics.iter().find(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE" | "GEOMETRY_UNIVERSE_INVALID_BOUNDS"
        ) && diagnostic.blocks.iter().any(|block| block == "build_mesh")
    });
    let mut check = presence_check(
        "domain",
        "Domain policy",
        outside.is_none(),
        "meshing/policies/universe",
        outside
            .map(|diagnostic| diagnostic.message.as_str())
            .unwrap_or("Review the domain policy."),
    );
    if check.state == ModelReadinessCheckState::Complete {
        let universe = scene
            .study
            .universe_mesh
            .as_ref()
            .or(scene.universe.as_ref());
        check.reason = Some(
            if universe.is_some_and(|universe| universe.mode == "manual") {
                "Manual domain bounds are configured; mesh and solver requirements are checked separately.".into()
            } else if scene.objects.is_empty() {
                "Automatic bounds will be derived after geometry is added. You can configure manual dimensions now or later.".into()
            } else {
                "Automatic domain policy follows the authored geometry; FEM air requirements depend on the selected physics.".into()
            },
        );
    }
    check
}

fn presence_check(
    id: &str,
    label: &str,
    complete: bool,
    target_resource: &str,
    blocked_reason: &str,
) -> ModelReadinessCheck {
    ModelReadinessCheck {
        id: id.to_string(),
        state: if complete {
            ModelReadinessCheckState::Complete
        } else {
            ModelReadinessCheckState::Blocked
        },
        label: label.to_string(),
        target_resource: Some(target_resource.to_string()),
        reason: (!complete).then(|| blocked_reason.to_string()),
    }
}

fn discretization_check(
    snapshot: &SessionStateResponse,
    scene: &fullmag_authoring::SceneDocument,
) -> ModelReadinessCheck {
    let backend = scene.study.requested_backend.to_ascii_lowercase();
    match backend.as_str() {
        "fdm" => {
            let configured =
                scene.study.fdm.as_ref().is_some_and(|fdm| {
                    fdm.default_cell.is_some() || !fdm.per_object_grid.is_empty()
                });
            presence_check(
                "discretization",
                "Discretization",
                configured,
                "model/study",
                "Configure an FDM grid before running.",
            )
        }
        "fem" => {
            let source_revision =
                crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(snapshot);
            let current = snapshot.fem_mesh.is_some() && source_revision == Some(scene.revision);
            ModelReadinessCheck {
                id: "discretization".to_string(),
                state: if current {
                    ModelReadinessCheckState::Complete
                } else if snapshot.fem_mesh.is_some() {
                    ModelReadinessCheckState::Stale
                } else {
                    ModelReadinessCheckState::Blocked
                },
                label: "Discretization".to_string(),
                target_resource: Some("meshing/builds/current".to_string()),
                reason: (!current)
                    .then(|| "Build a current shared-domain mesh before running.".to_string()),
            }
        }
        _ => presence_check(
            "discretization",
            "Discretization",
            false,
            "model/study",
            "Choose FDM or FEM discretization.",
        ),
    }
}

fn unavailable_transform_capability() -> ModelAuthoringCapability {
    ModelAuthoringCapability {
        available: false,
        reason: Some(TRANSFORM_CAPABILITY_REASON.to_string()),
    }
}

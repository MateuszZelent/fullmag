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
    let snapshot = state.current_live_state.read().await;
    let snapshot = snapshot
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local session"))?;
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
    let object_ids = scene
        .objects
        .iter()
        .filter(|object| object.visible && object.role == "magnet")
        .map(|object| object.id.as_str())
        .collect::<Vec<_>>();
    let textures = scene
        .magnetization_assets
        .iter()
        .map(|texture| texture.id.as_str())
        .collect::<BTreeSet<_>>();

    let geometry = presence_check(
        "geometry",
        "Geometry",
        !object_ids.is_empty(),
        "model/scene",
        "Add at least one magnetic object.",
    );
    let material_error = scene
        .objects
        .iter()
        .filter(|object| object_ids.contains(&object.id.as_str()))
        .find_map(|object| {
            fullmag_authoring::resolve_scene_object_solve_material(scene, object)
                .err()
                .map(|error| error.to_string())
        });
    let material = presence_check(
        "material",
        "Material",
        !object_ids.is_empty() && material_error.is_none(),
        "model/materials",
        material_error
            .as_deref()
            .unwrap_or("Assign a material to every magnetic object."),
    );
    let texture = presence_check(
        "texture",
        "Initial magnetization",
        !object_ids.is_empty()
            && scene
                .objects
                .iter()
                .filter(|object| object_ids.contains(&object.id.as_str()))
                .all(|object| {
                    object
                        .magnetization_ref
                        .as_deref()
                        .is_some_and(|id| textures.contains(id))
                }),
        "model/magnetization-assets",
        "Assign initial magnetization to every magnetic object.",
    );
    let interactions = presence_check(
        "interactions",
        "Interactions",
        !object_ids.is_empty()
            && scene
                .objects
                .iter()
                .filter(|object| object_ids.contains(&object.id.as_str()))
                .all(|object| object.physics_stack.iter().any(|entry| entry.enabled)),
        "model/objects/interactions",
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

    let checks = vec![
        geometry,
        material,
        texture,
        interactions,
        discretization,
        study,
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
    let export_checks_complete = checks[..4]
        .iter()
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
    let backend = scene
        .study
        .backend
        .as_deref()
        .filter(|backend| !backend.is_empty())
        .unwrap_or(scene.study.requested_backend.as_str())
        .to_ascii_lowercase();
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

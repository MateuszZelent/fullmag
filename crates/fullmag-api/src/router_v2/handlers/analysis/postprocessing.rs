//! Persistent user-created Results nodes (ADR 0054, spec frontend-v2/32 §8).
//!
//! Definitions live in the scene document so they are saved with the project
//! and restored with it. Every mutation goes through the scene revision check
//! and the authoring validation of the committed scene.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    Json,
};
use fullmag_authoring::{SceneDocument, ScenePostprocessingDefinition};

use crate::{
    error::ApiError,
    schemas::{
        PostprocessingDefinition, PostprocessingDefinitionCollectionResource,
        PostprocessingDefinitionCreateRequest, PostprocessingDefinitionDeleteRequest,
        PostprocessingDefinitionPatchRequest, PostprocessingDefinitionResource,
    },
    types::AppState,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/postprocessing/definitions",
    responses((status = 200, body = PostprocessingDefinitionCollectionResource)),
    tag = "analysis"
)]
pub async fn list_postprocessing_definitions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PostprocessingDefinitionCollectionResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    Ok(Json(collection_resource(scene)))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/analysis/postprocessing/definitions",
    request_body = PostprocessingDefinitionCreateRequest,
    responses(
        (status = 200, body = PostprocessingDefinitionResource),
        (status = 400, description = "Invalid definition"),
        (status = 409, description = "Revision or identity conflict")
    ),
    tag = "analysis"
)]
pub async fn create_postprocessing_definition(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PostprocessingDefinitionCreateRequest>,
) -> Result<Json<PostprocessingDefinitionResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    let definition_id = request.definition.definition_id.clone();
    if find_definition(&scene, &definition_id).is_some() {
        return Err(ApiError::conflict(format!(
            "duplicate_postprocessing_definition_id: {definition_id}"
        )));
    }
    let mut definition = ScenePostprocessingDefinition::from(request.definition);
    definition.revision = 1;
    scene.analysis.postprocessing_definitions.push(definition);
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    definition_resource(&committed, &definition_id).map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/postprocessing/definitions/{definition_id}",
    params(("definition_id" = String, Path)),
    responses(
        (status = 200, body = PostprocessingDefinitionResource),
        (status = 404, description = "Definition missing")
    ),
    tag = "analysis"
)]
pub async fn get_postprocessing_definition(
    State(state): State<Arc<AppState>>,
    Path(definition_id): Path<String>,
) -> Result<Json<PostprocessingDefinitionResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    definition_resource(&scene, &definition_id).map(Json)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/analysis/postprocessing/definitions/{definition_id}",
    params(("definition_id" = String, Path)),
    request_body = PostprocessingDefinitionPatchRequest,
    responses(
        (status = 200, body = PostprocessingDefinitionResource),
        (status = 400, description = "Invalid definition"),
        (status = 404, description = "Definition missing"),
        (status = 409, description = "Revision conflict")
    ),
    tag = "analysis"
)]
pub async fn patch_postprocessing_definition(
    State(state): State<Arc<AppState>>,
    Path(definition_id): Path<String>,
    Json(request): Json<PostprocessingDefinitionPatchRequest>,
) -> Result<Json<PostprocessingDefinitionResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    if request.definition.definition_id != definition_id {
        return Err(ApiError::bad_request(
            "postprocessing_definition_id_mismatch: path id and payload id differ",
        ));
    }
    let existing = scene
        .analysis
        .postprocessing_definitions
        .iter_mut()
        .find(|definition| definition.definition_id == definition_id)
        .ok_or_else(|| missing_definition(&definition_id))?;
    if existing.module_id != request.definition.module_id {
        return Err(ApiError::bad_request(
            "postprocessing_definition_owner_changed: module_id cannot change",
        ));
    }
    let next_revision = existing.revision + 1;
    let mut next = ScenePostprocessingDefinition::from(request.definition);
    next.revision = next_revision;
    *existing = next;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    definition_resource(&committed, &definition_id).map(Json)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/analysis/postprocessing/definitions/{definition_id}",
    params(("definition_id" = String, Path)),
    request_body = PostprocessingDefinitionDeleteRequest,
    responses(
        (status = 200, body = PostprocessingDefinitionCollectionResource),
        (status = 404, description = "Definition missing"),
        (status = 409, description = "Revision conflict or definition has children")
    ),
    tag = "analysis"
)]
pub async fn delete_postprocessing_definition(
    State(state): State<Arc<AppState>>,
    Path(definition_id): Path<String>,
    Json(request): Json<PostprocessingDefinitionDeleteRequest>,
) -> Result<Json<PostprocessingDefinitionCollectionResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    if find_definition(&scene, &definition_id).is_none() {
        return Err(missing_definition(&definition_id));
    }
    if scene
        .analysis
        .postprocessing_definitions
        .iter()
        .any(|definition| definition.parent_definition_id.as_deref() == Some(&definition_id))
    {
        return Err(ApiError::conflict(format!(
            "postprocessing_definition_has_children: delete the children of {definition_id} first"
        )));
    }
    scene
        .analysis
        .postprocessing_definitions
        .retain(|definition| definition.definition_id != definition_id);
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(collection_resource(committed)))
}

fn check_scene_revision(current: u64, expected: u64) -> Result<(), ApiError> {
    if current == expected {
        Ok(())
    } else {
        Err(ApiError::conflict(format!(
            "scene_revision_conflict: expected {expected}, current {current}"
        )))
    }
}

fn find_definition<'a>(
    scene: &'a SceneDocument,
    definition_id: &str,
) -> Option<&'a ScenePostprocessingDefinition> {
    scene
        .analysis
        .postprocessing_definitions
        .iter()
        .find(|definition| definition.definition_id == definition_id)
}

fn missing_definition(definition_id: &str) -> ApiError {
    ApiError::not_found(format!(
        "postprocessing definition not found: {definition_id}"
    ))
}

fn definition_resource(
    scene: &SceneDocument,
    definition_id: &str,
) -> Result<PostprocessingDefinitionResource, ApiError> {
    let definition = find_definition(scene, definition_id)
        .cloned()
        .ok_or_else(|| missing_definition(definition_id))?;
    Ok(PostprocessingDefinitionResource {
        scene_revision: scene.revision,
        definition: PostprocessingDefinition::from(definition),
    })
}

fn collection_resource(scene: SceneDocument) -> PostprocessingDefinitionCollectionResource {
    let definitions = scene
        .analysis
        .postprocessing_definitions
        .into_iter()
        .map(PostprocessingDefinition::from)
        .collect::<Vec<_>>();
    PostprocessingDefinitionCollectionResource {
        scene_revision: scene.revision,
        count: definitions.len(),
        definitions,
    }
}

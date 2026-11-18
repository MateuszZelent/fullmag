//! Durable per-user material catalog, independent of the current session.

use std::path::Path;

use axum::extract::{rejection::JsonRejection, Path as AxumPath};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::material_library::{
    MaterialLibraryError, MaterialLibraryMutationResource, MaterialLibraryResource,
    MaterialLibraryStore, MaterialLibraryWriteRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryUpdateRequest {
    /// Revision of the entry being replaced, not the catalog revision.
    pub base_revision: u64,
    #[serde(flatten)]
    pub material: MaterialLibraryWriteRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MaterialLibraryDeleteRequest {
    /// Revision of the entry being deleted.
    pub base_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryDeleteResource {
    /// Catalog revision after deletion.
    pub revision: u64,
}

#[utoipa::path(
    get, path = "/v2/workspace/material-library",
    responses(
        (status = 200, description = "Built-in and user material entries with catalog revision", body = MaterialLibraryResource),
        (status = 500, description = "Material catalog storage is unavailable", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "workspace"
)]
pub async fn list_materials() -> Result<Json<MaterialLibraryResource>, ApiError> {
    run(list_at).await.map(Json)
}

#[utoipa::path(
    post, path = "/v2/workspace/material-library",
    request_body = MaterialLibraryWriteRequest,
    responses(
        (status = 201, description = "User material created", body = MaterialLibraryMutationResource),
        (status = 400, description = "Invalid material document", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Material identity already exists or is read-only", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Material catalog storage is unavailable", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "workspace"
)]
pub async fn create_material(
    request: Result<Json<MaterialLibraryWriteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MaterialLibraryMutationResource>), ApiError> {
    let request = json_request(request)?;
    let entry = run(move |db| create_at(db, request)).await?;
    Ok((StatusCode::CREATED, Json(entry)))
}

#[utoipa::path(
    put, path = "/v2/workspace/material-library/{id}",
    params(("id" = String, Path, description = "Stable custom material identity")),
    request_body = MaterialLibraryUpdateRequest,
    responses(
        (status = 200, description = "User material replaced", body = MaterialLibraryMutationResource),
        (status = 400, description = "Invalid material or revision", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Material does not exist", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale revision or read-only built-in material", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Material catalog storage is unavailable", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "workspace"
)]
pub async fn update_material(
    AxumPath(id): AxumPath<String>,
    request: Result<Json<MaterialLibraryUpdateRequest>, JsonRejection>,
) -> Result<Json<MaterialLibraryMutationResource>, ApiError> {
    let request = json_request(request)?;
    run(move |db| update_at(db, &id, request)).await.map(Json)
}

#[utoipa::path(
    delete, path = "/v2/workspace/material-library/{id}",
    params(("id" = String, Path, description = "Stable custom material identity")),
    request_body = MaterialLibraryDeleteRequest,
    responses(
        (status = 200, description = "Material deleted and catalog revision advanced", body = MaterialLibraryDeleteResource),
        (status = 400, description = "Invalid material identity or revision", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Material does not exist", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale revision or read-only built-in material", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Material catalog storage is unavailable", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "workspace"
)]
pub async fn delete_material(
    AxumPath(id): AxumPath<String>,
    request: Result<Json<MaterialLibraryDeleteRequest>, JsonRejection>,
) -> Result<Json<MaterialLibraryDeleteResource>, ApiError> {
    let request = json_request(request)?;
    run(move |db| delete_at(db, &id, request)).await.map(Json)
}

fn json_request<T>(request: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    request.map(|Json(value)| value).map_err(|error| {
        ApiError::bad_request(format!("invalid material library request: {error}"))
    })
}

async fn run<T: Send + 'static>(
    body: impl FnOnce(&Path) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let db = fullmag_workspace::default_database_path()
        .map_err(|error| {
            ApiError::internal(format!(
                "cannot resolve material library directory: {error}"
            ))
        })?
        .with_file_name("material-library.sqlite3");
    tokio::task::spawn_blocking(move || body(&db))
        .await
        .map_err(|error| ApiError::internal(format!("material library task failed: {error}")))?
}

pub(crate) fn list_at(db: &Path) -> Result<MaterialLibraryResource, ApiError> {
    MaterialLibraryStore::open(db)
        .map_err(map_error)?
        .list()
        .map_err(map_error)
}

pub(crate) fn create_at(
    db: &Path,
    request: MaterialLibraryWriteRequest,
) -> Result<MaterialLibraryMutationResource, ApiError> {
    MaterialLibraryStore::open(db)
        .map_err(map_error)?
        .create_with_revision(request)
        .map_err(map_error)
}

pub(crate) fn update_at(
    db: &Path,
    id: &str,
    request: MaterialLibraryUpdateRequest,
) -> Result<MaterialLibraryMutationResource, ApiError> {
    MaterialLibraryStore::open(db)
        .map_err(map_error)?
        .update_with_revision(id, request.material, request.base_revision)
        .map_err(map_error)
}

pub(crate) fn delete_at(
    db: &Path,
    id: &str,
    request: MaterialLibraryDeleteRequest,
) -> Result<MaterialLibraryDeleteResource, ApiError> {
    let revision = MaterialLibraryStore::open(db)
        .map_err(map_error)?
        .delete(id, request.base_revision)
        .map_err(map_error)?;
    Ok(MaterialLibraryDeleteResource { revision })
}

fn map_error(error: MaterialLibraryError) -> ApiError {
    match error {
        MaterialLibraryError::Invalid(message) => ApiError::bad_request(message),
        MaterialLibraryError::NotFound(message) => ApiError::not_found(message),
        MaterialLibraryError::Conflict(message) => {
            ApiError::conflict_with_code("material_library_conflict", message)
        }
        MaterialLibraryError::Storage(error) => {
            ApiError::internal(format!("material library storage: {error}"))
        }
    }
}

#[cfg(test)]
#[path = "material_library_tests.rs"]
mod tests;

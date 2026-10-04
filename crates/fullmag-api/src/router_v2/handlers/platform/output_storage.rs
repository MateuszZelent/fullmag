use axum::{http::StatusCode, Json};
use fullmag_workspace::{OpenOutcome, Workspace};
use std::path::PathBuf;

use crate::schemas::output_storage::{
    hdf5_unavailable_reason, supported_output_formats, OutputDataFormatSchema,
    OutputStorageDefaultsRequest, OutputStorageDefaultsResource,
};
use crate::ApiError;

const DEFAULTS_KEY: &str = "output_storage.defaults.v1";

#[utoipa::path(
    get,
    path = "/v2/platform/output-storage",
    responses(
        (status = 200, description = "Resolved output storage defaults and runtime format capabilities", body = OutputStorageDefaultsResource),
        (status = 500, description = "Storage defaults could not be read"),
    ),
    tag = "platform"
)]
pub async fn get_output_storage_defaults() -> Result<Json<OutputStorageDefaultsResource>, ApiError>
{
    let settings = tokio::task::spawn_blocking(load_defaults)
        .await
        .map_err(|_| ApiError::internal("output storage defaults read task failed"))??;
    Ok(Json(resource(settings)))
}

#[utoipa::path(
    put,
    path = "/v2/platform/output-storage",
    request_body = OutputStorageDefaultsRequest,
    responses(
        (status = 200, description = "Output storage defaults saved", body = OutputStorageDefaultsResource),
        (status = 400, description = "Invalid output storage defaults"),
        (status = 500, description = "Output storage defaults could not be saved"),
    ),
    tag = "platform"
)]
pub async fn put_output_storage_defaults(
    Json(settings): Json<OutputStorageDefaultsRequest>,
) -> Result<(StatusCode, Json<OutputStorageDefaultsResource>), ApiError> {
    settings.validate().map_err(ApiError::bad_request)?;
    let saved = tokio::task::spawn_blocking(move || save_defaults(settings))
        .await
        .map_err(|_| ApiError::internal("output storage defaults write task failed"))??;
    Ok((StatusCode::OK, Json(resource(saved))))
}

fn load_defaults() -> Result<OutputStorageDefaultsRequest, ApiError> {
    let (workspace, outcome) = Workspace::open_default().map_err(|error| {
        ApiError::internal(format!("failed to open workspace defaults: {error}"))
    })?;
    if let OpenOutcome::Quarantined { backup, reason } = outcome {
        return Err(ApiError::internal(format!(
            "workspace defaults database was quarantined at {} and saved output settings were not read: {reason}",
            backup.display()
        )));
    }
    match workspace.get_kv(DEFAULTS_KEY).map_err(|error| {
        ApiError::internal(format!("failed to read output storage defaults: {error}"))
    })? {
        Some(value) => {
            let settings =
                serde_json::from_value::<OutputStorageDefaultsRequest>(value).map_err(|error| {
                    ApiError::internal(format!(
                        "saved output storage defaults are invalid: {error}"
                    ))
                })?;
            settings.validate_paths().map_err(|error| {
                ApiError::internal(format!(
                    "saved output storage defaults are invalid: {error}"
                ))
            })?;
            Ok(settings)
        }
        None => default_settings(),
    }
}

fn save_defaults(
    settings: OutputStorageDefaultsRequest,
) -> Result<OutputStorageDefaultsRequest, ApiError> {
    let (workspace, outcome) = Workspace::open_default().map_err(|error| {
        ApiError::internal(format!("failed to open workspace defaults: {error}"))
    })?;
    match outcome {
        OpenOutcome::Quarantined { backup, reason } => {
            return Err(ApiError::internal(format!(
                "workspace defaults database was quarantined at {}: {reason}",
                backup.display()
            )));
        }
        OpenOutcome::ReadOnlyNewerSchema { found, supported } => {
            return Err(ApiError::internal(format!(
                "workspace defaults database is read-only (schema {found}, supported {supported}); output settings were not saved"
            )));
        }
        OpenOutcome::Created | OpenOutcome::Ready | OpenOutcome::Migrated { .. } => {}
    }
    let value = serde_json::to_value(&settings).map_err(|error| {
        ApiError::internal(format!("failed to encode output storage defaults: {error}"))
    })?;
    workspace.set_kv(DEFAULTS_KEY, &value).map_err(|error| {
        ApiError::internal(format!("failed to save output storage defaults: {error}"))
    })?;
    Ok(settings)
}

fn default_settings() -> Result<OutputStorageDefaultsRequest, ApiError> {
    let output_parent = match std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT") {
        Some(root) => {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                return Err(ApiError::internal(
                    "FULLMAG_PROJECT_STORAGE_ROOT must be absolute to resolve output defaults",
                ));
            }
            root.join("runs").join("projects")
        }
        None => fullmag_workspace::state_dir()
            .map_err(|error| {
                ApiError::internal(format!(
                    "failed to resolve Fullmag state directory: {error}"
                ))
            })?
            .join("projects"),
    };
    let output_parent = output_parent
        .into_os_string()
        .into_string()
        .map_err(|_| ApiError::internal("resolved output storage path is not valid UTF-8"))?;
    let settings = OutputStorageDefaultsRequest {
        output_parent,
        temp_parent: None,
        data_format: OutputDataFormatSchema::Zarr,
        cleanup: Default::default(),
        existing_output: Default::default(),
    };
    settings.validate_paths().map_err(|error| {
        ApiError::internal(format!(
            "resolved output storage defaults are invalid: {error}"
        ))
    })?;
    Ok(settings)
}

fn resource(settings: OutputStorageDefaultsRequest) -> OutputStorageDefaultsResource {
    OutputStorageDefaultsResource {
        output_parent: settings.output_parent,
        temp_parent: settings.temp_parent,
        data_format: settings.data_format,
        cleanup: settings.cleanup,
        existing_output: settings.existing_output,
        supported_formats: supported_output_formats(),
        hdf5_unavailable_reason: hdf5_unavailable_reason(),
    }
}

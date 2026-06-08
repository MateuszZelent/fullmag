//! Artifact directory, file reading, and collection utilities.

use crate::error::ApiError;
use crate::session::current_artifact_dir;
use crate::types::*;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) fn collect_artifacts(
    root: &Path,
    current: &Path,
    out: &mut Vec<ArtifactEntry>,
) -> Result<(), ApiError> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if path.extension().and_then(|ext| ext.to_str()) == Some("zarr") {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .display()
                    .to_string();
                out.push(ArtifactEntry {
                    path: relative,
                    kind: "zarr".to_string(),
                    region_owned_provenance: None,
                });
                continue;
            }
            collect_artifacts(root, &path, out)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        let kind = match path.extension().and_then(|ext| ext.to_str()) {
            Some("json") => "json",
            Some("csv") => "csv",
            Some("zarr") => "zarr",
            Some("h5") => "h5",
            Some("ovf") => "ovf",
            _ => "file",
        };
        out.push(ArtifactEntry {
            path: relative,
            kind: kind.to_string(),
            region_owned_provenance: None,
        });
    }
    out.sort_by(|lhs, rhs| lhs.path.cmp(&rhs.path));
    Ok(())
}

pub(crate) fn sanitize_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.replace(['/', '\\'], "_"))
        .unwrap_or_default()
}

pub(crate) fn sanitize_artifact_relative_path(raw: &str) -> Result<PathBuf, ApiError> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err(ApiError::bad_request(
            "artifact path must be relative to the current artifact directory",
        ));
    }
    let mut sanitized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(value) => sanitized.push(value),
            std::path::Component::CurDir => {}
            _ => {
                return Err(ApiError::bad_request(
                    "artifact path must not contain '..' or root prefixes",
                ));
            }
        }
    }
    if sanitized.as_os_str().is_empty() {
        return Err(ApiError::bad_request("artifact path must not be empty"));
    }
    Ok(sanitized)
}

pub(crate) async fn require_current_live_artifact_dir(
    state: &Arc<AppState>,
) -> Result<PathBuf, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))
}

pub(crate) fn try_resolve_artifact_path(
    artifact_dir: &Path,
    raw: &str,
) -> Result<Option<PathBuf>, ApiError> {
    let relative = sanitize_artifact_relative_path(raw)?;
    let artifact_path = artifact_dir.join(relative);
    if artifact_path.exists() && artifact_path.is_file() {
        Ok(Some(artifact_path))
    } else {
        Ok(None)
    }
}

pub(crate) fn resolve_artifact_path(artifact_dir: &Path, raw: &str) -> Result<PathBuf, ApiError> {
    try_resolve_artifact_path(artifact_dir, raw)?
        .ok_or_else(|| ApiError::not_found(format!("artifact '{}' was not found", raw)))
}

pub(crate) fn read_text_artifact_value(artifact_dir: &Path, raw: &str) -> Result<String, ApiError> {
    let artifact_path = resolve_artifact_path(artifact_dir, raw)?;
    std::fs::read_to_string(&artifact_path)
        .map_err(|error| ApiError::internal(format!("failed to read artifact: {}", error)))
}

pub(crate) fn read_json_artifact_value(artifact_dir: &Path, raw: &str) -> Result<Value, ApiError> {
    let content = read_text_artifact_value(artifact_dir, raw)?;
    serde_json::from_str(&content).map_err(|error| {
        ApiError::internal(format!("failed to parse artifact '{}': {}", raw, error))
    })
}

pub(crate) fn parse_eigen_dispersion_csv(
    content: &str,
) -> Result<Vec<EigenDispersionRow>, ApiError> {
    let mut rows = Vec::new();
    for (line_number, line) in content.lines().enumerate() {
        if line_number == 0 {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let columns = trimmed.split(',').map(str::trim).collect::<Vec<_>>();
        if columns.len() != 6 {
            return Err(ApiError::internal(format!(
                "invalid eigen dispersion row {}: expected 6 columns, got {}",
                line_number + 1,
                columns.len()
            )));
        }
        let parse_u32 = |label: &str, raw: &str| {
            raw.parse::<u32>().map_err(|error| {
                ApiError::internal(format!(
                    "invalid {} value '{}' in dispersion row {}: {}",
                    label,
                    raw,
                    line_number + 1,
                    error
                ))
            })
        };
        let parse_f64 = |label: &str, raw: &str| {
            raw.parse::<f64>().map_err(|error| {
                ApiError::internal(format!(
                    "invalid {} value '{}' in dispersion row {}: {}",
                    label,
                    raw,
                    line_number + 1,
                    error
                ))
            })
        };
        rows.push(EigenDispersionRow {
            mode_index: parse_u32("mode_index", columns[0])?,
            kx: parse_f64("kx", columns[1])?,
            ky: parse_f64("ky", columns[2])?,
            kz: parse_f64("kz", columns[3])?,
            frequency_hz: parse_f64("frequency_hz", columns[4])?,
            angular_frequency_rad_per_s: parse_f64("angular_frequency_rad_per_s", columns[5])?,
        });
    }
    Ok(rows)
}

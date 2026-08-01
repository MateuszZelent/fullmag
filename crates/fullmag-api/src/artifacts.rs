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
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".autosave.json"))
        {
            out.push(stage_autosave_artifact_entry(root, &path, relative)?);
            continue;
        }
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

fn stage_autosave_artifact_entry(
    _root: &Path,
    _path: &Path,
    relative: String,
) -> Result<ArtifactEntry, ApiError> {
    Ok(ArtifactEntry {
        path: relative,
        kind: "stage_autosave".into(),
        region_owned_provenance: None,
    })
}

pub(crate) fn read_stage_autosave_metadata(
    path: &Path,
) -> Result<StageAutosaveArtifactMetadata, ApiError> {
    let value: Value = serde_json::from_slice(&std::fs::read(path)?).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse stage autosave artifact manifest '{}': {error}",
            path.display()
        ))
    })?;
    let target = value
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let format = value
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let layout = value
        .get("layout")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let extension = match format {
        "zarr" => "zarr",
        "hdf5" => "h5",
        "txt" => "txt",
        _ => "",
    };
    let stages = value
        .get("stages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|stage| {
            let complete = stage
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let stage_id = stage
                .get("stage_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stage_index = stage
                .get("stage_index")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            StageAutosaveArtifactStageMetadata {
                stage_id: stage_id.into(),
                stage_index,
                resource_path: if format == "txt" && layout == "separate" {
                    format!("{target}.stage_{stage_index:04}_{stage_id}.txt")
                } else if extension.is_empty() {
                    target.into()
                } else {
                    format!("{target}.{extension}")
                },
                download_path: match format {
                    "txt" if layout == "separate" => {
                        Some(format!("{target}.stage_{stage_index:04}_{stage_id}.txt"))
                    }
                    "txt" => Some(format!("{target}.txt")),
                    "hdf5" => Some(format!("{target}.h5")),
                    _ => None,
                },
                status: if complete { "completed" } else { "in_progress" }.into(),
                complete,
                table_quantities: string_array(stage.get("table_quantities")),
                field_quantities: string_array(stage.get("field_quantities")),
                table_sample_count: stage
                    .get("table_sample_count")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                field_sample_count: stage
                    .get("field_sample_count")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            }
        })
        .collect();
    Ok(StageAutosaveArtifactMetadata {
        schema_version: value
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .into(),
        target: target.into(),
        format: format.into(),
        layout: layout.into(),
        resource_path: if extension.is_empty() {
            target.into()
        } else {
            format!("{target}.{extension}")
        },
        download_path: match format {
            "txt" if layout == "continuous" => Some(format!("{target}.txt")),
            "hdf5" => Some(format!("{target}.h5")),
            _ => None,
        },
        stages,
    })
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
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
    let Some((header_line_number, header_line)) = content
        .lines()
        .enumerate()
        .find(|(_, line)| !line.trim().is_empty())
    else {
        return Ok(Vec::new());
    };
    let headers = header_line.split(',').map(str::trim).collect::<Vec<_>>();
    let find_column = |labels: &[&str]| {
        labels
            .iter()
            .find_map(|label| headers.iter().position(|header| header == label))
            .ok_or_else(|| {
                ApiError::internal(format!(
                    "invalid eigen dispersion header: missing {}",
                    labels.join(" or ")
                ))
            })
    };
    let mode_index_col = find_column(&["mode_index", "raw_mode_index"])?;
    let kx_col = find_column(&["kx", "kx_rad_per_m"])?;
    let ky_col = find_column(&["ky", "ky_rad_per_m"])?;
    let kz_col = find_column(&["kz", "kz_rad_per_m"])?;
    let frequency_col = find_column(&["frequency_hz"])?;
    let angular_frequency_col = find_column(&["angular_frequency_rad_per_s", "omega_rad_s"])?;

    let mut rows = Vec::new();
    for (line_number, line) in content.lines().enumerate() {
        if line_number <= header_line_number {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let columns = trimmed.split(',').map(str::trim).collect::<Vec<_>>();
        let column = |label: &str, index: usize| {
            columns.get(index).copied().ok_or_else(|| {
                ApiError::internal(format!(
                    "invalid eigen dispersion row {}: missing {} column value",
                    line_number + 1,
                    label
                ))
            })
        };
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
            mode_index: parse_u32("mode_index", column("mode_index", mode_index_col)?)?,
            kx: parse_f64("kx", column("kx", kx_col)?)?,
            ky: parse_f64("ky", column("ky", ky_col)?)?,
            kz: parse_f64("kz", column("kz", kz_col)?)?,
            frequency_hz: parse_f64("frequency_hz", column("frequency_hz", frequency_col)?)?,
            angular_frequency_rad_per_s: parse_f64(
                "angular_frequency_rad_per_s",
                column("angular_frequency_rad_per_s", angular_frequency_col)?,
            )?,
        });
    }
    Ok(rows)
}

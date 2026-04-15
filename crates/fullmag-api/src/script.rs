//! Script builder, Python helper invocation, and magnetization state IO.

use crate::error::ApiError;
use crate::types::*;
use crate::ReadMagnetizationStateHelperResponse;
use fullmag_authoring::{
    scene_document_from_script_builder, scene_document_problem_projection,
    scene_document_to_script_builder, SceneDocument, ScriptBuilderState,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

pub(crate) fn repo_root() -> PathBuf {
    if let Some(root) = std::env::var_os("FULLMAG_REPO_ROOT") {
        return PathBuf::from(root);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate dir should have parent")
        .parent()
        .expect("workspace root should exist")
        .to_path_buf()
}

pub(crate) fn rewrite_script_via_python_helper(
    repo_root: &Path,
    workspace_root: &Path,
    script_path: &Path,
    overrides: Option<&Value>,
) -> Result<ScriptSyncResponse, ApiError> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "rewrite-script".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
        "--write".to_string(),
    ];

    let overrides_path = if let Some(overrides) = overrides {
        std::fs::create_dir_all(workspace_root).map_err(|error| {
            ApiError::internal(format!("failed to prepare workspace: {}", error))
        })?;
        let path = workspace_root.join(format!("script-sync-{}.json", uuid_v4_hex()));
        let body = serde_json::to_string_pretty(overrides).map_err(|error| {
            ApiError::internal(format!("failed to serialize overrides: {}", error))
        })?;
        std::fs::write(&path, body).map_err(|error| {
            ApiError::internal(format!("failed to persist overrides: {}", error))
        })?;
        helper_args.push("--overrides-json".to_string());
        helper_args.push(path.display().to_string());
        Some(path)
    } else {
        None
    };

    let output = run_python_helper(repo_root, &helper_args);
    if let Some(path) = overrides_path {
        let _ = std::fs::remove_file(path);
    }
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python rewrite helper failed: {}",
            stderr.trim()
        )));
    }

    serde_json::from_slice::<ScriptSyncResponse>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize rewrite helper response: {}",
            error
        ))
    })
}

pub(crate) fn load_script_builder_state(
    repo_root: &Path,
    _workspace_root: &Path,
    script_path: &Path,
) -> Result<ScriptBuilderState, ApiError> {
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-builder-draft".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    let output = run_python_helper(repo_root, &helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python builder helper failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<ScriptBuilderState>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize builder draft response: {}",
            error
        ))
    })
}

pub(crate) fn load_scene_document_state(
    repo_root: &Path,
    workspace_root: &Path,
    script_path: &Path,
) -> Result<SceneDocument, ApiError> {
    let builder = load_script_builder_state(repo_root, workspace_root, script_path)?;
    Ok(scene_document_from_script_builder(&builder))
}

pub(crate) fn scene_document_builder_projection(
    scene_document: &SceneDocument,
) -> Result<ScriptBuilderState, ApiError> {
    scene_document_to_script_builder(scene_document)
        .map_err(|error| ApiError::bad_request(error.message))
}

pub(crate) fn scene_document_overrides(scene_document: &SceneDocument) -> Result<Value, ApiError> {
    Ok(scene_document_problem_projection(scene_document)
        .map_err(|error| ApiError::bad_request(error.message))?
        .rewrite_overrides)
}

pub(crate) fn read_magnetization_state_with_python(
    repo_root: &Path,
    path: &Path,
    format: Option<&str>,
    dataset: Option<&str>,
    sample_index: Option<i64>,
) -> Result<ReadMagnetizationStateHelperResponse, ApiError> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "read-magnetization-state".to_string(),
        "--path".to_string(),
        path.display().to_string(),
    ];
    if let Some(format) = format {
        helper_args.push("--format".to_string());
        helper_args.push(format.to_string());
    }
    if let Some(dataset) = dataset {
        helper_args.push("--dataset".to_string());
        helper_args.push(dataset.to_string());
    }
    if let Some(sample_index) = sample_index {
        helper_args.push("--sample".to_string());
        helper_args.push(sample_index.to_string());
    }

    let output = run_python_helper(repo_root, &helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(format!(
            "python magnetization-state reader failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<ReadMagnetizationStateHelperResponse>(&output.stdout).map_err(
        |error| {
            ApiError::internal(format!(
                "failed to deserialize state reader output: {}",
                error
            ))
        },
    )
}

pub(crate) fn convert_magnetization_state_with_python(
    repo_root: &Path,
    input_path: &Path,
    output_path: &Path,
    input_format: Option<&str>,
    output_format: Option<&str>,
    input_dataset: Option<&str>,
    output_dataset: Option<&str>,
    sample_index: Option<i64>,
) -> Result<(), ApiError> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "convert-magnetization-state".to_string(),
        "--input-path".to_string(),
        input_path.display().to_string(),
        "--output-path".to_string(),
        output_path.display().to_string(),
    ];
    if let Some(input_format) = input_format {
        helper_args.push("--input-format".to_string());
        helper_args.push(input_format.to_string());
    }
    if let Some(output_format) = output_format {
        helper_args.push("--output-format".to_string());
        helper_args.push(output_format.to_string());
    }
    if let Some(input_dataset) = input_dataset {
        helper_args.push("--input-dataset".to_string());
        helper_args.push(input_dataset.to_string());
    }
    if let Some(output_dataset) = output_dataset {
        helper_args.push("--output-dataset".to_string());
        helper_args.push(output_dataset.to_string());
    }
    if let Some(sample_index) = sample_index {
        helper_args.push("--sample".to_string());
        helper_args.push(sample_index.to_string());
    }

    let output = run_python_helper(repo_root, &helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(format!(
            "python magnetization-state converter failed: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

pub(crate) fn run_python_helper(
    repo_root: &Path,
    args: &[String],
) -> Result<std::process::Output, ApiError> {
    let local_python = repo_root
        .join(".fullmag")
        .join("local")
        .join("python")
        .join("bin")
        .join("python");
    let repo_python = repo_root.join(".venv").join("bin").join("python");
    let mut candidates = Vec::new();

    if let Ok(preferred) = std::env::var("FULLMAG_PYTHON") {
        candidates.push(preferred);
    } else {
        for candidate in [local_python, repo_python] {
            if candidate.is_file() {
                candidates.push(candidate.display().to_string());
            }
        }
    }
    for fallback in ["python3", "python"] {
        if !candidates.iter().any(|candidate| candidate == fallback) {
            candidates.push(fallback.to_string());
        }
    }

    let pythonpath = repo_root.join("packages").join("fullmag-py").join("src");
    let fem_mesh_cache_dir = repo_root
        .join(".fullmag")
        .join("local")
        .join("cache")
        .join("fem_mesh_assets");
    let inherited_pythonpath = std::env::var("PYTHONPATH").ok();
    let mut last_error = None;

    for candidate in candidates {
        let mut command = ProcessCommand::new(&candidate);
        command.args(args);
        command.env("PYTHONUNBUFFERED", "1");
        command.env("FULLMAG_FEM_MESH_CACHE_DIR", &fem_mesh_cache_dir);
        if pythonpath.exists() {
            let mut merged = pythonpath.display().to_string();
            if let Some(existing) = &inherited_pythonpath {
                if !existing.is_empty() {
                    merged.push(':');
                    merged.push_str(existing);
                }
            }
            command.env("PYTHONPATH", merged);
        }

        match command.output() {
            Ok(output) => return Ok(output),
            Err(error) => {
                last_error = Some(format!("{}: {}", candidate, error));
            }
        }
    }

    Err(ApiError::internal(format!(
        "failed to spawn python helper ({})",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::{parse_eigen_dispersion_csv, sanitize_artifact_relative_path};
    use axum::http::StatusCode;

    #[test]
    fn sanitize_artifact_relative_path_rejects_parent_segments() {
        let error = sanitize_artifact_relative_path("../secret.json")
            .expect_err("parent segments must be rejected");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_eigen_dispersion_csv_decodes_rows() {
        let csv =
            "mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n0,0.0,1.0,2.0,3.0,4.0\n";
        let rows = parse_eigen_dispersion_csv(csv).expect("csv should parse");
        assert_eq!(
            rows,
            vec![EigenDispersionRow {
                mode_index: 0,
                kx: 0.0,
                ky: 1.0,
                kz: 2.0,
                frequency_hz: 3.0,
                angular_frequency_rad_per_s: 4.0,
            }]
        );
    }

    #[test]
    fn parse_eigen_dispersion_csv_rejects_short_rows() {
        let error = parse_eigen_dispersion_csv(
            "mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n0,1,2\n",
        )
        .expect_err("short rows must fail");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn script_builder_state_deserializes_mesh_without_adaptive_fields() {
        let builder: ScriptBuilderState = serde_json::from_value(serde_json::json!({
            "revision": 1,
            "solver": {
                "integrator": "rk45",
                "fixed_timestep": "",
                "relax_algorithm": "llg_overdamped",
                "torque_tolerance": "1e-4",
                "energy_tolerance": "",
                "max_relax_steps": "1000"
            },
            "mesh": {
                "algorithm_2d": 6,
                "algorithm_3d": 1,
                "hmax": "",
                "hmin": "",
                "size_factor": 1.0,
                "size_from_curvature": 0,
                "smoothing_steps": 1,
                "optimize": "",
                "optimize_iterations": 1,
                "compute_quality": false,
                "per_element_quality": false
            },
            "geometries": []
        }))
        .expect("builder draft without adaptive fields should deserialize");

        assert!(!builder.mesh.adaptive_enabled);
        assert_eq!(builder.mesh.adaptive_policy, "manual");
        assert_eq!(builder.mesh.adaptive_theta, 0.3);
        assert_eq!(builder.mesh.adaptive_max_passes, 5);
        assert_eq!(builder.mesh.growth_rate, "");
        assert_eq!(builder.mesh.narrow_regions, 0);
    }
}

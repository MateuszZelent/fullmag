//! Script builder and Python helper invocation.

use crate::error::ApiError;
use crate::types::*;
use fullmag_authoring::{
    SceneDocument, ScriptBuilderState, scene_document_problem_projection,
    scene_document_to_script_builder,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Arc;

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

pub(crate) async fn sync_current_live_script_with_request(
    state: &Arc<AppState>,
    req: ScriptSyncRequest,
) -> Result<ScriptSyncResponse, ApiError> {
    let (script_path, scene_document) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let script_path = snapshot.session.script_path.trim();
        if script_path.is_empty() {
            return Err(ApiError::bad_request(
                "active local live workspace does not expose a script path",
            ));
        }
        (PathBuf::from(script_path), snapshot.scene_document.clone())
    };

    if !script_path.is_file() {
        return Err(ApiError::bad_request(format!(
            "script path does not exist: {}",
            script_path.display()
        )));
    }

    let overrides = if let Some(overrides) = req.overrides.clone() {
        Some(overrides)
    } else if let Some(scene_document) = scene_document.as_ref() {
        Some(scene_document_overrides(scene_document)?)
    } else {
        None
    };
    eprintln!(
        "[fullmag-api] RX <- frontend script sync {}",
        script_path.display()
    );
    let response = rewrite_script_via_python_helper(
        &state.repo_root,
        &state.current_workspace_root,
        &script_path,
        overrides.as_ref(),
    )?;
    eprintln!(
        "[fullmag-api] TX -> frontend script sync ok {}",
        response.script_path
    );
    Ok(response)
}

pub(crate) async fn get_current_live_script_source(
    state: &Arc<AppState>,
) -> Result<ScriptSourceResponse, ApiError> {
    let script_path = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let script_path = snapshot.session.script_path.trim();
        if script_path.is_empty() {
            return Err(ApiError::bad_request(
                "active local live workspace does not expose a script path",
            ));
        }
        PathBuf::from(script_path)
    };

    if !script_path.is_file() {
        return Err(ApiError::bad_request(format!(
            "script path does not exist: {}",
            script_path.display()
        )));
    }

    let source = std::fs::read_to_string(&script_path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read current live script '{}': {}",
            script_path.display(),
            error
        ))
    })?;

    Ok(ScriptSourceResponse {
        script_path: script_path.display().to_string(),
        bytes: source.len(),
        source,
    })
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

pub(crate) fn load_scene_document_state(
    repo_root: &Path,
    _workspace_root: &Path,
    script_path: &Path,
) -> Result<SceneDocument, ApiError> {
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-scene-document".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    let output = run_python_helper(repo_root, &helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python scene document helper failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<SceneDocument>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize scene document response: {}",
            error
        ))
    })
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

pub(crate) fn python_executable(repo_root: &Path) -> String {
    if let Ok(preferred) = std::env::var("FULLMAG_PYTHON") {
        return preferred;
    }
    let real_root = if repo_root.join("packages/fullmag-py/src/fullmag").exists() {
        repo_root.to_path_buf()
    } else {
        self::repo_root()
    };
    let local_python = real_root
        .join(".fullmag")
        .join("local")
        .join("python")
        .join("bin")
        .join("python");
    if local_python.is_file() {
        return local_python.display().to_string();
    }
    let repo_python = real_root.join(".venv").join("bin").join("python");
    if repo_python.is_file() {
        return repo_python.display().to_string();
    }
    "python3".to_string()
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

    #[test]
    fn load_scene_document_state_preserves_script_object_regions() {
        let root = repo_root();
        let script_path = root.join("examples/permalloy_box_relax_300x1000x10nm.py");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("permalloy script should export a scene document");
        let object = scene
            .objects
            .iter()
            .find(|object| object.id == "permalloy_box")
            .expect("permalloy_box object should be exported");
        let region = object
            .regions
            .iter()
            .find(|region| region.name == "hole_refinement")
            .expect("hole_refinement region should be exported");

        assert_eq!(region.region_id, "permalloy_box:r1");
        assert_eq!(region.owner_object, "permalloy_box");
        assert_eq!(
            region.realization_policy,
            fullmag_authoring::SceneRegionRealizationPolicy::Inherit
        );
        assert_eq!(
            region
                .mesh_policy
                .as_ref()
                .expect("hole_refinement region should include mesh policy")
                .maximum_element_size,
            Some(5.0e-9)
        );
    }
}

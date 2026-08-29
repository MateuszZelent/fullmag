//! Script builder and Python helper invocation.

use crate::error::ApiError;
use crate::types::*;
use fullmag_authoring::{
    scene_document_problem_projection, scene_document_to_script_builder, SceneDocument,
    ScriptBuilderState,
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
    let workspace_root = state.current_workspace_root.clone();
    let (script_path, scene_document, has_input_script) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let authored_script_path = snapshot.session.script_path.trim();
        let has_input_script = !authored_script_path.is_empty();
        let script_path = if has_input_script {
            PathBuf::from(authored_script_path)
        } else {
            workspace_root.join("scene_document.py")
        };
        (
            script_path,
            snapshot.scene_document.clone(),
            has_input_script,
        )
    };

    eprintln!(
        "[fullmag-api] RX <- frontend script sync {}",
        script_path.display()
    );
    let response = if has_input_script {
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
        rewrite_script_via_python_helper(
            &state.repo_root,
            &workspace_root,
            &script_path,
            overrides.as_ref(),
        )?
    } else {
        let scene_document = scene_document.as_ref().ok_or_else(|| {
            ApiError::bad_request(
                "scratch workspace has no SceneDocument to render as a canonical script",
            )
        })?;
        render_scene_document_via_python_helper(
            &state.repo_root,
            &workspace_root,
            &script_path,
            scene_document,
        )?
    };
    if !has_input_script {
        let mut current = state.current_live_state.write().await;
        if let Some(snapshot) = current.as_mut() {
            if snapshot.session.script_path.trim().is_empty() {
                snapshot.session.script_path = response.script_path.clone();
            }
        }
    }
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

pub(crate) fn render_scene_document_via_python_helper(
    repo_root: &Path,
    workspace_root: &Path,
    output_path: &Path,
    scene_document: &SceneDocument,
) -> Result<ScriptSyncResponse, ApiError> {
    std::fs::create_dir_all(workspace_root)
        .map_err(|error| ApiError::internal(format!("failed to prepare workspace: {}", error)))?;
    let scene_path = workspace_root.join(format!("scene-export-{}.json", uuid_v4_hex()));
    let scene_body = serde_json::to_string_pretty(scene_document).map_err(|error| {
        ApiError::internal(format!("failed to serialize SceneDocument: {}", error))
    })?;
    std::fs::write(&scene_path, scene_body).map_err(|error| {
        ApiError::internal(format!("failed to persist SceneDocument: {}", error))
    })?;
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "render-scene-document".to_string(),
        "--scene-json".to_string(),
        scene_path.display().to_string(),
        "--output".to_string(),
        output_path.display().to_string(),
    ];
    let output = run_python_helper(repo_root, &helper_args);
    let _ = std::fs::remove_file(&scene_path);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python SceneDocument render helper failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<ScriptSyncResponse>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize SceneDocument render response: {}",
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
        repo_root
    } else {
        &self::repo_root()
    };
    if let Some(candidate) = python_path_candidates(real_root)
        .into_iter()
        .find(|candidate| candidate.is_file())
    {
        return candidate.display().to_string();
    }
    "python3".to_string()
}

pub(crate) fn run_python_helper(
    repo_root: &Path,
    args: &[String],
) -> Result<std::process::Output, ApiError> {
    let real_root = if repo_root.join("packages/fullmag-py/src/fullmag").exists() {
        repo_root.to_path_buf()
    } else {
        self::repo_root()
    };
    let mut candidates = Vec::new();

    if let Ok(preferred) = std::env::var("FULLMAG_PYTHON") {
        candidates.push(preferred);
    } else {
        for candidate in python_path_candidates(&real_root) {
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

    let pythonpath = real_root.join("packages").join("fullmag-py").join("src");
    let python_extension_root = real_root.join(".fullmag").join("local");
    let fem_mesh_cache_dir = real_root
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
                    merged.push(if cfg!(windows) { ';' } else { ':' });
                    merged.push_str(existing);
                }
            }
            if python_extension_root.is_dir() {
                merged.push(if cfg!(windows) { ';' } else { ':' });
                merged.push_str(&python_extension_root.display().to_string());
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

fn python_path_candidates(repo_root: &Path) -> Vec<PathBuf> {
    vec![
        repo_root
            .join(".fullmag")
            .join("local")
            .join("python")
            .join("bin")
            .join("python"),
        repo_root
            .join(".fullmag")
            .join("local")
            .join("python")
            .join("python.exe"),
        repo_root.join(".venv").join("bin").join("python"),
        repo_root.join(".venv").join("Scripts").join("python.exe"),
        repo_root
            .join("packages")
            .join("fullmag-py")
            .join(".venv")
            .join("bin")
            .join("python"),
        repo_root
            .join("packages")
            .join("fullmag-py")
            .join(".venv")
            .join("Scripts")
            .join("python.exe"),
    ]
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
    fn parse_eigen_dispersion_csv_decodes_canonical_v2_rows() {
        let csv = "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score\n3,1.0,1.0,2.0,3.0,X,7,4,1500000000.0,9424777960.77,0.0,1e-9,0.99\n";
        let rows = parse_eigen_dispersion_csv(csv).expect("csv should parse");
        assert_eq!(
            rows,
            vec![EigenDispersionRow {
                mode_index: 7,
                kx: 1.0,
                ky: 2.0,
                kz: 3.0,
                frequency_hz: 1.5e9,
                angular_frequency_rad_per_s: 9424777960.77,
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
    fn planar_monitor_round_trip_survives_api_scene_projection() {
        let scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": 7,
            "monitors": {
                "planar": [{
                    "id": "domain-plane",
                    "name": "Domain plane",
                    "target": {"kind": "domain"},
                    "frame": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "u_axis": [1.0, 0.0, 0.0],
                        "v_axis": [0.0, 1.0, 0.0],
                        "normal": [0.0, 0.0, 1.0],
                        "preset": "xy",
                        "normalization_version": "planar_frame_v1",
                        "extent": {"kind": "universe", "padding_m": 0.0}
                    },
                    "operator": {
                        "kind": "depth_projection",
                        "reduction": "mean_occupied",
                        "empty_policy": "exclude_empty"
                    }
                }]
            }
        }))
        .expect("planar scene should deserialize");

        let builder =
            scene_document_builder_projection(&scene).expect("scene projection should validate");
        let overrides = scene_document_overrides(&scene).expect("overrides should build");

        assert_eq!(builder.revision, 7);
        assert_eq!(builder.planar_monitors, scene.monitors.planar);
        assert_eq!(
            overrides["planar_monitors"][0]["id"],
            serde_json::json!("domain-plane")
        );
        assert!(overrides["planar_monitors"][0].get("quantity").is_none());
        assert!(overrides["planar_monitors"][0].get("resolution").is_none());
    }

    #[test]
    fn load_scene_document_state_preserves_script_object_regions() {
        let root = repo_root();
        let script_path =
            std::env::temp_dir().join(format!("fullmag-region-export-{}.py", uuid_v4_hex()));
        std::fs::write(
            &script_path,
            r#"
import fullmag as fm

study = fm.study("region_export")
study.engine("fem")
body = study.geometry(
    fm.Box(300e-9, 1000e-9, 30e-9) - fm.Cylinder(radius=40e-9, height=30e-9),
    name="permalloy_box",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.mesh(minimum_element_size=8e-9, maximum_element_size=50e-9, order=1)
hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=70e-9, height=30e-9),
    priority=10,
    realization_policy="conformal",
)
hole_refinement.mesh(minimum_element_size=0.5e-9, maximum_element_size=1e-9, order=1)
"#,
        )
        .expect("failed to write region export fixture");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("permalloy script should export a scene document");
        let _ = std::fs::remove_file(&script_path);
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
            fullmag_authoring::SceneRegionRealizationPolicy::Conformal
        );
        assert_eq!(
            region
                .mesh_policy
                .as_ref()
                .expect("hole_refinement region should include mesh policy")
                .maximum_element_size,
            Some(1.0e-9)
        );
    }

    #[test]
    fn load_scene_document_state_accepts_frequency_response_stage() {
        let root = repo_root();
        let script_path = root.join("examples/fem_frequency_response_smoke.py");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("frequency-response script should export a scene document");

        assert!(
            scene
                .study
                .stages
                .iter()
                .any(|stage| stage.kind == "frequency_response"),
            "scene document should preserve the frequency_response stage"
        );
        let pipeline = scene
            .study
            .study_pipeline
            .as_ref()
            .expect("frequency-response scene should include a study pipeline");
        assert!(
            pipeline.nodes.iter().any(|node| {
                matches!(
                    node,
                    fullmag_authoring::StudyPipelineNode::Primitive(stage)
                        if stage.stage_kind
                            == fullmag_authoring::StudyPrimitiveStageKind::FrequencyResponse
                )
            }),
            "study pipeline should deserialize frequency_response primitive stage"
        );
    }

    #[test]
    fn load_scene_document_state_accepts_change_device_stage() {
        let root = repo_root();
        let script_path =
            std::env::temp_dir().join(format!("fullmag-change-device-{}.py", uuid_v4_hex()));
        std::fs::write(
            &script_path,
            r#"
import fullmag as fm

study = fm.study("stage_change_device")
study.engine("fem")
study.device("gpu", precision="double")
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.1
body.m = fm.texture.uniform(1, 0, 0)
study.stages.add_relax(max_steps=25, dt=1e-15)
study.stages.change_device("cpu")
study.stages.add_eigenmodes(count=4)
"#,
        )
        .expect("failed to write change-device fixture");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("change-device script should export a scene document");
        let _ = std::fs::remove_file(&script_path);

        let pipeline = scene
            .study
            .study_pipeline
            .as_ref()
            .expect("change-device scene should include a study pipeline");
        assert!(
            pipeline.nodes.iter().any(|node| {
                matches!(
                    node,
                    fullmag_authoring::StudyPipelineNode::Primitive(stage)
                        if stage.stage_kind
                            == fullmag_authoring::StudyPrimitiveStageKind::ChangeDevice
                            && stage
                                .payload
                                .get("device")
                                .and_then(|value| value.as_str())
                                == Some("cpu")
                )
            }),
            "study pipeline should deserialize change_device primitive stage"
        );
    }
}

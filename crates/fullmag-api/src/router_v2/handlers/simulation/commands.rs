//! POST /v2/sessions/current/simulation/commands — submit a command.

use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::commands::{
    CommandResponse, RuntimeCommandIntent, RuntimeCommandTarget, StructuredCommandRequest,
};
use crate::types::{AppState, CommandLifecycleState, SessionCommand, TrackedCommandRecord};
use fullmag_authoring::{
    geometry_blocks_solver_run, realize_geometry_scene, GeometryBackendTarget,
    GeometryRealizationSnapshot, SceneDocument, SceneObject,
};
use fullmag_ir::{GeometryEntryIR, InitialMagnetizationIR, MagnetIR, MaterialIR, RegionIR};

const MU0_T_PER_APM: f64 = 4.0 * std::f64::consts::PI * 1.0e-7;

#[utoipa::path(
    post,
    path = "/v2/sessions/current/simulation/commands",
    request_body = StructuredCommandRequest,
    responses(
        (status = 200, description = "Command accepted", body = CommandResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn submit_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<StructuredCommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    let response = submit_structured_command_impl(state, &headers, req).await?;
    Ok(Json(response))
}

pub(crate) async fn submit_structured_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    mut req: StructuredCommandRequest,
) -> Result<CommandResponse, ApiError> {
    if let Some((scene, realization)) = validate_authoring_gate_for_command(&state, &req).await? {
        attach_geometry_realization_to_mesh_request(&mut req, &scene, &realization)?;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let command_id = format!("fm-{}", uuid::Uuid::new_v4());
    let command = command_from_structured(req, command_id, now);
    validate_runtime_command_contract(&state, &command).await?;
    enqueue_session_command_impl(state, headers, command).await
}

async fn validate_runtime_command_contract(
    state: &Arc<AppState>,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let snapshot = {
        let guard = state.current_live_state.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?
    };

    if let Some(precondition) = command.precondition.as_ref() {
        let runtime_state = runtime_state_for_command_validation(&snapshot);
        if precondition
            .runtime_state
            .as_deref()
            .is_some_and(|expected| expected != runtime_state)
        {
            return Err(ApiError::conflict(format!(
                "runtime_state precondition failed: expected {}, got {}",
                precondition.runtime_state.as_deref().unwrap_or_default(),
                runtime_state
            )));
        }

        if let Some(expected) = precondition.stage_execution_revision {
            if snapshot.stage_execution.is_none() || snapshot.state_version != expected {
                return Err(ApiError::conflict(format!(
                    "stage_execution_revision precondition failed: expected {}, got {}",
                    expected,
                    if snapshot.stage_execution.is_some() {
                        snapshot.state_version
                    } else {
                        0
                    }
                )));
            }
        }

        if let Some(expected) = precondition.mesh_revision {
            if snapshot.mesh_revision != expected {
                return Err(ApiError::conflict(format!(
                    "mesh_revision precondition failed: expected {}, got {}",
                    expected, snapshot.mesh_revision
                )));
            }
        }

        if let Some(expected) = precondition.scene_revision {
            let actual = snapshot.scene_document.as_ref().map(|scene| scene.revision);
            if actual != Some(expected) {
                return Err(ApiError::conflict(format!(
                    "scene_revision precondition failed: expected {}, got {}",
                    expected,
                    actual
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "missing".to_string())
                )));
            }
        }

        if let Some(expected) = precondition.command_revision {
            let actual = state.current_command_ledger.lock().await.len() as u64;
            if actual != expected {
                return Err(ApiError::conflict(format!(
                    "command_revision precondition failed: expected {}, got {}",
                    expected, actual
                )));
            }
        }
    }

    if is_stage_control_command(command.kind.as_str()) {
        validate_stage_control_state(&snapshot, command)?;
        validate_stage_control_target(&snapshot, command)?;
    }

    Ok(())
}

fn is_stage_control_command(kind: &str) -> bool {
    matches!(kind, "pause" | "resume" | "stop" | "skip")
}

fn validate_stage_control_state(
    snapshot: &crate::types::SessionStateResponse,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let runtime_state = runtime_state_for_command_validation(snapshot);
    let allowed = match command.kind.as_str() {
        "pause" => runtime_state == "running",
        "resume" => runtime_state == "paused",
        "stop" => runtime_state == "running" || runtime_state == "paused",
        "skip" => runtime_state == "running" || runtime_state == "paused",
        _ => true,
    };
    if !allowed {
        return Err(ApiError::conflict(format!(
            "{} command requires a compatible runtime state; got {}",
            command.kind, runtime_state
        )));
    }

    if command.kind == "skip" && active_stage_index(snapshot).is_none() {
        return Err(ApiError::conflict(
            "skip command requires an active stage target",
        ));
    }

    Ok(())
}

fn validate_stage_control_target(
    snapshot: &crate::types::SessionStateResponse,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let active_index = active_stage_index(snapshot);
    let Some(target) = command.target.as_ref() else {
        return Ok(());
    };

    match target {
        RuntimeCommandTarget::CurrentStage { stage_id } => {
            validate_current_stage_target(active_index, stage_id.as_deref())
        }
        RuntimeCommandTarget::StageIndex { stage_index } => {
            validate_stage_index_target(active_index, *stage_index)
        }
        RuntimeCommandTarget::StageId { stage_id } => {
            validate_current_stage_target(active_index, Some(stage_id.as_str()))
        }
        RuntimeCommandTarget::Study
        | RuntimeCommandTarget::Run { .. }
        | RuntimeCommandTarget::CommandId { .. } => Err(ApiError::conflict(format!(
            "{} command target must reference the active stage",
            command.kind
        ))),
    }
}

fn validate_current_stage_target(
    active_index: Option<usize>,
    stage_id: Option<&str>,
) -> Result<(), ApiError> {
    let Some(active_index) = active_index else {
        return Err(ApiError::conflict(
            "stage control command requires an active stage",
        ));
    };
    if let Some(stage_id) = stage_id {
        let expected = stage_id_for_command_validation(active_index);
        if stage_id != expected {
            return Err(ApiError::conflict(format!(
                "stage target mismatch: expected {}, got {}",
                expected, stage_id
            )));
        }
    }
    Ok(())
}

fn validate_stage_index_target(
    active_index: Option<usize>,
    requested_index: u32,
) -> Result<(), ApiError> {
    let Some(active_index) = active_index else {
        return Err(ApiError::conflict(
            "stage control command requires an active stage",
        ));
    };
    if active_index as u32 != requested_index {
        return Err(ApiError::conflict(format!(
            "stage target mismatch: expected stage_index {}, got {}",
            active_index, requested_index
        )));
    }
    Ok(())
}

fn active_stage_index(snapshot: &crate::types::SessionStateResponse) -> Option<usize> {
    snapshot
        .stage_execution
        .as_ref()
        .and_then(|stage| stage.active_stage_index)
}

fn runtime_state_for_command_validation(snapshot: &crate::types::SessionStateResponse) -> &str {
    snapshot
        .stage_execution
        .as_ref()
        .map(|stage| stage.runtime_state.as_str())
        .or_else(|| {
            snapshot
                .live_state
                .as_ref()
                .map(|state| state.status.as_str())
        })
        .unwrap_or(snapshot.session.status.as_str())
}

fn stage_id_for_command_validation(index: usize) -> String {
    format!("stage-{index:03}")
}

async fn validate_authoring_gate_for_command(
    state: &Arc<AppState>,
    req: &StructuredCommandRequest,
) -> Result<Option<(SceneDocument, GeometryRealizationSnapshot)>, ApiError> {
    let should_check_mesh = matches!(req, StructuredCommandRequest::MeshBuild { .. });
    let should_check_run = matches!(
        req,
        StructuredCommandRequest::Run { .. }
            | StructuredCommandRequest::Relax { .. }
            | StructuredCommandRequest::Solve { .. }
            | StructuredCommandRequest::ComputeFields { .. }
            | StructuredCommandRequest::ComputeEnergies { .. }
    );
    if !should_check_mesh && !should_check_run {
        return Ok(None);
    }
    let Some(scene) = current_authoring_gate_scene(state).await? else {
        return Ok(None);
    };
    let backend_target = GeometryBackendTarget::from_scene(&scene);
    if should_check_mesh {
        let realization = realize_geometry_scene(&scene, backend_target);
        if realization.status == "blocked" {
            let reason = realization
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.blocks.iter().any(|block| block == "build_mesh"))
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "Geometry realization is blocked.".to_string());
            return Err(ApiError::bad_request(reason));
        }
        return Ok(Some((scene, realization)));
    } else if let Some(reason) = geometry_blocks_solver_run(&scene, backend_target) {
        return Err(ApiError::conflict(reason));
    }
    Ok(None)
}

async fn current_authoring_gate_scene(
    state: &Arc<AppState>,
) -> Result<Option<fullmag_authoring::SceneDocument>, ApiError> {
    let script_path = {
        let current = state.current_live_state.read().await;
        let Some(snapshot) = current.as_ref() else {
            return Err(ApiError::not_found("no active local live workspace"));
        };
        if let Some(scene) = snapshot.scene_document.clone() {
            return Ok(Some(scene));
        }
        snapshot.session.script_path.trim().to_string()
    };

    if script_path.is_empty() || !Path::new(&script_path).is_file() {
        return Ok(None);
    }

    match crate::get_or_load_current_live_scene_document(state).await {
        Ok(scene) => Ok(Some(scene)),
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => Ok(None),
        Err(error) => Err(error),
    }
}

fn attach_geometry_realization_to_mesh_request(
    req: &mut StructuredCommandRequest,
    scene: &SceneDocument,
    realization: &GeometryRealizationSnapshot,
) -> Result<(), ApiError> {
    let StructuredCommandRequest::MeshBuild { mesh_options, .. } = req else {
        return Ok(());
    };
    let mut options = mesh_options.take().unwrap_or_else(|| serde_json::json!({}));
    if !options.is_object() {
        options = serde_json::json!({ "user_options": options });
    }
    let Some(options_object) = options.as_object_mut() else {
        return Err(ApiError::internal("failed to prepare mesh options payload"));
    };
    options_object.insert(
        "geometry_realization".to_string(),
        serde_json::json!({
            "source_scene_revision": realization.source_scene_revision,
            "realization_revision": realization.realization_revision,
            "backend_target": realization.backend_target,
            "status": realization.status,
        }),
    );
    options_object.insert(
        "source_scene_revision".to_string(),
        serde_json::json!(realization.source_scene_revision),
    );
    if !options_object.contains_key("per_geometry") {
        if let Some(per_geometry) = scene_per_geometry_mesh_options(scene)? {
            options_object.insert("per_geometry".to_string(), per_geometry);
        }
    }
    options_object.insert(
        "scene_problem_patch".to_string(),
        scene_problem_patch_for_mesh(scene)?,
    );
    *mesh_options = Some(options);
    Ok(())
}

fn scene_per_geometry_mesh_options(
    scene: &SceneDocument,
) -> Result<Option<serde_json::Value>, ApiError> {
    let mut entries = Vec::new();

    for object in &scene.objects {
        let Some(mesh) = object
            .object_mesh
            .as_ref()
            .or(object.mesh_override.as_ref())
        else {
            continue;
        };
        let mut value = serde_json::to_value(mesh).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize mesh policy for object '{}': {error}",
                object.id
            ))
        })?;
        let Some(map) = value.as_object_mut() else {
            return Err(ApiError::internal(format!(
                "mesh policy for object '{}' did not serialize as an object",
                object.id
            )));
        };
        map.insert(
            "geometry".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        map.insert(
            "geometry_name".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        map.insert(
            "object_id".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        entries.push(value);
    }

    if entries.is_empty() {
        Ok(None)
    } else {
        Ok(Some(serde_json::Value::Array(entries)))
    }
}

fn scene_problem_patch_for_mesh(scene: &SceneDocument) -> Result<serde_json::Value, ApiError> {
    let mut geometry_entries = Vec::with_capacity(scene.objects.len());
    let mut regions = Vec::with_capacity(scene.objects.len());
    let mut materials = Vec::with_capacity(scene.objects.len());
    let mut magnets = Vec::with_capacity(scene.objects.len());

    for object in &scene.objects {
        let geometry_name = object.id.clone();
        let region_name = object.id.clone();
        let material_name = format!("material:{}", object.id);
        let material_asset = scene
            .materials
            .iter()
            .find(|candidate| candidate.id == object.material_ref)
            .ok_or_else(|| {
                ApiError::bad_request(format!(
                    "missing material '{}' for object '{}'",
                    object.material_ref, object.id
                ))
            })?;

        geometry_entries.push(scene_object_geometry_entry(object, &geometry_name)?);
        regions.push(RegionIR {
            geometry: geometry_name,
            name: region_name.clone(),
        });
        materials.push(MaterialIR {
            alpha_field: None,
            a_field: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            damping: material_asset.properties.alpha,
            exchange_stiffness: material_asset.properties.aex.ok_or_else(|| {
                ApiError::bad_request(format!(
                    "missing Aex material property for object '{}'",
                    object.id
                ))
            })?,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            ku2_field: None,
            ku_field: None,
            ms_field: None,
            name: material_name.clone(),
            saturation_magnetisation: material_asset.properties.ms.ok_or_else(|| {
                ApiError::bad_request(format!(
                    "missing Ms material property for object '{}'",
                    object.id
                ))
            })?,
            uniaxial_anisotropy: None,
            uniaxial_anisotropy_k2: None,
            anisotropy_axis: None,
        });
        magnets.push(MagnetIR {
            initial_magnetization: Some(initial_magnetization_for_object(scene, object)),
            material: material_name,
            name: object.id.clone(),
            region: region_name,
        });
    }

    Ok(serde_json::json!({
        "geometry_entries": geometry_entries,
        "magnets": magnets,
        "materials": materials,
        "regions": regions,
        "source_scene_revision": scene.revision,
        "universe": study_universe_for_problem_patch(scene)?,
    }))
}

fn study_universe_for_problem_patch(
    scene: &SceneDocument,
) -> Result<Option<serde_json::Value>, ApiError> {
    let Some(universe) = scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
    else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(universe).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize scene universe for mesh patch: {error}"
        ))
    })?;
    if let Some(object) = value.as_object_mut() {
        let mode = object
            .get("mode")
            .and_then(|candidate| candidate.as_str())
            .unwrap_or("auto");
        if mode == "box" {
            object.insert(
                "mode".to_string(),
                serde_json::Value::String("manual".to_string()),
            );
        }
    }
    Ok(Some(value))
}

fn scene_object_geometry_entry(
    object: &SceneObject,
    geometry_name: &str,
) -> Result<GeometryEntryIR, ApiError> {
    if !is_identity_quat(object.transform.rotation_quat) {
        return Err(ApiError::bad_request(format!(
            "mesh build cannot lower rotated object '{}' into ProblemIR yet",
            object.id
        )));
    }
    if !is_unit_scale(object.transform.scale) {
        return Err(ApiError::bad_request(format!(
            "mesh build cannot lower scaled object '{}' into ProblemIR yet",
            object.id
        )));
    }

    let params = &object.geometry.geometry_params;
    let base = match object.geometry.geometry_kind.as_str() {
        "Box" => GeometryEntryIR::Box {
            name: geometry_name.to_string(),
            size: vec3_param(params, "size")
                .or_else(|| vec3_param(params, "dimensions"))
                .ok_or_else(|| {
                    ApiError::bad_request(format!(
                        "Box object '{}' is missing size/dimensions",
                        object.id
                    ))
                })?,
        },
        "Cylinder" => GeometryEntryIR::Cylinder {
            height: number_param(params, "height", &object.id)?,
            name: geometry_name.to_string(),
            radius: number_param(params, "radius", &object.id)?,
        },
        "SinWaveguide" => GeometryEntryIR::SinWaveguide {
            amplitude: number_param(params, "amplitude", &object.id)?,
            height: number_param(params, "height", &object.id)?,
            length: number_param(params, "length", &object.id)?,
            name: geometry_name.to_string(),
            period: number_param(params, "period", &object.id)?,
            phase: optional_number_param(params, "phase").unwrap_or(0.0),
            width: number_param(params, "width", &object.id)?,
            z0: optional_number_param(params, "z0").unwrap_or(0.0),
        },
        "ArchWaveguide" => GeometryEntryIR::ArchWaveguide {
            arch_height: number_param(params, "arch_height", &object.id)?,
            height: number_param(params, "height", &object.id)?,
            length: number_param(params, "length", &object.id)?,
            name: geometry_name.to_string(),
            width: number_param(params, "width", &object.id)?,
            z0: optional_number_param(params, "z0").unwrap_or(0.0),
        },
        "Ellipsoid" => GeometryEntryIR::Ellipsoid {
            name: geometry_name.to_string(),
            radii: vec3_param(params, "radii").unwrap_or([
                number_param(params, "rx", &object.id)?,
                number_param(params, "ry", &object.id)?,
                number_param(params, "rz", &object.id)?,
            ]),
        },
        "Sphere" => GeometryEntryIR::Sphere {
            name: geometry_name.to_string(),
            radius: number_param(params, "radius", &object.id)?,
        },
        "Ellipse" => GeometryEntryIR::Ellipse {
            height: number_param(params, "height", &object.id)?,
            name: geometry_name.to_string(),
            radii: vec2_param(params, "radii").unwrap_or([
                number_param(params, "rx", &object.id)?,
                number_param(params, "ry", &object.id)?,
            ]),
        },
        other => {
            return Err(ApiError::bad_request(format!(
                "mesh build cannot lower geometry kind '{}' for object '{}'",
                other, object.id
            )));
        }
    };

    if is_zero_vec3(object.transform.translation) {
        Ok(base)
    } else {
        Ok(GeometryEntryIR::Translate {
            base: Box::new(base),
            by: object.transform.translation,
            name: geometry_name.to_string(),
        })
    }
}

fn initial_magnetization_for_object(
    scene: &SceneDocument,
    object: &SceneObject,
) -> InitialMagnetizationIR {
    let Some(reference) = object.magnetization_ref.as_ref() else {
        return InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        };
    };
    let Some(asset) = scene
        .magnetization_assets
        .iter()
        .find(|candidate| candidate.id == *reference)
    else {
        return InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        };
    };

    if let Some(value) = asset
        .value
        .as_ref()
        .and_then(|values| vec3_from_f64_slice(values))
    {
        return InitialMagnetizationIR::Uniform { value };
    }
    if asset.kind == "preset_texture" {
        let preset_kind = asset.preset_kind.clone().unwrap_or_else(|| "uniform".to_string());
        if preset_kind == "uniform" {
            if let Some(value) = asset
                .preset_params
                .as_ref()
                .and_then(|params| params.get("direction"))
                .and_then(|value| value.as_array())
                .and_then(|values| vec3_from_json_slice(values))
            {
                return InitialMagnetizationIR::Uniform { value };
            }
        }

        // Map non-uniform preset textures correctly
        let mut preset_params = std::collections::BTreeMap::new();
        if let Some(serde_json::Value::Object(map)) = &asset.preset_params {
            for (k, v) in map {
                preset_params.insert(k.clone(), v.clone());
            }
        }

        let mapping = fullmag_ir::TextureMappingIR {
            space: asset.mapping.space.clone(),
            projection: match asset.mapping.projection.as_str() {
                "planar_xy" | "planarXy" => fullmag_ir::TextureProjectionMode::PlanarXy,
                "planar_xz" | "planarXz" => fullmag_ir::TextureProjectionMode::PlanarXz,
                "planar_yz" | "planarYz" => fullmag_ir::TextureProjectionMode::PlanarYz,
                _ => fullmag_ir::TextureProjectionMode::ObjectLocal,
            },
            clamp_mode: asset.mapping.clamp_mode.clone(),
        };

        let texture_transform = fullmag_ir::TextureTransform3DIR {
            translation: asset.texture_transform.translation,
            rotation_quat: asset.texture_transform.rotation_quat,
            scale: asset.texture_transform.scale,
            pivot: asset.texture_transform.pivot,
        };

        return InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_params,
            mapping,
            texture_transform,
        };
    }
    InitialMagnetizationIR::Uniform {
        value: [0.0, 0.0, 1.0],
    }
}

fn number_param(params: &serde_json::Value, key: &str, object_id: &str) -> Result<f64, ApiError> {
    optional_number_param(params, key).ok_or_else(|| {
        ApiError::bad_request(format!(
            "object '{}' geometry parameter '{}' must be a finite number",
            object_id, key
        ))
    })
}

fn optional_number_param(params: &serde_json::Value, key: &str) -> Option<f64> {
    params.get(key).and_then(|value| {
        let number = value.as_f64()?;
        number.is_finite().then_some(number)
    })
}

fn vec3_param(params: &serde_json::Value, key: &str) -> Option<[f64; 3]> {
    params
        .get(key)
        .and_then(|value| value.as_array())
        .and_then(|values| vec3_from_json_slice(values))
}

fn vec2_param(params: &serde_json::Value, key: &str) -> Option<[f64; 2]> {
    let values = params.get(key)?.as_array()?;
    Some([
        finite_json_number(values.first()?)?,
        finite_json_number(values.get(1)?)?,
    ])
}

fn vec3_from_json_slice(values: &[serde_json::Value]) -> Option<[f64; 3]> {
    Some([
        finite_json_number(values.first()?)?,
        finite_json_number(values.get(1)?)?,
        finite_json_number(values.get(2)?)?,
    ])
}

fn vec3_from_f64_slice(values: &[f64]) -> Option<[f64; 3]> {
    let value = [*values.first()?, *values.get(1)?, *values.get(2)?];
    value
        .iter()
        .all(|component| component.is_finite())
        .then_some(value)
}

fn finite_json_number(value: &serde_json::Value) -> Option<f64> {
    let number = value.as_f64()?;
    number.is_finite().then_some(number)
}

fn is_zero_vec3(value: [f64; 3]) -> bool {
    value.iter().all(|component| component.abs() <= 1e-18)
}

fn is_unit_scale(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| (*component - 1.0).abs() <= 1e-12)
}

fn is_identity_quat(value: [f64; 4]) -> bool {
    value[0].abs() <= 1e-12
        && value[1].abs() <= 1e-12
        && value[2].abs() <= 1e-12
        && (value[3] - 1.0).abs() <= 1e-12
}

pub(crate) async fn enqueue_session_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    command: SessionCommand,
) -> Result<CommandResponse, ApiError> {
    let _guard = state.current_live_state.read().await;
    if _guard.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }
    drop(_guard);

    if let Some(idempotency_key) = command_request_key(&headers) {
        let cached = {
            let responses = state.current_command_responses.lock().await;
            responses
                .iter()
                .find(|(key, _)| key == &idempotency_key)
                .map(|(_, response)| response.clone())
        };
        if let Some(response) = cached {
            return Ok(response);
        }
    }
    let command_id = command.command_id.clone();
    let request_id = command_request_id(headers);

    // Enqueue
    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    let mut enqueued = command;
    enqueued.seq = seq;
    state
        .current_control_queue
        .lock()
        .await
        .push_back(enqueued.clone());
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: enqueued,
            request_id: request_id.clone(),
            status: CommandLifecycleState::Queued,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        });
        while ledger.len() > 256 {
            ledger.pop_front();
        }
    }
    let _ = state.current_control_events.send(seq);

    let response = CommandResponse {
        accepted: true,
        command_id,
        request_id,
        error: None,
    };

    if let Some(idempotency_key) = command_request_key(&headers) {
        let mut responses = state.current_command_responses.lock().await;
        responses.push_back((idempotency_key, response.clone()));
        while responses.len() > 128 {
            responses.pop_front();
        }
    }

    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(&state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0)
            .await?;
    }

    Ok(response)
}

fn command_request_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn command_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn new_session_command(command_id: String, kind: &str, created_at_unix_ms: u128) -> SessionCommand {
    SessionCommand {
        seq: 0,
        command_id,
        kind: kind.to_string(),
        created_at_unix_ms,
        target: None,
        reason: None,
        precondition: None,
        client_intent_id: None,
        requested_at_unix_ms: None,
        until_seconds: None,
        max_steps: None,
        torque_tolerance: None,
        energy_tolerance: None,
        integrator: None,
        fixed_timestep: None,
        max_error: None,
        relax_algorithm: None,
        relax_alpha: None,
        mesh_options: None,
        mesh_target: None,
        mesh_reason: None,
        state_path: None,
        state_format: None,
        state_dataset: None,
        state_sample_index: None,
        display_selection: None,
        preview_config: None,
        stages: None,
        profile: None,
    }
}

fn command_from_structured(
    req: StructuredCommandRequest,
    command_id: String,
    created_at_unix_ms: u128,
) -> SessionCommand {
    match req {
        StructuredCommandRequest::Run {
            intent,
            until_seconds,
            max_steps,
            integrator,
            fixed_timestep,
        } => {
            let mut command = new_session_command(command_id, "run", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command.until_seconds = Some(until_seconds);
            command.max_steps = max_steps;
            command.integrator = integrator;
            command.fixed_timestep = fixed_timestep;
            command
        }
        StructuredCommandRequest::Relax {
            intent,
            until_seconds,
            max_steps,
            torque_tolerance_apm,
            torque_tolerance_t,
            torque_tolerance,
            energy_tolerance,
            relax_algorithm,
            relax_alpha,
            fixed_timestep,
            max_error,
        } => {
            let mut command = new_session_command(command_id, "relax", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command.until_seconds = until_seconds;
            command.max_steps = max_steps;
            command.torque_tolerance = torque_tolerance_apm
                .or(torque_tolerance)
                .or_else(|| torque_tolerance_t.map(|value| value / MU0_T_PER_APM));
            command.energy_tolerance = energy_tolerance;
            command.relax_algorithm = relax_algorithm;
            command.relax_alpha = relax_alpha;
            command.fixed_timestep = fixed_timestep;
            command.max_error = max_error;
            command
        }
        StructuredCommandRequest::Pause { intent } => {
            let mut command = new_session_command(command_id, "pause", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Resume { intent } => {
            let mut command = new_session_command(command_id, "resume", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Stop { intent } => {
            let mut command = new_session_command(command_id, "stop", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Skip { intent } => {
            let mut command = new_session_command(command_id, "skip", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::SaveVtk { intent } => {
            let mut command = new_session_command(command_id, "save_vtk", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Solve { intent } => {
            let mut command = new_session_command(command_id, "solve", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::ComputeFields { intent } => {
            let mut command = new_session_command(command_id, "compute_fields", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::ComputeEnergies { intent } => {
            let mut command =
                new_session_command(command_id, "compute_energies", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::Close { intent } => {
            let mut command = new_session_command(command_id, "close", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command
        }
        StructuredCommandRequest::MeshBuild {
            intent,
            mesh_options,
            mesh_target,
            mesh_reason,
        } => {
            let mut command = new_session_command(command_id, "remesh", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command.mesh_options = mesh_options;
            command.mesh_target = mesh_target;
            command.mesh_reason = mesh_reason;
            command
        }
        StructuredCommandRequest::SetSolverProfile { intent, profile } => {
            let mut command =
                new_session_command(command_id, "set_solver_profile", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command.profile =
                Some(serde_json::to_value(profile).unwrap_or(serde_json::Value::Null));
            command
        }
    }
}

fn apply_command_intent(
    command: &mut SessionCommand,
    intent: RuntimeCommandIntent,
    default_target: RuntimeCommandTarget,
) {
    command.target = Some(intent.target.unwrap_or(default_target));
    command.reason = Some(intent.reason.unwrap_or_else(|| "unspecified".to_string()));
    command.precondition = intent.precondition;
    command.client_intent_id = intent.client_intent_id;
    command.requested_at_unix_ms = intent.requested_at_unix_ms;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemas::diagnostics::SolverProfileCommandConfig;

    #[test]
    fn set_solver_profile_command_preserves_profile_payload() {
        let command = command_from_structured(
            StructuredCommandRequest::SetSolverProfile {
                intent: RuntimeCommandIntent::default(),
                profile: SolverProfileCommandConfig {
                    enabled: true,
                    sample_every: 2,
                    max_samples: 7,
                    emit_engine_log: true,
                    persist_artifact: false,
                },
            },
            "cmd-profile".to_string(),
            123,
        );

        assert_eq!(command.kind, "set_solver_profile");
        assert_eq!(command.command_id, "cmd-profile");
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("enabled")),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("sample_every")),
            Some(&serde_json::json!(2))
        );
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("max_samples")),
            Some(&serde_json::json!(7))
        );
    }
}

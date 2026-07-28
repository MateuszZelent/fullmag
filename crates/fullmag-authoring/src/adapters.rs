use crate::{
    validate_scene_document, MagnetizationAsset, SceneCurrentModulesState, SceneDocument,
    SceneDocumentValidationError, SceneEditorState, SceneGeometry, SceneMaterialAsset,
    SceneMeshInterface, SceneMetadata, SceneObject, SceneOutputsState, SceneStudyState,
    ScriptBuilderGeometryEntry, ScriptBuilderMagneticInteractionEntry,
    ScriptBuilderMagneticInteractionKind, ScriptBuilderMagnetizationState,
    ScriptBuilderMeshInterfaceState, ScriptBuilderPerGeometryMeshState, ScriptBuilderState,
    StudyPipelineNode, Transform3D,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct SceneProblemProjection {
    pub builder: ScriptBuilderState,
    pub rewrite_overrides: Value,
}

pub fn normalize_scene_document_magnetization_assets(scene: &mut SceneDocument) {
    for asset in &mut scene.magnetization_assets {
        *asset = canonicalize_magnetization_asset(asset);
    }
}

pub fn scene_document_from_script_builder(builder: &ScriptBuilderState) -> SceneDocument {
    let objects = builder
        .geometries
        .iter()
        .map(scene_object_from_geometry)
        .collect::<Vec<_>>();
    let materials = builder
        .geometries
        .iter()
        .map(|geometry| SceneMaterialAsset {
            id: material_id_for_geometry(&geometry.name),
            name: format!("{} material", geometry.name),
            properties: geometry.material.clone(),
            references: Vec::new(),
        })
        .collect::<Vec<_>>();
    let magnetization_assets = builder
        .geometries
        .iter()
        .map(|geometry| magnetization_asset_from_geometry(&geometry.name, &geometry.magnetization))
        .collect::<Vec<_>>();

    SceneDocument {
        version: "scene.v2".to_string(),
        revision: builder.revision,
        scene: SceneMetadata {
            id: "scene".to_string(),
            name: "Scene".to_string(),
            source_of_truth: "repo_head".to_string(),
            authoring_schema: "mesh-first-fem.v1".to_string(),
        },
        universe: builder.universe.clone(),
        objects,
        couplings: Vec::new(),
        materials,
        magnetization_assets,
        field_drives: crate::SceneFieldDrivesState {
            drives: builder.field_drives.clone(),
        },
        monitors: crate::SceneMonitorState {
            planar: builder.planar_monitors.clone(),
        },
        current_modules: SceneCurrentModulesState {
            modules: builder.current_modules.clone(),
            excitation_analysis: builder.excitation_analysis.clone(),
        },
        study: SceneStudyState {
            backend: builder.backend.clone(),
            requested_backend: builder
                .backend
                .clone()
                .unwrap_or_else(|| "auto".to_string()),
            requested_device: "auto".to_string(),
            requested_precision: "double".to_string(),
            requested_mode: builder
                .requested_mode
                .clone()
                .unwrap_or_else(|| "strict".to_string()),
            requested_cpu_threads: builder.cpu_threads,
            fem_demag_solver_policy: builder.fem_demag_solver_policy.clone(),
            exchange_enabled: builder.exchange_enabled,
            demag_enabled: builder.demag_enabled,
            demag_realization: builder.demag_realization.clone(),
            external_field: builder.external_field,
            solver: builder.solver.clone(),
            universe_mesh: builder.universe.clone(),
            shared_domain_mesh: builder.mesh.clone(),
            mesh_defaults: builder.mesh.clone(),
            mesh_interfaces: builder
                .mesh_interfaces
                .iter()
                .map(scene_mesh_interface_from_builder)
                .collect(),
            stages: builder.stages.clone(),
            study_pipeline: builder.study_pipeline.clone(),
            initial_state: builder.initial_state.clone(),
        },
        outputs: SceneOutputsState::default(),
        editor: SceneEditorState::default(),
    }
}

pub fn scene_document_to_script_builder(
    scene: &SceneDocument,
) -> Result<ScriptBuilderState, SceneDocumentValidationError> {
    let mut normalized_scene = scene.clone();
    normalize_scene_document_study_pipeline_labels(&mut normalized_scene);
    validate_scene_document(&normalized_scene)?;
    let materials = scene
        .materials
        .iter()
        .map(|material| (material.id.clone(), material.properties.clone()))
        .collect::<BTreeMap<_, _>>();
    let magnetization_assets = scene
        .magnetization_assets
        .iter()
        .map(|asset| (asset.id.clone(), asset.clone()))
        .collect::<BTreeMap<_, _>>();

    let geometries = scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
        .map(|object| {
            let material = materials
                .get(&object.material_ref)
                .cloned()
                .ok_or_else(|| {
                    SceneDocumentValidationError::new(format!(
                        "missing material '{}' for object '{}'",
                        object.material_ref, object.id
                    ))
                })?;
            let magnetization_ref = object
                .magnetization_ref
                .as_ref()
                .filter(|reference| !reference.trim().is_empty())
                .ok_or_else(|| {
                    SceneDocumentValidationError::new(format!(
                        "missing magnetization reference for object '{}'",
                        object.id
                    ))
                })?;
            let magnetization = magnetization_assets
                .get(magnetization_ref)
                .map(script_builder_magnetization_from_asset)
                .ok_or_else(|| {
                    SceneDocumentValidationError::new(format!(
                        "missing magnetization '{}' for object '{}'",
                        magnetization_ref, object.id
                    ))
                })?;
            if !is_identity_quaternion(object.transform.rotation_quat)
                || !is_identity_scale(object.transform.scale)
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "owner_transform_rotation_scale_unsupported: object '{}' uses rotation or scale that is not represented by the canonical FDM owner-frame lowering",
                    object.id
                )));
            }
            let material_dind = material.dind;
            let material_dbulk = material.dbulk;

            let mut geometry_params = object.geometry.geometry_params.clone();
            strip_translation_fields(&mut geometry_params);
            if !is_zero_vec3(object.transform.translation) {
                insert_translation(&mut geometry_params, object.transform.translation);
            }

            Ok(ScriptBuilderGeometryEntry {
                name: builder_geometry_name_for_object(object),
                region_name: object.region_name.clone(),
                geometry_kind: object.geometry.geometry_kind.clone(),
                geometry_params,
                bounds_min: object.geometry.bounds_min,
                bounds_max: object.geometry.bounds_max,
                material,
                magnetization,
                physics_stack: ensure_object_physics_stack(
                    &object.physics_stack,
                    material_dind,
                    material_dbulk,
                ),
                mesh: object
                    .object_mesh
                    .clone()
                    .or_else(|| object.mesh_override.clone()),
                object_regions: object.regions.clone(),
                allocated_region_ids: object.allocated_region_ids.clone(),
                material_parameter_fields: object.material_parameter_fields.clone(),
            })
        })
        .collect::<Result<Vec<_>, SceneDocumentValidationError>>()?;

    Ok(ScriptBuilderState {
        revision: scene.revision,
        backend: normalized_scene.study.backend.clone(),
        requested_mode: Some(normalized_scene.study.requested_mode.clone()),
        cpu_threads: normalized_scene.study.requested_cpu_threads,
        fem_demag_solver_policy: normalized_scene.study.fem_demag_solver_policy.clone(),
        exchange_enabled: normalized_scene.study.exchange_enabled,
        demag_enabled: normalized_scene.study.demag_enabled,
        demag_realization: normalized_scene.study.demag_realization.clone(),
        external_field: normalized_scene.study.external_field,
        solver: normalized_scene.study.solver.clone(),
        mesh: normalized_scene.study.shared_domain_mesh.clone(),
        universe: normalized_scene
            .study
            .universe_mesh
            .clone()
            .or_else(|| normalized_scene.universe.clone()),
        domain_frame: None,
        stages: normalized_scene.study.stages.clone(),
        study_pipeline: normalized_scene.study.study_pipeline.clone(),
        initial_state: normalized_scene.study.initial_state.clone(),
        geometries,
        mesh_interfaces: normalized_scene
            .study
            .mesh_interfaces
            .iter()
            .map(builder_mesh_interface_from_scene)
            .collect(),
        field_drives: normalized_scene.field_drives.drives.clone(),
        planar_monitors: normalized_scene.monitors.planar.clone(),
        current_modules: normalized_scene.current_modules.modules.clone(),
        excitation_analysis: normalized_scene.current_modules.excitation_analysis.clone(),
    })
}

pub fn scene_document_to_script_builder_overrides(
    scene: &SceneDocument,
) -> Result<Value, SceneDocumentValidationError> {
    let builder = scene_document_to_script_builder(scene)?;
    Ok(serde_json::json!({
        "runtime_selection": {
            "backend": scene.study.requested_backend,
            "device": scene.study.requested_device,
            "precision": scene.study.requested_precision,
            "mode": scene.study.requested_mode,
            "cpu_threads": scene.study.requested_cpu_threads,
            "fem_demag_solver_policy": scene.study.fem_demag_solver_policy,
            "explicit_selection": scene.study.requested_backend != "auto"
                || scene.study.requested_device != "auto"
                || scene.study.requested_precision != "double"
                || scene.study.requested_mode != "strict"
                || scene.study.requested_cpu_threads.is_some(),
        },
        "exchange_enabled": builder.exchange_enabled,
        "demag_enabled": builder.demag_enabled,
        "demag_realization": builder.demag_realization,
        "external_field": builder.external_field
            .map(|value| serde_json::json!([value[0], value[1], value[2]]))
            .unwrap_or(Value::Null),
        "solver": solver_override_value(&builder.solver),
        "mesh": {
            "algorithm_2d": builder.mesh.algorithm_2d,
            "algorithm_3d": builder.mesh.algorithm_3d,
            "size_mode": builder.mesh.size_mode.as_ref().map(|value| Value::String(value.clone())).unwrap_or(Value::Null),
            "hmax": parse_optional_text_f64_or_auto(&builder.mesh.hmax),
            "hmin": parse_optional_text_f64(&builder.mesh.hmin),
            "maximum_element_size": builder.mesh.maximum_element_size.as_deref().map(parse_optional_text_f64_or_auto).unwrap_or(Value::Null),
            "minimum_element_size": builder.mesh.minimum_element_size.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "calibrate_for": builder.mesh.calibrate_for.as_ref().map(|value| Value::String(value.clone())).unwrap_or(Value::Null),
            "size_preset": builder.mesh.size_preset.as_ref().map(|value| Value::String(value.clone())).unwrap_or(Value::Null),
            "size_factor": builder.mesh.size_factor,
            "size_from_curvature": builder.mesh.size_from_curvature,
            "curvature_factor": builder.mesh.curvature_factor.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "growth_rate": parse_optional_text_f64(&builder.mesh.growth_rate),
            "maximum_element_growth_rate": builder.mesh.maximum_element_growth_rate.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "narrow_regions": builder.mesh.narrow_regions,
            "narrow_region_resolution": builder.mesh.narrow_region_resolution.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "resolved_size_from_curvature": builder.mesh.resolved_size_from_curvature.map(Value::from).unwrap_or(Value::Null),
            "resolved_narrow_regions": builder.mesh.resolved_narrow_regions.map(Value::from).unwrap_or(Value::Null),
            "resolved_growth_rate": builder.mesh.resolved_growth_rate.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "smoothing_steps": builder.mesh.smoothing_steps,
            "optimize": string_or_null(&builder.mesh.optimize),
            "optimize_iterations": builder.mesh.optimize_iterations,
            "compute_quality": builder.mesh.compute_quality,
            "per_element_quality": builder.mesh.per_element_quality,
            "interface_hmax": builder.mesh.interface_hmax.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "interface_thickness": builder.mesh.interface_thickness.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "transition_distance": builder.mesh.transition_distance.as_deref().map(parse_transition_distance_value).unwrap_or(Value::Null),
            "transition_growth": builder.mesh.transition_growth.as_deref().map(parse_optional_text_f64).unwrap_or(Value::Null),
            "adaptive_mesh": if !builder.mesh.adaptive_enabled {
                Value::Null
            } else {
                serde_json::json!({
                    "enabled": builder.mesh.adaptive_enabled,
                    "policy": builder.mesh.adaptive_policy,
                    "indicator": builder.mesh.adaptive_indicator.as_ref(),
                    "target_quantity": builder.mesh.adaptive_target_quantity.as_ref(),
                    "convergence_metric": builder.mesh.adaptive_convergence_metric.as_ref(),
                    "theta": builder.mesh.adaptive_theta,
                    "h_min": parse_optional_text_f64(&builder.mesh.adaptive_h_min),
                    "h_max": parse_optional_text_f64(&builder.mesh.adaptive_h_max),
                    "max_passes": builder.mesh.adaptive_max_passes,
                    "error_tolerance": parse_optional_text_f64(&builder.mesh.adaptive_error_tolerance),
                })
            },
        },
        "mesh_interfaces": scene
            .study
            .mesh_interfaces
            .iter()
            .map(|interface| serde_json::json!({
                "interface_id": interface.interface_id,
                "owner_a": interface.owner_a,
                "owner_b": interface.owner_b,
                "config": geometry_mesh_override_value(&interface.config),
            }))
            .collect::<Vec<_>>(),
        "universe": builder.universe.as_ref().map(|universe| serde_json::json!({
            "mode": universe.mode,
            "size": universe.size,
            "center": universe.center,
            "padding": universe.padding,
            "airbox_hmax": universe.airbox_hmax,
            "airbox_hmin": universe.airbox_hmin,
            "airbox_growth_rate": universe.airbox_growth_rate,
            "airbox_grading": universe.airbox_grading,
        })).unwrap_or(Value::Null),
        "stages": builder.stages.iter().map(|stage| serde_json::json!({
            "kind": stage.kind,
            "entrypoint_kind": stage.entrypoint_kind,
            "integrator": string_or_null(&stage.integrator),
            "fixed_timestep": parse_optional_text_f64(&stage.fixed_timestep),
            "adaptive_timestep": stage.adaptive_timestep.as_ref().map(adaptive_timestep_override_value).unwrap_or(Value::Null),
            "until_seconds": parse_optional_text_f64(&stage.until_seconds),
            "relax_algorithm": string_or_null(&stage.relax_algorithm),
            "torque_tolerance": parse_optional_text_f64(&stage.torque_tolerance),
            "energy_tolerance": parse_optional_text_f64(&stage.energy_tolerance),
            "max_steps": parse_optional_text_u64(&stage.max_steps),
            "eigen_count": parse_optional_text_u64(&stage.eigen_count),
            "eigen_target": string_or_null(&stage.eigen_target),
            "eigen_include_demag": stage.eigen_include_demag,
            "eigen_equilibrium_source": string_or_null(&stage.eigen_equilibrium_source),
            "eigen_normalization": string_or_null(&stage.eigen_normalization),
        })).collect::<Vec<_>>(),
        "study_pipeline": builder.study_pipeline.as_ref().map(|document| {
            serde_json::to_value(document).unwrap_or(Value::Null)
        }).unwrap_or(Value::Null),
        "initial_state": builder.initial_state.as_ref().map(|initial_state| serde_json::json!({
            "magnet_name": initial_state.magnet_name,
            "source_path": initial_state.source_path,
            "format": initial_state.format,
            "dataset": initial_state.dataset,
            "sample_index": initial_state.sample_index,
        })).unwrap_or(Value::Null),
        "geometries": builder
            .geometries
            .iter()
            .map(geometry_override_value)
            .collect::<Vec<_>>(),
        "couplings": scene
            .couplings
            .iter()
            .map(|coupling| serde_json::to_value(coupling).unwrap_or(Value::Null))
            .collect::<Vec<_>>(),
        "planar_monitors": builder.planar_monitors,
        "current_modules": builder.current_modules.iter().map(|module| serde_json::json!({
            "kind": module.kind,
            "name": module.name,
            "solver": module.solver,
            "air_box_factor": module.air_box_factor,
            "antenna_kind": module.antenna_kind,
            "antenna_params": module.antenna_params,
            "drive": {
                "current_a": module.drive.current_a,
                "frequency_hz": module.drive.frequency_hz,
                "phase_rad": module.drive.phase_rad,
                "waveform": module.drive.waveform,
            },
        })).collect::<Vec<_>>(),
        "excitation_analysis": builder.excitation_analysis.as_ref().map(|analysis| serde_json::json!({
            "source": analysis.source,
            "method": analysis.method,
            "propagation_axis": analysis.propagation_axis,
            "k_max_rad_per_m": analysis.k_max_rad_per_m,
            "samples": analysis.samples,
        })).unwrap_or(Value::Null),
    }))
}

fn solver_override_value(solver: &crate::ScriptBuilderSolverState) -> Value {
    let mut value = Map::new();
    value.insert("integrator".to_string(), string_or_null(&solver.integrator));
    value.insert(
        "demag_interval_s".to_string(),
        parse_optional_text_f64(&solver.demag_interval_s),
    );
    if !solver.fixed_timestep.trim().is_empty() {
        value.insert(
            "fixed_timestep".to_string(),
            parse_optional_text_f64(&solver.fixed_timestep),
        );
    } else if let Some(adaptive) = solver.adaptive_timestep.as_ref() {
        value.insert(
            "adaptive_timestep".to_string(),
            serde_json::json!({
                "atol": parse_optional_text_f64(&adaptive.atol),
                "rtol": parse_optional_text_f64(&adaptive.rtol),
                "dt_initial": parse_optional_text_f64(&adaptive.dt_initial),
                "dt_min": parse_optional_text_f64(&adaptive.dt_min),
                "dt_max": parse_optional_text_f64(&adaptive.dt_max),
                "safety": parse_optional_text_f64(&adaptive.safety),
                "growth_limit": parse_optional_text_f64(&adaptive.growth_limit),
                "shrink_limit": parse_optional_text_f64(&adaptive.shrink_limit),
                "max_spin_rotation": parse_optional_text_f64(&adaptive.max_spin_rotation),
                "norm_tolerance": parse_optional_text_f64(&adaptive.norm_tolerance),
            }),
        );
    } else if [
        &solver.dt_initial,
        &solver.dt_min,
        &solver.dt_max,
        &solver.max_err,
    ]
    .iter()
    .any(|entry| !entry.trim().is_empty())
    {
        value.insert(
            "dt_initial".to_string(),
            parse_optional_text_f64(&solver.dt_initial),
        );
        value.insert(
            "dt_min".to_string(),
            parse_optional_text_f64(&solver.dt_min),
        );
        value.insert(
            "dt_max".to_string(),
            parse_optional_text_f64(&solver.dt_max),
        );
        value.insert(
            "max_err".to_string(),
            parse_optional_text_f64(&solver.max_err),
        );
    }
    value.insert(
        "relax".to_string(),
        serde_json::json!({
            "algorithm": string_or_null(&solver.relax_algorithm),
            "torque_tolerance": parse_optional_text_f64(&solver.torque_tolerance),
            "energy_tolerance": parse_optional_text_f64(&solver.energy_tolerance),
            "max_steps": parse_optional_text_u64(&solver.max_relax_steps),
        }),
    );
    Value::Object(value)
}

fn adaptive_timestep_override_value(adaptive: &crate::ScriptBuilderAdaptiveTimestepState) -> Value {
    serde_json::json!({
        "tolerance_mode": adaptive.tolerance_mode,
        "atol": parse_optional_text_f64(&adaptive.atol),
        "rtol": parse_optional_text_f64(&adaptive.rtol),
        "dt_initial": parse_optional_text_f64(&adaptive.dt_initial),
        "dt_min": parse_optional_text_f64(&adaptive.dt_min),
        "dt_max": parse_optional_text_f64(&adaptive.dt_max),
        "safety": parse_optional_text_f64(&adaptive.safety),
        "growth_limit": parse_optional_text_f64(&adaptive.growth_limit),
        "shrink_limit": parse_optional_text_f64(&adaptive.shrink_limit),
        "max_spin_rotation": parse_optional_text_f64(&adaptive.max_spin_rotation),
        "norm_tolerance": parse_optional_text_f64(&adaptive.norm_tolerance),
    })
}

fn scene_mesh_interface_from_builder(
    interface: &ScriptBuilderMeshInterfaceState,
) -> SceneMeshInterface {
    SceneMeshInterface {
        interface_id: interface.interface_id.clone(),
        owner_a: interface.owner_a.clone(),
        owner_b: interface.owner_b.clone(),
        config: interface.config.clone(),
    }
}

fn builder_mesh_interface_from_scene(
    interface: &SceneMeshInterface,
) -> ScriptBuilderMeshInterfaceState {
    ScriptBuilderMeshInterfaceState {
        interface_id: interface.interface_id.clone(),
        owner_a: interface.owner_a.clone(),
        owner_b: interface.owner_b.clone(),
        config: interface.config.clone(),
    }
}

pub fn normalize_scene_document_study_pipeline_labels(scene: &mut SceneDocument) {
    if let Some(document) = &mut scene.study.study_pipeline {
        normalize_study_pipeline_node_labels(&mut document.nodes);
    }
}

fn normalize_study_pipeline_node_labels(nodes: &mut [StudyPipelineNode]) {
    for node in nodes {
        match node {
            StudyPipelineNode::Primitive(node) => {
                if node.label.trim().is_empty() {
                    node.label = node.id.clone();
                }
            }
            StudyPipelineNode::Macro(node) => {
                if node.label.trim().is_empty() {
                    node.label = node.id.clone();
                }
            }
            StudyPipelineNode::Group(node) => {
                if node.label.trim().is_empty() {
                    node.label = node.id.clone();
                }
                normalize_study_pipeline_node_labels(&mut node.children);
            }
        }
    }
}

pub fn scene_document_problem_projection(
    scene: &SceneDocument,
) -> Result<SceneProblemProjection, SceneDocumentValidationError> {
    let builder = scene_document_to_script_builder(scene)?;
    let rewrite_overrides = scene_document_to_script_builder_overrides(scene)?;
    Ok(SceneProblemProjection {
        builder,
        rewrite_overrides,
    })
}

fn geometry_override_value(geo: &ScriptBuilderGeometryEntry) -> Value {
    let mut map = Map::new();
    map.insert("name".to_string(), Value::String(geo.name.clone()));
    map.insert(
        "region_name".to_string(),
        geo.region_name
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "geometry_kind".to_string(),
        Value::String(geo.geometry_kind.clone()),
    );
    map.insert("geometry_params".to_string(), geo.geometry_params.clone());
    map.insert(
        "bounds_min".to_string(),
        serde_json::to_value(geo.bounds_min).unwrap_or(Value::Null),
    );
    map.insert(
        "bounds_max".to_string(),
        serde_json::to_value(geo.bounds_max).unwrap_or(Value::Null),
    );
    map.insert(
        "material".to_string(),
        serde_json::json!({
            "Ms": geo.material.ms,
            "Aex": geo.material.aex,
            "alpha": geo.material.alpha,
            "Dind": geo.material.dind,
        }),
    );
    map.insert(
        "magnetization".to_string(),
        serde_json::json!({
            "kind": geo.magnetization.kind,
            "value": geo.magnetization.value,
            "seed": geo.magnetization.seed,
            "source_path": geo.magnetization.source_path,
            "source_format": geo.magnetization.source_format,
            "dataset": geo.magnetization.dataset,
            "sample_index": geo.magnetization.sample_index,
            "mapping": geo.magnetization.mapping,
            "texture_transform": geo.magnetization.texture_transform,
            "preset_kind": geo.magnetization.preset_kind,
            "preset_params": geo.magnetization.preset_params,
            "preset_version": geo.magnetization.preset_version,
            "ui_label": geo.magnetization.ui_label,
        }),
    );
    map.insert(
        "physics_stack".to_string(),
        Value::Array(
            geo.physics_stack
                .iter()
                .map(|interaction| {
                    serde_json::json!({
                        "kind": interaction.kind,
                        "enabled": interaction.enabled,
                        "params": interaction.params,
                    })
                })
                .collect(),
        ),
    );
    map.insert(
        "mesh".to_string(),
        geo.mesh
            .as_ref()
            .map(geometry_mesh_override_value)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "object_regions".to_string(),
        serde_json::to_value(&geo.object_regions).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    map.insert(
        "allocated_region_ids".to_string(),
        serde_json::to_value(&geo.allocated_region_ids)
            .unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    map.insert(
        "material_parameter_fields".to_string(),
        serde_json::to_value(&geo.material_parameter_fields)
            .unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    Value::Object(map)
}

fn geometry_mesh_override_value(mesh: &ScriptBuilderPerGeometryMeshState) -> Value {
    let mut map = Map::new();
    map.insert("mode".to_string(), Value::String(mesh.mode.clone()));
    map.insert(
        "size_mode".to_string(),
        mesh.size_mode
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "hmax".to_string(),
        parse_optional_text_f64_or_auto(&mesh.hmax),
    );
    map.insert("hmin".to_string(), parse_optional_text_f64(&mesh.hmin));
    map.insert(
        "maximum_element_size".to_string(),
        mesh.maximum_element_size
            .as_deref()
            .map(parse_optional_text_f64_or_auto)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "minimum_element_size".to_string(),
        mesh.minimum_element_size
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "calibrate_for".to_string(),
        mesh.calibrate_for
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "size_preset".to_string(),
        mesh.size_preset
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "mesh_strategy".to_string(),
        mesh.mesh_strategy
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "order".to_string(),
        serde_json::to_value(mesh.order).unwrap_or(Value::Null),
    );
    map.insert(
        "through_thickness_elements".to_string(),
        serde_json::to_value(mesh.through_thickness_elements).unwrap_or(Value::Null),
    );
    map.insert(
        "through_thickness_distribution".to_string(),
        mesh.through_thickness_distribution
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "through_thickness_element_ratio".to_string(),
        serde_json::to_value(mesh.through_thickness_element_ratio).unwrap_or(Value::Null),
    );
    map.insert(
        "through_thickness_symmetric".to_string(),
        serde_json::to_value(mesh.through_thickness_symmetric).unwrap_or(Value::Null),
    );
    map.insert(
        "sweep_face_meshing".to_string(),
        mesh.sweep_face_meshing
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "topology".to_string(),
        mesh.topology
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "sweep_direction".to_string(),
        mesh.sweep_direction
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "element_family".to_string(),
        mesh.element_family
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "transition_policy".to_string(),
        mesh.transition_policy
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "exact_layer_count".to_string(),
        serde_json::to_value(mesh.exact_layer_count).unwrap_or(Value::Null),
    );
    map.insert(
        "source".to_string(),
        mesh.source
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "algorithm_2d".to_string(),
        serde_json::to_value(mesh.algorithm_2d).unwrap_or(Value::Null),
    );
    map.insert(
        "algorithm_3d".to_string(),
        serde_json::to_value(mesh.algorithm_3d).unwrap_or(Value::Null),
    );
    map.insert(
        "size_factor".to_string(),
        serde_json::to_value(mesh.size_factor).unwrap_or(Value::Null),
    );
    map.insert(
        "size_from_curvature".to_string(),
        serde_json::to_value(mesh.size_from_curvature).unwrap_or(Value::Null),
    );
    map.insert(
        "curvature_factor".to_string(),
        mesh.curvature_factor
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "growth_rate".to_string(),
        parse_optional_text_f64(&mesh.growth_rate),
    );
    map.insert(
        "maximum_element_growth_rate".to_string(),
        mesh.maximum_element_growth_rate
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "narrow_regions".to_string(),
        serde_json::to_value(mesh.narrow_regions).unwrap_or(Value::Null),
    );
    map.insert(
        "narrow_region_resolution".to_string(),
        mesh.narrow_region_resolution
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "resolved_size_from_curvature".to_string(),
        mesh.resolved_size_from_curvature
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "resolved_narrow_regions".to_string(),
        mesh.resolved_narrow_regions
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "resolved_growth_rate".to_string(),
        mesh.resolved_growth_rate
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "smoothing_steps".to_string(),
        serde_json::to_value(mesh.smoothing_steps).unwrap_or(Value::Null),
    );
    map.insert(
        "optimize".to_string(),
        mesh.optimize
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "optimize_iterations".to_string(),
        serde_json::to_value(mesh.optimize_iterations).unwrap_or(Value::Null),
    );
    map.insert(
        "compute_quality".to_string(),
        serde_json::to_value(mesh.compute_quality).unwrap_or(Value::Null),
    );
    map.insert(
        "per_element_quality".to_string(),
        serde_json::to_value(mesh.per_element_quality).unwrap_or(Value::Null),
    );
    map.insert(
        "interface_hmax".to_string(),
        mesh.interface_hmax
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "interface_thickness".to_string(),
        mesh.interface_thickness
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    let edge_hmax = mesh
        .edge_hmax
        .as_deref()
        .map(parse_optional_text_f64)
        .unwrap_or(Value::Null);
    map.insert("edge_hmax".to_string(), edge_hmax.clone());
    map.insert("edge_maximum_element_size".to_string(), edge_hmax);
    map.insert(
        "edge_thickness".to_string(),
        mesh.edge_thickness
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "edge_transition_distance".to_string(),
        mesh.edge_transition_distance
            .as_deref()
            .map(parse_transition_distance_value)
            .unwrap_or(Value::Null),
    );
    let corner_hmax = mesh
        .corner_hmax
        .as_deref()
        .map(parse_optional_text_f64)
        .unwrap_or(Value::Null);
    map.insert("corner_hmax".to_string(), corner_hmax.clone());
    map.insert("corner_maximum_element_size".to_string(), corner_hmax);
    map.insert(
        "corner_extent".to_string(),
        mesh.corner_extent
            .as_deref()
            .map(parse_optional_text_f64)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "corner_transition_distance".to_string(),
        mesh.corner_transition_distance
            .as_deref()
            .map(parse_transition_distance_value)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "transition_distance".to_string(),
        mesh.transition_distance
            .as_deref()
            .map(parse_transition_distance_value)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "transition_growth".to_string(),
        serde_json::to_value(mesh.transition_growth).unwrap_or(Value::Null),
    );
    map.insert(
        "size_fields".to_string(),
        Value::Array(
            mesh.size_fields
                .iter()
                .map(|field| {
                    serde_json::json!({
                        "kind": field.kind,
                        "params": field.params,
                    })
                })
                .collect(),
        ),
    );
    map.insert(
        "operations".to_string(),
        Value::Array(
            mesh.operations
                .iter()
                .map(|operation| {
                    serde_json::json!({
                        "kind": operation.kind,
                        "params": operation.params,
                    })
                })
                .collect(),
        ),
    );
    map.insert(
        "build_requested".to_string(),
        Value::Bool(mesh.build_requested),
    );
    Value::Object(map)
}

fn scene_object_from_geometry(geometry: &ScriptBuilderGeometryEntry) -> SceneObject {
    let (geometry_params, translation) = split_top_level_translation(&geometry.geometry_params);
    SceneObject {
        id: geometry.name.clone(),
        name: geometry.name.clone(),
        role: "magnet".to_string(),
        geometry: SceneGeometry {
            geometry_kind: geometry.geometry_kind.clone(),
            geometry_params,
            bounds_min: geometry.bounds_min,
            bounds_max: geometry.bounds_max,
        },
        transform: Transform3D {
            translation,
            ..Transform3D::default()
        },
        material_ref: material_id_for_geometry(&geometry.name),
        region_name: geometry.region_name.clone(),
        magnetization_ref: Some(magnetization_id_for_geometry(&geometry.name)),
        region_overrides: BTreeMap::new(),
        physics_stack: ensure_object_physics_stack(
            &geometry.physics_stack,
            geometry.material.dind,
            geometry.material.dbulk,
        ),
        object_mesh: geometry.mesh.clone(),
        mesh_override: geometry.mesh.clone(),
        regions: geometry.object_regions.clone(),
        allocated_region_ids: geometry.allocated_region_ids.clone(),
        material_parameter_fields: geometry.material_parameter_fields.clone(),
        notes: None,
        visible: true,
        locked: false,
        tags: Vec::new(),
    }
}

const INTERACTION_ORDER: [ScriptBuilderMagneticInteractionKind; 5] = [
    ScriptBuilderMagneticInteractionKind::Exchange,
    ScriptBuilderMagneticInteractionKind::Demag,
    ScriptBuilderMagneticInteractionKind::InterfacialDmi,
    ScriptBuilderMagneticInteractionKind::BulkDmi,
    ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy,
];

fn ensure_object_physics_stack(
    raw: &[ScriptBuilderMagneticInteractionEntry],
    material_dind: Option<f64>,
    material_dbulk: Option<f64>,
) -> Vec<ScriptBuilderMagneticInteractionEntry> {
    let mut normalized: Vec<ScriptBuilderMagneticInteractionEntry> = Vec::new();
    for entry in raw {
        upsert_interaction(
            &mut normalized,
            normalize_interaction_entry(entry, material_dind, material_dbulk),
        );
    }
    if !normalized
        .iter()
        .any(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::Exchange)
    {
        upsert_interaction(
            &mut normalized,
            ScriptBuilderMagneticInteractionEntry {
                kind: ScriptBuilderMagneticInteractionKind::Exchange,
                enabled: true,
                params: None,
            },
        );
    }
    if !normalized
        .iter()
        .any(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::Demag)
    {
        upsert_interaction(
            &mut normalized,
            ScriptBuilderMagneticInteractionEntry {
                kind: ScriptBuilderMagneticInteractionKind::Demag,
                enabled: true,
                params: None,
            },
        );
    }
    if material_dind.is_some()
        && !normalized
            .iter()
            .any(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::InterfacialDmi)
    {
        upsert_interaction(
            &mut normalized,
            normalize_interaction_entry(
                &ScriptBuilderMagneticInteractionEntry {
                    kind: ScriptBuilderMagneticInteractionKind::InterfacialDmi,
                    enabled: true,
                    params: None,
                },
                material_dind,
                None,
            ),
        );
    }
    if material_dbulk.is_some()
        && !normalized
            .iter()
            .any(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::BulkDmi)
    {
        upsert_interaction(
            &mut normalized,
            normalize_interaction_entry(
                &ScriptBuilderMagneticInteractionEntry {
                    kind: ScriptBuilderMagneticInteractionKind::BulkDmi,
                    enabled: true,
                    params: None,
                },
                None,
                material_dbulk,
            ),
        );
    }
    INTERACTION_ORDER
        .iter()
        .filter_map(|kind| normalized.iter().find(|entry| entry.kind == *kind).cloned())
        .collect()
}

fn normalize_interaction_entry(
    entry: &ScriptBuilderMagneticInteractionEntry,
    material_dind: Option<f64>,
    material_dbulk: Option<f64>,
) -> ScriptBuilderMagneticInteractionEntry {
    match entry.kind {
        ScriptBuilderMagneticInteractionKind::Exchange => ScriptBuilderMagneticInteractionEntry {
            kind: ScriptBuilderMagneticInteractionKind::Exchange,
            enabled: entry.enabled,
            params: None,
        },
        ScriptBuilderMagneticInteractionKind::Demag => ScriptBuilderMagneticInteractionEntry {
            kind: ScriptBuilderMagneticInteractionKind::Demag,
            enabled: entry.enabled,
            params: None,
        },
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => {
            let mut params = params_map(entry.params.as_ref());
            let dind = params
                .get("dind")
                .and_then(Value::as_f64)
                .or(material_dind)
                .unwrap_or(1e-3);
            params.insert("dind".to_string(), Value::from(dind));
            ScriptBuilderMagneticInteractionEntry {
                kind: ScriptBuilderMagneticInteractionKind::InterfacialDmi,
                enabled: entry.enabled,
                params: Some(Value::Object(params)),
            }
        }
        ScriptBuilderMagneticInteractionKind::BulkDmi => {
            let mut params = params_map(entry.params.as_ref());
            let dbulk = params
                .get("dbulk")
                .and_then(Value::as_f64)
                .or(material_dbulk)
                .unwrap_or(1e-3);
            params.insert("dbulk".to_string(), Value::from(dbulk));
            ScriptBuilderMagneticInteractionEntry {
                kind: ScriptBuilderMagneticInteractionKind::BulkDmi,
                enabled: entry.enabled,
                params: Some(Value::Object(params)),
            }
        }
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => {
            let mut params = params_map(entry.params.as_ref());
            let ku1 = params.get("ku1").and_then(Value::as_f64).unwrap_or(0.0);
            let axis = normalize_axis3(params.get("axis"));
            params.insert("ku1".to_string(), Value::from(ku1));
            params.insert(
                "axis".to_string(),
                Value::Array(axis.into_iter().map(Value::from).collect()),
            );
            ScriptBuilderMagneticInteractionEntry {
                kind: ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy,
                enabled: entry.enabled,
                params: Some(Value::Object(params)),
            }
        }
    }
}

fn params_map(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn normalize_axis3(value: Option<&Value>) -> [f64; 3] {
    match value {
        Some(Value::Array(values)) if values.len() == 3 => [
            values[0].as_f64().unwrap_or(0.0),
            values[1].as_f64().unwrap_or(0.0),
            values[2].as_f64().unwrap_or(1.0),
        ],
        _ => [0.0, 0.0, 1.0],
    }
}

fn upsert_interaction(
    entries: &mut Vec<ScriptBuilderMagneticInteractionEntry>,
    next: ScriptBuilderMagneticInteractionEntry,
) {
    if let Some(index) = entries.iter().position(|entry| entry.kind == next.kind) {
        entries[index] = next;
    } else {
        entries.push(next);
    }
}

fn builder_geometry_name_for_object(object: &SceneObject) -> String {
    if object.name.trim().is_empty() {
        object.id.clone()
    } else {
        object.name.clone()
    }
}

fn material_id_for_geometry(name: &str) -> String {
    format!("mat:{name}")
}

fn magnetization_id_for_geometry(name: &str) -> String {
    format!("mag:{name}")
}

fn magnetization_asset_from_geometry(
    name: &str,
    magnetization: &ScriptBuilderMagnetizationState,
) -> MagnetizationAsset {
    let normalized = canonicalize_script_builder_magnetization(magnetization);
    MagnetizationAsset {
        id: magnetization_id_for_geometry(name),
        name: format!("{} magnetization", name),
        kind: normalized.kind,
        value: normalized.value,
        seed: normalized.seed,
        source_path: normalized.source_path,
        source_format: normalized.source_format,
        dataset: normalized.dataset,
        sample_index: normalized.sample_index,
        mapping: normalized.mapping.unwrap_or_default(),
        texture_transform: normalized.texture_transform.unwrap_or_default(),
        preset_kind: normalized.preset_kind,
        preset_params: normalized.preset_params,
        preset_version: normalized.preset_version,
        ui_label: normalized.ui_label,
    }
}

fn script_builder_magnetization_from_asset(
    asset: &MagnetizationAsset,
) -> ScriptBuilderMagnetizationState {
    canonicalize_script_builder_magnetization(&ScriptBuilderMagnetizationState {
        kind: asset.kind.clone(),
        value: asset.value.clone(),
        seed: asset.seed,
        source_path: asset.source_path.clone(),
        source_format: asset.source_format.clone(),
        dataset: asset.dataset.clone(),
        sample_index: asset.sample_index,
        mapping: Some(asset.mapping.clone()),
        texture_transform: Some(asset.texture_transform.clone()),
        preset_kind: asset.preset_kind.clone(),
        preset_params: asset.preset_params.clone(),
        preset_version: asset.preset_version,
        ui_label: asset.ui_label.clone(),
    })
}

fn normalize_vec3(value: Option<&Vec<f64>>, fallback: [f64; 3]) -> Vec<f64> {
    let values = value.filter(|values| values.len() >= 3);
    vec![
        values
            .and_then(|values| values.first().copied())
            .unwrap_or(fallback[0]),
        values
            .and_then(|values| values.get(1).copied())
            .unwrap_or(fallback[1]),
        values
            .and_then(|values| values.get(2).copied())
            .unwrap_or(fallback[2]),
    ]
}

fn preset_params_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn preset_direction_params(
    preset_params: Option<&Value>,
    legacy_value: Option<&Vec<f64>>,
) -> Value {
    let direction = preset_params_object(preset_params)
        .and_then(|params| params.get("direction"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .take(3)
                .map(|value| value.as_f64().unwrap_or(0.0))
                .collect::<Vec<_>>()
        })
        .filter(|values| values.len() == 3);
    serde_json::json!({
        "direction": direction.unwrap_or_else(|| normalize_vec3(legacy_value, [1.0, 0.0, 0.0])),
    })
}

fn preset_random_seed_params(preset_params: Option<&Value>, legacy_seed: Option<u64>) -> Value {
    let seed = preset_params_object(preset_params)
        .and_then(|params| params.get("seed"))
        .and_then(Value::as_u64)
        .or(legacy_seed)
        .unwrap_or(1);
    serde_json::json!({ "seed": seed })
}

fn canonicalize_script_builder_magnetization(
    magnetization: &ScriptBuilderMagnetizationState,
) -> ScriptBuilderMagnetizationState {
    let normalized_kind = if magnetization.kind == "file"
        && (magnetization.dataset.is_some() || magnetization.sample_index.is_some())
    {
        "sampled"
    } else {
        magnetization.kind.as_str()
    };
    match normalized_kind {
        "uniform" => ScriptBuilderMagnetizationState {
            kind: "preset_texture".to_string(),
            value: None,
            seed: None,
            source_path: None,
            source_format: None,
            dataset: None,
            sample_index: None,
            mapping: Some(magnetization.mapping.clone().unwrap_or_default()),
            texture_transform: Some(magnetization.texture_transform.clone().unwrap_or_default()),
            preset_kind: Some("uniform".to_string()),
            preset_params: Some(preset_direction_params(
                magnetization.preset_params.as_ref(),
                magnetization.value.as_ref(),
            )),
            preset_version: Some(magnetization.preset_version.unwrap_or(1)),
            ui_label: Some(
                magnetization
                    .ui_label
                    .clone()
                    .unwrap_or_else(|| "Uniform".to_string()),
            ),
        },
        "random" | "random_seeded" => ScriptBuilderMagnetizationState {
            kind: "preset_texture".to_string(),
            value: None,
            seed: None,
            source_path: None,
            source_format: None,
            dataset: None,
            sample_index: None,
            mapping: Some(magnetization.mapping.clone().unwrap_or_default()),
            texture_transform: Some(magnetization.texture_transform.clone().unwrap_or_default()),
            preset_kind: Some("random".to_string()),
            preset_params: Some(preset_random_seed_params(
                magnetization.preset_params.as_ref(),
                magnetization.seed,
            )),
            preset_version: Some(magnetization.preset_version.unwrap_or(1)),
            ui_label: Some(
                magnetization
                    .ui_label
                    .clone()
                    .unwrap_or_else(|| "Random".to_string()),
            ),
        },
        "preset_texture" => {
            let preset_kind = magnetization
                .preset_kind
                .clone()
                .unwrap_or_else(|| "uniform".to_string());
            let preset_params = match preset_kind.as_str() {
                "uniform" => preset_direction_params(
                    magnetization.preset_params.as_ref(),
                    magnetization.value.as_ref(),
                ),
                "random" | "random_seeded" => preset_random_seed_params(
                    magnetization.preset_params.as_ref(),
                    magnetization.seed,
                ),
                _ => magnetization
                    .preset_params
                    .clone()
                    .unwrap_or_else(|| Value::Object(Map::new())),
            };
            ScriptBuilderMagnetizationState {
                kind: "preset_texture".to_string(),
                value: None,
                seed: None,
                source_path: None,
                source_format: None,
                dataset: None,
                sample_index: None,
                mapping: Some(magnetization.mapping.clone().unwrap_or_default()),
                texture_transform: Some(
                    magnetization.texture_transform.clone().unwrap_or_default(),
                ),
                preset_kind: Some(preset_kind.clone()),
                preset_params: Some(preset_params),
                preset_version: Some(magnetization.preset_version.unwrap_or(1)),
                ui_label: Some(magnetization.ui_label.clone().unwrap_or_else(|| {
                    if preset_kind == "uniform" {
                        "Uniform".to_string()
                    } else if preset_kind == "random" || preset_kind == "random_seeded" {
                        "Random".to_string()
                    } else {
                        preset_kind.clone()
                    }
                })),
            }
        }
        "file" | "sampled" => ScriptBuilderMagnetizationState {
            kind: "sampled".to_string(),
            value: None,
            seed: None,
            source_path: magnetization.source_path.clone(),
            source_format: magnetization.source_format.clone(),
            dataset: magnetization.dataset.clone(),
            sample_index: magnetization.sample_index,
            mapping: Some(magnetization.mapping.clone().unwrap_or_default()),
            texture_transform: Some(magnetization.texture_transform.clone().unwrap_or_default()),
            preset_kind: None,
            preset_params: None,
            preset_version: None,
            ui_label: magnetization.ui_label.clone(),
        },
        _ => magnetization.clone(),
    }
}

fn canonicalize_magnetization_asset(asset: &MagnetizationAsset) -> MagnetizationAsset {
    let normalized = canonicalize_script_builder_magnetization(&ScriptBuilderMagnetizationState {
        kind: asset.kind.clone(),
        value: asset.value.clone(),
        seed: asset.seed,
        source_path: asset.source_path.clone(),
        source_format: asset.source_format.clone(),
        dataset: asset.dataset.clone(),
        sample_index: asset.sample_index,
        mapping: Some(asset.mapping.clone()),
        texture_transform: Some(asset.texture_transform.clone()),
        preset_kind: asset.preset_kind.clone(),
        preset_params: asset.preset_params.clone(),
        preset_version: asset.preset_version,
        ui_label: asset.ui_label.clone(),
    });
    MagnetizationAsset {
        id: asset.id.clone(),
        name: asset.name.clone(),
        kind: normalized.kind,
        value: normalized.value,
        seed: normalized.seed,
        source_path: normalized.source_path,
        source_format: normalized.source_format,
        dataset: normalized.dataset,
        sample_index: normalized.sample_index,
        mapping: normalized.mapping.unwrap_or_default(),
        texture_transform: normalized.texture_transform.unwrap_or_default(),
        preset_kind: normalized.preset_kind,
        preset_params: normalized.preset_params,
        preset_version: normalized.preset_version,
        ui_label: normalized.ui_label,
    }
}

fn split_top_level_translation(value: &Value) -> (Value, [f64; 3]) {
    let mut translation = [0.0, 0.0, 0.0];
    let mut params = match value {
        Value::Object(map) => map.clone(),
        _ => return (value.clone(), translation),
    };
    for key in ["translation", "translate"] {
        if let Some(raw) = params.remove(key) {
            if let Some(vec3) = read_vec3(&raw) {
                translation = vec3;
                break;
            }
        }
    }
    (Value::Object(params), translation)
}

fn strip_translation_fields(value: &mut Value) {
    if let Value::Object(map) = value {
        map.remove("translation");
        map.remove("translate");
    }
}

fn insert_translation(value: &mut Value, translation: [f64; 3]) {
    match value {
        Value::Object(map) => {
            map.insert(
                "translation".to_string(),
                Value::Array(translation.into_iter().map(Value::from).collect()),
            );
        }
        _ => {
            let mut map = Map::new();
            map.insert(
                "translation".to_string(),
                Value::Array(translation.into_iter().map(Value::from).collect()),
            );
            *value = Value::Object(map);
        }
    }
}

fn read_vec3(value: &Value) -> Option<[f64; 3]> {
    match value {
        Value::Array(values) if values.len() == 3 => Some([
            values[0].as_f64()?,
            values[1].as_f64()?,
            values[2].as_f64()?,
        ]),
        _ => None,
    }
}

fn is_zero_vec3(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| component.abs() <= f64::EPSILON)
}

fn is_identity_quaternion(value: [f64; 4]) -> bool {
    value[0].abs() <= f64::EPSILON
        && value[1].abs() <= f64::EPSILON
        && value[2].abs() <= f64::EPSILON
        && (value[3].abs() - 1.0).abs() <= f64::EPSILON
}

fn is_identity_scale(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| (*component - 1.0).abs() <= f64::EPSILON)
}

fn string_or_null(value: &str) -> Value {
    if value.trim().is_empty() {
        Value::Null
    } else {
        Value::String(value.to_string())
    }
}

fn parse_optional_text_f64(raw: &str) -> Value {
    raw.trim()
        .parse::<f64>()
        .ok()
        .map_or(Value::Null, Value::from)
}

fn parse_transition_distance_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("airbox_boundary") {
        return Value::String("airbox_boundary".to_string());
    }
    parse_optional_text_f64(trimmed)
}

fn parse_optional_text_f64_or_auto(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("auto") {
        return Value::String("auto".to_string());
    }
    parse_optional_text_f64(trimmed)
}

fn parse_optional_text_u64(raw: &str) -> Value {
    raw.trim()
        .parse::<u64>()
        .ok()
        .map_or(Value::Null, Value::from)
}

impl From<crate::SceneRegionFrame> for fullmag_ir::RegionFrameIR {
    fn from(frame: crate::SceneRegionFrame) -> Self {
        match frame {
            crate::SceneRegionFrame::Object => fullmag_ir::RegionFrameIR::Object,
            crate::SceneRegionFrame::World => fullmag_ir::RegionFrameIR::World,
        }
    }
}

impl From<crate::SceneRegionRealizationPolicy> for fullmag_ir::RegionRealizationPolicyIR {
    fn from(policy: crate::SceneRegionRealizationPolicy) -> Self {
        match policy {
            crate::SceneRegionRealizationPolicy::Inherit => {
                fullmag_ir::RegionRealizationPolicyIR::Inherit
            }
            crate::SceneRegionRealizationPolicy::Conformal => {
                fullmag_ir::RegionRealizationPolicyIR::Conformal
            }
            crate::SceneRegionRealizationPolicy::Project => {
                fullmag_ir::RegionRealizationPolicyIR::Project
            }
        }
    }
}

impl From<crate::SceneRegionMeshPolicy> for fullmag_ir::RegionMeshPolicyIR {
    fn from(policy: crate::SceneRegionMeshPolicy) -> Self {
        fullmag_ir::RegionMeshPolicyIR {
            maximum_element_size: policy.maximum_element_size,
            minimum_element_size: policy.minimum_element_size,
            transition_distance: policy.transition_distance,
            order: policy.order,
        }
    }
}

impl From<crate::SceneMaterialTransitionScope> for fullmag_ir::MaterialTransitionScopeIR {
    fn from(scope: crate::SceneMaterialTransitionScope) -> Self {
        match scope {
            crate::SceneMaterialTransitionScope::Boundary => {
                fullmag_ir::MaterialTransitionScopeIR::Boundary
            }
            crate::SceneMaterialTransitionScope::Inside => {
                fullmag_ir::MaterialTransitionScopeIR::Inside
            }
            crate::SceneMaterialTransitionScope::Outside => {
                fullmag_ir::MaterialTransitionScopeIR::Outside
            }
        }
    }
}

impl From<crate::SceneMaterialTransition> for fullmag_ir::MaterialTransitionSpecIR {
    fn from(transition: crate::SceneMaterialTransition) -> Self {
        match transition {
            crate::SceneMaterialTransition::MeshRelative { cells, scope } => {
                fullmag_ir::MaterialTransitionSpecIR::MeshRelative {
                    cells,
                    scope: scope.into(),
                }
            }
            crate::SceneMaterialTransition::Metric { width, scope } => {
                fullmag_ir::MaterialTransitionSpecIR::Metric {
                    width,
                    scope: scope.into(),
                }
            }
            crate::SceneMaterialTransition::Sharp => fullmag_ir::MaterialTransitionSpecIR::Sharp,
        }
    }
}

impl From<crate::SceneMaterialParameterName> for fullmag_ir::MaterialParameterNameIR {
    fn from(name: crate::SceneMaterialParameterName) -> Self {
        match name {
            crate::SceneMaterialParameterName::Ms => fullmag_ir::MaterialParameterNameIR::Ms,
            crate::SceneMaterialParameterName::Aex => fullmag_ir::MaterialParameterNameIR::Aex,
            crate::SceneMaterialParameterName::Alpha => fullmag_ir::MaterialParameterNameIR::Alpha,
            crate::SceneMaterialParameterName::Ku1 => fullmag_ir::MaterialParameterNameIR::Ku1,
            crate::SceneMaterialParameterName::Ku2 => fullmag_ir::MaterialParameterNameIR::Ku2,
            crate::SceneMaterialParameterName::AnisotropyAxis => {
                fullmag_ir::MaterialParameterNameIR::AnisotropyAxis
            }
            crate::SceneMaterialParameterName::Kc1 => fullmag_ir::MaterialParameterNameIR::Kc1,
            crate::SceneMaterialParameterName::Kc2 => fullmag_ir::MaterialParameterNameIR::Kc2,
            crate::SceneMaterialParameterName::Kc3 => fullmag_ir::MaterialParameterNameIR::Kc3,
            crate::SceneMaterialParameterName::Dind => fullmag_ir::MaterialParameterNameIR::Dind,
            crate::SceneMaterialParameterName::Dbulk => fullmag_ir::MaterialParameterNameIR::Dbulk,
        }
    }
}

impl From<crate::SceneMaterialFieldLocation> for fullmag_ir::MaterialFieldLocationIR {
    fn from(loc: crate::SceneMaterialFieldLocation) -> Self {
        match loc {
            crate::SceneMaterialFieldLocation::Cell => fullmag_ir::MaterialFieldLocationIR::Cell,
            crate::SceneMaterialFieldLocation::Node => fullmag_ir::MaterialFieldLocationIR::Node,
            crate::SceneMaterialFieldLocation::Element => {
                fullmag_ir::MaterialFieldLocationIR::Element
            }
            crate::SceneMaterialFieldLocation::Quadrature => {
                fullmag_ir::MaterialFieldLocationIR::Quadrature
            }
        }
    }
}

impl From<crate::SceneMaterialParameterField> for fullmag_ir::MaterialParameterFieldIR {
    fn from(field: crate::SceneMaterialParameterField) -> Self {
        match field {
            crate::SceneMaterialParameterField::Constant { value, unit } => {
                fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::to_value(value).unwrap(),
                    unit,
                }
            }
            crate::SceneMaterialParameterField::Linear {
                base,
                gradient,
                frame,
                unit,
            } => fullmag_ir::MaterialParameterFieldIR::Linear {
                base,
                gradient,
                frame: frame.into(),
                unit,
            },
            crate::SceneMaterialParameterField::Radial {
                center,
                radius,
                inside,
                outside,
                frame,
                unit,
            } => fullmag_ir::MaterialParameterFieldIR::Radial {
                center,
                radius,
                inside,
                outside,
                frame: frame.into(),
                unit,
            },
            crate::SceneMaterialParameterField::Sampled {
                asset_id,
                component_count,
                location,
                unit,
            } => fullmag_ir::MaterialParameterFieldIR::Sampled {
                asset_id,
                component_count,
                location: location.into(),
                unit,
            },
        }
    }
}

impl From<crate::SceneRegionConflictPolicy> for fullmag_ir::RegionConflictPolicyIR {
    fn from(policy: crate::SceneRegionConflictPolicy) -> Self {
        match policy {
            crate::SceneRegionConflictPolicy::Error => fullmag_ir::RegionConflictPolicyIR::Error,
            crate::SceneRegionConflictPolicy::HigherPriorityWins => {
                fullmag_ir::RegionConflictPolicyIR::HigherPriorityWins
            }
            crate::SceneRegionConflictPolicy::MinMeshSizeWins => {
                fullmag_ir::RegionConflictPolicyIR::MinMeshSizeWins
            }
        }
    }
}

impl From<crate::SceneRegionMaterialOverride> for fullmag_ir::RegionMaterialOverrideIR {
    fn from(o: crate::SceneRegionMaterialOverride) -> Self {
        fullmag_ir::RegionMaterialOverrideIR {
            parameter: o.parameter.into(),
            value: o.value.into(),
            priority: o.priority,
            conflict_policy: o.conflict_policy.into(),
        }
    }
}

impl From<crate::SceneTextureMapping> for fullmag_ir::TextureMappingIR {
    fn from(m: crate::SceneTextureMapping) -> Self {
        let projection = match m.projection.trim().to_ascii_lowercase().as_str() {
            "planar_xy" | "planarxy" => fullmag_ir::TextureProjectionMode::PlanarXy,
            "planar_xz" | "planarxz" => fullmag_ir::TextureProjectionMode::PlanarXz,
            "planar_yz" | "planaryz" => fullmag_ir::TextureProjectionMode::PlanarYz,
            _ => fullmag_ir::TextureProjectionMode::ObjectLocal,
        };
        fullmag_ir::TextureMappingIR {
            space: m.space,
            projection,
            clamp_mode: m.clamp_mode,
        }
    }
}

impl From<crate::SceneTextureTransform3D> for fullmag_ir::TextureTransform3DIR {
    fn from(t: crate::SceneTextureTransform3D) -> Self {
        fullmag_ir::TextureTransform3DIR {
            translation: t.translation,
            rotation_quat: t.rotation_quat,
            scale: t.scale,
            pivot: t.pivot,
        }
    }
}

impl From<crate::SceneInitialMagnetization> for fullmag_ir::InitialMagnetizationIR {
    fn from(mag: crate::SceneInitialMagnetization) -> Self {
        match mag {
            crate::SceneInitialMagnetization::Uniform { value } => {
                fullmag_ir::InitialMagnetizationIR::Uniform { value }
            }
            crate::SceneInitialMagnetization::RandomSeeded { seed } => {
                fullmag_ir::InitialMagnetizationIR::RandomSeeded { seed }
            }
            crate::SceneInitialMagnetization::SampledField { values } => {
                fullmag_ir::InitialMagnetizationIR::SampledField { values }
            }
            crate::SceneInitialMagnetization::PresetTexture {
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
            } => fullmag_ir::InitialMagnetizationIR::PresetTexture {
                preset_kind,
                preset_params,
                mapping: mapping.into(),
                texture_transform: texture_transform.into(),
            },
        }
    }
}

impl From<crate::SceneTextureOverride> for fullmag_ir::RegionTextureOverrideIR {
    fn from(o: crate::SceneTextureOverride) -> Self {
        fullmag_ir::RegionTextureOverrideIR {
            initial_magnetization: o.initial_magnetization.into(),
        }
    }
}

impl From<crate::SceneRegionShape> for fullmag_ir::RegionShapeIR {
    fn from(shape: crate::SceneRegionShape) -> Self {
        match shape {
            crate::SceneRegionShape::Box { size, center } => {
                fullmag_ir::RegionShapeIR::Box { size, center }
            }
            crate::SceneRegionShape::Cylinder {
                radius,
                height,
                center,
                axis,
            } => fullmag_ir::RegionShapeIR::Cylinder {
                radius,
                height,
                center,
                axis,
            },
            crate::SceneRegionShape::Sphere { radius, center } => {
                fullmag_ir::RegionShapeIR::Sphere { radius, center }
            }
            crate::SceneRegionShape::Csg { expression } => {
                fullmag_ir::RegionShapeIR::Csg { expression }
            }
        }
    }
}

impl From<crate::SceneObjectRegion> for fullmag_ir::ObjectRegionIR {
    fn from(r: crate::SceneObjectRegion) -> Self {
        fullmag_ir::ObjectRegionIR {
            region_id: r.region_id,
            owner_object: r.owner_object,
            name: r.name,
            shape: r.shape.into(),
            frame: r.frame.into(),
            enabled: r.enabled,
            priority: r.priority,
            mesh_policy: r.mesh_policy.map(Into::into),
            material_overrides: r.material_overrides.into_iter().map(Into::into).collect(),
            texture_override: r.texture_override.map(Into::into),
            material_transition: r.material_transition.map(Into::into),
            realization_policy: r.realization_policy.into(),
        }
    }
}

impl From<crate::SceneMaterialParameterAssignment> for fullmag_ir::MaterialParameterAssignmentIR {
    fn from(a: crate::SceneMaterialParameterAssignment) -> Self {
        fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: a.assignment_id,
            owner_object: a.owner_object,
            region_id: a.region_id,
            parameter: a.parameter.into(),
            value: a.value.into(),
            priority: a.priority,
            conflict_policy: a.conflict_policy.into(),
        }
    }
}

impl From<crate::SceneCouplingKind> for fullmag_ir::CouplingKindIR {
    fn from(k: crate::SceneCouplingKind) -> Self {
        match k {
            crate::SceneCouplingKind::Exchange => fullmag_ir::CouplingKindIR::Exchange,
            crate::SceneCouplingKind::Rkky => fullmag_ir::CouplingKindIR::Rkky,
            crate::SceneCouplingKind::InterlayerExchange => {
                fullmag_ir::CouplingKindIR::InterlayerExchange
            }
        }
    }
}

impl From<crate::SceneCouplingEndpoint> for fullmag_ir::CouplingEndpointIR {
    fn from(ep: crate::SceneCouplingEndpoint) -> Self {
        match ep {
            crate::SceneCouplingEndpoint::Object { object } => {
                fullmag_ir::CouplingEndpointIR::Object { object }
            }
            crate::SceneCouplingEndpoint::Region { object, region_id } => {
                fullmag_ir::CouplingEndpointIR::Region { object, region_id }
            }
            crate::SceneCouplingEndpoint::Surface { object, selector } => {
                fullmag_ir::CouplingEndpointIR::Surface { object, selector }
            }
        }
    }
}

impl From<crate::SceneExchangeCouplingMode> for fullmag_ir::ExchangeCouplingModeIR {
    fn from(mode: crate::SceneExchangeCouplingMode) -> Self {
        match mode {
            crate::SceneExchangeCouplingMode::HarmonicMean => {
                fullmag_ir::ExchangeCouplingModeIR::HarmonicMean
            }
            crate::SceneExchangeCouplingMode::Explicit => {
                fullmag_ir::ExchangeCouplingModeIR::Explicit
            }
            crate::SceneExchangeCouplingMode::Disabled => {
                fullmag_ir::ExchangeCouplingModeIR::Disabled
            }
        }
    }
}

impl From<crate::SceneCouplingParameters> for fullmag_ir::CouplingParametersIR {
    fn from(params: crate::SceneCouplingParameters) -> Self {
        match params {
            crate::SceneCouplingParameters::Exchange {
                mode,
                scale,
                inter_exchange,
            } => fullmag_ir::CouplingParametersIR::Exchange {
                mode: mode.into(),
                scale,
                inter_exchange,
            },
            crate::SceneCouplingParameters::Rkky { j1 } => {
                fullmag_ir::CouplingParametersIR::Rkky { j1 }
            }
            crate::SceneCouplingParameters::InterlayerExchange { j1, j2 } => {
                fullmag_ir::CouplingParametersIR::InterlayerExchange { j1, j2 }
            }
        }
    }
}

impl From<crate::SceneCouplingCapabilityPolicy> for fullmag_ir::CouplingCapabilityPolicyIR {
    fn from(policy: crate::SceneCouplingCapabilityPolicy) -> Self {
        match policy {
            crate::SceneCouplingCapabilityPolicy::RequireRuntime => {
                fullmag_ir::CouplingCapabilityPolicyIR::RequireRuntime
            }
            crate::SceneCouplingCapabilityPolicy::AuthoredOnly => {
                fullmag_ir::CouplingCapabilityPolicyIR::AuthoredOnly
            }
        }
    }
}

impl From<crate::SceneCoupling> for fullmag_ir::CouplingIR {
    fn from(c: crate::SceneCoupling) -> Self {
        fullmag_ir::CouplingIR {
            coupling_id: c.coupling_id,
            kind: c.kind.into(),
            source: c.source.into(),
            target: c.target.into(),
            enabled: c.enabled,
            parameters: c.parameters.into(),
            capability_policy: c.capability_policy.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MacroStageNode, PrimitiveStageNode, ScriptBuilderAdaptiveTimestepState,
        ScriptBuilderCurrentModuleState, ScriptBuilderDriveState, ScriptBuilderInitialState,
        ScriptBuilderMagneticInteractionEntry, ScriptBuilderMagneticInteractionKind,
        ScriptBuilderMaterialState, ScriptBuilderMeshOperationState,
        ScriptBuilderMeshSizeFieldState, ScriptBuilderMeshState, ScriptBuilderPerGeometryMeshState,
        ScriptBuilderSolverState, ScriptBuilderStageState, ScriptBuilderUniverseState,
        StudyMacroStageKind, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
        StudyPrimitiveStageKind,
    };

    #[test]
    fn per_geometry_transition_distance_sentinels_survive_override_projection() {
        let mesh = ScriptBuilderPerGeometryMeshState {
            transition_distance: Some("airbox_boundary".to_string()),
            edge_transition_distance: Some("airbox_boundary".to_string()),
            corner_transition_distance: Some("airbox_boundary".to_string()),
            ..ScriptBuilderPerGeometryMeshState::default()
        };

        let projected = geometry_mesh_override_value(&mesh);
        assert_eq!(projected["transition_distance"], "airbox_boundary");
        assert_eq!(projected["edge_transition_distance"], "airbox_boundary");
        assert_eq!(projected["corner_transition_distance"], "airbox_boundary");
    }

    #[test]
    fn scene_document_round_trips_typed_regional_field_drives() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "field_drives": {
                "drives": [{
                    "kind": "regional",
                    "id": "pulse",
                    "name": "Pulse",
                    "target": { "kind": "global" },
                    "spatial_profile": { "kind": "uniform" },
                    "amplitude_B_T": 0.001,
                    "direction": [0.0, 1.0, 0.0],
                    "waveform": { "kind": "constant", "value": 1.0 },
                    "time_origin": "stage_local",
                    "activation": { "kind": "stage_ids", "stage_ids": ["run-1"] }
                }]
            }
        });

        let scene: SceneDocument = serde_json::from_value(value).expect("typed scene should parse");
        assert_eq!(scene.field_drives.drives[0].id, "pulse");
        let encoded = serde_json::to_value(scene).expect("typed scene should serialize");
        assert_eq!(
            encoded["field_drives"]["drives"][0]["target"]["kind"],
            "global"
        );
    }

    fn sample_builder() -> ScriptBuilderState {
        ScriptBuilderState {
            revision: 7,
            backend: Some("fem".to_string()),
            requested_mode: Some("strict".to_string()),
            cpu_threads: Some(8),
            fem_demag_solver_policy: Some(fullmag_ir::FemLinearSolverPolicy::default()),
            exchange_enabled: true,
            demag_enabled: true,
            demag_realization: Some("airbox_robin".to_string()),
            external_field: Some([0.0, 0.0, 0.015]),
            solver: ScriptBuilderSolverState {
                integrator: "rk45".to_string(),
                fixed_timestep: "1e-15".to_string(),
                relax_algorithm: "llg_overdamped".to_string(),
                torque_tolerance: "1e-6".to_string(),
                energy_tolerance: String::new(),
                max_relax_steps: "1000".to_string(),
                ..ScriptBuilderSolverState::default()
            },
            mesh: ScriptBuilderMeshState {
                algorithm_2d: 6,
                algorithm_3d: 1,
                size_mode: Some("predefined".to_string()),
                hmax: "20e-9".to_string(),
                hmin: String::new(),
                maximum_element_size: Some("20e-9".to_string()),
                minimum_element_size: Some(String::new()),
                calibrate_for: Some("general_physics".to_string()),
                size_preset: Some("normal".to_string()),
                size_factor: 1.0,
                size_from_curvature: 0,
                curvature_factor: Some(String::new()),
                growth_rate: String::new(),
                maximum_element_growth_rate: Some(String::new()),
                narrow_regions: 0,
                narrow_region_resolution: Some(String::new()),
                resolved_size_from_curvature: None,
                resolved_narrow_regions: None,
                resolved_growth_rate: None,
                smoothing_steps: 1,
                optimize: "Netgen".to_string(),
                optimize_iterations: 2,
                compute_quality: true,
                per_element_quality: false,
                interface_hmax: None,
                interface_thickness: None,
                transition_distance: None,
                transition_growth: None,
                adaptive_enabled: false,
                adaptive_policy: "auto".to_string(),
                adaptive_indicator: Some("geometric_only".to_string()),
                adaptive_target_quantity: Some("auto".to_string()),
                adaptive_convergence_metric: Some("energy_delta".to_string()),
                adaptive_theta: 0.3,
                adaptive_h_min: String::new(),
                adaptive_h_max: String::new(),
                adaptive_max_passes: 2,
                adaptive_error_tolerance: "1e-3".to_string(),
            },
            universe: Some(ScriptBuilderUniverseState {
                mode: "auto".to_string(),
                size: None,
                center: Some([0.0, 0.0, 0.0]),
                padding: Some([100e-9, 120e-9, 140e-9]),
                airbox_hmax: Some(60e-9),
                airbox_hmin: Some(12e-9),
                airbox_growth_rate: Some(1.35),
                airbox_grading: Some("linear".to_string()),
            }),
            domain_frame: None,
            stages: vec![ScriptBuilderStageState {
                kind: "run".to_string(),
                entrypoint_kind: "study".to_string(),
                integrator: "rk45".to_string(),
                fixed_timestep: String::new(),
                adaptive_timestep: None,
                until_seconds: "1e-9".to_string(),
                relax_algorithm: String::new(),
                torque_tolerance: String::new(),
                energy_tolerance: String::new(),
                max_steps: String::new(),
                eigen_count: String::new(),
                eigen_target: String::new(),
                eigen_include_demag: false,
                eigen_equilibrium_source: String::new(),
                eigen_normalization: String::new(),
                eigen_target_frequency: String::new(),
                eigen_damping_policy: String::new(),
                eigen_k_vector: String::new(),
                eigen_spin_wave_bc: String::new(),
                eigen_spin_wave_bc_config: None,
                extra: BTreeMap::new(),
            }],
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive(PrimitiveStageNode {
                        id: "stage_1_relax".to_string(),
                        label: "Relax".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some(StudyPipelineNodeSource::UiAuthored),
                        stage_kind: StudyPrimitiveStageKind::Relax,
                        payload: BTreeMap::from([
                            ("kind".to_string(), serde_json::json!("relax")),
                            (
                                "relax_algorithm".to_string(),
                                serde_json::json!("llg_overdamped"),
                            ),
                        ]),
                    }),
                    StudyPipelineNode::Macro(MacroStageNode {
                        id: "stage_2_relax_run".to_string(),
                        label: "Relax -> Run".to_string(),
                        enabled: true,
                        notes: Some("Warmup sweep".to_string()),
                        source: Some(StudyPipelineNodeSource::UiAuthored),
                        macro_kind: StudyMacroStageKind::RelaxRun,
                        config: BTreeMap::from([(
                            "run_until_seconds".to_string(),
                            serde_json::json!("1e-9"),
                        )]),
                    }),
                ],
            }),
            initial_state: Some(ScriptBuilderInitialState {
                magnet_name: Some("flower".to_string()),
                source_path: "/tmp/m0.ovf".to_string(),
                format: "ovf".to_string(),
                dataset: Some("values".to_string()),
                sample_index: Some(0),
            }),
            geometries: vec![ScriptBuilderGeometryEntry {
                name: "flower".to_string(),
                region_name: Some("core".to_string()),
                geometry_kind: "ImportedGeometry".to_string(),
                geometry_params: serde_json::json!({
                    "source": "flower.stl",
                    "units": "nm",
                    "translation": [1.0, 2.0, 3.0],
                }),
                bounds_min: Some([-1.0, -2.0, -3.0]),
                bounds_max: Some([1.0, 2.0, 3.0]),
                material: ScriptBuilderMaterialState {
                    ms: Some(752e3),
                    aex: Some(15.5e-12),
                    alpha: 0.1,
                    dind: None,
                    dbulk: None,
                },
                magnetization: ScriptBuilderMagnetizationState {
                    kind: "sampled".to_string(),
                    value: None,
                    seed: None,
                    source_path: Some("m0.ovf".to_string()),
                    source_format: Some("ovf".to_string()),
                    dataset: Some("values".to_string()),
                    sample_index: Some(3),
                    mapping: None,
                    texture_transform: None,
                    preset_kind: None,
                    preset_params: None,
                    preset_version: None,
                    ui_label: None,
                },
                physics_stack: vec![
                    ScriptBuilderMagneticInteractionEntry {
                        kind: ScriptBuilderMagneticInteractionKind::Exchange,
                        enabled: true,
                        params: None,
                    },
                    ScriptBuilderMagneticInteractionEntry {
                        kind: ScriptBuilderMagneticInteractionKind::Demag,
                        enabled: true,
                        params: None,
                    },
                    ScriptBuilderMagneticInteractionEntry {
                        kind: ScriptBuilderMagneticInteractionKind::InterfacialDmi,
                        enabled: true,
                        params: Some(serde_json::json!({ "dind": 2.5e-3 })),
                    },
                    ScriptBuilderMagneticInteractionEntry {
                        kind: ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy,
                        enabled: true,
                        params: Some(serde_json::json!({
                            "ku1": 4.2e4,
                            "axis": [0.0, 0.0, 1.0],
                        })),
                    },
                ],
                mesh: Some(ScriptBuilderPerGeometryMeshState {
                    mode: "custom".to_string(),
                    size_mode: Some("custom".to_string()),
                    hmax: "10e-9".to_string(),
                    hmin: String::new(),
                    maximum_element_size: Some("10e-9".to_string()),
                    minimum_element_size: Some(String::new()),
                    calibrate_for: Some("general_physics".to_string()),
                    size_preset: Some("normal".to_string()),
                    mesh_strategy: Some("swept_prism".to_string()),
                    order: Some(1),
                    through_thickness_elements: Some(1),
                    through_thickness_distribution: Some("fixed".to_string()),
                    through_thickness_element_ratio: None,
                    through_thickness_symmetric: None,
                    sweep_face_meshing: Some("triangular".to_string()),
                    topology: None,
                    sweep_direction: Some("auto".to_string()),
                    element_family: Some("prism".to_string()),
                    transition_policy: Some("reject".to_string()),
                    exact_layer_count: Some(true),
                    source: None,
                    algorithm_2d: Some(6),
                    algorithm_3d: Some(10),
                    size_factor: Some(0.8),
                    size_from_curvature: Some(16),
                    curvature_factor: Some(String::new()),
                    growth_rate: "1.6".to_string(),
                    maximum_element_growth_rate: Some("1.6".to_string()),
                    narrow_regions: Some(2),
                    narrow_region_resolution: Some(String::new()),
                    resolved_size_from_curvature: None,
                    resolved_narrow_regions: None,
                    resolved_growth_rate: None,
                    smoothing_steps: Some(3),
                    optimize: Some("Netgen".to_string()),
                    optimize_iterations: Some(4),
                    compute_quality: Some(true),
                    per_element_quality: Some(false),
                    bulk_hmax: None,
                    bulk_hmin: None,
                    interface_hmax: None,
                    interface_thickness: None,
                    edge_hmax: Some("8e-9".to_string()),
                    edge_thickness: Some("20e-9".to_string()),
                    edge_transition_distance: Some("30e-9".to_string()),
                    corner_hmax: Some("5e-9".to_string()),
                    corner_extent: Some("12e-9".to_string()),
                    corner_transition_distance: Some("24e-9".to_string()),
                    transition_distance: None,
                    transition_growth: None,
                    size_fields: vec![ScriptBuilderMeshSizeFieldState {
                        kind: "Ball".to_string(),
                        params: serde_json::json!({ "VIn": 1e-9 }),
                    }],
                    operations: vec![ScriptBuilderMeshOperationState {
                        kind: "smooth".to_string(),
                        params: serde_json::json!({ "iterations": 2 }),
                    }],
                    build_requested: true,
                }),
                object_regions: vec![crate::SceneObjectRegion {
                    region_id: "flower:r1".to_string(),
                    owner_object: "flower".to_string(),
                    name: "hole_refinement".to_string(),
                    shape: crate::SceneRegionShape::Cylinder {
                        radius: 40e-9,
                        height: 30e-9,
                        center: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0],
                    },
                    frame: crate::SceneRegionFrame::Object,
                    enabled: true,
                    priority: 10,
                    mesh_policy: Some(crate::SceneRegionMeshPolicy {
                        maximum_element_size: Some(5e-9),
                        minimum_element_size: Some(2e-9),
                        transition_distance: Some(30e-9),
                        order: Some(1),
                    }),
                    material_overrides: Vec::new(),
                    texture_override: None,
                    material_transition: None,
                    realization_policy: crate::SceneRegionRealizationPolicy::Inherit,
                }],
                allocated_region_ids: vec!["flower:r1".to_string()],
                material_parameter_fields: Vec::new(),
            }],
            mesh_interfaces: vec![ScriptBuilderMeshInterfaceState {
                interface_id: "object:flower|air".to_string(),
                owner_a: "object:flower".to_string(),
                owner_b: "air".to_string(),
                config: ScriptBuilderPerGeometryMeshState {
                    mode: "custom".to_string(),
                    size_mode: Some("custom".to_string()),
                    hmax: String::new(),
                    hmin: String::new(),
                    maximum_element_size: None,
                    minimum_element_size: None,
                    calibrate_for: None,
                    size_preset: None,
                    mesh_strategy: None,
                    order: None,
                    through_thickness_elements: None,
                    through_thickness_distribution: None,
                    through_thickness_element_ratio: None,
                    through_thickness_symmetric: None,
                    sweep_face_meshing: None,
                    topology: None,
                    sweep_direction: None,
                    element_family: None,
                    transition_policy: None,
                    exact_layer_count: None,
                    source: None,
                    algorithm_2d: None,
                    algorithm_3d: None,
                    size_factor: None,
                    size_from_curvature: None,
                    curvature_factor: None,
                    growth_rate: String::new(),
                    maximum_element_growth_rate: None,
                    narrow_regions: None,
                    narrow_region_resolution: None,
                    resolved_size_from_curvature: None,
                    resolved_narrow_regions: None,
                    resolved_growth_rate: None,
                    smoothing_steps: None,
                    optimize: None,
                    optimize_iterations: None,
                    compute_quality: None,
                    per_element_quality: None,
                    bulk_hmax: None,
                    bulk_hmin: None,
                    interface_hmax: Some("4e-9".to_string()),
                    interface_thickness: Some("8e-9".to_string()),
                    edge_hmax: None,
                    edge_thickness: None,
                    edge_transition_distance: None,
                    corner_hmax: None,
                    corner_extent: None,
                    corner_transition_distance: None,
                    transition_distance: Some("24e-9".to_string()),
                    transition_growth: Some(1.2),
                    size_fields: Vec::new(),
                    operations: Vec::new(),
                    build_requested: false,
                },
            }],
            field_drives: Vec::new(),
            planar_monitors: Vec::new(),
            current_modules: vec![ScriptBuilderCurrentModuleState {
                kind: "antenna_field_source".to_string(),
                name: "cpw_1".to_string(),
                solver: "mqs_2p5d_az".to_string(),
                air_box_factor: 12.0,
                antenna_kind: "CPWAntenna".to_string(),
                antenna_params: serde_json::json!({ "gap": 1e-6 }),
                drive: ScriptBuilderDriveState {
                    current_a: 0.01,
                    frequency_hz: Some(10e9),
                    phase_rad: 0.0,
                    waveform: None,
                },
            }],
            excitation_analysis: Some(crate::ScriptBuilderExcitationAnalysisState {
                source: "cpw_1".to_string(),
                method: "dispersion".to_string(),
                propagation_axis: [1.0, 0.0, 0.0],
                k_max_rad_per_m: Some(1e7),
                samples: 256,
            }),
        }
    }

    #[test]
    fn scene_document_round_trips_script_builder_state() {
        let builder = sample_builder();
        let scene = scene_document_from_script_builder(&builder);
        let round_trip = scene_document_to_script_builder(&scene).expect("scene should validate");

        assert_eq!(scene.version, "scene.v2");
        assert_eq!(round_trip.revision, builder.revision);
        assert_eq!(round_trip.backend, builder.backend);
        assert_eq!(round_trip.external_field, builder.external_field);
        assert_eq!(round_trip.solver, builder.solver);
        assert_eq!(round_trip.mesh, builder.mesh);
        assert_eq!(round_trip.universe, builder.universe);
        assert_eq!(round_trip.study_pipeline, builder.study_pipeline);
        assert_eq!(round_trip.mesh_interfaces, builder.mesh_interfaces);
        assert_eq!(round_trip.initial_state, builder.initial_state);
        assert_eq!(round_trip.current_modules, builder.current_modules);
        assert_eq!(round_trip.excitation_analysis, builder.excitation_analysis);
        assert_eq!(
            round_trip.geometries[0].physics_stack,
            builder.geometries[0].physics_stack
        );
        assert_eq!(
            scene.objects[0].regions[0].name,
            builder.geometries[0].object_regions[0].name
        );
        assert_eq!(
            round_trip.geometries[0].object_regions,
            builder.geometries[0].object_regions
        );
        assert_eq!(
            round_trip.geometries[0].allocated_region_ids,
            builder.geometries[0].allocated_region_ids
        );
        assert_eq!(
            round_trip.geometries[0]
                .mesh
                .as_ref()
                .and_then(|mesh| mesh.mesh_strategy.as_deref()),
            Some("swept_prism")
        );
        assert_eq!(
            round_trip.geometries[0]
                .mesh
                .as_ref()
                .and_then(|mesh| mesh.through_thickness_elements),
            Some(1)
        );
        assert_eq!(
            round_trip.geometries[0]
                .mesh
                .as_ref()
                .and_then(|mesh| mesh.sweep_face_meshing.as_deref()),
            Some("triangular")
        );
        assert_eq!(
            round_trip.geometries[0].geometry_params.get("translation"),
            Some(&serde_json::json!([1.0, 2.0, 3.0]))
        );
        assert_eq!(round_trip.geometries[0].magnetization.kind, "sampled");
        assert_eq!(
            scene
                .study
                .study_pipeline
                .as_ref()
                .map(|document| document.version.as_str()),
            Some("study_pipeline.v1")
        );
    }

    #[test]
    fn scene_document_round_trips_requested_prismatic_layered_mesh_fields() {
        let mut builder = sample_builder();
        let mesh = builder.geometries[0].mesh.as_mut().unwrap();
        mesh.topology = Some("prismatic".to_string());
        mesh.sweep_direction = Some("auto".to_string());
        mesh.element_family = Some("prism".to_string());
        mesh.transition_policy = Some("pyramid_to_tetrahedra".to_string());
        mesh.exact_layer_count = Some(true);

        let scene = scene_document_from_script_builder(&builder);
        let projection = scene_document_problem_projection(&scene)
            .expect("requested layered mesh should project");
        let mesh = projection.builder.geometries[0].mesh.as_ref().unwrap();

        assert_eq!(mesh.topology.as_deref(), Some("prismatic"));
        assert_eq!(mesh.sweep_direction.as_deref(), Some("auto"));
        assert_eq!(mesh.element_family.as_deref(), Some("prism"));
        assert_eq!(
            mesh.transition_policy.as_deref(),
            Some("pyramid_to_tetrahedra")
        );
        assert_eq!(mesh.exact_layer_count, Some(true));
        assert_eq!(
            projection.rewrite_overrides["geometries"][0]["mesh"]["exact_layer_count"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn scene_document_rejects_invalid_requested_layered_mesh_before_projection() {
        let mut cases = Vec::new();

        let mut zero_layers = sample_builder();
        zero_layers.geometries[0]
            .mesh
            .as_mut()
            .unwrap()
            .through_thickness_elements = Some(0);
        cases.push(zero_layers);

        let mut high_order = sample_builder();
        let mesh = high_order.geometries[0].mesh.as_mut().unwrap();
        mesh.topology = Some("prismatic".to_string());
        mesh.element_family = Some("prism".to_string());
        mesh.transition_policy = Some("pyramid_to_tetrahedra".to_string());
        mesh.exact_layer_count = Some(true);
        mesh.order = Some(2);
        cases.push(high_order);

        let mut contradictory_hex = sample_builder();
        let mesh = contradictory_hex.geometries[0].mesh.as_mut().unwrap();
        mesh.element_family = Some("hex".to_string());
        mesh.sweep_face_meshing = Some("quadrilateral".to_string());
        mesh.transition_policy = Some("pyramid_to_tetrahedra".to_string());
        mesh.exact_layer_count = Some(true);
        cases.push(contradictory_hex);

        let mut unknown_transition = sample_builder();
        unknown_transition.geometries[0]
            .mesh
            .as_mut()
            .unwrap()
            .transition_policy = Some("unknown".to_string());
        cases.push(unknown_transition);

        for builder in cases {
            let scene = scene_document_from_script_builder(&builder);
            let error = scene_document_problem_projection(&scene)
                .expect_err("invalid requested layered mesh must fail before projection");
            assert!(error.message.contains("mesh"), "{}", error.message);
        }
    }

    #[test]
    fn scene_document_only_rejects_inexact_prismatic_intent_in_explicit_strict_mode() {
        let mut builder = sample_builder();
        let mesh = builder.geometries[0].mesh.as_mut().unwrap();
        mesh.topology = Some("prismatic".to_string());
        mesh.element_family = Some("prism".to_string());
        mesh.transition_policy = Some("pyramid_to_tetrahedra".to_string());
        mesh.exact_layer_count = Some(false);

        let mut scene = scene_document_from_script_builder(&builder);
        scene.study.requested_mode = "extended".to_string();
        scene_document_problem_projection(&scene)
            .expect("extended mode should preserve inexact requested prism intent");

        scene.study.requested_mode = "strict".to_string();
        let error = scene_document_problem_projection(&scene)
            .expect_err("explicit strict mode should reject inexact requested prism intent");
        assert!(
            error.message.contains("exact_layer_count=true"),
            "{}",
            error.message
        );

        scene.study.requested_mode = "hybrid".to_string();
        let error = scene_document_problem_projection(&scene)
            .expect_err("hybrid mode should reject inexact requested prism intent");
        assert!(
            error.message.contains("exact_layer_count=true"),
            "{}",
            error.message
        );

        scene.study.requested_mode = "unknown".to_string();
        let error = scene_document_problem_projection(&scene)
            .expect_err("unknown requested mode must fail closed");
        assert!(
            error.message.contains("requested_mode"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_projection_preserves_canonical_fixed_and_adaptive_solver_policies() {
        let mut fixed = sample_builder();
        fixed.solver.fixed_timestep = "2e-15".to_string();
        fixed.solver.dt_initial.clear();
        fixed.solver.dt_min.clear();
        fixed.solver.dt_max.clear();
        fixed.solver.max_err.clear();
        fixed.solver.adaptive_timestep = None;

        let fixed_scene = scene_document_from_script_builder(&fixed);
        let fixed_projection = scene_document_problem_projection(&fixed_scene)
            .expect("fixed solver policy should project");
        assert_eq!(
            fixed_projection.rewrite_overrides["solver"]["fixed_timestep"],
            serde_json::json!(2e-15)
        );
        assert_eq!(
            scene_document_to_script_builder(&fixed_scene)
                .expect("fixed scene should round-trip")
                .solver,
            fixed.solver
        );

        let mut adaptive = sample_builder();
        adaptive.solver.integrator = "rk45".to_string();
        adaptive.solver.fixed_timestep.clear();
        adaptive.solver.dt_initial.clear();
        adaptive.solver.dt_min = "1e-16".to_string();
        adaptive.solver.dt_max.clear();
        adaptive.solver.max_err = "1e-6".to_string();
        adaptive.solver.adaptive_timestep = None;

        let adaptive_scene = scene_document_from_script_builder(&adaptive);
        let adaptive_projection = scene_document_problem_projection(&adaptive_scene)
            .expect("adaptive solver policy should project");
        assert_eq!(
            adaptive_projection.rewrite_overrides["solver"]["dt_initial"],
            serde_json::Value::Null
        );
        assert_eq!(
            adaptive_projection.rewrite_overrides["solver"]["dt_max"],
            serde_json::Value::Null
        );
        assert_eq!(
            adaptive_projection.rewrite_overrides["solver"]["max_err"],
            serde_json::json!(1e-6)
        );
        assert_eq!(
            scene_document_to_script_builder(&adaptive_scene)
                .expect("adaptive scene should round-trip")
                .solver,
            adaptive.solver
        );

        let mut advanced = sample_builder();
        advanced.solver.integrator = "rk45".to_string();
        advanced.solver.fixed_timestep.clear();
        advanced.solver.adaptive_timestep = Some(ScriptBuilderAdaptiveTimestepState {
            tolerance_mode: "advanced".to_string(),
            atol: "1e-8".to_string(),
            rtol: "1e-5".to_string(),
            dt_initial: String::new(),
            dt_min: "1e-16".to_string(),
            dt_max: "1e-13".to_string(),
            safety: "0.9".to_string(),
            growth_limit: "2".to_string(),
            shrink_limit: "0.2".to_string(),
            max_spin_rotation: String::new(),
            norm_tolerance: String::new(),
        });
        let advanced_scene = scene_document_from_script_builder(&advanced);
        let advanced_projection = scene_document_problem_projection(&advanced_scene)
            .expect("advanced solver policy should project");
        assert_eq!(
            advanced_projection.rewrite_overrides["solver"]["adaptive_timestep"]["dt_initial"],
            serde_json::Value::Null
        );
        assert_eq!(
            advanced_projection.rewrite_overrides["solver"]["adaptive_timestep"]["atol"],
            serde_json::json!(1e-8)
        );
        assert_eq!(
            advanced_projection.rewrite_overrides["solver"]["adaptive_timestep"]["rtol"],
            serde_json::json!(1e-5)
        );
    }

    #[test]
    fn scene_projection_rejects_conflicting_and_malformed_solver_policy() {
        let mut conflict = sample_builder();
        conflict.solver.fixed_timestep = "1e-15".to_string();
        conflict.solver.dt_min = "1e-16".to_string();
        conflict.solver.dt_max = "1e-14".to_string();
        conflict.solver.max_err = "1e-6".to_string();
        let error =
            scene_document_problem_projection(&scene_document_from_script_builder(&conflict))
                .expect_err("fixed and adaptive scene state must fail closed");
        assert!(error.message.contains("mutually exclusive"));

        let mut malformed = sample_builder();
        malformed.solver.fixed_timestep = "not-a-number".to_string();
        let error =
            scene_document_problem_projection(&scene_document_from_script_builder(&malformed))
                .expect_err("malformed present numerics must not normalize to null");
        assert!(error.message.contains("fixed_timestep"));
    }

    #[test]
    fn scene_projection_exports_edited_stage_adaptive_policy() {
        let builder = sample_builder();
        let mut encoded = serde_json::to_value(builder).unwrap();
        encoded["stages"][0]["integrator"] = serde_json::json!("rk45");
        encoded["stages"][0]["fixed_timestep"] = serde_json::json!("");
        encoded["stages"][0]["adaptive_timestep"] = serde_json::json!({
            "atol": "1e-8",
            "rtol": "1e-5",
            "dt_initial": "",
            "dt_min": "1e-16",
            "dt_max": "1e-13",
            "safety": "0.9",
            "growth_limit": "2.0",
            "shrink_limit": "0.2"
        });
        let builder: ScriptBuilderState = serde_json::from_value(encoded).unwrap();
        let projection =
            scene_document_problem_projection(&scene_document_from_script_builder(&builder))
                .expect("valid stage adaptive policy should project");
        assert_eq!(
            projection.rewrite_overrides["stages"][0]["adaptive_timestep"]["dt_max"],
            serde_json::json!(1e-13)
        );
        assert_eq!(
            projection.rewrite_overrides["stages"][0]["adaptive_timestep"]["rtol"],
            serde_json::json!(1e-5)
        );
    }

    #[test]
    fn scene_document_validation_rejects_missing_refs() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.objects[0].material_ref = "missing".to_string();
        let error =
            scene_document_to_script_builder(&scene).expect_err("missing material must fail");
        assert!(error.message.contains("missing material"));

        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.objects[0].magnetization_ref = None;
        let error = scene_document_to_script_builder(&scene)
            .expect_err("missing magnetization ref must fail");
        assert!(error
            .message
            .contains("must reference a magnetization asset"));
    }

    #[test]
    fn scene_document_validation_rejects_owner_rotation_and_scale_until_fdm_support_exists() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.objects[0].transform.rotation_quat =
            [0.0, 0.0, 0.7071067811865476, 0.7071067811865476];
        scene.objects[0].transform.scale = [2.0, 1.0, 1.0];
        let error = scene_document_to_script_builder(&scene)
            .expect_err("owner rotation/scale must not be silently dropped");
        assert!(error
            .message
            .contains("owner_transform_rotation_scale_unsupported"));
    }

    #[test]
    fn scene_document_validation_accepts_preset_texture_asset_kind() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.magnetization_assets[0].kind = "preset_texture".to_string();
        scene.magnetization_assets[0].mapping.clamp_mode = "none".to_string();
        scene.magnetization_assets[0].preset_kind = Some("vortex".to_string());
        scene.magnetization_assets[0].preset_params = Some(serde_json::json!({
            "circulation": 1,
            "core_polarity": 1,
            "core_radius": 10e-9,
            "plane": "xy"
        }));
        scene.magnetization_assets[0].preset_version = Some(1);
        scene.magnetization_assets[0].ui_label = Some("Vortex".to_string());
        let builder = scene_document_to_script_builder(&scene)
            .expect("preset_texture magnetization kind should validate");
        assert_eq!(builder.geometries[0].magnetization.kind, "preset_texture");
    }

    #[test]
    fn scene_document_validation_rejects_unsupported_asset_kind() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.magnetization_assets[0].kind = "procedural".to_string();
        let error = scene_document_to_script_builder(&scene)
            .expect_err("unsupported magnetization kind must fail");
        assert!(error
            .message
            .contains("unsupported magnetization asset kind"));
    }

    #[test]
    fn scene_problem_projection_uses_scene_revision() {
        let scene = scene_document_from_script_builder(&sample_builder());
        let projection =
            scene_document_problem_projection(&scene).expect("problem projection should build");
        assert_eq!(projection.builder.revision, scene.revision);
        assert_eq!(
            projection
                .rewrite_overrides
                .get("study_pipeline")
                .and_then(Value::as_object)
                .and_then(|value| value.get("version"))
                .and_then(Value::as_str),
            Some("study_pipeline.v1")
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("external_field")
                .and_then(Value::as_array)
                .and_then(|values| values.get(2))
                .and_then(Value::as_f64),
            Some(0.015)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("universe")
                .and_then(Value::as_object)
                .and_then(|value| value.get("airbox_hmax"))
                .and_then(Value::as_f64),
            Some(60e-9)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("universe")
                .and_then(Value::as_object)
                .and_then(|value| value.get("airbox_grading"))
                .and_then(Value::as_str),
            Some("linear")
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("magnetization"))
                .and_then(Value::as_object)
                .and_then(|mag| mag.get("mapping"))
                .and_then(Value::as_object)
                .and_then(|mapping| mapping.get("space"))
                .and_then(Value::as_str),
            Some("object")
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("magnetization"))
                .and_then(Value::as_object)
                .and_then(|mag| mag.get("texture_transform"))
                .and_then(Value::as_object)
                .and_then(|transform| transform.get("translation"))
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_f64),
            Some(0.0)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("mesh"))
                .and_then(Value::as_object)
                .and_then(|mesh| mesh.get("mesh_strategy"))
                .and_then(Value::as_str),
            Some("swept_prism")
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("mesh"))
                .and_then(Value::as_object)
                .and_then(|mesh| mesh.get("through_thickness_elements"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("mesh"))
                .and_then(Value::as_object)
                .and_then(|mesh| mesh.get("edge_maximum_element_size"))
                .and_then(Value::as_f64),
            Some(8e-9)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("mesh"))
                .and_then(Value::as_object)
                .and_then(|mesh| mesh.get("corner_maximum_element_size"))
                .and_then(Value::as_f64),
            Some(5e-9)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("object_regions"))
                .and_then(Value::as_array)
                .and_then(|regions| regions.first())
                .and_then(Value::as_object)
                .and_then(|region| region.get("region_id"))
                .and_then(Value::as_str),
            Some("flower:r1")
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("geometries")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|geo| geo.get("allocated_region_ids"))
                .and_then(Value::as_array)
                .and_then(|region_ids| region_ids.first())
                .and_then(Value::as_str),
            Some("flower:r1")
        );
    }

    #[test]
    fn scene_problem_projection_preserves_scene_couplings_for_script_rewrite() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.couplings.push(crate::SceneCoupling {
            coupling_id: "exchange:flower-core".to_string(),
            kind: crate::SceneCouplingKind::Exchange,
            source: crate::SceneCouplingEndpoint::Region {
                object: "flower".to_string(),
                region_id: "flower:r1".to_string(),
            },
            target: crate::SceneCouplingEndpoint::Object {
                object: "flower".to_string(),
            },
            enabled: true,
            parameters: crate::SceneCouplingParameters::Exchange {
                mode: crate::SceneExchangeCouplingMode::HarmonicMean,
                scale: Some(0.75),
                inter_exchange: None,
            },
            capability_policy: crate::SceneCouplingCapabilityPolicy::AuthoredOnly,
        });

        let projection =
            scene_document_problem_projection(&scene).expect("problem projection should build");
        let couplings = projection
            .rewrite_overrides
            .get("couplings")
            .and_then(Value::as_array)
            .expect("rewrite overrides should include scene couplings");

        assert_eq!(couplings.len(), 1);
        assert_eq!(couplings[0]["coupling_id"], "exchange:flower-core");
        assert_eq!(couplings[0]["source"]["region_id"], "flower:r1");
        assert_eq!(couplings[0]["parameters"]["scale"], 0.75);
        assert_eq!(couplings[0]["capability_policy"], "authored_only");
    }

    #[test]
    fn scene_document_round_trips_disabled_effective_field_terms() {
        let mut builder = sample_builder();
        builder.exchange_enabled = false;
        builder.demag_enabled = false;
        builder.geometries[0].physics_stack[0].enabled = false;
        builder.geometries[0].physics_stack[1].enabled = false;

        let scene = scene_document_from_script_builder(&builder);
        assert_eq!(scene.study.exchange_enabled, false);
        assert_eq!(scene.study.demag_enabled, false);
        assert_eq!(scene.objects[0].physics_stack[0].enabled, false);
        assert_eq!(scene.objects[0].physics_stack[1].enabled, false);

        let projection =
            scene_document_problem_projection(&scene).expect("problem projection should build");
        assert_eq!(projection.builder.exchange_enabled, false);
        assert_eq!(projection.builder.demag_enabled, false);
        assert_eq!(
            projection
                .rewrite_overrides
                .get("exchange_enabled")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            projection
                .rewrite_overrides
                .get("demag_enabled")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn scene_document_bootstraps_mesh_editor_defaults() {
        let scene = scene_document_from_script_builder(&sample_builder());

        assert_eq!(scene.editor.object_view_mode.as_deref(), Some("context"));
        assert_eq!(scene.editor.air_mesh_visible, Some(true));
        assert_eq!(scene.editor.air_mesh_opacity, Some(28.0));
        assert_eq!(scene.editor.selected_entity_id, None);
        assert_eq!(scene.editor.focused_entity_id, None);
        assert!(scene.editor.mesh_entity_view_state.is_empty());
    }

    #[test]
    fn scene_document_validation_rejects_unsupported_study_pipeline_version() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene
            .study
            .study_pipeline
            .as_mut()
            .expect("sample builder should contain study pipeline")
            .version = "study_pipeline.v0".to_string();
        let error = scene_document_to_script_builder(&scene)
            .expect_err("unsupported study pipeline version must fail");
        assert!(error.message.contains("unsupported study pipeline version"));
    }

    #[test]
    fn scene_document_validation_accepts_legacy_scene_v1() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        scene.version = "scene.v1".to_string();
        scene.couplings.clear();
        for object in &mut scene.objects {
            object.regions.clear();
            object.allocated_region_ids.clear();
            object.material_parameter_fields.clear();
        }

        scene_document_to_script_builder(&scene).expect("legacy scene.v1 should validate");
    }

    #[test]
    fn scene_problem_projection_fills_missing_study_pipeline_labels_from_ids() {
        let mut scene = scene_document_from_script_builder(&sample_builder());
        let pipeline = scene
            .study
            .study_pipeline
            .as_mut()
            .expect("sample builder should contain study pipeline");
        let StudyPipelineNode::Primitive(first_node) = pipeline
            .nodes
            .first_mut()
            .expect("sample builder should have at least one study node")
        else {
            panic!("first study node should be primitive");
        };
        first_node.label = "  ".to_string();
        let expected_id = first_node.id.clone();

        let projection =
            scene_document_problem_projection(&scene).expect("problem projection should build");
        let projected_pipeline = projection
            .builder
            .study_pipeline
            .expect("projection should include study pipeline");
        let StudyPipelineNode::Primitive(projected_first_node) = projected_pipeline
            .nodes
            .first()
            .expect("projected pipeline should keep first node")
        else {
            panic!("first projected study node should be primitive");
        };
        assert_eq!(projected_first_node.label, expected_id);
    }

    #[test]
    fn scene_document_round_trips_planar_monitors_without_view_state() {
        let mut builder = sample_builder();
        builder.planar_monitors = vec![fullmag_ir::PlanarMonitorIR {
            id: "midplane".into(),
            name: "Midplane".into(),
            target: fullmag_ir::MonitorTargetIR::Object {
                object_id: builder.geometries[0].name.clone(),
            },
            frame: fullmag_ir::PlanarFrameIR::axis_preset(
                fullmag_ir::PlanarFramePresetIR::Xy,
                0.0,
                fullmag_ir::PlanarExtentIR::TargetBounds { padding_m: 1e-9 },
            ),
            operator: fullmag_ir::PlanarOperatorIR::SlabAverage { thickness_m: 5e-9 },
        }];

        let scene = scene_document_from_script_builder(&builder);
        let round_trip =
            scene_document_to_script_builder(&scene).expect("monitor scene must validate");

        assert_eq!(scene.monitors.planar, builder.planar_monitors);
        assert_eq!(round_trip.planar_monitors, builder.planar_monitors);
        let encoded = serde_json::to_value(scene).unwrap();
        assert!(encoded["monitors"]["planar"][0].get("quantity").is_none());
        assert!(encoded["monitors"]["planar"][0].get("resolution").is_none());
    }
}

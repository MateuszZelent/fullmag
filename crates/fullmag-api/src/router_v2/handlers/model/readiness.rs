use std::collections::BTreeSet;
use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::types::{AppState, SessionStateResponse};

const TRANSFORM_CAPABILITY_REASON: &str =
    "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadinessCheckState {
    Complete,
    Blocked,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelReadinessCheck {
    pub id: String,
    pub state: ModelReadinessCheckState,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelAuthoringCapability {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelAuthoringCapabilities {
    #[serde(rename = "move")]
    pub move_object: ModelAuthoringCapability,
    pub rotate: ModelAuthoringCapability,
    pub scale: ModelAuthoringCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelReadinessResource {
    pub scene_revision: u64,
    pub ready_to_run: bool,
    pub ready_to_export: bool,
    pub checks: Vec<ModelReadinessCheck>,
    pub blockers: Vec<String>,
    pub capabilities: ModelAuthoringCapabilities,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/readiness",
    responses(
        (status = 200, description = "Derived readiness of the current canonical authoring model", body = ModelReadinessResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_model_readiness(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ModelReadinessResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let snapshot = state.current_live_state.read().await;
    let snapshot = snapshot
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local session"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene document"))?;
    Ok(Json(build_model_readiness(snapshot, scene)))
}

fn build_model_readiness(
    snapshot: &SessionStateResponse,
    scene: &fullmag_authoring::SceneDocument,
) -> ModelReadinessResource {
    let solve_objects = fullmag_authoring::scene_solve_objects(scene).collect::<Vec<_>>();
    let textures = scene
        .magnetization_assets
        .iter()
        .map(|texture| texture.id.as_str())
        .collect::<BTreeSet<_>>();

    let geometry = presence_check(
        "geometry",
        "Geometry",
        !solve_objects.is_empty(),
        "model/scene",
        "Add at least one magnetic object.",
    );
    let missing_material_object = solve_objects.iter().find(|object| {
        fullmag_authoring::resolve_scene_object_solve_material(scene, object).is_err()
    });
    let material_error = solve_objects.iter().find_map(|object| {
        fullmag_authoring::resolve_scene_object_solve_material(scene, object)
            .err()
            .map(|error| error.to_string())
    });
    let material = presence_check(
        "material",
        "Material",
        !solve_objects.is_empty() && material_error.is_none(),
        &missing_material_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/materials".into()),
        material_error
            .as_deref()
            .unwrap_or("Assign a material to every magnetic object."),
    );
    let missing_texture_object = solve_objects.iter().find(|object| {
        !object
            .magnetization_ref
            .as_deref()
            .is_some_and(|id| textures.contains(id))
    });
    let texture = presence_check(
        "texture",
        "Initial magnetization",
        !solve_objects.is_empty()
            && solve_objects.iter().all(|object| {
                object
                    .magnetization_ref
                    .as_deref()
                    .is_some_and(|id| textures.contains(id))
            }),
        &missing_texture_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/magnetization-assets".into()),
        "Assign initial magnetization to every magnetic object.",
    );
    let missing_interaction_object = solve_objects
        .iter()
        .find(|object| !object.physics_stack.iter().any(|entry| entry.enabled));
    let interactions = presence_check(
        "interactions",
        "Interactions",
        !solve_objects.is_empty()
            && solve_objects
                .iter()
                .all(|object| object.physics_stack.iter().any(|entry| entry.enabled)),
        &missing_interaction_object
            .map(|object| format!("model/objects/{}", object.id))
            .unwrap_or_else(|| "model/objects/interactions".into()),
        "Enable at least one interaction for every magnetic object.",
    );
    let discretization = discretization_check(snapshot, scene);
    let study = presence_check(
        "study",
        "Study",
        !scene.study.stages.is_empty() || scene.study.study_pipeline.is_some(),
        "model/study",
        "Add at least one study stage.",
    );

    let method = presence_check(
        "method",
        "Simulation method",
        matches!(scene.study.requested_backend.as_str(), "fdm" | "fem"),
        "model/study",
        "Choose FEM or FDM in Study settings.",
    );
    let domain = domain_check(scene);
    let mut execution = presence_check(
        "execution",
        "Execution request",
        matches!(
            scene.study.requested_device.as_str(),
            "auto" | "cpu" | "gpu" | "cuda"
        ),
        "model/study",
        "Choose CPU, GPU or Auto for the next solver run in Study settings.",
    );
    if execution.state == ModelReadinessCheckState::Complete {
        execution.reason = Some("The requested device is configured; engine availability is checked during preparation for each run.".into());
    }
    let mut checks = vec![
        method,
        domain,
        geometry,
        material,
        texture,
        interactions,
        discretization,
        study,
        execution,
    ];
    let validation_error = fullmag_authoring::validate_scene_document(scene)
        .err()
        .map(|error| error.to_string());
    if validation_error.is_none() && solve_objects.is_empty() && prepared_field_only_scene(snapshot, scene) {
        for check in &mut checks {
            let reason = match check.id.as_str() {
                "geometry" => "The prepared field-only operation owns the source conductor geometry.",
                "material" => "The authored current transport supplies the conductor material requirements.",
                "texture" | "interactions" => "This prepared antenna field-only operation has no magnetic state.",
                _ => continue,
            };
            check.state = ModelReadinessCheckState::Complete;
            check.target_resource = Some("model/scene".into());
            check.reason = Some(reason.into());
        }
    }
    let mut blockers = checks
        .iter()
        .filter(|check| check.state != ModelReadinessCheckState::Complete)
        .filter_map(|check| check.reason.clone())
        .collect::<Vec<_>>();
    if let Some(error) = validation_error.as_ref() {
        blockers.push(error.clone());
    }
    let ready_to_run = blockers.is_empty();
    let export_checks_complete = checks
        .iter()
        .filter(|check| {
            matches!(
                check.id.as_str(),
                "geometry" | "material" | "texture" | "interactions"
            )
        })
        .all(|check| check.state == ModelReadinessCheckState::Complete);

    ModelReadinessResource {
        scene_revision: scene.revision,
        ready_to_run,
        ready_to_export: export_checks_complete && validation_error.is_none(),
        checks,
        blockers,
        capabilities: ModelAuthoringCapabilities {
            move_object: ModelAuthoringCapability {
                available: true,
                reason: None,
            },
            rotate: unavailable_transform_capability(),
            scale: unavailable_transform_capability(),
        },
    }
}


fn prepared_field_only_scene(
    snapshot: &SessionStateResponse,
    scene: &fullmag_authoring::SceneDocument,
) -> bool {
    let Some(plan) = crate::router_v2::handlers::meshing::mesh::prepared_field_only_source_mesh(snapshot)
    else { return false; };
    let Some(stage_id) = plan["stage_id"].as_str() else { return false; };
    let Some(stage) = scene.antenna_field_solve_stages.iter().find(|stage| stage.id == stage_id)
    else { return false; };
    if Some(stage.source_object_id.as_str()) != plan["source_object_id"].as_str()
        || !stage.port_mode_ids.iter().any(|id| Some(id.as_str()) == plan["port_mode_id"].as_str())
        || !field_only_stage_has_source(scene, stage)
    {
        return false;
    }
    fn enabled_fields(
        scene: &fullmag_authoring::SceneDocument,
        nodes: &[fullmag_authoring::StudyPipelineNode],
        selected: &str,
        seen: &mut bool,
    ) -> bool {
        nodes.iter().all(|node| match node {
            fullmag_authoring::StudyPipelineNode::Primitive(node) if !node.enabled => true,
            fullmag_authoring::StudyPipelineNode::Primitive(node) => {
                if node.stage_kind != fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve {
                    return false;
                }
                let Some(id) = node.payload.get("stage_id").and_then(serde_json::Value::as_str)
                else { return false; };
                let Some(stage) = scene.antenna_field_solve_stages.iter().find(|stage| stage.id == id)
                else { return false; };
                *seen |= id == selected;
                field_only_stage_has_source(scene, stage)
            }
            fullmag_authoring::StudyPipelineNode::Group(node) =>
                !node.enabled || enabled_fields(scene, &node.children, selected, seen),
            fullmag_authoring::StudyPipelineNode::Macro(node) => !node.enabled,
        })
    }
    let mut selected_enabled = false;
    let only_fields = if let Some(pipeline) = scene.study.study_pipeline.as_ref() {
        enabled_fields(scene, &pipeline.nodes, stage_id, &mut selected_enabled)
    } else {
        scene.study.stages.iter().all(|stage| {
            match stage.extra.get("enabled") {
                Some(serde_json::Value::Bool(false)) => return true,
                None | Some(serde_json::Value::Bool(true)) => {}
                _ => return false,
            }
            if stage.kind != "antenna_field_solve" { return false; }
            let Some(id) = stage.extra.get("stage_id").and_then(serde_json::Value::as_str)
            else { return false; };
            let Some(stage) = scene.antenna_field_solve_stages.iter().find(|stage| stage.id == id)
            else { return false; };
            selected_enabled |= id == stage_id;
            field_only_stage_has_source(scene, stage)
        })
    };
    only_fields && selected_enabled
}

fn field_only_stage_has_source(
    scene: &fullmag_authoring::SceneDocument,
    stage: &fullmag_ir::AntennaFieldSolveStageIR,
) -> bool {
    scene.objects.iter().any(|object| object.id == stage.source_object_id)
        && !stage.port_mode_ids.is_empty()
        && stage.port_mode_ids.iter().all(|id| scene.antenna_port_modes.iter().any(|port|
            port.id == *id && port.source_object_id == stage.source_object_id
                && port.current_transport_id == stage.current_transport_id))
        && scene.current_transports.iter().any(|transport| transport.known().is_some_and(|transport|
            transport.name == stage.current_transport_id
                && transport.domain.iter().any(|region| region.object_id == stage.source_object_id)))
}

fn domain_check(scene: &fullmag_authoring::SceneDocument) -> ModelReadinessCheck {
    let target = if scene.study.requested_backend == "fem" {
        fullmag_authoring::GeometryBackendTarget::Fem
    } else {
        fullmag_authoring::GeometryBackendTarget::Fdm
    };
    let validation = fullmag_authoring::validate_geometry_scene(scene, target);
    let outside = validation.diagnostics.iter().find(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE" | "GEOMETRY_UNIVERSE_INVALID_BOUNDS"
        ) && diagnostic.blocks.iter().any(|block| block == "build_mesh")
    });
    let mut check = presence_check(
        "domain",
        "Domain policy",
        outside.is_none(),
        "meshing/policies/universe",
        outside
            .map(|diagnostic| diagnostic.message.as_str())
            .unwrap_or("Review the domain policy."),
    );
    if check.state == ModelReadinessCheckState::Complete {
        let universe = scene
            .study
            .universe_mesh
            .as_ref()
            .or(scene.universe.as_ref());
        check.reason = Some(
            if universe.is_some_and(|universe| universe.mode == "manual") {
                "Manual domain bounds are configured; mesh and solver requirements are checked separately.".into()
            } else if scene.objects.is_empty() {
                "Automatic bounds will be derived after geometry is added. You can configure manual dimensions now or later.".into()
            } else {
                "Automatic domain policy follows the authored geometry; FEM air requirements depend on the selected physics.".into()
            },
        );
    }
    check
}

fn presence_check(
    id: &str,
    label: &str,
    complete: bool,
    target_resource: &str,
    blocked_reason: &str,
) -> ModelReadinessCheck {
    ModelReadinessCheck {
        id: id.to_string(),
        state: if complete {
            ModelReadinessCheckState::Complete
        } else {
            ModelReadinessCheckState::Blocked
        },
        label: label.to_string(),
        target_resource: Some(target_resource.to_string()),
        reason: (!complete).then(|| blocked_reason.to_string()),
    }
}

fn discretization_check(
    snapshot: &SessionStateResponse,
    scene: &fullmag_authoring::SceneDocument,
) -> ModelReadinessCheck {
    let backend = scene.study.requested_backend.to_ascii_lowercase();
    match backend.as_str() {
        "fdm" => {
            let configured =
                scene.study.fdm.as_ref().is_some_and(|fdm| {
                    fdm.default_cell.is_some() || !fdm.per_object_grid.is_empty()
                });
            presence_check(
                "discretization",
                "Discretization",
                configured,
                "model/study",
                "Configure an FDM grid before running.",
            )
        }
        "fem" => {
            let source_revision =
                crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(snapshot);
            let current = snapshot.fem_mesh.is_some() && source_revision == Some(scene.revision);
            ModelReadinessCheck {
                id: "discretization".to_string(),
                state: if current {
                    ModelReadinessCheckState::Complete
                } else if snapshot.fem_mesh.is_some() {
                    ModelReadinessCheckState::Stale
                } else {
                    ModelReadinessCheckState::Blocked
                },
                label: "Discretization".to_string(),
                target_resource: Some("meshing/builds/current".to_string()),
                reason: (!current)
                    .then(|| "Build a current shared-domain mesh before running.".to_string()),
            }
        }
        _ => presence_check(
            "discretization",
            "Discretization",
            false,
            "model/study",
            "Choose FDM or FEM discretization.",
        ),
    }
}

fn unavailable_transform_capability() -> ModelAuthoringCapability {
    ModelAuthoringCapability {
        available: false,
        reason: Some(TRANSFORM_CAPABILITY_REASON.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Reuses the authored closed-loop regression input, not a solved/qualified fixture.
    fn field_only_scene() -> fullmag_authoring::SceneDocument {
        let mut scene: fullmag_authoring::SceneDocument =
            serde_json::from_str(r#"{"version":"scene.v2","objects":[{"id":"object","name":"loop","role":"antenna","geometry":{"geometry_kind":"MicrostripAntennaLayout","geometry_params":{"length_m":2e-06,"thickness_m":2e-07,"conductivity_s_per_m":58000000,"stations":[{"s":0,"signal_width_m":3e-07},{"s":0.5,"signal_width_m":1e-07},{"s":1,"signal_width_m":3e-07}],"return_width_m":1e-06,"return_offset_m":4e-07,"conductors":[{"id":"signal","kind":"signal"},{"id":"return","kind":"return"}],"terminal_faces":{"signal":{"inlet":"local_u_min","outlet":"local_u_max"},"return":{"inlet":"local_u_min","outlet":"local_u_max"}},"transform":{"rotation_matrix":[[0,-1,0],[1,0,0],[0,0,1]],"translation_m":[0,-1e-06,0]},"loop":{"enabled":true,"inlet_connection_length_m":2e-07,"inlet_connection_width_m":4e-07,"inlet_connection_offset_v_m":0,"inlet_connection_part_id":"inlet","inlet_connection_conductivity_s_per_m":30000000,"outlet_connection_length_m":2e-07,"outlet_connection_width_m":4e-07,"outlet_connection_offset_v_m":0,"outlet_connection_part_id":"outlet","outlet_connection_conductivity_s_per_m":30000000}}},"material_ref":"","magnetization_ref":null,"physics_stack":[],"transform":{"translation":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}],"current_transports":[{"kind":"current_transport","name":"charge","model":"ohmic_poisson","coupling":"one_way","domain":[{"object_id":"object"}],"materials":[{"region":{"object_id":"object","region_id":"signal"},"material":{"sigma_Spm":58000000}},{"region":{"object_id":"object","region_id":"return"},"material":{"sigma_Spm":58000000}},{"region":{"object_id":"object","region_id":"inlet"},"material":{"sigma_Spm":30000000}},{"region":{"object_id":"object","region_id":"outlet"},"material":{"sigma_Spm":30000000}}],"boundaries":[],"gauge":"zero_mean","solver":{"engine":"cg","linear":{"relative_tolerance":1e-12,"absolute_tolerance":0,"max_iterations":10000},"operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"},"structured_current_closure":{"schema_version":"structured_current_closure.v2","closure_id":"object:closed-loop","kind":"closed_geometry","source_cuts":[{"source_cut_id":"object:source-cut:inlet","circuit_id":"object:circuit","region":{"object_id":"object","region_id":"inlet"},"plane":{"coordinate_frame":"object","axis":"z","offset_m":-3e-07,"normal":"positive_axis"},"drive":{"schema_version":"impressed_potential_jump.v1","kind":"impressed_potential_jump","drive_id":"object:source-drive","potential_jump_V":0.25}}]}}]}"#).unwrap();
        let mut sampling = scene.objects[0].clone();
        sampling.id = "sampling".into();
        sampling.name = "Sampling".into();
        sampling.role = "geometry".into();
        sampling.geometry.geometry_kind = "Box".into();
        sampling.geometry.geometry_params = json!({"size":[80e-9,80e-9,80e-9]});
        sampling.transform.translation = [1e-6,0.0,0.3e-6];
        scene.objects.push(sampling);
        scene.revision = 7;
        scene.study.requested_backend = "fem".into();
        scene.study.requested_device = "cpu".into();
        scene.antenna_port_modes = vec![serde_json::from_value(json!({
            "schema_version":"antenna_port_mode.v3","id":"port","source_object_id":"object",
            "current_transport_id":"charge","normalization_current_a":1.0,
            "normalization":{"kind":"source_cut_rt0","source_cut_ref":"object:source-cut:inlet","orientation":"minus_outward"},
            "branches":[
                {"id":"signal","inlet_terminal_ref":"signal_in","outlet_terminal_ref":"signal_out","signed_weight":1.0},
                {"id":"return","inlet_terminal_ref":"return_in","outlet_terminal_ref":"return_out","signed_weight":-1.0}
            ]
        })).unwrap()];
        scene.antenna_field_solve_stages = vec![serde_json::from_value(json!({
            "id":"inspect","source_object_id":"object","current_transport_id":"charge","port_mode_ids":["port"],
            "model":"quasistatic_conduction_biot_savart3d","oersted_realization":"direct_tetra_quadrature",
            "conductor_mesh_policy":"authored_shared_domain","field_sampling_domain":{"kind":"object","object_id":"sampling"},"target_refs":[{"kind":"object","object_id":"sampling"}],
            "solver_policy":"production_default","outputs":[{"id":"inspection","quantity":"H_ant_basis"}]
        })).unwrap()];
        scene.study.study_pipeline = Some(serde_json::from_value(json!({
            "version":"study_pipeline.v1","nodes":[{"node_kind":"primitive","id":"inspect",
                "label":"Inspect","enabled":true,"stage_kind":"antenna_field_solve","payload":{"stage_id":"inspect"}}]
        })).unwrap());
        scene
    }

    fn prepared_snapshot(scene: &fullmag_authoring::SceneDocument) -> SessionStateResponse {
        let request = serde_json::from_value(json!({"session_id":"readiness-field-only"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let mut mesh = fullmag_ir::MeshIR::default();
        mesh.mesh_name = "readiness-source".into();
        mesh.nodes = vec![[0.0,0.0,0.0],[1e-9,0.0,0.0],[0.0,1e-9,0.0],[0.0,0.0,1e-9]];
        mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0,1,2,3]]);
        mesh.element_markers = vec![1];
        let plan = fullmag_ir::AntennaFieldOnlyPlanIR {
            schema_version:"antenna_field_only_plan.v1".into(),stage_id:"inspect".into(),
            port_mode_id:"port".into(),source_object_id:"object".into(),source_mesh:mesh,
            source_object_segments:vec![fullmag_ir::FemObjectSegmentIR {
                object_id:"object".into(),geometry_id:None,node_start:0,node_count:4,
                element_start:0,element_count:1,boundary_face_start:0,boundary_face_count:0,
            }],
            source_mesh_parts:Vec::new(),
            field_sampling:fullmag_ir::AntennaFieldSamplingPlanIR {
                domain:fullmag_ir::FieldTargetIR::Object {object_id:"sampling".into()},carrier_kind:"fem_mesh_asset:sampling".into(),
                location:"node".into(),topology_digest:"a".repeat(64),
                positions_xyz_m:vec![[1e-6,0.0,0.3e-6],[1.02e-6,0.0,0.3e-6],[1e-6,0.02e-6,0.3e-6],[1e-6,0.0,0.32e-6]],cells:fullmag_ir::FemConnectivityIR::from_tet4(vec![[0,1,2,3]]),
            },
        };
        snapshot.fem_mesh = Some(fullmag_runner::StageFemMeshAsset::build_from_antenna_field_only_plan(&plan).payload.into());
        let execution_plan = json!({"backend_plan":fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan)});
        snapshot.scene_document = Some(scene.clone());
        snapshot.metadata = Some(json!({"execution_plan":execution_plan.clone()}).into());
        snapshot.mesh_workspace = Some(json!({
            "schema_version":crate::live_scene_preparation::LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            "preparation_id":"prep-readiness","source_scene_revision":scene.revision,
            "plan_fingerprint":format!("sha256:{}","b".repeat(64)),
            "status":"completed","active_build":null,"last_build_error":null,"execution_plan":execution_plan,
            "accepted_run_id":snapshot.session.run_id,"accepted_step_id":"inspection-step"
        }).into());
        snapshot.simulation_preparation = Some(crate::types::SimulationPreparationSnapshot {
            preparation_id:"prep-readiness".into(),revision:1,status:"ready".into(),active_stage_id:None,
            started_at_unix_ms:1,completed_at_unix_ms:Some(2),stages:Vec::new(),log_tail:Vec::new(),failure:None,
        });
        snapshot
    }

    #[test]
    fn prepared_nonmagnetic_antenna_has_no_llg_prerequisites() {
        let scene = field_only_scene();
        assert!(fullmag_authoring::validate_scene_document(&scene).is_ok());
        assert!(fullmag_authoring::scene_solve_objects(&scene).next().is_none());
        assert!(scene.materials.is_empty() && scene.magnetization_assets.is_empty());
        let snapshot = prepared_snapshot(&scene);
        let readiness = build_model_readiness(&snapshot,&scene);
        assert!(readiness.ready_to_run,"{:?}",readiness.blockers);
        assert!(readiness.ready_to_export);
        assert!(scene.objects.iter().any(|object|object.id=="sampling" && object.visible));
        assert!(snapshot.fem_mesh.as_ref().unwrap().object_segments.iter().all(|segment|segment.object_id!="sampling"));
        assert_eq!(crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(&snapshot),Some(scene.revision));
        for id in ["geometry","material","texture","interactions","discretization"] {
            assert_eq!(readiness.checks.iter().find(|check|check.id==id).unwrap().state,ModelReadinessCheckState::Complete);
        }
    }

    #[test]
    fn field_only_readiness_requires_the_current_prepared_observation() {
        let scene = field_only_scene();
        for change in 0..15 {
            let mut snapshot = prepared_snapshot(&scene);
            match change {
                0 => snapshot.mesh_workspace.as_mut().unwrap()["source_scene_revision"]=json!(scene.revision-1),
                1 => snapshot.mesh_workspace.as_mut().unwrap()["preparation_id"]=json!("other-prep"),
                2 => snapshot.mesh_workspace.as_mut().unwrap()["schema_version"]=json!("legacy"),
                3 => snapshot.mesh_workspace.as_mut().unwrap()["status"]=json!("running"),
                4 => snapshot.simulation_preparation.as_mut().unwrap().status="failed".into(),
                5 => snapshot.metadata.as_mut().unwrap()["execution_plan"]=json!({}),
                6 => snapshot.fem_mesh=None,
                7 => snapshot.mesh_workspace=None,
                8 => snapshot.metadata.as_mut().unwrap()["execution_plan"]["backend_plan"]["source_object_id"]=json!("other"),
                9 => snapshot.fem_mesh.as_mut().unwrap().mesh_name="other".into(),
                10 => snapshot.fem_mesh.as_mut().unwrap().object_segments.clear(),
                11 => snapshot.mesh_workspace.as_mut().unwrap()["accepted_run_id"]=json!("foreign"),
                12 => snapshot.fem_mesh.as_mut().unwrap().generation_id=None,
                13 => snapshot.simulation_preparation.as_mut().unwrap().preparation_id="old".into(),
                _ => snapshot.mesh_workspace.as_mut().unwrap()["accepted_run_id"]=json!(42),
            }
            assert!(!build_model_readiness(&snapshot,&scene).ready_to_run,"change {change}");
            assert_eq!(crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(&snapshot),None,"change {change}");
        }
    }

    #[test]
    fn disabled_field_stage_and_mixed_run_relax_do_not_remove_llg_guards() {
        for kind in ["disabled","run","relax","group"] {
            let mut scene = field_only_scene();
            let mut pipeline = serde_json::to_value(scene.study.study_pipeline.as_ref().unwrap()).unwrap();
            if kind=="disabled" { pipeline["nodes"][0]["enabled"]=json!(false); }
            else if kind=="group" {
                pipeline["nodes"]=json!([{"node_kind":"group","id":"off","label":"Off","enabled":false,
                    "children":pipeline["nodes"].clone()}]);
            } else {
                pipeline["nodes"].as_array_mut().unwrap().push(json!({
                    "node_kind":"primitive","id":"magnetic","label":"Magnetic","enabled":true,"stage_kind":kind
                }));
            }
            scene.study.study_pipeline=Some(serde_json::from_value(pipeline).unwrap());
            let snapshot=prepared_snapshot(&scene);
            assert!(!build_model_readiness(&snapshot,&scene).ready_to_run,"{kind}");
        }
    }

    #[test]
    fn malformed_sources_and_real_magnets_keep_existing_validation() {
        for change in 0..4 {
            let mut scene=field_only_scene();
            match change {
                0 => scene.antenna_field_solve_stages[0].source_object_id="missing".into(),
                1 => scene.antenna_port_modes[0].current_transport_id="other".into(),
                2 => {
                    let mut transport=serde_json::to_value(&scene.current_transports[0]).unwrap();
                    transport["materials"][0]["material"]["sigma_Spm"]=json!(1.0);
                    scene.current_transports[0]=serde_json::from_value(transport).unwrap();
                }
                _ => {
                    let mut magnet=scene.objects[0].clone();
                    magnet.id="magnet".into();magnet.role="magnet".into();
                    scene.objects.push(magnet);
                }
            }
            let snapshot=prepared_snapshot(&scene);
            let readiness=build_model_readiness(&snapshot,&scene);
            assert!(!readiness.ready_to_run,"change {change}");
            if change==3 {
                for id in ["material","texture","interactions"] {
                    assert_eq!(readiness.checks.iter().find(|check|check.id==id).unwrap().state,ModelReadinessCheckState::Blocked);
                }
            }
        }
    }

    #[test]
    fn disabled_magnetic_nodes_and_flat_field_stage_keep_canonical_enablement() {
        let mut scene=field_only_scene();
        let mut pipeline=serde_json::to_value(scene.study.study_pipeline.as_ref().unwrap()).unwrap();
        pipeline["nodes"].as_array_mut().unwrap().push(json!({
            "node_kind":"primitive","id":"off","label":"Off","enabled":false,"stage_kind":"run"
        }));
        scene.study.study_pipeline=Some(serde_json::from_value(pipeline).unwrap());
        assert!(build_model_readiness(&prepared_snapshot(&scene),&scene).ready_to_run);
        scene.study.study_pipeline=None;
        scene.study.stages=vec![serde_json::from_value(json!({
            "kind":"antenna_field_solve","entrypoint_kind":"flat_antenna_field_solve",
            "stage_id":"inspect","enabled":true
        })).unwrap()];
        assert!(build_model_readiness(&prepared_snapshot(&scene),&scene).ready_to_run);
        scene.study.stages[0].extra.insert("enabled".into(),json!(false));
        assert!(!build_model_readiness(&prepared_snapshot(&scene),&scene).ready_to_run);
    }

    #[test]
    fn invalid_field_only_publication_does_not_fall_back_to_clean_source_geometry() {
        let mut scene=field_only_scene();
        scene.objects.retain(|object|object.id!="sampling");
        let mut snapshot=prepared_snapshot(&scene);
        snapshot.simulation_preparation.as_mut().unwrap().status="failed".into();
        assert_eq!(crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(&snapshot),None);
    }
}

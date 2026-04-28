//! Contract tests for the v2 API router.
//!
//! These tests exercise the v2 endpoints through `tower::ServiceExt::oneshot`
//! without starting a real HTTP server.  They verify:
//!
//! - response status codes,
//! - response body shapes / schema compliance,
//! - middleware headers (`x-request-id`, `x-api-contract-version`),
//! - 404 behaviour for missing live state,
//! - unknown-route fallback.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, RwLock};

use crate::feature_flags::FeatureFlags;
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, CurrentDisplaySelection,
    CurrentLiveSnapshotRequest, CurrentWorkspaceLayout, CurrentWorkspaceRibbon,
    CurrentWorkspaceSelection, DisplayPresentationState, LatestFields, LiveState, RunManifest,
    RuntimeLifecycleState, RuntimeStatusView, ScalarRow, SessionCommand, SessionManifest,
    SessionStateResponse, StageExecutionRecord, StageExecutionState, StageLifecycleState,
    StepUpdateView, TrackedCommandRecord,
};
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload, RuntimeStatus};

use super::build_v2_router;
// ─── helpers ────────────────────────────────────────────────────────────────

fn sample_scene_document() -> fullmag_authoring::SceneDocument {
    let builder = fullmag_authoring::ScriptBuilderState {
        revision: 3,
        backend: None,
        cpu_threads: None,
        fem_demag_solver_policy: None,
        demag_realization: None,
        external_field: None,
        solver: fullmag_authoring::ScriptBuilderSolverState {
            integrator: "rk45".to_string(),
            fixed_timestep: String::new(),
            relax_algorithm: String::new(),
            torque_tolerance: "1e-4".to_string(),
            energy_tolerance: String::new(),
            max_relax_steps: "1000".to_string(),
        },
        mesh: fullmag_authoring::ScriptBuilderMeshState {
            algorithm_2d: 6,
            algorithm_3d: 1,
            size_mode: Some("predefined".to_string()),
            hmax: String::new(),
            hmin: String::new(),
            maximum_element_size: Some(String::new()),
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
            optimize: String::new(),
            optimize_iterations: 1,
            compute_quality: false,
            per_element_quality: false,
            interface_hmax: None,
            interface_thickness: None,
            transition_distance: None,
            transition_growth: None,
            adaptive_enabled: false,
            adaptive_policy: "manual".to_string(),
            adaptive_indicator: Some("geometric_only".to_string()),
            adaptive_target_quantity: Some("auto".to_string()),
            adaptive_convergence_metric: Some("energy_delta".to_string()),
            adaptive_theta: 0.3,
            adaptive_h_min: String::new(),
            adaptive_h_max: String::new(),
            adaptive_max_passes: 5,
            adaptive_error_tolerance: String::new(),
        },
        universe: None,
        domain_frame: None,
        stages: Vec::new(),
        study_pipeline: None,
        initial_state: None,
        geometries: vec![fullmag_authoring::ScriptBuilderGeometryEntry {
            name: "body".to_string(),
            region_name: None,
            geometry_kind: "Box".to_string(),
            geometry_params: serde_json::json!({ "size": [1.0, 1.0, 1.0] }),
            bounds_min: None,
            bounds_max: None,
            material: fullmag_authoring::ScriptBuilderMaterialState {
                ms: Some(800e3),
                aex: Some(13e-12),
                alpha: 0.02,
                dind: None,
            },
            magnetization: fullmag_authoring::ScriptBuilderMagnetizationState {
                kind: "preset_texture".to_string(),
                value: None,
                seed: None,
                source_path: None,
                source_format: None,
                dataset: None,
                sample_index: None,
                mapping: None,
                texture_transform: None,
                preset_kind: Some("uniform".to_string()),
                preset_params: Some(serde_json::json!({ "direction": [1.0, 0.0, 0.0] })),
                preset_version: Some(1),
                ui_label: Some("Uniform".to_string()),
            },
            physics_stack: vec![],
            mesh: None,
        }],
        mesh_interfaces: Vec::new(),
        current_modules: Vec::new(),
        excitation_analysis: None,
    };
    fullmag_authoring::scene_document_from_script_builder(&builder)
}

fn sample_fem_mesh_payload() -> FemMeshPayload {
    FemMeshPayload {
        mesh_name: "test-mesh".to_string(),
        mesh_id: "test-mesh:1".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![7],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![3],
        object_segments: vec![FemMeshObjectSegment {
            object_id: "body".to_string(),
            geometry_id: Some("body".to_string()),
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
        }],
        mesh_parts: Vec::new(),
        domain_mesh_mode: Some("shared_domain".to_string()),
        domain_frame: None,
        generation_id: Some("42".to_string()),
        per_domain_quality: Default::default(),
    }
}

fn sample_fem_mesh_payload_with_manifest() -> FemMeshPayload {
    let mut mesh = sample_fem_mesh_payload();
    mesh.mesh_parts = vec![
        FemMeshPartPayload {
            id: "airbox".to_string(),
            label: "airbox".to_string(),
            role: "air".to_string(),
            object_id: None,
            geometry_id: None,
            material_id: None,
            element_start: 0,
            element_count: 0,
            boundary_face_start: 0,
            boundary_face_count: 0,
            boundary_face_indices: vec![],
            node_start: 0,
            node_count: 0,
            node_indices: vec![],
            surface_faces: vec![],
            bounds_min: Some([-1.0, -1.0, -1.0]),
            bounds_max: Some([2.0, 2.0, 2.0]),
        },
        FemMeshPartPayload {
            id: "body".to_string(),
            label: "body".to_string(),
            role: "magnetic_object".to_string(),
            object_id: Some("body".to_string()),
            geometry_id: Some("body".to_string()),
            material_id: Some("mat-body".to_string()),
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
            boundary_face_indices: vec![0],
            node_start: 0,
            node_count: 4,
            node_indices: vec![0, 1, 2, 3],
            surface_faces: vec![[0, 1, 2]],
            bounds_min: Some([0.0, 0.0, 0.0]),
            bounds_max: Some([1.0, 1.0, 1.0]),
        },
    ];
    mesh
}

fn sample_scoped_fem_mesh_payload() -> FemMeshPayload {
    FemMeshPayload {
        mesh_name: "scoped-test-mesh".to_string(),
        mesh_id: "scoped-test-mesh:1".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-1.0, -1.0, -1.0],
            [2.0, -1.0, -1.0],
            [-1.0, 2.0, -1.0],
            [-1.0, -1.0, 2.0],
        ],
        elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
        element_markers: vec![7, 8],
        boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
        boundary_markers: vec![3, 4],
        object_segments: vec![
            FemMeshObjectSegment {
                object_id: "body".to_string(),
                geometry_id: Some("body".to_string()),
                node_start: 0,
                node_count: 4,
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 1,
            },
            FemMeshObjectSegment {
                object_id: "__air__".to_string(),
                geometry_id: None,
                node_start: 4,
                node_count: 4,
                element_start: 1,
                element_count: 1,
                boundary_face_start: 1,
                boundary_face_count: 1,
            },
        ],
        mesh_parts: vec![
            FemMeshPartPayload {
                id: "body".to_string(),
                label: "body".to_string(),
                role: "magnetic_object".to_string(),
                object_id: Some("body".to_string()),
                geometry_id: Some("body".to_string()),
                material_id: Some("mat-body".to_string()),
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 1,
                boundary_face_indices: vec![0],
                node_start: 0,
                node_count: 4,
                node_indices: vec![0, 1, 2, 3],
                surface_faces: vec![[0, 1, 2]],
                bounds_min: Some([0.0, 0.0, 0.0]),
                bounds_max: Some([1.0, 1.0, 1.0]),
            },
            FemMeshPartPayload {
                id: "airbox".to_string(),
                label: "airbox".to_string(),
                role: "air".to_string(),
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_start: 1,
                element_count: 1,
                boundary_face_start: 1,
                boundary_face_count: 1,
                boundary_face_indices: vec![1],
                node_start: 4,
                node_count: 4,
                node_indices: vec![4, 5, 6, 7],
                surface_faces: vec![[4, 5, 6]],
                bounds_min: Some([-1.0, -1.0, -1.0]),
                bounds_max: Some([2.0, 2.0, 2.0]),
            },
        ],
        domain_mesh_mode: Some("shared_domain".to_string()),
        domain_frame: None,
        generation_id: Some("42".to_string()),
        per_domain_quality: Default::default(),
    }
}

/// Minimal `AppState` with no active live session.
fn test_app_state() -> Arc<AppState> {
    let (control_events_tx, _rx) = watch::channel(0u64);

    Arc::new(AppState {
        repo_root: PathBuf::from("."),
        current_workspace_root: PathBuf::from("."),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_realtime_events: tokio::sync::broadcast::channel(16).0,
        current_live_realtime_replay: Arc::new(Mutex::new(VecDeque::new())),
        current_live_realtime_next_seq: Arc::new(AtomicU64::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_display_presentation: Arc::new(RwLock::new(DisplayPresentationState::default())),
        current_workspace_selection: Arc::new(RwLock::new(CurrentWorkspaceSelection::default())),
        current_workspace_ribbon: Arc::new(RwLock::new(CurrentWorkspaceRibbon::default())),
        current_workspace_layout: Arc::new(RwLock::new(CurrentWorkspaceLayout::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_command_responses: Arc::new(Mutex::new(VecDeque::new())),
        current_command_ledger: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: control_events_tx,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        feature_flags: FeatureFlags::default(),
        quantity_data_plane: Arc::new(crate::quantity_data_plane::QuantityDataPlaneStore::new()),
    })
}

/// `AppState` with a minimal live session populated, so endpoints that read
/// from `current_live_state` can return 200.
async fn test_app_state_with_live_session() -> Arc<AppState> {
    let state = test_app_state();

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: ".".into(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        state_version: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    state
}

fn test_router() -> axum::Router {
    build_v2_router().with_state(test_app_state())
}

async fn test_router_with_session() -> axum::Router {
    build_v2_router().with_state(test_app_state_with_live_session().await)
}

async fn test_v2_router_with_session() -> axum::Router {
    build_v2_router().with_state(test_app_state_with_live_session().await)
}

async fn test_router_with_scene_document() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.session.script_path.clear();
    }
    build_v2_router().with_state(state)
}

async fn test_router_with_scene_document_and_script_file() -> (axum::Router, PathBuf) {
    let state = test_app_state_with_live_session().await;
    let script_dir = std::env::temp_dir().join(format!(
        "fullmag-api-router-v1-scene-script-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos(),
    ));
    fs::create_dir_all(&script_dir).expect("failed to create script dir");
    let script_path = script_dir.join("scene.py");
    fs::write(&script_path, "from fullmag import *\n").expect("failed to write test script");

    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.session.script_path = script_path.display().to_string();
    }

    (build_v2_router().with_state(state), script_path)
}

async fn test_router_with_runtime_read_models() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.run = Some(RunManifest {
            run_id: "run-1".into(),
            session_id: snapshot.session.session_id.clone(),
            status: "running".into(),
            total_steps: 42,
            final_time: Some(2.5e-9),
            final_e_ex: Some(1.0),
            final_e_demag: Some(2.0),
            final_e_ext: Some(3.0),
            final_e_ani: Some(4.0),
            final_e_dmi: Some(5.0),
            final_e_total: Some(15.0),
            artifact_dir: "/tmp/fullmag-tests".into(),
        });
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 42,
                time: 2.5e-9,
                dt: 1.0e-13,
                e_ex: 1.0,
                e_demag: 2.0,
                e_ext: 3.0,
                e_ani: 4.0,
                e_dmi: 5.0,
                e_total: 15.0,
                max_dm_dt: 10.0,
                max_h_eff: 11.0,
                max_h_demag: 12.0,
                max_torque_Apm: 13.0,
                max_torque_T: 14.0,
                wall_time_ns: 100,
                grid: [4, 4, 1],
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                finished: false,
            },
        });
        snapshot.scalar_rows = vec![
            ScalarRow {
                step: 41,
                time: 2.4e-9,
                solver_dt: 1.0e-13,
                mx: 0.0,
                my: 0.0,
                mz: 1.0,
                e_ex: 0.9,
                e_demag: 1.9,
                e_ext: 2.9,
                e_ani: 3.9,
                e_dmi: 4.9,
                e_total: 14.5,
                max_dm_dt: 10.0,
                max_h_eff: 11.0,
                max_h_demag: 12.0,
                max_torque_Apm: 13.0,
                max_torque_T: 14.0,
            },
            ScalarRow {
                step: 42,
                time: 2.5e-9,
                solver_dt: 1.0e-13,
                mx: 0.0,
                my: 0.0,
                mz: 1.0,
                e_ex: 1.0,
                e_demag: 2.0,
                e_ext: 3.0,
                e_ani: 4.0,
                e_dmi: 5.0,
                e_total: 15.0,
                max_dm_dt: 10.0,
                max_h_eff: 11.0,
                max_h_demag: 12.0,
                max_torque_Apm: 13.0,
                max_torque_T: 14.0,
            },
        ];
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 3,
            completed_stage_indexes: vec![0],
            stages: vec![
                StageExecutionRecord {
                    status: StageLifecycleState::Completed,
                    reason: None,
                    metric_name: None,
                    metric_value: None,
                    threshold: None,
                },
                StageExecutionRecord {
                    status: StageLifecycleState::Running,
                    reason: None,
                    metric_name: Some("max_torque_T".into()),
                    metric_value: Some(14.0),
                    threshold: Some(1.0e-4),
                },
            ],
            stage_statuses: vec![
                StageLifecycleState::Completed,
                StageLifecycleState::Running,
                StageLifecycleState::Pending,
            ],
            active_stage_index: Some(1),
            active_stage_kind: Some("relax".into()),
            runtime_state: RuntimeLifecycleState::Running,
        });
        snapshot.metadata = Some(serde_json::json!({
            "execution_plan": {
                "backend_plan": {
                    "kind": "fdm",
                    "integrator": "rk45"
                }
            }
        }));
        snapshot.engine_log = vec![
            crate::types::EngineLogEntry {
                timestamp_unix_ms: 1,
                level: "warn".into(),
                message: "using fallback preview pipeline".into(),
            },
            crate::types::EngineLogEntry {
                timestamp_unix_ms: 2,
                level: "error".into(),
                message: "latest runtime error".into(),
            },
        ];
        snapshot.state_version = 7;
    }

    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: SessionCommand {
                seq: 1,
                command_id: "cmd-1".into(),
                kind: "run".into(),
                created_at_unix_ms: 1_700_000_000_500,
                until_seconds: Some(1.0e-9),
                max_steps: Some(1000),
                torque_tolerance: None,
                energy_tolerance: None,
                integrator: Some("rk45".into()),
                fixed_timestep: Some(1.0e-13),
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
            },
            status: CommandLifecycleState::Queued,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        });
        ledger.push_back(TrackedCommandRecord {
            command: SessionCommand {
                seq: 2,
                command_id: "cmd-2".into(),
                kind: "pause".into(),
                created_at_unix_ms: 1_700_000_000_700,
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
            },
            status: CommandLifecycleState::Dispatched,
            dispatched_at_unix_ms: Some(1_700_000_000_800),
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        });
        ledger.push_back(TrackedCommandRecord {
            command: SessionCommand {
                seq: 3,
                command_id: "cmd-3".into(),
                kind: "stop".into(),
                created_at_unix_ms: 1_700_000_000_900,
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
            },
            status: CommandLifecycleState::Completed,
            dispatched_at_unix_ms: Some(1_700_000_000_950),
            completed_at_unix_ms: Some(1_700_000_001_000),
            completion_status: Some(CommandCompletionState::Completed),
            error: None,
        });
    }

    build_v2_router().with_state(state)
}

async fn test_router_with_session_and_artifact_dir() -> (axum::Router, PathBuf) {
    let state = test_app_state();
    let artifact_dir = std::env::temp_dir().join(format!(
        "fullmag-api-router-v1-assets-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos(),
    ));
    fs::create_dir_all(&artifact_dir).expect("failed to create artifact dir");

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: artifact_dir.display().to_string(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        state_version: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (build_v2_router().with_state(state), artifact_dir)
}

async fn test_router_with_session_store() -> (axum::Router, PathBuf) {
    let repo_root = std::env::temp_dir().join(format!(
        "fullmag-api-router-v1-session-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos(),
    ));
    fs::create_dir_all(&repo_root).expect("failed to create temp repo root");

    let (control_events_tx, _rx) = watch::channel(0u64);

    let state = Arc::new(AppState {
        repo_root: repo_root.clone(),
        current_workspace_root: repo_root.clone(),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_realtime_events: tokio::sync::broadcast::channel(16).0,
        current_live_realtime_replay: Arc::new(Mutex::new(VecDeque::new())),
        current_live_realtime_next_seq: Arc::new(AtomicU64::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_display_presentation: Arc::new(RwLock::new(DisplayPresentationState::default())),
        current_workspace_selection: Arc::new(RwLock::new(CurrentWorkspaceSelection::default())),
        current_workspace_ribbon: Arc::new(RwLock::new(CurrentWorkspaceRibbon::default())),
        current_workspace_layout: Arc::new(RwLock::new(CurrentWorkspaceLayout::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_command_responses: Arc::new(Mutex::new(VecDeque::new())),
        current_command_ledger: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: control_events_tx,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        feature_flags: FeatureFlags::default(),
        quantity_data_plane: Arc::new(crate::quantity_data_plane::QuantityDataPlaneStore::new()),
    });

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: repo_root.join("artifacts").display().to_string(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        state_version: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (build_v2_router().with_state(state), repo_root)
}

/// Read the response body into bytes.
async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("failed to read response body")
        .to_vec()
}

/// Read and parse the response body as JSON.
async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = body_bytes(response).await;
    serde_json::from_slice(&bytes).expect("response body is not valid JSON")
}

// ─── system endpoints ───────────────────────────────────────────────────────

#[tokio::test]
async fn health_endpoint_returns_200() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["status"], "ok");
    assert!(json["api_contract_version"].is_string());
    assert_eq!(json["api_contract_version"], "1.0.0");
    assert!(json["uptime_seconds"].is_number());
    assert!(json.get("active_session").is_some());
}

#[tokio::test]
async fn health_reports_no_active_session_when_empty() {
    let app = test_router();
    let json = body_json(
        app.oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;

    assert_eq!(json["active_session"], false);
}

#[tokio::test]
async fn health_reports_active_session_when_present() {
    let app = test_router_with_session().await;
    let json = body_json(
        app.oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;

    assert_eq!(json["active_session"], true);
}

#[tokio::test]
async fn capabilities_endpoint_returns_200() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["profile_version"].is_string());
    assert!(json["engines"].is_array());
}

// ─── middleware ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn request_id_middleware_adds_header() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.headers().contains_key("x-request-id"));
    let id = response
        .headers()
        .get("x-request-id")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        id.starts_with("fm-"),
        "auto-generated request id should start with 'fm-', got: {id}"
    );
}

#[tokio::test]
async fn request_id_middleware_preserves_client_id() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .header("x-request-id", "client-abc-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("x-request-id")
            .unwrap()
            .to_str()
            .unwrap(),
        "client-abc-123"
    );
}

#[tokio::test]
async fn contract_version_header_present() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("x-api-contract-version")
            .unwrap()
            .to_str()
            .unwrap(),
        "1.0.0"
    );
}

// ─── status endpoint ────────────────────────────────────────────────────────

#[tokio::test]
async fn status_returns_404_without_live_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn status_returns_200_with_live_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["api_contract_version"], "1.0.0");
    assert!(json["session"].is_object());
    assert_eq!(json["session"]["session_id"], "test-session");
    assert!(json["solver"].is_object());
    assert!(json["display"].is_object());
    assert_eq!(json["display"]["view_mode"], "3d");
    assert_eq!(json["display"]["field_component"], "magnitude");
    assert!(json["display"]["max_points"].is_number());
    assert!(json["display"]["x_chosen_size"].is_number());
    assert!(json["display"]["y_chosen_size"].is_number());
    assert!(json["domain"].is_object());
    assert!(json["resources"].is_object());
    assert!(json["resources"]["topology_revision"].is_number());
    assert!(json["resources"]["field_catalog_revision"].is_number());
    assert!(json["resources"]["field_revision"].is_number());
    assert!(json["resources"]["slice_revision"].is_number());
    assert!(json["resources"]["artifact_revision"].is_number());
    assert!(json["resources"]["command_completion_revision"].is_number());
    assert_eq!(json["resources"]["workspace_revision"], 0);
    assert_eq!(json["resources"]["mesh_revision"], 0);
    assert_eq!(json["resources"]["mesh_build_revision"], 0);
    assert_eq!(json["resources"]["commands_revision"], 0);
    assert_eq!(json["resources"]["stages_revision"], 0);
    assert!(json["resources"]["scene_revision"].is_null());
    assert!(json["capabilities"].is_object());
    assert!(json["energies"].is_object());
    assert!(json["metrics"].is_object());
}

// ─── domain endpoints ───────────────────────────────────────────────────────

#[tokio::test]
async fn domain_meta_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn domain_meta_returns_json_with_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["domain_id"], "current");
    assert!(json["discretization"].is_string());
    assert!(json["dimension"].is_number());
    assert_eq!(json["coordinate_system"], "cartesian");
    assert!(json["bounds"].is_object());
    assert!(json["counts"].is_object());
}

#[tokio::test]
async fn domain_topology_returns_204_for_fdm() {
    // With no FEM mesh, the FDM path returns 204 No Content.
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn domain_topology_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 17;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/topology")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn field_vector_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 23;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0]
                ],
                "layout": {
                    "grid_cells": [2, 1, 1]
                }
            }
        }))
        .expect("latest_fields payload should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn field_vector_component_projection_does_not_fallback_to_full_vector() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 23;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [1.0, 10.0, 100.0],
                    [2.0, 20.0, 200.0]
                ],
                "layout": {
                    "grid_cells": [2, 1, 1]
                }
            }
        }))
        .expect("latest_fields payload should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let full_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?component=full")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(full_response.status(), StatusCode::OK);
    let full_len = body_bytes(full_response).await.len();

    let x_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(x_response.status(), StatusCode::OK);
    assert_eq!(
        x_response
            .headers()
            .get("x-fullmag-component")
            .and_then(|value| value.to_str().ok()),
        Some("c0")
    );
    assert_eq!(
        x_response
            .headers()
            .get("x-fullmag-n-comp")
            .and_then(|value| value.to_str().ok()),
        Some("1")
    );

    let x_len = body_bytes(x_response).await.len();
    assert!(
        x_len < full_len,
        "component projection unexpectedly matched full-vector payload size: component={x_len}, full={full_len}"
    );
}

#[tokio::test]
async fn slice_meta_revision_changes_with_component() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 9;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 0.0]
                ],
                "layout": {
                    "grid_cells": [2, 2, 1]
                }
            }
        }))
        .expect("latest_fields payload should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let x_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xy&component=x&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(x_response.status(), StatusCode::OK);
    let x_json = body_json(x_response).await;

    let y_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xy&component=y&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(y_response.status(), StatusCode::OK);
    let y_json = body_json(y_response).await;

    assert_ne!(x_json["slice_revision"], y_json["slice_revision"]);
    assert_eq!(x_json["field_revision"], y_json["field_revision"]);
    assert_eq!(
        x_json["domain_generation_id"],
        y_json["domain_generation_id"]
    );
}

#[tokio::test]
async fn status_payload_remains_thin_even_with_large_field_buffers() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut values = Vec::with_capacity(4096);
        for i in 0..4096 {
            values.push(serde_json::json!([i as f64, 0.0, 0.0]));
        }
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": values,
                "layout": {
                    "grid_cells": [4096, 1, 1]
                }
            }
        }))
        .expect("latest_fields payload should deserialize");
        snapshot.state_version = 41;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = body_bytes(response).await;
    assert!(
        payload.len() < 12_000,
        "status payload unexpectedly large: {} bytes",
        payload.len()
    );
    let json: serde_json::Value =
        serde_json::from_slice(&payload).expect("status payload should decode as JSON");
    assert!(json.get("latest_fields").is_none());
    assert!(json.get("preview_cache").is_none());
}

#[tokio::test]
async fn status_topology_revision_is_stable_across_quantity_switch() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 77;
    }
    let app = build_v2_router().with_state(state);

    let first_status = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first_status.status(), StatusCode::OK);
    let first_json = body_json(first_status).await;
    let first_topology_revision = first_json["resources"]["topology_revision"]
        .as_u64()
        .expect("topology revision should be present");

    let patch_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_eff"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch_response.status(), StatusCode::OK);

    let second_status = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_status.status(), StatusCode::OK);
    let second_json = body_json(second_status).await;
    let second_topology_revision = second_json["resources"]["topology_revision"]
        .as_u64()
        .expect("topology revision should be present");

    assert_eq!(first_topology_revision, second_topology_revision);
}

// ─── quantities endpoints ───────────────────────────────────────────────────

#[tokio::test]
async fn quantities_catalog_returns_json_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/quantities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["schema_version"].is_string());
    let quantities = json["quantities"]
        .as_array()
        .expect("quantities must be an array");
    assert!(
        !quantities.is_empty(),
        "quantity catalog should not be empty"
    );

    let first = &quantities[0];
    assert!(first["id"].is_string());
    assert!(first["label"].is_string());
    assert!(first["description"].is_string());
    assert!(first["shape"].is_string());
    assert!(first["unit"].is_string());
    assert!(first["location"].is_string());
    assert!(first["domain"].is_string());
    assert!(first["n_comp"].is_number());
    assert!(first["normalization_hint"].is_string());
    assert!(first["interactive_preview"].is_boolean());
    assert!(first["supports_preview_2d"].is_boolean());
    assert!(first["supports_preview_3d"].is_boolean());
    assert!(first["supports_history"].is_boolean());
    assert!(first["supports_export"].is_boolean());
}

// ─── display endpoint ───────────────────────────────────────────────────────

#[tokio::test]
async fn display_get_returns_current_selection() {
    let app = test_router();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/display")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["active_quantity_id"], "m");
    assert_eq!(json["view_mode"], "3d");
    assert_eq!(json["field_component"], "magnitude");
}

#[tokio::test]
async fn display_put_replaces_full_selection() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_eff",
                        "view_mode": "2d",
                        "field_component": "z",
                        "colormap": "plasma",
                        "auto_contrast": false,
                        "contrast_min": -2.0,
                        "contrast_max": 4.0,
                        "vector_glyphs": false,
                        "vector_density": 25,
                        "slice_mode": "single",
                        "slice_layer": 3,
                        "max_points": 2048,
                        "x_chosen_size": 32,
                        "y_chosen_size": 16
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["active_quantity_id"], "h_eff");
    assert_eq!(json["view_mode"], "2d");
    assert_eq!(json["field_component"], "z");
    assert_eq!(json["colormap"], "plasma");
    assert_eq!(json["vector_glyphs"], false);

    let sel = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    assert_eq!(sel.selection.quantity, "h_eff");
    assert_eq!(sel.selection.preview_component(), "z");
    assert_eq!(sel.selection.every_n, 25);
    assert_eq!(sel.selection.layer, 3);
    assert!(!sel.selection.auto_scale_enabled);
    assert_eq!(sel.revision, 1);
    assert_eq!(presentation.colormap, "plasma");
    assert_eq!(presentation.contrast_min, Some(-2.0));
    assert_eq!(presentation.contrast_max, Some(4.0));
    assert!(!presentation.vector_glyphs);
}

#[tokio::test]
async fn display_patch_updates_view_mode_and_field_component() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "view_mode": "2d",
                        "field_component": "z"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["view_mode"], "2d");
    assert_eq!(json["field_component"], "z");

    let sel = state.current_display_selection.read().await;
    assert_eq!(sel.selection.preview_component(), "z");
    assert_eq!(sel.revision, 1);
}

#[tokio::test]
async fn display_patch_accepts_partial_update() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_demag",
                        "slice_layer": 4,
                        "max_points": 4096,
                        "x_chosen_size": 32,
                        "y_chosen_size": 16
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let sel = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    assert_eq!(sel.selection.quantity, "h_demag");
    assert_eq!(sel.selection.layer, 4);
    assert_eq!(sel.selection.max_points, 4096);
    assert_eq!(sel.selection.x_chosen_size, 32);
    assert_eq!(sel.selection.y_chosen_size, 16);
    assert_eq!(sel.revision, 1);
    assert_eq!(presentation.colormap, "viridis");
    assert!(presentation.vector_glyphs);
}

#[tokio::test]
async fn display_patch_returns_persisted_presentation_state() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "colormap": "plasma",
                        "vector_glyphs": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let second = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_eff"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);

    let second_json = body_json(second).await;
    assert_eq!(second_json["colormap"], "plasma");
    assert_eq!(second_json["vector_glyphs"], false);
}

#[tokio::test]
async fn display_put_rejects_invalid_json() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();

    // Axum returns 422 for deserialization failures.
    assert!(
        response.status().is_client_error(),
        "expected 4xx for invalid JSON, got {}",
        response.status()
    );
}

#[tokio::test]
async fn display_put_rejects_partial_payload() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/visualization/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "m"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status().is_client_error(),
        "expected 4xx for incomplete PUT payload, got {}",
        response.status()
    );
}

// ─── workspace endpoints ───────────────────────────────────────────────────

#[tokio::test]
async fn workspace_selection_get_requires_live_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/workspace/selection")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn workspace_selection_get_returns_defaults() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/workspace/selection")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 0);
    assert!(json.get("selected_node_id").is_none());
    assert!(json.get("selected_object_id").is_none());
    assert!(json.get("selected_entity_id").is_none());
}

#[tokio::test]
async fn workspace_selection_put_replaces_selection() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/workspace/selection")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "selected_node_id": "objects/body",
                        "selected_object_id": "body",
                        "selected_entity_id": "mesh:body:surface"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 1);
    assert_eq!(json["selected_node_id"], "objects/body");
    assert_eq!(json["selected_object_id"], "body");
    assert_eq!(json["selected_entity_id"], "mesh:body:surface");

    let selection = state.current_workspace_selection.read().await;
    assert_eq!(selection.revision, 1);
    assert_eq!(selection.selected_node_id.as_deref(), Some("objects/body"));
    assert_eq!(selection.selected_object_id.as_deref(), Some("body"));
    assert_eq!(
        selection.selected_entity_id.as_deref(),
        Some("mesh:body:surface")
    );
}

#[tokio::test]
async fn workspace_active_node_put_updates_selection_projection() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/workspace/tree/active-node")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "node_id": "study/stages/relax-1"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 1);
    assert_eq!(json["node_id"], "study/stages/relax-1");

    let selection = state.current_workspace_selection.read().await;
    assert_eq!(selection.revision, 1);
    assert_eq!(
        selection.selected_node_id.as_deref(),
        Some("study/stages/relax-1"),
    );
}

#[tokio::test]
async fn workspace_ribbon_put_replaces_ribbon_state() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/workspace/ribbon")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "workspace_mode": "build",
                        "active_core_tab": "Mesh",
                        "active_contextual_tab": "mesh-quality"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 1);
    assert_eq!(json["workspace_mode"], "build");
    assert_eq!(json["active_core_tab"], "Mesh");
    assert_eq!(json["active_contextual_tab"], "mesh-quality");

    let ribbon = state.current_workspace_ribbon.read().await;
    assert_eq!(ribbon.revision, 1);
    assert_eq!(ribbon.workspace_mode, "build");
    assert_eq!(ribbon.active_core_tab, "Mesh");
    assert_eq!(
        ribbon.active_contextual_tab.as_deref(),
        Some("mesh-quality")
    );
}

#[tokio::test]
async fn workspace_layout_put_replaces_layout_state() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/workspace/layout")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "current_stage": "analyze",
                        "stage_layouts": {
                            "build": {
                                "left_dock": "model",
                                "center_dock": "settings",
                                "right_dock": "properties",
                                "bottom_dock": "messages"
                            },
                            "study": {
                                "left_dock": "study-tree",
                                "center_dock": "viewport-controls",
                                "right_dock": "solver",
                                "bottom_dock": "jobs"
                            },
                            "analyze": {
                                "left_dock": "results-tree",
                                "center_dock": "plots",
                                "right_dock": "display",
                                "bottom_dock": "charts"
                            }
                        },
                        "active_workspace_tab_by_stage": {
                            "build": "core:mesh",
                            "study": "core:3d",
                            "analyze": "core:analyze"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 1);
    assert_eq!(json["current_stage"], "analyze");
    assert_eq!(json["active_workspace_tab_by_stage"]["build"], "core:mesh",);

    let layout = state.current_workspace_layout.read().await;
    assert_eq!(layout.revision, 1);
    assert_eq!(layout.current_stage, "analyze");
    assert_eq!(
        layout
            .active_workspace_tab_by_stage
            .get("build")
            .and_then(|value| value.as_deref()),
        Some("core:mesh"),
    );
}

// ─── mesh endpoints ────────────────────────────────────────────────────────

#[tokio::test]
async fn mesh_summary_returns_404_without_mesh_workspace() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/summary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn mesh_summary_returns_current_mesh_workspace() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_summary": { "nodes": 12, "elements": 24 },
            "mesh_quality_summary": { "min_quality": 0.82 }
        }));
        snapshot.mesh_revision = 11;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/summary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 11);
    assert_eq!(json["mesh_summary"]["nodes"], 12);
    assert_eq!(json["mesh_quality_summary"]["min_quality"], 0.82);
}

#[tokio::test]
async fn mesh_summary_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_summary": { "nodes": 12, "elements": 24 },
            "mesh_quality_summary": { "min_quality": 0.82 }
        }));
        snapshot.mesh_revision = 11;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/summary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/summary")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_semantics_returns_three_level_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut scene_value =
            serde_json::to_value(sample_scene_document()).expect("sample scene should serialize");
        scene_value["study"]["universe_mesh"] = serde_json::json!({
            "mode": "box",
            "size": [4.0, 5.0, 6.0],
            "padding": [1.0, 1.5, 2.0],
            "airbox_hmax": 8.0e-9
        });
        scene_value["objects"][0]["object_mesh"] = serde_json::json!({
            "mode": "override",
            "size_mode": "manual",
            "hmax": "2e-9",
            "hmin": "5e-10"
        });
        let scene = serde_json::from_value(scene_value)
            .expect("scene payload should deserialize after mesh semantics overrides");
        snapshot.scene_document = Some(scene);
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_quality_summary": { "min_quality": 0.82 },
            "last_build_summary": { "elements": 24 },
            "mesh_pipeline_status": [{ "id": "meshing", "status": "active" }],
            "last_build_error": "quality threshold not met"
        }));
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 73;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/semantics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 73);
    assert_eq!(json["universe_config"]["mode"], "box");
    assert_eq!(json["shared_domain_config"]["algorithm_2d"], 6);
    assert_eq!(json["object_configs"][0]["object_id"], "body");
    assert_eq!(json["object_configs"][0]["config"]["mode"], "override");
    assert_eq!(json["solver_mesh"]["mesh_name"], "test-mesh");
    assert_eq!(json["solver_mesh"]["object_segment_count"], 1);
    assert_eq!(
        json["mesh_build_diagnostics"]["last_build_error"],
        "quality threshold not met"
    );
    assert_eq!(
        json["render_only_controls_do_not_change_solver_domain"],
        true
    );
}

#[tokio::test]
async fn mesh_semantics_returns_404_without_scene_document() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/semantics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn mesh_active_build_returns_projection_from_mesh_workspace() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "active_build": { "build_id": "mesh-build-1", "status": "running" },
            "mesh_pipeline_status": { "phase": "remesh", "queued": true },
            "effective_airbox_target": { "hmax": "5e-9" },
            "effective_per_object_targets": { "body": { "hmax": "2e-9" } },
            "last_build_summary": { "elements": 42 },
            "last_build_error": "stale topology"
        }));
        snapshot.mesh_build_revision = 13;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 13);
    assert_eq!(json["active_build"]["build_id"], "mesh-build-1");
    assert_eq!(json["mesh_pipeline_status"]["phase"], "remesh");
    assert_eq!(json["effective_airbox_target"]["hmax"], "5e-9");
    assert_eq!(json["effective_per_object_targets"]["body"]["hmax"], "2e-9");
    assert_eq!(json["last_build_summary"]["elements"], 42);
    assert_eq!(json["last_build_error"], "stale topology");
}

#[tokio::test]
async fn mesh_shared_domain_report_preserves_backend_truth_payloads() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_summary": { "mesh_name": "mesh-b", "element_count": 24 },
            "mesh_statistics": {
                "mesh_name": "mesh-b",
                "global": {
                    "element_count": 24,
                    "gamma": { "min": 0.12 },
                    "sicn": { "p05": 0.34 }
                }
            },
            "mesh_pipeline_status": [{ "id": "generate", "status": "done" }],
            "last_build_summary": {
                "operation_statuses": [{
                    "kind": "swept_prism",
                    "scope": "free_layer",
                    "status": "fallback",
                    "requested_method": "swept_prism",
                    "actual_method": "free_tetrahedral",
                    "reason": "airbox combined-domain swept workflow is not implemented"
                }],
                "thin_film_diagnostics": [{
                    "geometry_name": "free_layer",
                    "actual_method": "free_tetrahedral",
                    "warnings": ["requested swept/prism meshing fell back to free tetrahedral"]
                }],
                "mesh_statistics": { "mesh_name": "mesh-b" }
            }
        }));
        snapshot.mesh_revision = 17;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/report")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 17);
    assert_eq!(json["report"]["mesh_statistics"]["global"]["element_count"], 24);
    assert_eq!(
        json["report"]["last_build_summary"]["operation_statuses"][0]["status"],
        "fallback"
    );
    assert_eq!(
        json["report"]["last_build_summary"]["thin_film_diagnostics"][0]["actual_method"],
        "free_tetrahedral"
    );
}

#[tokio::test]
async fn mesh_active_build_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "active_build": { "build_id": "mesh-build-1", "status": "running" },
            "mesh_pipeline_status": { "phase": "remesh", "queued": true },
            "effective_airbox_target": { "hmax": "5e-9" },
            "effective_per_object_targets": { "body": { "hmax": "2e-9" } },
            "last_build_summary": { "elements": 42 },
            "last_build_error": "stale topology"
        }));
        snapshot.mesh_build_revision = 13;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/current")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_build_command_enqueues_remesh_via_mesh_family() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "mesh_build",
                        "mesh_options": { "maximum_element_size": "4e-9" },
                        "mesh_target": { "kind": "object_mesh", "object_id": "body" },
                        "mesh_reason": "user_request"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    if status != StatusCode::OK {
        let body = body_bytes(response).await;
        panic!(
            "expected remesh command to be accepted, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
    let command = queue.front().expect("remesh command enqueued");
    assert_eq!(command.kind, "remesh");
    assert_eq!(
        command
            .mesh_target
            .as_ref()
            .and_then(|value| serde_json::to_value(value).ok())
            .and_then(|value| value.get("kind").cloned()),
        Some(serde_json::json!("object_mesh"))
    );
    assert_eq!(command.mesh_reason.as_deref(), Some("user_request"));
    let mesh_options = command
        .mesh_options
        .as_ref()
        .expect("mesh options should be enriched with geometry realization");
    assert_eq!(
        mesh_options
            .get("geometry_realization")
            .and_then(|value| value.get("source_scene_revision"))
            .and_then(serde_json::Value::as_u64),
        state
            .current_live_state
            .read()
            .await
            .as_ref()
            .and_then(|snapshot| snapshot.scene_document.as_ref())
            .map(|scene| scene.revision)
    );
}

#[tokio::test]
async fn mesh_build_snapshot_for_current_scene_clears_mesh_dirty_tags() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 42;
    scene.objects[0].tags.push("mesh:dirty".to_string());
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }

    {
        let mut guard = state.current_live_state.write().await;
        let snapshot = guard.as_mut().expect("live session exists");
        crate::session::apply_current_live_snapshot(
            snapshot,
            CurrentLiveSnapshotRequest {
                session_id: snapshot.session.session_id.clone(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: Some(serde_json::json!({
                    "active_build": null,
                    "last_build_error": null,
                    "last_build_summary": {
                        "kind": "mesh_build_summary",
                        "source_scene_revision": 42,
                        "realization_revision": 42,
                    }
                })),
                stage_execution: None,
                run: None,
                live_state: None,
                latest_scalar_row: None,
                latest_fields: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                fem_mesh: None,
            },
        )
        .expect("snapshot should apply");
    }

    let guard = state.current_live_state.read().await;
    let object = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .and_then(|scene| scene.objects.first())
        .expect("scene object exists");
    assert!(!object.tags.iter().any(|tag| tag == "mesh:dirty"));
}

#[tokio::test]
async fn commands_endpoint_rejects_public_remesh_variant() {
    let app = test_router_with_session().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "remesh",
                        "mesh_reason": "legacy"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status().is_client_error(),
        "expected 4xx for legacy public remesh command, got {}",
        response.status()
    );
}

#[tokio::test]
async fn mesh_build_history_returns_history_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_history": [
                { "mesh_name": "mesh-a", "node_count": 11 },
                { "mesh_name": "mesh-b", "node_count": 17 }
            ]
        }));
        snapshot.mesh_build_revision = 29;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 29);
    assert_eq!(json["history"][0]["mesh_name"], "mesh-a");
    assert_eq!(json["history"][1]["node_count"], 17);
}

#[tokio::test]
async fn mesh_build_history_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_history": [
                { "mesh_name": "mesh-a", "node_count": 11 },
                { "mesh_name": "mesh-b", "node_count": 17 }
            ]
        }));
        snapshot.mesh_build_revision = 29;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_last_successful_build_returns_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "last_build_summary": { "mesh_name": "mesh-b", "node_count": 17 },
            "effective_airbox_target": { "hmax": "5e-9" },
            "effective_per_object_targets": { "body": { "hmax": "2e-9" } },
            "last_build_error": "previous remesh failed"
        }));
        snapshot.mesh_build_revision = 31;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/latest-successful")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 31);
    assert_eq!(json["last_success"]["mesh_name"], "mesh-b");
    assert_eq!(json["last_success"]["node_count"], 17);
    assert_eq!(json["effective_airbox_target"]["hmax"], "5e-9");
    assert_eq!(json["effective_per_object_targets"]["body"]["hmax"], "2e-9");
    assert_eq!(json["last_build_error"], "previous remesh failed");
}

#[tokio::test]
async fn mesh_last_successful_build_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "last_build_summary": { "mesh_name": "mesh-b", "node_count": 17 },
            "effective_airbox_target": { "hmax": "5e-9" },
            "effective_per_object_targets": { "body": { "hmax": "2e-9" } },
            "last_build_error": "previous remesh failed"
        }));
        snapshot.mesh_build_revision = 31;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/latest-successful")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/builds/latest-successful")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_shared_domain_topology_returns_binary_fmmt_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/octet-stream"),
    );
    let body = body_bytes(response).await;
    assert!(body.starts_with(b"FMMT"));
}

#[tokio::test]
async fn mesh_shared_domain_topology_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 41;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/topology")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_shared_domain_manifest_returns_tree_metadata() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 41;
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.mesh_workspace = Some(serde_json::json!({
            "last_build_summary": {
                "source_scene_revision": 3,
                "geometry_realization": {
                    "source_scene_revision": 3,
                    "realization_revision": 3
                }
            }
        }));
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 41);
    assert_eq!(json["source_scene_revision"], 3);
    assert_eq!(json["geometry_realization_revision"], 3);
    assert_eq!(json["mesh_name"], "test-mesh");
    assert_eq!(json["object_segments"][0]["object_id"], "body");
    assert_eq!(json["mesh_parts"][0]["role"], "air");
    assert_eq!(json["mesh_parts"][1]["object_id"], "body");
    assert_eq!(json["regions"][0]["region_id"], "region:body");
    assert_eq!(json["regions"][0]["source_object_ids"][0], "body");
    assert_eq!(json["regions"][0]["material_ref"], "mat:body");
    assert_eq!(json["regions"][0]["mesh_part_ids"][0], "body");
    assert_eq!(json["regions"][0]["element_count"], 1);
}

#[tokio::test]
async fn mesh_shared_domain_manifest_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 41;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/manifest")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn mesh_universe_config_put_commits_scene_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/meshing/policies/universe")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "config": {
                            "mode": "box",
                            "size": [4.0, 5.0, 6.0],
                            "padding": [1.0, 1.5, 2.0],
                            "airbox_hmax": 8.0e-9,
                            "airbox_hmin": 2.0e-9,
                            "airbox_growth_rate": 1.4
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["config"]["mode"], "box");
    assert_eq!(json["config"]["size"][0], 4.0);
    assert_eq!(json["config"]["airbox_hmax"], 8.0e-9);
    assert_eq!(json["config"]["airbox_hmin"], 2.0e-9);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let universe = committed
        .study
        .universe_mesh
        .as_ref()
        .expect("study universe mesh present");
    assert_eq!(universe.mode, "box");
    assert_eq!(universe.size, Some([4.0, 5.0, 6.0]));
    assert_eq!(universe.airbox_hmax, Some(8.0e-9));
    assert_eq!(universe.airbox_hmin, Some(2.0e-9));
    assert_eq!(committed.universe.as_ref(), Some(universe));
}

#[tokio::test]
async fn mesh_shared_domain_config_put_commits_scene_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/meshing/policies/shared-domain")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "config": {
                            "algorithm_2d": 6,
                            "algorithm_3d": 10,
                            "size_mode": "manual",
                            "hmax": "3e-9",
                            "hmin": "1e-9",
                            "maximum_element_size": "3e-9",
                            "minimum_element_size": "1e-9",
                            "calibrate_for": "general_physics",
                            "size_preset": "normal",
                            "size_factor": 0.75,
                            "size_from_curvature": 1,
                            "curvature_factor": "0.25",
                            "growth_rate": "1.2",
                            "maximum_element_growth_rate": "1.2",
                            "narrow_regions": 1,
                            "narrow_region_resolution": "0.5",
                            "resolved_size_from_curvature": null,
                            "resolved_narrow_regions": null,
                            "resolved_growth_rate": null,
                            "smoothing_steps": 2,
                            "optimize": "",
                            "optimize_iterations": 1,
                            "compute_quality": true,
                            "per_element_quality": false,
                            "interface_hmax": null,
                            "interface_thickness": null,
                            "transition_distance": null,
                            "transition_growth": null,
                            "adaptive_enabled": false,
                            "adaptive_policy": "manual",
                            "adaptive_indicator": "geometric_only",
                            "adaptive_target_quantity": "auto",
                            "adaptive_convergence_metric": "energy_delta",
                            "adaptive_theta": 0.3,
                            "adaptive_h_min": "",
                            "adaptive_h_max": "",
                            "adaptive_max_passes": 5,
                            "adaptive_error_tolerance": ""
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["config"]["algorithm_3d"], 10);
    assert_eq!(json["config"]["hmax"], "3e-9");

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    assert_eq!(committed.study.shared_domain_mesh.algorithm_3d, 10);
    assert_eq!(committed.study.shared_domain_mesh.hmax, "3e-9");
    assert_eq!(
        committed.study.mesh_defaults,
        committed.study.shared_domain_mesh
    );
}

#[tokio::test]
async fn mesh_object_config_put_commits_scene_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/meshing/policies/objects/body")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "config": {
                            "mode": "override",
                            "size_mode": "manual",
                            "hmax": "2e-9",
                            "hmin": "5e-10",
                            "maximum_element_size": "2e-9",
                            "minimum_element_size": "5e-10",
                            "growth_rate": "1.1",
                            "maximum_element_growth_rate": "1.1",
                            "build_requested": true
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["object_id"], "body");
    assert_eq!(json["config"]["mode"], "override");
    assert_eq!(json["config"]["hmax"], "2e-9");

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == "body")
        .expect("body object present");
    let mesh = object.object_mesh.as_ref().expect("object mesh present");
    assert_eq!(mesh.mode, "override");
    assert_eq!(mesh.hmax, "2e-9");
    assert_eq!(object.mesh_override.as_ref(), Some(mesh));
}

#[tokio::test]
async fn mesh_interface_config_put_commits_scene_projection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/meshing/policies/interfaces/object%3Abody%7Cair")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "config": {
                            "mode": "custom",
                            "hmax": "3e-9",
                            "interface_hmax": "1e-9",
                            "interface_thickness": "2e-9",
                            "transition_distance": "6e-9",
                            "build_requested": true
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["interface_id"], "object:body|air");
    assert_eq!(json["config"]["interface_hmax"], "1e-9");

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let interface = committed
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == "object:body|air")
        .expect("interface mesh present");
    assert_eq!(interface.owner_a, "object:body");
    assert_eq!(interface.owner_b, "air");
    assert_eq!(interface.config.interface_hmax.as_deref(), Some("1e-9"));
}

// ─── retired flat scene route ─────────────────────────────────────────────

#[tokio::test]
async fn scene_document_get_is_removed_from_public_router() {
    let router = test_router_with_scene_document().await;

    let response = router
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/scene/document")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn scene_document_put_is_removed_from_public_router() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let router = build_v2_router().with_state(state.clone());

    let mut payload = serde_json::to_value(sample_scene_document()).unwrap();
    payload["revision"] = serde_json::json!(41);
    payload["scene"]["name"] = serde_json::json!("Updated Scene");

    let response = router
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/scene/document")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    assert_eq!(committed.scene.name, "Scene");
    assert_eq!(committed.revision, 3);
}

#[tokio::test]
async fn authoring_scene_get_returns_current_scene() {
    let app = test_router_with_scene_document().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/scene")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["scene"]["name"], "Scene");
}

#[tokio::test]
async fn authoring_scene_put_commits_scene_document() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());
    let mut updated = sample_scene_document();
    updated.revision = 5;
    updated.scene.name = "Authoring Scene".to_string();

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/model/scene")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&updated).expect("serialize scene"),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["scene"]["name"], "Authoring Scene");

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    assert_eq!(committed.scene.name, "Authoring Scene");
}

#[tokio::test]
async fn authoring_script_source_returns_current_python_source() {
    let (app, script_path) = test_router_with_scene_document_and_script_file().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/script")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["script_path"], script_path.display().to_string());
    assert_eq!(json["bytes"], 22);
    assert!(json["source"]
        .as_str()
        .expect("source string")
        .contains("from fullmag import *"));
}

#[tokio::test]
async fn authoring_scene_patch_applies_merge_patch() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/scene")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "merge_patch": {
                            "scene": {
                                "name": "Patched Scene"
                            }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["scene"]["name"], "Patched Scene");

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    assert_eq!(committed.scene.name, "Patched Scene");
}

#[tokio::test]
async fn authoring_transactions_replace_scene_commits_document() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());
    let mut updated = sample_scene_document();
    updated.revision = 9;
    updated.scene.name = "Transaction Scene".to_string();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/transactions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "replace_scene",
                        "scene": serde_json::to_value(updated).expect("scene value")
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["transaction_kind"], "replace_scene");
    assert_eq!(
        json["committed_scene"]["scene"]["name"],
        "Transaction Scene"
    );
}

#[tokio::test]
async fn authoring_transactions_merge_patch_commits_document() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/transactions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "merge_patch",
                        "merge_patch": {
                            "scene": {
                                "name": "Transaction Patch Scene"
                            }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["transaction_kind"], "merge_patch");
    assert_eq!(
        json["committed_scene"]["scene"]["name"],
        "Transaction Patch Scene"
    );
}

#[tokio::test]
async fn authoring_geometry_capabilities_returns_backend_matrix() {
    let app = test_router_with_scene_document().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/geometry/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert!(json["primitive_capabilities"]
        .as_array()
        .expect("primitive capabilities")
        .iter()
        .any(|entry| entry["id"] == "box" && entry["fem"] == true));
    assert!(json["csg_capabilities"]
        .as_array()
        .expect("csg capabilities")
        .iter()
        .any(|entry| entry["op"] == "subtract" && entry["status"] == "production"));
}

#[tokio::test]
async fn authoring_object_geometry_patch_marks_mesh_dirty_and_checks_revision() {
    let state = test_app_state_with_live_session().await;
    let scene = sample_scene_document();
    let object_id = scene.objects[0].id.clone();
    let base_revision = scene.revision;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/v2/sessions/current/model/objects/{object_id}/geometry"
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": base_revision,
                        "geometry": {
                            "geometry_kind": "Box",
                            "geometry_params": { "size": [1.0, 2.0, 3.0] }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .expect("object retained");
    assert_eq!(object.geometry.geometry_kind, "Box");
    assert!(object.tags.iter().any(|tag| tag == "mesh:dirty"));
}

#[tokio::test]
async fn authoring_transactions_create_transform_and_delete_objects() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 12;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state.clone());

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/transactions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "create_object",
                        "base_revision": 12,
                        "object_id": "box_001",
                        "name": "Box 001",
                        "geometry": {
                            "geometry_kind": "Box",
                            "geometry_params": { "size": [100e-9, 100e-9, 30e-9] }
                        },
                        "transform": {
                            "translation": [120e-9, 0.0, 0.0],
                            "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                            "scale": [1.0, 1.0, 1.0],
                            "pivot": [0.0, 0.0, 0.0]
                        },
                        "universe": {
                            "mode": "box",
                            "size": [300e-9, 200e-9, 100e-9],
                            "center": [100e-9, 0.0, 0.0],
                            "padding": [0.0, 0.0, 0.0]
                        },
                        "study_universe_mesh": {
                            "mode": "box",
                            "size": [300e-9, 200e-9, 100e-9],
                            "center": [100e-9, 0.0, 0.0],
                            "padding": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let create_json = body_json(create_response).await;
    assert_eq!(create_json["transaction_kind"], "create_object");
    let created_revision = create_json["scene_revision"].as_u64().unwrap();
    let created_object = create_json["committed_scene"]["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|object| object["id"] == "box_001")
        .expect("created object present");
    assert_eq!(created_object["geometry"]["geometry_kind"], "Box");
    assert!(created_object["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag == "mesh:dirty"));
    assert_eq!(
        create_json["committed_scene"]["universe"]["size"][0],
        300e-9
    );
    assert_eq!(
        create_json["committed_scene"]["study"]["universe_mesh"]["center"][0],
        100e-9
    );

    let transform_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/transactions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "commit_object_transform",
                        "base_revision": created_revision,
                        "object_id": "box_001",
                        "transform": {
                            "translation": [150e-9, 0.0, 0.0],
                            "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                            "scale": [1.0, 1.0, 1.0],
                            "pivot": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(transform_response.status(), StatusCode::OK);
    let transform_json = body_json(transform_response).await;
    assert_eq!(
        transform_json["transaction_kind"],
        "commit_object_transform"
    );
    let transformed_revision = transform_json["scene_revision"].as_u64().unwrap();

    let delete_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/transactions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "delete_object",
                        "base_revision": transformed_revision,
                        "object_id": "box_001"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::OK);
    let delete_json = body_json(delete_response).await;
    assert_eq!(delete_json["transaction_kind"], "delete_object");
    assert!(!delete_json["committed_scene"]["objects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|object| object["id"] == "box_001"));
}

#[tokio::test]
async fn authoring_universe_patch_and_fit_are_scene_owned() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 21;
    scene.objects[0].tags.clear();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state.clone());

    let patch_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/universe")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": 21,
                        "sync_study_universe_mesh": true,
                        "universe": {
                            "mode": "box",
                            "size": [4.0, 5.0, 6.0],
                            "center": [1.0, 2.0, 3.0],
                            "padding": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch_response.status(), StatusCode::OK);
    let patch_json = body_json(patch_response).await;
    assert_eq!(patch_json["universe"]["size"][0], 4.0);
    assert_eq!(patch_json["study_universe_mesh"]["center"][2], 3.0);
    assert_eq!(patch_json["mesh_dirty"], true);
    let patched_revision = patch_json["scene_revision"].as_u64().unwrap();

    let fit_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/universe/fit")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": patched_revision,
                        "padding": [0.1, 0.2, 0.3],
                        "minimum_size": [0.0, 0.0, 0.0],
                        "sync_study_universe_mesh": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fit_response.status(), StatusCode::OK);
    let fit_json = body_json(fit_response).await;
    assert_eq!(fit_json["universe"]["mode"], "box");
    assert!((fit_json["universe"]["size"][0].as_f64().unwrap() - 1.2).abs() < 1e-12);
    assert!((fit_json["universe"]["size"][1].as_f64().unwrap() - 1.4).abs() < 1e-12);
    assert!((fit_json["universe"]["size"][2].as_f64().unwrap() - 1.6).abs() < 1e-12);
    assert!((fit_json["study_universe_mesh"]["size"][2].as_f64().unwrap() - 1.6).abs() < 1e-12);
    assert_eq!(fit_json["mesh_dirty"], true);
}

#[tokio::test]
async fn authoring_geometry_realization_reports_blocked_csg() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].geometry.geometry_kind = "Csg".to_string();
    scene.objects[0].geometry.geometry_params = serde_json::json!({
        "op": "union",
        "children": []
    });
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/geometry/realizations")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "backend_target": "fem" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["status"], "blocked");
    assert!(json["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|entry| entry["code"] == "GEOMETRY_CSG_OP_UNSUPPORTED"));
}

#[tokio::test]
async fn authoring_study_runtime_get_returns_requested_selection() {
    let app = test_router_with_scene_document().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/study")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["requested_backend"], "auto");
    assert_eq!(json["requested_precision"], "double");
}

#[tokio::test]
async fn authoring_study_runtime_patch_commits_requested_selection() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/study")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "requested_backend": "fem",
                        "requested_device": "gpu",
                        "requested_cpu_threads": 8
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["requested_backend"], "fem");
    assert_eq!(json["requested_device"], "gpu");
    assert_eq!(json["requested_cpu_threads"], 8);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    assert_eq!(committed.study.requested_backend, "fem");
    assert_eq!(committed.study.requested_device, "gpu");
    assert_eq!(committed.study.requested_cpu_threads, Some(8));
}

#[tokio::test]
async fn authoring_regions_returns_object_derived_regions() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 21;
    scene.objects[0].region_name = Some("free_layer".to_string());
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/regions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["scene_revision"], 21);
    assert_eq!(json["geometry_realization_revision"], 21);
    assert_eq!(json["regions"][0]["name"], "free_layer");
    assert_eq!(json["regions"][0]["source"], "object");
    assert_eq!(json["regions"][0]["source_object_ids"][0], "body");
    assert!(json["regions"][0]["source_body_ids"][0]
        .as_str()
        .unwrap()
        .starts_with("body:body:"));
    assert_eq!(
        json["regions"][0]["mesh_part_ids"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn authoring_region_patch_commits_name_and_marks_mesh_dirty() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 22;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/regions/region:body")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "renamed_region",
                        "enabled": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    let object = &json["objects"][0];
    assert_eq!(object["region_name"], "renamed_region");
    assert_eq!(object["visible"], false);
    assert!(object["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag == "mesh:dirty"));
}

#[tokio::test]
async fn authoring_object_resource_crud_commits_scene() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 30;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/model/objects")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": 30,
                        "object_id": "object_crud",
                        "name": "Object CRUD",
                        "geometry": {
                            "geometry_kind": "Box",
                            "geometry_params": { "size": [2.0, 1.0, 1.0] }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let create_json = body_json(create_response).await;
    let create_revision = create_json["revision"].as_u64().unwrap();
    assert!(create_json["objects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|object| object["id"] == "object_crud"));

    let patch_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/objects/object_crud")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": create_revision,
                        "name": "Object CRUD Renamed",
                        "region_name": "crud_region"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch_response.status(), StatusCode::OK);
    let patch_json = body_json(patch_response).await;
    let patched_object = patch_json["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|object| object["id"] == "object_crud")
        .expect("patched object present");
    assert_eq!(patched_object["name"], "Object CRUD Renamed");
    assert_eq!(patched_object["region_name"], "crud_region");
    assert!(patched_object["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag == "mesh:dirty"));

    let delete_response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v2/sessions/current/model/objects/object_crud")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::OK);
    let delete_json = body_json(delete_response).await;
    assert!(!delete_json["objects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|object| object["id"] == "object_crud"));
}

#[tokio::test]
async fn authoring_geometry_diagnostics_endpoints_return_current_diagnostics() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].material_ref = "missing-material".to_string();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let list_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/geometry/diagnostics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_json = body_json(list_response).await;
    let diagnostic_id = list_json["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|diagnostic| diagnostic["code"] == "GEOMETRY_OBJECT_MATERIAL_MISSING")
        .and_then(|diagnostic| diagnostic["code"].as_str())
        .expect("material diagnostic code")
        .to_string();

    let detail_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v2/sessions/current/model/geometry/diagnostics/{diagnostic_id}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(detail_response.status(), StatusCode::OK);
    let detail_json = body_json(detail_response).await;
    assert_eq!(detail_json["code"], "GEOMETRY_OBJECT_MATERIAL_MISSING");
}

#[tokio::test]
async fn authoring_material_get_returns_requested_material() {
    let app = test_router_with_scene_document().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/materials/mat%3Abody")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["id"], "mat:body");
    assert_eq!(json["properties"]["Ms"], 800000.0);
}

#[tokio::test]
async fn authoring_material_patch_commits_requested_material() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/materials/mat%3Abody")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "Body Material",
                        "properties": {
                            "Ms": null,
                            "Aex": 15e-12,
                            "alpha": 0.05
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["name"], "Body Material");
    assert!(json["properties"]["Ms"].is_null());
    assert_eq!(json["properties"]["Aex"], 15e-12);
    assert_eq!(json["properties"]["alpha"], 0.05);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let material = committed
        .materials
        .iter()
        .find(|entry| entry.id == "mat:body")
        .expect("mat:body material");
    assert_eq!(material.name, "Body Material");
    assert_eq!(material.properties.ms, None);
    assert_eq!(material.properties.aex, Some(15e-12));
    assert_eq!(material.properties.alpha, 0.05);
}

#[tokio::test]
async fn authoring_object_interaction_get_returns_interfacial_dmi() {
    let mut scene = sample_scene_document();
    scene.objects[0]
        .physics_stack
        .push(fullmag_authoring::ScriptBuilderMagneticInteractionEntry {
            kind: fullmag_authoring::ScriptBuilderMagneticInteractionKind::InterfacialDmi,
            enabled: true,
            params: Some(
                [("dind".to_string(), serde_json::json!(0.0))]
                    .into_iter()
                    .collect(),
            ),
        });
    let object_id = scene.objects[0].id.clone();
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v2/sessions/current/model/objects/{object_id}/interactions/interfacial_dmi"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["interaction_kind"], "interfacial_dmi");
    assert_eq!(json["present"], true);
    assert_eq!(json["params"]["dind"], 0.0);
}

#[tokio::test]
async fn authoring_object_interaction_patch_updates_uniaxial_params() {
    let scene = sample_scene_document();
    let object_id = scene.objects[0].id.clone();
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/v2/sessions/current/model/objects/{object_id}/interactions/uniaxial_anisotropy"
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "present": true,
                        "enabled": true,
                        "params": {
                            "ku1": 42.0,
                            "axis": [1.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["interaction_kind"], "uniaxial_anisotropy");
    assert_eq!(json["present"], true);
    assert_eq!(json["params"]["ku1"], 42.0);
    assert_eq!(json["params"]["axis"][0], 1.0);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .expect("object");
    let interaction = object
        .physics_stack
        .iter()
        .find(|entry| {
            entry.kind
                == fullmag_authoring::ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy
        })
        .expect("uniaxial interaction");
    assert_eq!(interaction.enabled, true);
}

#[tokio::test]
async fn authoring_material_patch_syncs_interfacial_dmi_params_for_bound_objects() {
    let mut scene = sample_scene_document();
    scene.objects[0]
        .physics_stack
        .push(fullmag_authoring::ScriptBuilderMagneticInteractionEntry {
            kind: fullmag_authoring::ScriptBuilderMagneticInteractionKind::InterfacialDmi,
            enabled: true,
            params: Some(
                [("dind".to_string(), serde_json::json!(0.0))]
                    .into_iter()
                    .collect(),
            ),
        });
    let object_id = scene.objects[0].id.clone();
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/materials/mat%3Abody")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "properties": {
                            "Dind": 0.123
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let guard = state.current_live_state.read().await;
    let committed = guard
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.as_ref())
        .expect("scene document committed");
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .expect("object");
    let interaction = object
        .physics_stack
        .iter()
        .find(|entry| {
            entry.kind == fullmag_authoring::ScriptBuilderMagneticInteractionKind::InterfacialDmi
        })
        .expect("dmi interaction");
    assert_eq!(
        interaction
            .params
            .as_ref()
            .and_then(|params| params.get("dind"))
            .and_then(|value| value.as_f64()),
        Some(0.123)
    );
}

// ─── commands endpoint ──────────────────────────────────────────────────────

#[tokio::test]
async fn commands_endpoint_enqueues_single_command() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "run",
                        "until_seconds": 1.0
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue.front().map(|command| command.kind.as_str()),
        Some("run")
    );
}

#[tokio::test]
async fn commands_endpoint_reuses_response_for_same_request_id() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let first_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("idempotency-key", "cmd-dedupe-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "run",
                        "until_seconds": 1.0
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let second_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("idempotency-key", "cmd-dedupe-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "run",
                        "until_seconds": 1.0
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first_response.status(), StatusCode::OK);
    assert_eq!(second_response.status(), StatusCode::OK);

    let first_json = body_json(first_response).await;
    let second_json = body_json(second_response).await;
    assert_eq!(first_json["command_id"], second_json["command_id"]);

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
}

#[tokio::test]
async fn commands_endpoint_does_not_dedupe_by_request_id_only() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let first_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("x-request-id", "cmd-trace-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "pause"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let second_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("x-request-id", "cmd-trace-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "pause"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first_response.status(), StatusCode::OK);
    assert_eq!(second_response.status(), StatusCode::OK);

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 2);
}

#[tokio::test]
async fn commands_endpoint_rejects_legacy_command_payload_shape() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "command": "pause",
                        "params": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let queue = state.current_control_queue.lock().await;
    assert!(queue.is_empty());
}

#[tokio::test]
async fn command_status_endpoint_returns_queue_and_dispatch_ledger() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["pending_count"], 1);
    assert_eq!(json["accepted_count"], 0);
    assert_eq!(json["dispatched_count"], 1);
    assert_eq!(json["running_count"], 0);
    assert_eq!(json["completed_count"], 1);
    assert_eq!(json["rejected_count"], 0);
    assert_eq!(json["failed_count"], 0);
    assert_eq!(json["commands"].as_array().map(Vec::len), Some(3));
}

#[tokio::test]
async fn command_detail_endpoint_returns_command_payload() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/commands/cmd-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "run");
    assert_eq!(json["status"], "queued");
    assert_eq!(json["integrator"], "rk45");
}

#[tokio::test]
async fn command_detail_endpoint_exposes_completion_fields_for_terminal_commands() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/commands/cmd-3")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "stop");
    assert_eq!(json["status"], "completed");
    assert_eq!(json["completion_status"], "completed");
    assert_eq!(json["completed_at_unix_ms"], 1_700_000_001_000u64);
}

#[tokio::test]
async fn current_run_endpoint_returns_runtime_summary() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/runs/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["run_id"], "run-1");
    assert_eq!(json["status"], "running");
    assert_eq!(json["active_stage_kind"], "relax");
}

#[tokio::test]
async fn run_by_id_endpoint_returns_active_run_when_id_matches() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/runs/run-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["run_id"], "run-1");
    assert_eq!(json["status"], "running");
}

#[tokio::test]
async fn run_by_id_endpoint_returns_404_for_unknown_run() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/runs/missing-run")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = body_json(response).await;
    assert_eq!(json["error"], "run not found: missing-run");
}

#[tokio::test]
async fn stage_execution_endpoint_returns_current_stage_tree() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/stages/execution")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["runtime_state"], "running");
    assert_eq!(json["active_stage_index"], 1);
    assert_eq!(json["stages"].as_array().map(Vec::len), Some(2));
}

#[tokio::test]
async fn solver_status_endpoint_returns_detailed_read_model() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/solver/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["runtime_state"], "running");
    assert_eq!(json["integrator"], "rk45");
    assert_eq!(json["step_index"], 42);
    assert_eq!(json["last_error"], "latest runtime error");
}

#[tokio::test]
async fn solver_energies_current_endpoint_returns_latest_energy_sample() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/solver/energies/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["step"], 42);
    assert_eq!(json["total"], 15.0);
}

#[tokio::test]
async fn solver_energies_history_endpoint_honors_limit() {
    let app = test_router_with_runtime_read_models().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/solver/energies/history?limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["total_rows"], 2);
    assert_eq!(json["returned_rows"], 1);
    assert_eq!(json["rows"][0]["step"], 42);
}

// ─── session endpoints ──────────────────────────────────────────────────────

#[tokio::test]
async fn session_export_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/exports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn session_export_returns_fms_payload_with_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/exports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["session_id"], "test-session");
    assert_eq!(json["profile"], "compact");
    assert!(json["fms_base64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(json["size_bytes"].as_u64().unwrap_or(0) > 0);

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_import_inspect_round_trips_exported_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let export_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/exports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(export_response.status(), StatusCode::OK);
    let exported = body_json(export_response).await;
    let fms_base64 = exported["fms_base64"]
        .as_str()
        .expect("export response should contain fms_base64");

    let inspect_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/imports/inspections")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "fms_base64": fms_base64
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(inspect_response.status(), StatusCode::OK);

    let json = body_json(inspect_response).await;
    assert_eq!(json["inspection"]["session_id"], "test-session");
    assert_eq!(json["inspection"]["name"], "contract-test");
    assert_eq!(json["inspection"]["profile"], "compact");

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_import_commit_round_trips_exported_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let export_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/exports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(export_response.status(), StatusCode::OK);
    let exported = body_json(export_response).await;
    let fms_base64 = exported["fms_base64"]
        .as_str()
        .expect("export response should contain fms_base64");

    let commit_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/imports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "fms_base64": fms_base64
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(commit_response.status(), StatusCode::OK);

    let json = body_json(commit_response).await;
    assert_eq!(json["session_id"], "test-session");
    assert_eq!(json["restore_class"], "config_only");

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_recovery_returns_200() {
    let (app, repo_root) = test_router_with_session_store().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/persistence/recovery")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["snapshots"].is_array());

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn assets_import_returns_200_with_session() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/assets/import")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "file_name": "note.txt",
                        "content_base64": "aGVsbG8=",
                        "target_realization": "geometry"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["asset_id"].is_string());
    assert_eq!(json["target_realization"], "geometry");
    assert_eq!(json["summary"]["file_name"], "note.txt");

    let imports_dir = artifact_dir.join("imports");
    assert!(
        imports_dir.exists(),
        "asset import should create imports dir"
    );

    let _ = fs::remove_dir_all(&artifact_dir);
}

// ─── engine log endpoint ────────────────────────────────────────────────────

#[tokio::test]
async fn engine_log_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/engine-log")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn engine_log_returns_200_with_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/engine-log")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["revision"], 0);
    assert!(json["entries"].is_array());
    assert_eq!(json["total"], 0);
}

#[tokio::test]
async fn engine_log_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/engine-log")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/engine-log")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn artifacts_list_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.artifacts = vec![
            crate::types::ArtifactEntry {
                path: "results/final.ovf".into(),
                kind: "field".into(),
            },
            crate::types::ArtifactEntry {
                path: "plots/energy.csv".into(),
                kind: "table".into(),
            },
        ];
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/artifacts")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/artifacts")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty());
}

#[tokio::test]
async fn asyncapi_document_returns_200() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/asyncapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["asyncapi"], "2.6.0");
    assert_eq!(
        json["channels"]["/v2/sessions/current/events/ws"]["subscribe"]["operationId"],
        "subscribeCurrentLiveRealtime"
    );
}

#[tokio::test]
async fn asyncapi_docs_page_links_to_v2_document() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/docs/asyncapi")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = String::from_utf8(body_bytes(response).await).expect("HTML body should be UTF-8");
    assert!(body.contains("/v2/platform/asyncapi.json"));
    assert!(!body.contains("/v1/asyncapi.json"));
}

#[tokio::test]
async fn realtime_ws_requires_subprotocol() {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "sec-websocket-protocol",
        axum::http::HeaderValue::from_static("wrong.protocol"),
    );

    let error = super::handlers::platform::realtime::ensure_realtime_subprotocol(&headers)
        .expect_err("wrong subprotocol should be rejected");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

// ─── unknown route ──────────────────────────────────────────────────────────

#[tokio::test]
async fn unknown_route_returns_404() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/nonexistent/path")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn middleware_headers_on_all_endpoints() {
    // Verify both middleware headers appear on a non-health endpoint too.
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.headers().contains_key("x-request-id"),
        "x-request-id header missing on status endpoint"
    );
    assert_eq!(
        response
            .headers()
            .get("x-api-contract-version")
            .unwrap()
            .to_str()
            .unwrap(),
        "1.0.0"
    );
}

// ─── P1: field vector component selection ─────────────────────────────────

/// Insert a minimal 2×2×1 nComp=3 field into `latest_fields` and return the router.
async fn test_router_with_mock_field() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 11;
        // 4 points × 3 components, interleaved: p0=[1,0,0], p1=[0,1,0], p2=[0,0,1], p3=[1,2,2]
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 2.0, 2.0]
                ],
                "layout": {
                    "grid_cells": [2, 2, 1]
                }
            }
        }))
        .expect("mock latest_fields should deserialize");
    }
    build_v2_router().with_state(state)
}

async fn test_router_with_live_magnetization() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 23;
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 7,
                time: 1.0e-9,
                dt: 1.0e-13,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 100,
                grid: [2, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                preview_field: None,
                finished: false,
            },
        });
    }
    build_v2_router().with_state(state)
}

/// Same as `test_router_with_mock_field`, but marks runtime as FEM without
/// topology buffers so slice endpoints must return 409.
async fn test_router_with_mock_field_fem_without_topology() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 11;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 2.0, 2.0]
                ],
                "layout": {
                    "grid_cells": [2, 2, 1]
                }
            }
        }))
        .expect("mock latest_fields should deserialize");
        snapshot.fem_mesh = Some(FemMeshPayload {
            mesh_name: "fem-empty-topology".to_string(),
            mesh_id: "fem-empty-topology:1".to_string(),
            nodes: Vec::new(),
            elements: Vec::new(),
            element_markers: Vec::new(),
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some("101".to_string()),
            per_domain_quality: Default::default(),
        });
    }
    build_v2_router().with_state(state)
}

#[tokio::test]
async fn field_vector_full_returns_ncomp_3() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let ncomp = response
        .headers()
        .get("x-fullmag-n-comp")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    assert_eq!(ncomp, Some(3), "nComp header should be 3 for full vector");

    let bytes = body_bytes(response).await;
    // FMVP v2 header is 48 bytes; 4 points × 3 × 8 = 96 bytes payload
    assert_eq!(
        bytes.len(),
        48 + 4 * 3 * 8,
        "full vector payload length mismatch"
    );
    assert_eq!(&bytes[..4], b"FMVP", "missing FMVP magic");
    assert_eq!(bytes[4], 2, "expected FMVP version 2");
    assert_eq!(bytes[6], 3, "nComp header byte should be 3");
}

#[tokio::test]
async fn v2_field_catalog_exposes_live_magnetization_fallback() {
    let app = test_router_with_live_magnetization().await;
    let catalog_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(catalog_response.status(), StatusCode::OK);
    let catalog = body_json(catalog_response).await;
    let quantities = catalog
        .get("quantities")
        .and_then(|value| value.as_array())
        .expect("field catalog quantities should be an array");
    let magnetization = quantities
        .iter()
        .find(|entry| entry.get("quantity_id").and_then(|value| value.as_str()) == Some("m"))
        .expect("field catalog should expose live magnetization");
    assert_eq!(
        magnetization.get("label").and_then(|value| value.as_str()),
        Some("Magnetization")
    );
    assert_eq!(
        magnetization
            .get("available")
            .and_then(|value| value.as_bool()),
        Some(true)
    );

    let meta_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(meta_response.status(), StatusCode::OK);

    let vector_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(vector_response.status(), StatusCode::OK);
    assert_eq!(
        vector_response
            .headers()
            .get("x-fullmag-quantity-id")
            .and_then(|value| value.to_str().ok()),
        Some("m")
    );
}

#[tokio::test]
async fn v2_field_vector_supports_mesh_scoped_samples() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 29;
        snapshot.mesh_revision = 31;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [0.0, 0.1, 0.2],
                    [1.0, 1.1, 1.2],
                    [2.0, 2.1, 2.2],
                    [3.0, 3.1, 3.2],
                    [4.0, 4.1, 4.2],
                    [5.0, 5.1, 5.2],
                    [6.0, 6.1, 6.2],
                    [7.0, 7.1, 7.2]
                ],
                "layout": {
                    "grid_cells": [8, 1, 1]
                }
            }
        }))
        .expect("scoped latest_fields should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=airbox")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-scope-kind")
            .and_then(|value| value.to_str().ok()),
        Some("airbox")
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-scope-id")
            .and_then(|value| value.to_str().ok()),
        Some("airbox")
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-point-count")
            .and_then(|value| value.to_str().ok()),
        Some("4")
    );
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    assert_eq!(&bytes[12..16], &(12u32).to_le_bytes(), "4 vector points");
    assert_eq!(&bytes[16..20], &(4u32).to_le_bytes(), "scoped grid x-size");
    let first_value = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
    assert_eq!(
        first_value, 4.0,
        "airbox scope should start at airbox node values"
    );
}

#[tokio::test]
async fn v2_field_vector_object_scope_prefers_mesh_part_node_indices() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut mesh = sample_scoped_fem_mesh_payload();
        mesh.object_segments[0].node_start = 0;
        mesh.object_segments[0].node_count = 2;
        mesh.mesh_parts[0].node_indices = vec![3, 1];
        mesh.mesh_parts[0].node_start = 0;
        mesh.mesh_parts[0].node_count = 2;
        snapshot.fem_mesh = Some(mesh);
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [0.0, 0.1, 0.2],
                    [1.0, 1.1, 1.2],
                    [2.0, 2.1, 2.2],
                    [3.0, 3.1, 3.2],
                    [4.0, 4.1, 4.2],
                    [5.0, 5.1, 5.2],
                    [6.0, 6.1, 6.2],
                    [7.0, 7.1, 7.2]
                ],
                "layout": {
                    "grid_cells": [8, 1, 1]
                }
            }
        }))
        .expect("scoped latest_fields should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=object&scope_id=body")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-point-count")
            .and_then(|value| value.to_str().ok()),
        Some("2")
    );
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    let first_x = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
    let second_x = f64::from_le_bytes(bytes[72..80].try_into().unwrap());
    assert_eq!(first_x, 3.0);
    assert_eq!(second_x, 1.0);
}

#[tokio::test]
async fn v2_field_vector_supports_workspace_selection_scope() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 30;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                    [4.0, 0.0, 0.0],
                    [5.0, 0.0, 0.0],
                    [6.0, 0.0, 0.0],
                    [7.0, 0.0, 0.0]
                ],
                "layout": {
                    "grid_cells": [8, 1, 1]
                }
            }
        }))
        .expect("scoped latest_fields should deserialize");
    }
    {
        let mut selection = state.current_workspace_selection.write().await;
        selection.selected_entity_id = Some("body".to_string());
        selection.revision = 4;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=selection")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-scope-kind")
            .and_then(|value| value.to_str().ok()),
        Some("selection")
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-scope-id")
            .and_then(|value| value.to_str().ok()),
        Some("body")
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-point-count")
            .and_then(|value| value.to_str().ok()),
        Some("4")
    );
}

#[tokio::test]
async fn v2_mesh_part_topology_returns_scoped_mesh() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_revision = 31;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/parts/airbox/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMMT");
    assert_eq!(
        &bytes[8..12],
        &(4u32).to_le_bytes(),
        "airbox topology nodes"
    );
    assert_eq!(
        &bytes[12..16],
        &(1u32).to_le_bytes(),
        "airbox topology elements"
    );
    let full_len = crate::field_store::serialize_fem_mesh_topology_binary_v1(
        &sample_scoped_fem_mesh_payload(),
    )
    .len();
    assert!(
        bytes.len() < full_len,
        "part topology should be smaller than shared-domain topology"
    );
}

#[tokio::test]
async fn field_vector_x_component_returns_scalar() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let ncomp = response
        .headers()
        .get("x-fullmag-n-comp")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    assert_eq!(ncomp, Some(1), "x component should produce nComp=1");

    let bytes = body_bytes(response).await;
    // nComp=1, 4 points × 1 × 8 = 32 bytes payload
    assert_eq!(
        bytes.len(),
        48 + 4 * 1 * 8,
        "x component payload length mismatch"
    );
    assert_eq!(bytes[6], 1, "nComp header byte should be 1 for scalar");

    // Verify x values: p0.x=1.0, p1.x=0.0, p2.x=0.0, p3.x=1.0
    let vals: Vec<f64> = (0..4)
        .map(|i| f64::from_le_bytes(bytes[48 + i * 8..48 + i * 8 + 8].try_into().unwrap()))
        .collect();
    assert!(
        (vals[0] - 1.0).abs() < 1e-12,
        "p0.x should be 1.0, got {}",
        vals[0]
    );
    assert!(
        (vals[1] - 0.0).abs() < 1e-12,
        "p1.x should be 0.0, got {}",
        vals[1]
    );
    assert!(
        (vals[2] - 0.0).abs() < 1e-12,
        "p2.x should be 0.0, got {}",
        vals[2]
    );
    assert!(
        (vals[3] - 1.0).abs() < 1e-12,
        "p3.x should be 1.0, got {}",
        vals[3]
    );
}

#[tokio::test]
async fn field_vector_y_component_returns_scalar() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=y")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert_eq!(bytes.len(), 48 + 4 * 8, "y component payload length");
    assert_eq!(bytes[6], 1, "nComp byte should be 1");

    let vals: Vec<f64> = (0..4)
        .map(|i| f64::from_le_bytes(bytes[48 + i * 8..48 + i * 8 + 8].try_into().unwrap()))
        .collect();
    assert!((vals[0] - 0.0).abs() < 1e-12, "p0.y");
    assert!((vals[1] - 1.0).abs() < 1e-12, "p1.y");
    assert!((vals[2] - 0.0).abs() < 1e-12, "p2.y");
    assert!((vals[3] - 2.0).abs() < 1e-12, "p3.y");
}

#[tokio::test]
async fn field_vector_z_component_returns_scalar() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=z")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert_eq!(bytes.len(), 48 + 4 * 8, "z component payload length");

    let vals: Vec<f64> = (0..4)
        .map(|i| f64::from_le_bytes(bytes[48 + i * 8..48 + i * 8 + 8].try_into().unwrap()))
        .collect();
    assert!((vals[0] - 0.0).abs() < 1e-12, "p0.z");
    assert!((vals[1] - 0.0).abs() < 1e-12, "p1.z");
    assert!((vals[2] - 1.0).abs() < 1e-12, "p2.z");
    assert!((vals[3] - 2.0).abs() < 1e-12, "p3.z");
}

#[tokio::test]
async fn field_vector_c1_alias_matches_y() {
    let app = test_router_with_mock_field().await;
    let resp_c1 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=c1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp_c1.status(), StatusCode::OK);
    let bytes_c1 = body_bytes(resp_c1).await;
    // c1 = y, so should match exact byte layout of y
    let vals: Vec<f64> = (0..4)
        .map(|i| f64::from_le_bytes(bytes_c1[48 + i * 8..48 + i * 8 + 8].try_into().unwrap()))
        .collect();
    assert!((vals[1] - 1.0).abs() < 1e-12, "c1[1] == y[1] == 1.0");
    assert!((vals[3] - 2.0).abs() < 1e-12, "c1[3] == y[3] == 2.0");
}

#[tokio::test]
async fn field_vector_magnitude_returns_scalar() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=magnitude")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert_eq!(bytes.len(), 48 + 4 * 8, "magnitude payload length");
    assert_eq!(bytes[6], 1, "nComp byte should be 1 for magnitude");

    let vals: Vec<f64> = (0..4)
        .map(|i| f64::from_le_bytes(bytes[48 + i * 8..48 + i * 8 + 8].try_into().unwrap()))
        .collect();
    // p0=[1,0,0] → |m|=1; p1=[0,1,0] → 1; p2=[0,0,1] → 1; p3=[1,2,2] → 3
    assert!(
        (vals[0] - 1.0).abs() < 1e-10,
        "p0 magnitude should be 1.0, got {}",
        vals[0]
    );
    assert!(
        (vals[1] - 1.0).abs() < 1e-10,
        "p1 magnitude should be 1.0, got {}",
        vals[1]
    );
    assert!(
        (vals[2] - 1.0).abs() < 1e-10,
        "p2 magnitude should be 1.0, got {}",
        vals[2]
    );
    assert!(
        (vals[3] - 3.0).abs() < 1e-10,
        "p3 magnitude should be 3.0, got {}",
        vals[3]
    );
}

#[tokio::test]
async fn field_vector_invalid_component_returns_400() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                // "c5" is out of range for a 3-component field
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=c5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn field_vector_component_etag_304() {
    let app = test_router_with_mock_field().await;
    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("ETag must be present on first response")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=x")
                .header("if-none-match", &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty(), "304 body must be empty");
}

#[tokio::test]
async fn field_vector_different_components_have_different_etags() {
    let app = test_router_with_mock_field().await;

    let resp_x = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let etag_x = resp_x
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();

    let resp_y = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?format=bin&component=y")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let etag_y = resp_y
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();

    assert_ne!(
        etag_x, etag_y,
        "x and y components must produce distinct ETags"
    );
}

// ─── P2: 2-D field slice endpoints ────────────────────────────────────────

#[tokio::test]
async fn slice_meta_missing_plane_returns_400() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn slice_meta_cut_world_and_cut_norm_conflict_returns_400() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xy&cut_world=0.0&cut_norm=0.5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn slice_meta_xy_plane_returns_json() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xy")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["plane"], "xy");
    assert!(json["etag"].is_string(), "slice/meta should include etag");
    assert!(json["x_pixels"].is_number());
    assert!(json["y_pixels"].is_number());
}

#[tokio::test]
async fn slice_scalar_xy_returns_binary() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/scalar?plane=xy&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let ct = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        ct.contains("octet-stream"),
        "slice/scalar content-type should be octet-stream, got: {ct}"
    );

    let bytes = body_bytes(response).await;
    assert!(
        !bytes.is_empty(),
        "slice/scalar binary payload must not be empty"
    );
}

#[tokio::test]
async fn slice_scalar_xy_etag_304() {
    let app = test_router_with_mock_field().await;
    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/scalar?plane=xy&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("ETag must be present")
        .to_string();

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/scalar?plane=xy&component=x")
                .header("if-none-match", &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    let body = body_bytes(second).await;
    assert!(body.is_empty(), "304 body must be empty");
}

#[tokio::test]
async fn slice_scalar_missing_field_returns_404() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/nonexistent/samples/slice/scalar?plane=xy")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn slice_arrows_returns_binary_when_include_arrows_true() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/arrows?plane=xy&include_arrows=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert!(
        !bytes.is_empty(),
        "slice/arrows binary payload must not be empty"
    );
}

#[tokio::test]
async fn slice_meta_fem_without_topology_returns_409() {
    let app = test_router_with_mock_field_fem_without_topology().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xy")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn slice_scalar_fem_without_topology_returns_409() {
    let app = test_router_with_mock_field_fem_without_topology().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/scalar?plane=xy&component=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn slice_arrows_etag_changes_when_arrow_sampling_params_change() {
    let app = test_router_with_mock_field().await;

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/arrows?plane=xy&include_arrows=true&arrow_every=2&max_arrows=100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let etag_first = first
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("missing ETag for arrows request #1")
        .to_string();

    let second = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/arrows?plane=xy&include_arrows=true&arrow_every=4&max_arrows=100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let etag_second = second
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("missing ETag for arrows request #2")
        .to_string();

    let third = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/arrows?plane=xy&include_arrows=true&arrow_every=4&max_arrows=200")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(third.status(), StatusCode::OK);
    let etag_third = third
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("missing ETag for arrows request #3")
        .to_string();

    assert_ne!(
        etag_first, etag_second,
        "ETag should change when arrow_every changes"
    );
    assert_ne!(
        etag_second, etag_third,
        "ETag should change when max_arrows changes"
    );
}

#[test]
fn openapi_contains_field_slice_paths() {
    let openapi = crate::openapi_v2::openapi_json();
    let value = openapi;
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI paths must be an object");

    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta"),
        "OpenAPI missing /slice/meta path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar"),
        "OpenAPI missing /slice/scalar path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows"),
        "OpenAPI missing /slice/arrows path"
    );
}

#[test]
fn openapi_contains_field_slice_contract() {
    let openapi = crate::openapi_v2::openapi_json();
    let value = openapi;
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI paths must be an object");
    let components = value
        .get("components")
        .and_then(|c| c.get("schemas"))
        .and_then(|s| s.as_object())
        .expect("OpenAPI schemas must be present");

    let vector_get = paths
        .get("/v2/sessions/current/data/fields/{quantity_id}/samples/vector")
        .and_then(|p| p.get("get"))
        .expect("vector GET path missing");
    let vector_params = vector_get
        .get("parameters")
        .and_then(|p| p.as_array())
        .expect("vector GET parameters missing");
    assert!(
        vector_params.iter().any(|p| {
            p.get("name").and_then(|n| n.as_str()) == Some("component")
                && p.get("in").and_then(|i| i.as_str()) == Some("query")
        }),
        "vector GET should expose query param `component`"
    );

    let slice_meta_get = paths
        .get("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta")
        .and_then(|p| p.get("get"))
        .expect("slice/meta GET path missing");
    let slice_meta_params = slice_meta_get
        .get("parameters")
        .and_then(|p| p.as_array())
        .expect("slice/meta parameters missing");
    assert!(
        slice_meta_params
            .iter()
            .any(|p| p.get("name").and_then(|n| n.as_str()) == Some("plane")),
        "slice/meta should expose query param `plane`"
    );
    assert!(
        slice_meta_get
            .get("responses")
            .and_then(|r| r.get("409"))
            .is_some(),
        "slice/meta should document 409 response"
    );

    assert!(
        components.contains_key("FieldSliceMeta"),
        "OpenAPI missing FieldSliceMeta schema"
    );
    assert!(
        components.contains_key("FieldSliceGrid"),
        "OpenAPI missing FieldSliceGrid schema"
    );
    assert!(
        components.contains_key("FieldSliceBounds"),
        "OpenAPI missing FieldSliceBounds schema"
    );
    assert!(
        components.contains_key("FieldSliceBinaryDescriptor"),
        "OpenAPI missing FieldSliceBinaryDescriptor schema"
    );
}

#[test]
fn openapi_contains_mesh_semantics_path() {
    let openapi = crate::openapi_v2::openapi_json();
    let value = openapi;
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI paths must be an object");

    assert!(
        paths.contains_key("/v2/sessions/current/meshing/semantics"),
        "OpenAPI missing /mesh/semantics path while router exposes it"
    );
}

#[test]
fn openapi_v2_exposes_professional_session_tree() {
    let value = crate::openapi_v2::openapi_json();
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI v2 paths must be an object");
    let tags = value
        .get("tags")
        .and_then(|t| t.as_array())
        .expect("OpenAPI v2 tags must be present");

    for path in [
        "/v2/platform/health",
        "/v2/sessions/current/status",
        "/v2/sessions/current/model/scene",
        "/v2/sessions/current/meshing/semantics",
        "/v2/sessions/current/simulation/commands",
        "/v2/sessions/current/data/quantities",
        "/v2/sessions/current/data/fields/{quantity_id}/samples/vector",
        "/v2/sessions/current/visualization/display",
        "/v2/sessions/current/visualization/state",
        "/v2/sessions/current/workspace/layout",
        "/v2/sessions/current/analysis/eigenmodes/spectrum",
        "/v2/sessions/current/persistence/imports",
        "/v2/sessions/current/diagnostics/gpu",
    ] {
        assert!(paths.contains_key(path), "OpenAPI v2 missing {path}");
    }

    let tag_names = tags
        .iter()
        .filter_map(|tag| tag.get("name").and_then(|name| name.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        tag_names,
        vec![
            "platform",
            "sessions",
            "model",
            "meshing",
            "simulation",
            "data",
            "visualization",
            "workspace",
            "analysis",
            "persistence",
            "diagnostics",
        ]
    );
}

#[test]
fn openapi_v2_has_no_public_v1_paths() {
    let value = crate::openapi_v2::openapi_json();
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI v2 paths must be an object");

    let public_v1_paths = paths
        .keys()
        .filter(|path| path.starts_with("/v1"))
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        public_v1_paths.is_empty(),
        "OpenAPI v2 must not expose public v1 paths: {public_v1_paths:?}"
    );
}

#[test]
fn openapi_status_schema_remains_thin_and_owned() {
    let value = crate::openapi_v2::openapi_json();
    let schemas = value
        .get("components")
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.as_object())
        .expect("OpenAPI schemas must be present");
    let status_props = schema_property_names(schemas, "LiveStatus");

    for forbidden in [
        "latest_fields",
        "preview_cache",
        "mesh_workspace",
        "fem_mesh",
        "scalar_rows",
        "engine_log",
        "stage_execution",
        "command_ledger",
        "scene_document",
    ] {
        assert!(
            !status_props.contains(forbidden),
            "LiveStatus must stay thin; forbidden field `{forbidden}` leaked into status"
        );
    }

    let expected = BTreeSet::from([
        "api_contract_version".to_string(),
        "runtime_bundle_version".to_string(),
        "session".to_string(),
        "run".to_string(),
        "solver".to_string(),
        "display".to_string(),
        "domain".to_string(),
        "resources".to_string(),
        "capabilities".to_string(),
        "energies".to_string(),
        "metrics".to_string(),
    ]);
    assert_eq!(
        status_props, expected,
        "LiveStatus may contain only summaries, capabilities, and revision pointers"
    );
}

#[test]
fn openapi_mesh_read_model_overlap_is_explicitly_transitional() {
    let value = crate::openapi_v2::openapi_json();
    let schemas = value
        .get("components")
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.as_object())
        .expect("OpenAPI schemas must be present");

    let summary = schema_property_names(schemas, "MeshSummaryResource");
    let active = schema_property_names(schemas, "MeshActiveBuildResource");
    let last_success = schema_property_names(schemas, "MeshLastSuccessfulBuildResource");
    let semantics = schema_property_names(schemas, "MeshSemanticsResource");

    let summary_active_overlap = set_intersection_without_revision(&summary, &active);
    assert_eq!(
        summary_active_overlap,
        BTreeSet::from([
            "effective_airbox_target".to_string(),
            "effective_per_object_targets".to_string(),
        ]),
        "summary/build overlap must remain limited to transitional dashboard target projections"
    );

    let summary_last_success_overlap = set_intersection_without_revision(&summary, &last_success);
    assert_eq!(
        summary_last_success_overlap,
        BTreeSet::from([
            "effective_airbox_target".to_string(),
            "effective_per_object_targets".to_string(),
        ]),
        "summary/latest-success overlap must remain limited to transitional dashboard target projections"
    );

    let active_last_success_overlap = set_intersection_without_revision(&active, &last_success);
    assert_eq!(
        active_last_success_overlap,
        BTreeSet::from([
            "effective_airbox_target".to_string(),
            "effective_per_object_targets".to_string(),
            "last_build_error".to_string(),
        ]),
        "active/latest-success overlap must not grow beyond transitional target and error projections"
    );

    for field in [
        "mesh_summary",
        "mesh_quality_summary",
        "mesh_pipeline_status",
        "last_build_summary",
        "active_build",
        "last_success",
    ] {
        assert!(
            !semantics.contains(field),
            "MeshSemanticsResource must own solver-domain semantics only; `{field}` belongs to summary/build/diagnostics resources"
        );
    }
    assert!(
        semantics.contains("mesh_build_diagnostics"),
        "MeshSemanticsResource keeps diagnostics only as a named transitional projection"
    );
}

#[tokio::test]
async fn router_v2_delegates_core_control_room_resources() {
    let app = test_v2_router_with_session().await;

    for uri in [
        "/v2/sessions/current/status",
        "/v2/sessions/current/data/quantities",
        "/v2/sessions/current/data/fields",
        "/v2/sessions/current/visualization/display",
        "/v2/sessions/current/simulation/commands",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri} should resolve");
    }
}

#[tokio::test]
async fn router_v2_mounts_every_openapi_endpoint() {
    let app = test_router_with_live_magnetization().await;
    let value = crate::openapi_v2::openapi_json();
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .expect("OpenAPI v2 paths must be an object");

    for (template, path_item) in paths {
        // In production this JSON endpoint is served by the SwaggerUi external
        // document mount in main.rs, not by the isolated router_v2 test app.
        if template == "/v2/platform/openapi.json" {
            continue;
        }
        let Some(path_item) = path_item.as_object() else {
            continue;
        };
        let uri = v2_test_uri(template);
        for method in ["get", "post", "put", "patch", "delete"] {
            if !path_item.contains_key(method) {
                continue;
            }
            let method_value = Method::from_bytes(method.to_ascii_uppercase().as_bytes())
                .expect("test method should be valid");
            let mut builder = Request::builder().method(method_value).uri(&uri);
            let body = if method == "get" || method == "delete" {
                Body::empty()
            } else {
                builder = builder.header("content-type", "application/json");
                Body::from("{}")
            };
            let response = app
                .clone()
                .oneshot(builder.body(body).unwrap())
                .await
                .unwrap();
            assert_ne!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {uri} is declared in OpenAPI v2 but not mounted"
            );
            if response.status() == StatusCode::NOT_FOUND {
                let body = body_bytes(response).await;
                let payload: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                assert!(
                    payload
                        .get("error")
                        .and_then(|value| value.as_str())
                        .is_some(),
                    "{method} {uri} returned an unhandled 404 instead of a mounted ApiError"
                );
            }
        }
    }
}

fn schema_property_names(
    schemas: &serde_json::Map<String, serde_json::Value>,
    schema_name: &str,
) -> BTreeSet<String> {
    schemas
        .get(schema_name)
        .and_then(|schema| schema.get("properties"))
        .and_then(|properties| properties.as_object())
        .unwrap_or_else(|| panic!("schema `{schema_name}` must expose object properties"))
        .keys()
        .cloned()
        .collect()
}

fn set_intersection_without_revision(
    left: &BTreeSet<String>,
    right: &BTreeSet<String>,
) -> BTreeSet<String> {
    left.intersection(right)
        .filter(|field| field.as_str() != "revision")
        .cloned()
        .collect()
}

fn v2_test_uri(template: &str) -> String {
    template
        .replace("{quantity_id}", "m")
        .replace("{command_id}", "missing-command")
        .replace("{run_id}", "test-run")
        .replace("{mode_id}", "0")
        .replace("{artifact_id}", "missing-artifact")
        .replace("{material_id}", "missing-material")
        .replace("{object_id}", "missing-object")
        .replace("{part_id}", "missing-part")
        .replace("{interaction_kind}", "exchange")
        .replace("{interface_id}", "missing-interface")
}

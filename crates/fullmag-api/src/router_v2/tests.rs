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
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, RwLock};

use crate::feature_flags::FeatureFlags;
use crate::schemas::realtime::{RealtimeResourceName, RealtimeResourceRevisionMap};
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, CurrentDisplaySelection,
    CurrentLiveSnapshotRequest, CurrentWorkspaceLayout, CurrentWorkspaceRibbon,
    CurrentWorkspaceSelection, DisplayPresentationState, LatestFields, LiveState, RunManifest,
    RuntimeLifecycleState, RuntimeStatusView, ScalarRow, SessionCommand, SessionManifest,
    SessionStateResponse, StageExecutionRecord, StageExecutionState, StageLifecycleState,
    StepUpdateView, TrackedCommandRecord,
};
use fullmag_runner::LivePreviewField;
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload, RuntimeStatus};

use super::build_v2_router;
// ─── helpers ────────────────────────────────────────────────────────────────

fn sample_scene_document() -> fullmag_authoring::SceneDocument {
    let builder = fullmag_authoring::ScriptBuilderState {
        revision: 3,
        backend: None,
        cpu_threads: None,
        fem_demag_solver_policy: None,
        exchange_enabled: true,
        demag_enabled: true,
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
                dbulk: None,
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
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
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

fn regular_tetra_fem_mesh_payload() -> FemMeshPayload {
    let h = (2.0_f64 / 3.0).sqrt();
    FemMeshPayload {
        mesh_name: "regular-tetra".to_string(),
        mesh_id: "regular-tetra:1".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 3.0_f64.sqrt() / 2.0, 0.0],
            [0.5, 3.0_f64.sqrt() / 6.0, h],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![7],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![3],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
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
        generation_id: Some("regular-tetra-gen".to_string()),
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

fn sample_periodic_fem_mesh_payload() -> FemMeshPayload {
    let mut mesh = sample_fem_mesh_payload();
    mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0e-6, 0.0, 0.0],
        [0.0, 1.0e-6, 0.0],
        [1.0e-6, 1.0e-6, 0.0],
        [0.0, 0.0, 1.0e-6],
        [1.0e-6, 0.0, 1.0e-6],
    ];
    mesh.boundary_faces = vec![[0, 2, 4], [1, 3, 5]];
    mesh.boundary_markers = vec![10, 11];
    mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: Some("x_min".to_string()),
        destination_marker: Some("x_max".to_string()),
        marker_a: 10,
        marker_b: 11,
        translation: Some([1.0e-6, 0.0, 0.0]),
        tolerance: Some(1.0e-12),
        axis_hint: Some("x".to_string()),
        orientation: Some("same".to_string()),
        pairing_policy: Some("nearest".to_string()),
    }];
    mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 2,
            node_b: 3,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 4,
            node_b: 5,
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
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
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

fn sample_shared_node_airbox_mesh_payload() -> FemMeshPayload {
    FemMeshPayload {
        mesh_name: "shared-node-test-mesh".to_string(),
        mesh_id: "shared-node-test-mesh:1".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![7, 0],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![3, 4],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: vec![FemMeshPartPayload {
            id: "airbox".to_string(),
            label: "Airbox".to_string(),
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
            node_indices: vec![0, 1, 2, 4],
            surface_faces: vec![[0, 1, 4]],
            bounds_min: Some([0.0, 0.0, -1.0]),
            bounds_max: Some([1.0, 1.0, 0.0]),
        }],
        domain_mesh_mode: Some("shared_domain".to_string()),
        domain_frame: None,
        generation_id: Some("shared-node-generation".to_string()),
        per_domain_quality: Default::default(),
    }
}

fn sample_scoped_mesh_statistics() -> serde_json::Value {
    serde_json::json!({
        "mesh_name": "scoped-test-mesh",
        "quality_source": "gmsh",
        "global": {
            "element_count": 2,
            "edge_length": { "min": 1.0e-9, "mean": 2.0e-9, "max": 4.0e-9, "std": 0.5e-9 },
            "volume": { "min": 1.0e-27, "mean": 2.0e-27, "max": 3.0e-27, "std": 0.2e-27, "ratio": 3.0 },
            "sicn": { "min": 0.2, "mean": 0.8, "p05": 0.3, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 2 }] },
            "gamma": { "min": 0.1, "mean": 0.7, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 2 }] }
        },
        "scopes": [
            {
                "scope_id": "marker:0",
                "kind": "airbox",
                "label": "Airbox",
                "role": "air",
                "marker": 0,
                "element_count": 5,
                "edge_length": { "min": 5.0e-9, "mean": 8.0e-9, "max": 1.0e-8, "std": 1.0e-9 },
                "volume": { "min": 1.0e-25, "mean": 2.0e-25, "max": 4.0e-25, "std": 0.4e-25, "ratio": 4.0 },
                "sicn": { "min": 0.5, "mean": 0.85, "p05": 0.55, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 5 }] },
                "gamma": { "min": 0.4, "mean": 0.9, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 5 }] }
            },
            {
                "scope_id": "marker:7",
                "kind": "domain",
                "label": "Domain 7",
                "role": "domain",
                "marker": 7,
                "element_count": 3,
                "edge_length": { "min": 1.0e-9, "mean": 2.0e-9, "max": 4.0e-9, "std": 0.5e-9 },
                "volume": { "min": 1.0e-27, "mean": 2.0e-27, "max": 3.0e-27, "std": 0.2e-27, "ratio": 3.0 },
                "sicn": { "min": 0.2, "mean": 0.8, "p05": 0.3, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 3 }] },
                "gamma": { "min": 0.1, "mean": 0.7, "histogram": [{ "lo": 0.0, "hi": 1.0, "count": 3 }] }
            }
        ],
        "worst_elements": [
            { "element_index": 1, "marker": 7, "scope_label": "Domain 7", "sicn": 0.2, "gamma": 0.1 },
            { "element_index": 2, "marker": 0, "scope_label": "Airbox", "sicn": 0.5, "gamma": 0.4 }
        ],
        "worst_elements_by_metric": {
            "gamma": [
                { "element_index": 1, "marker": 7, "scope_label": "Domain 7", "sicn": 0.2, "gamma": 0.1 },
                { "element_index": 2, "marker": 0, "scope_label": "Airbox", "sicn": 0.5, "gamma": 0.4 }
            ],
            "sicn": [
                { "element_index": 1, "marker": 7, "scope_label": "Domain 7", "sicn": 0.2, "gamma": 0.1 },
                { "element_index": 2, "marker": 0, "scope_label": "Airbox", "sicn": 0.5, "gamma": 0.4 }
            ]
        }
    })
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
        current_visualization_client_acks: Arc::new(RwLock::new(Default::default())),
        current_visualization_client_ack_revision: Arc::new(AtomicU64::new(0)),
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
        solver_profile: crate::schemas::diagnostics::SolverProfileResource::default(),
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
        scalar_revision: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
        field_catalog_revision: 0,
        field_samples_revision: 0,
        field_quantity_revisions: BTreeMap::new(),
        stage_execution_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    state
}

async fn set_running_stage_execution(state: &Arc<AppState>, state_version: u64) {
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 3,
            completed_stage_indexes: vec![0],
            stages: vec![
                StageExecutionRecord {
                    stage_id: None,
                    kind: None,
                    status: StageLifecycleState::Completed,
                    command_id: Some("cmd-stage-0".into()),
                    started_at_unix_ms: Some(1_700_000_000_000),
                    completed_at_unix_ms: Some(1_700_000_001_000),
                    reason: None,
                    artifact_refs: vec!["artifacts/stage-000".into()],
                    checkpoint_ref: None,
                    loaded_state_ref: None,
                    resume_from_checkpoint_ref: None,
                    state_transition: None,
                    metric_name: None,
                    metric_value: None,
                    threshold: None,
                },
                StageExecutionRecord {
                    stage_id: None,
                    kind: None,
                    status: StageLifecycleState::Running,
                    command_id: Some("cmd-stage-1".into()),
                    started_at_unix_ms: Some(1_700_000_002_000),
                    completed_at_unix_ms: None,
                    reason: None,
                    artifact_refs: vec!["artifacts/stage-001".into()],
                    checkpoint_ref: None,
                    loaded_state_ref: None,
                    resume_from_checkpoint_ref: None,
                    state_transition: None,
                    metric_name: None,
                    metric_value: None,
                    threshold: None,
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
        snapshot.state_version = state_version;
    }
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

fn sample_scalar_row(step: u64, time: f64, e_total: f64) -> ScalarRow {
    ScalarRow {
        step,
        time,
        solver_dt: 1e-12,
        mx: 0.1 * step as f64,
        my: 0.2 * step as f64,
        mz: 0.9,
        e_ex: 1.0,
        e_demag: 2.0,
        e_ext: 3.0,
        e_ani: 0.4,
        e_dmi: 0.5,
        e_total,
        max_dm_dt: 0.01,
        max_h_eff: 100.0,
        max_h_demag: 10.0,
        max_torque_Apm: 2.0,
        max_torque_T: 0.002,
    }
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
                per_object_scalars: Default::default(),
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
                    stage_id: None,
                    kind: None,
                    status: StageLifecycleState::Completed,
                    command_id: Some("cmd-stage-0".into()),
                    started_at_unix_ms: Some(1_700_000_000_000),
                    completed_at_unix_ms: Some(1_700_000_001_000),
                    reason: None,
                    artifact_refs: vec!["artifacts/stage-000".into()],
                    checkpoint_ref: Some("cp-000041".into()),
                    loaded_state_ref: None,
                    resume_from_checkpoint_ref: None,
                    state_transition: Some("preserved".into()),
                    metric_name: None,
                    metric_value: None,
                    threshold: None,
                },
                StageExecutionRecord {
                    stage_id: None,
                    kind: None,
                    status: StageLifecycleState::Running,
                    command_id: Some("cmd-stage-1".into()),
                    started_at_unix_ms: Some(1_700_000_002_000),
                    completed_at_unix_ms: None,
                    reason: None,
                    artifact_refs: vec!["artifacts/stage-001".into()],
                    checkpoint_ref: None,
                    loaded_state_ref: Some("states/imported-state.fmstate".into()),
                    resume_from_checkpoint_ref: Some("cp-000041".into()),
                    state_transition: Some("restored".into()),
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
                target: None,
                reason: None,
                precondition: None,
                client_intent_id: None,
                requested_at_unix_ms: None,
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
                profile: None,
            },
            request_id: Some("req-cmd-1".into()),
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
            },
            request_id: Some("req-cmd-2".into()),
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
            },
            request_id: Some("req-cmd-3".into()),
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
        solver_profile: crate::schemas::diagnostics::SolverProfileResource::default(),
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
        scalar_revision: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
        field_catalog_revision: 0,
        field_samples_revision: 0,
        field_quantity_revisions: BTreeMap::new(),
        stage_execution_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (build_v2_router().with_state(state), artifact_dir)
}

async fn test_router_with_session_store() -> (axum::Router, PathBuf) {
    let (router, _state, repo_root) = test_router_with_session_store_state().await;
    (router, repo_root)
}

async fn test_router_with_session_store_state() -> (axum::Router, Arc<AppState>, PathBuf) {
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
        current_visualization_client_acks: Arc::new(RwLock::new(Default::default())),
        current_visualization_client_ack_revision: Arc::new(AtomicU64::new(0)),
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
        live_state: Some(LiveState {
            status: "paused".into(),
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
                grid: [2, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        }),
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
        solver_profile: crate::schemas::diagnostics::SolverProfileResource::default(),
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
        scalar_revision: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
        field_catalog_revision: 0,
        field_samples_revision: 0,
        field_quantity_revisions: BTreeMap::new(),
        stage_execution_revision: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (
        build_v2_router().with_state(state.clone()),
        state,
        repo_root,
    )
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

fn is_iso_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
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

#[tokio::test]
async fn contract_version_header_is_exposed_to_browser_clients() {
    let app = test_router().layer(super::middleware::cors::cors_layer());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/platform/health")
                .header(header::ORIGIN, "http://localhost:3100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let exposed_headers = response
        .headers()
        .get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
        .expect("access-control-expose-headers should be present for browser clients")
        .to_str()
        .unwrap()
        .to_ascii_lowercase();

    assert!(
        exposed_headers.contains("x-api-contract-version"),
        "browser clients must be able to read x-api-contract-version, got {exposed_headers}"
    );
    assert!(
        exposed_headers.contains("x-request-id"),
        "browser clients must be able to read x-request-id, got {exposed_headers}"
    );
    assert!(
        exposed_headers.contains("etag"),
        "browser clients must be able to read etag, got {exposed_headers}"
    );
    for header_name in [
        "x-fullmag-field-revision",
        "x-fullmag-domain-generation-id",
        "x-fullmag-quantity-id",
        "x-fullmag-component",
        "x-fullmag-encoding",
        "x-fullmag-point-count",
        "x-fullmag-value-count",
        "x-fullmag-n-comp",
        "x-fullmag-scope-kind",
        "x-fullmag-scope-id",
    ] {
        assert!(
            exposed_headers.contains(header_name),
            "browser clients must be able to read {header_name}, got {exposed_headers}"
        );
    }
}

#[tokio::test]
async fn browser_clients_can_preflight_authoring_transactions() {
    let app = test_router().layer(super::middleware::cors::cors_layer());
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v2/sessions/current/model/transactions")
                .header(header::ORIGIN, "http://localhost:3100")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_some(),
        "preflight response must allow the browser origin"
    );
    let allowed_methods = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .expect("access-control-allow-methods should be present")
        .to_str()
        .unwrap()
        .to_ascii_uppercase();
    assert!(
        allowed_methods == "*" || allowed_methods.contains("POST"),
        "authoring transaction preflight must allow POST, got {allowed_methods}"
    );
    let allowed_headers = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .expect("access-control-allow-headers should be present")
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(
        allowed_headers == "*" || allowed_headers.contains("content-type"),
        "authoring transaction preflight must allow content-type, got {allowed_headers}"
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
    assert_ne!(
        json["runtime_bundle_version"], "1.0.0",
        "runtime_bundle_version must describe the backend build, not the API/session protocol"
    );
    let runtime_bundle = json["runtime_bundle_version"]
        .as_str()
        .expect("runtime_bundle_version should be a string");
    assert!(
        is_iso_calendar_date(runtime_bundle),
        "runtime_bundle_version should expose the backend build date as YYYY-MM-DD, got {runtime_bundle}"
    );
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

#[tokio::test]
async fn status_steps_per_second_uses_solver_wall_time_not_session_uptime() {
    let app = test_router_with_runtime_read_models().await;
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
    assert_eq!(json["metrics"]["total_steps"], 42);
    assert_eq!(
        json["metrics"]["steps_per_second"],
        serde_json::json!(420_000_000.0)
    );
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
async fn domain_meta_uses_fdm_physical_cell_size_for_grid_and_bounds() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.metadata = Some(serde_json::json!({
            "artifact_layout": {
                "backend": "fdm",
                "grid_cells": [4, 3, 2],
                "origin": [1.0e-9, -2.0e-9, 3.0e-9],
                "cell_size": [2.0e-9, 3.0e-9, 4.0e-9]
            }
        }));
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 7,
                time: 2.5e-9,
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
                wall_time_ns: 0,
                grid: [4, 3, 2],
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);
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
    assert_eq!(json["discretization"], "fdm");
    assert_eq!(json["grid"]["shape"], serde_json::json!([4, 3, 2]));
    assert_eq!(
        json["grid"]["spacing"],
        serde_json::json!([2.0e-9, 3.0e-9, 4.0e-9])
    );
    assert_eq!(
        json["grid"]["origin"],
        serde_json::json!([1.0e-9, -2.0e-9, 3.0e-9])
    );
    let max = json["bounds"]["max"].as_array().unwrap();
    for (index, expected) in [9.0e-9, 7.0e-9, 11.0e-9].iter().enumerate() {
        assert!(
            (max[index].as_f64().unwrap() - expected).abs() < 1e-18,
            "bounds.max[{index}]"
        );
    }
}

#[tokio::test]
async fn domain_meta_accepts_planar_fdm_zero_spacing_axis() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.metadata = Some(serde_json::json!({
            "artifact_layout": {
                "backend": "fdm",
                "grid_cells": [4, 3, 1],
                "cell_size": [2.0e-9, 3.0e-9, 0.0]
            }
        }));
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 7,
                time: 2.5e-9,
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
                wall_time_ns: 0,
                grid: [4, 3, 1],
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);
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
    assert_eq!(
        json["grid"]["spacing"],
        serde_json::json!([2.0e-9, 3.0e-9, 0.0])
    );
    assert_eq!(json["bounds"]["max"][2], serde_json::json!(0.0));
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
async fn domain_topology_supports_byte_ranges_for_large_topology_payloads() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 18;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/topology")
                .header("range", "bytes=0-3")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("accept-ranges")
            .and_then(|value| value.to_str().ok()),
        Some("bytes")
    );
    assert_eq!(
        response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok()),
        Some("bytes 0-3/164")
    );
    let body = body_bytes(response).await;
    assert_eq!(&body[..], b"FMMT");
}

#[tokio::test]
async fn domain_slice_mesh_overlay_returns_204_for_fdm() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/slice/mesh-overlay?plane=xy&cut_norm=0.5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn domain_slice_mesh_overlay_returns_json_for_fem() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 31;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/slice/mesh-overlay?plane=xy&cut_norm=0.25")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();
    let json = body_json(response).await;
    assert_eq!(json["schema"], "fullmag.domain_2d.mesh_overlay.v1");
    assert_eq!(json["plane"], "xy");
    assert_eq!(json["u_axis"], "x");
    assert_eq!(json["v_axis"], "y");
    assert_eq!(json["normal_axis"], "z");
    assert_eq!(json["domain_generation_id"], 42);
    assert_eq!(json["topology_revision"], 31);
    assert_eq!(json["etag"], etag);
    assert_eq!(json["truncated"], false);
    assert_eq!(
        json["segment_count"].as_u64().unwrap_or(0),
        json["segments"]
            .as_array()
            .map(|value| value.len())
            .unwrap_or(0) as u64
    );
    assert!(
        json["segment_count"].as_u64().unwrap_or(0) > 0,
        "exact FEM slice overlay should expose line segments"
    );
}

#[tokio::test]
async fn domain_slice_mesh_overlay_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 9;
    }
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/domain/slice/mesh-overlay?plane=xz&cut_world=0.25")
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
                .uri("/v2/sessions/current/data/domain/slice/mesh-overlay?plane=xz&cut_world=0.25")
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

#[tokio::test]
async fn visualization_state_exposes_v2_layer_model_with_legacy_projection() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["schema_version"], 5);
    assert_eq!(
        json["quantity"]["active_quantity_id"],
        json["active_quantity_id"]
    );
    assert_eq!(json["layers"]["vectors"]["visible"], json["vector_glyphs"]);
    assert_eq!(json["layers"]["vectors"]["density"], json["vector_density"]);
    assert_eq!(json["layers"]["airbox"]["visible"], false);
    assert_eq!(json["layers"]["airbox"]["wireframe"]["visible"], true);
    assert_eq!(json["layers"]["airbox"]["vectors"]["domain"], "airbox_only");
    assert_eq!(json["sampling"]["max_points"], json["max_points"]);
    assert_eq!(json["fdm"]["x_chosen_size"], json["x_chosen_size"]);
    assert_eq!(json["slice"]["quantity_id"], json["active_quantity_id"]);
    assert_eq!(json["slice"]["axis"], "z");
    assert_eq!(json["slice"]["mode"], "single");
    assert_eq!(json["slice"]["airbox_render_mode"], "wireframe");
    assert_eq!(json["slice"]["show_vectors"], false);
    assert_eq!(json["slice"]["render_mode"], "heatmap");
    assert_eq!(json["trim"]["enabled"], false);
    assert_eq!(json["trim"]["axes"]["x"]["min_percent"], 0.0);
    assert_eq!(json["trim"]["axes"]["x"]["max_percent"], 100.0);
    assert_eq!(json["camera"]["projection"], "perspective");
    assert_eq!(
        json["camera"]["position"],
        serde_json::json!([2e-6, 1.4e-6, 2e-6])
    );
    assert_eq!(json["camera"]["target"], serde_json::json!([0.0, 0.0, 0.0]));
    assert_eq!(json["camera"]["up"], serde_json::json!([0.0, 0.0, 1.0]));
    assert_eq!(json["camera"]["fov_degrees"], 45.0);
    assert_eq!(
        json["camera"]["orthographic_scale"],
        serde_json::Value::Null
    );
    assert!(json["overrides"].as_array().is_some());
    assert!(json["diagnostics"]["warnings"].as_array().is_some());
}

#[tokio::test]
async fn visualization_state_exposes_effective_scene_object_targets() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].id = "arch_waveguide".to_string();
    scene.objects[0].name = "arch_waveguide".to_string();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    let objects = json["targets"]["objects"]
        .as_array()
        .expect("visualization target registry should expose scene objects");
    let target = objects
        .iter()
        .find(|target| target["scope_id"] == "arch_waveguide")
        .expect("arch_waveguide target should be present");

    assert_eq!(target["scope"], "object");
    assert_eq!(target["label"], "arch_waveguide");
    assert_eq!(target["source"], "scene_object");
    assert_eq!(target["settings"]["visible"], true);
    assert_eq!(target["settings"]["surface_visible"], true);
    assert_eq!(target["settings"]["wireframe_visible"], false);
    assert_eq!(target["settings"]["render_mode"], "surface");
}

#[tokio::test]
async fn visualization_state_patch_accepts_nested_v2_controls() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].id = "arch_waveguide".to_string();
    scene.objects[0].name = "arch_waveguide".to_string();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "quantity": {
                            "active_quantity_id": "h_eff",
                            "field_component": "magnitude",
                            "colormap": "viridis"
                        },
                        "layers": {
                            "vectors": {
                                "visible": true,
                                "density": 6
                            }
                        },
                        "sampling": {
                            "max_points": 2048,
                            "max_glyphs": 512
                        },
                        "fdm": {
                            "x_chosen_size": 96,
                            "y_chosen_size": 64
                        },
                        "slice": {
                            "axis": "y",
                            "mode": "slab",
                            "position_percent": 32.5,
                            "show_airbox": true,
                            "airbox_render_mode": "points",
                            "show_airbox_vectors": true,
                            "show_vectors": true,
                            "render_mode": "vectors"
                        },
                        "camera": {
                            "projection": "orthographic",
                            "position": [1.0e-6, 2.0e-6, 3.0e-6],
                            "target": [0.0, 0.0, 0.0],
                            "up": [0.0, 0.0, 1.0],
                            "fov_degrees": 35.0,
                            "orthographic_scale": 2.5e-6
                        },
                        "overrides": [
                            {
                                "scope": "object",
                                "scope_id": "arch_waveguide",
                                "visible": true,
                                "display": {
                                    "visible": true,
                                    "bounds": { "visible": true },
                                    "surface": { "visible": true },
                                    "wireframe": { "visible": true, "opacity": 0.65 },
                                    "points": { "visible": false },
                                    "vectors": { "visible": false },
                                    "opacity": 0.55,
                                    "geometry_scope": "surface"
                                },
                                "style": {
                                    "surface_color_source": "orientation",
                                    "surface_mono_color": "#00ffaa",
                                    "point_color": "#66eeff",
                                    "vector_color_mode": "orientation",
                                    "vector_mono_color": "#ff00aa",
                                    "vector_alpha": 0.45,
                                    "vector_budget": 384,
                                    "vector_length_scale": 1.75,
                                    "vector_thickness": 2.0,
                                    "wireframe_color": "#111111"
                                },
                                "quantity": {
                                    "active_quantity_id": "h_demag"
                                }
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["schema_version"], 5);
    assert_eq!(json["active_quantity_id"], "h_eff");
    assert_eq!(json["quantity"]["active_quantity_id"], "h_eff");
    assert_eq!(json["field_component"], "magnitude");
    assert_eq!(json["layers"]["vectors"]["visible"], true);
    assert_eq!(json["layers"]["vectors"]["density"], 6);
    assert_eq!(json["sampling"]["max_points"], 2048);
    assert_eq!(json["fdm"]["x_chosen_size"], 96);
    assert_eq!(json["slice"]["axis"], "y");
    assert_eq!(json["slice"]["mode"], "slab");
    assert_eq!(json["slice"]["position_percent"], 32.5);
    assert_eq!(json["slice"]["show_airbox"], true);
    assert_eq!(json["slice"]["airbox_render_mode"], "points");
    assert_eq!(json["slice"]["show_airbox_vectors"], true);
    assert_eq!(json["slice"]["render_mode"], "vectors");
    assert_eq!(json["camera"]["projection"], "orthographic");
    assert_eq!(
        json["camera"]["position"],
        serde_json::json!([1.0e-6, 2.0e-6, 3.0e-6])
    );
    assert_eq!(json["camera"]["orthographic_scale"], 2.5e-6);
    assert_eq!(json["overrides"][0]["scope"], "object");
    assert_eq!(json["overrides"][0]["scope_id"], "arch_waveguide");
    assert_eq!(json["overrides"][0]["display"]["bounds"]["visible"], true);
    assert_eq!(json["overrides"][0]["display"]["vectors"]["visible"], false);
    assert_eq!(json["overrides"][0]["display"]["geometry_scope"], "surface");
    assert_eq!(
        json["overrides"][0]["style"]["surface_color_source"],
        "orientation"
    );
    assert_eq!(json["overrides"][0]["style"]["point_color"], "#66eeff");
    assert_eq!(json["overrides"][0]["style"]["vector_alpha"], 0.45);
    assert_eq!(json["overrides"][0]["style"]["vector_budget"], 384);
    assert_eq!(json["overrides"][0]["style"]["vector_length_scale"], 1.75);
    assert_eq!(
        json["overrides"][0]["quantity"]["active_quantity_id"],
        "h_demag"
    );
    assert_eq!(
        json["targets"]["objects"][0]["settings"]["active_quantity_id"],
        "h_demag"
    );
}

#[tokio::test]
async fn visualization_target_overrides_resolve_vector_budget_and_length_scale() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].id = "free-layer".to_string();
    scene.objects[0].name = "Free Layer".to_string();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "overrides": [
                            {
                                "scope": "object",
                                "scope_id": "free-layer",
                                "display": {
                                    "vectors": { "visible": true }
                                },
                                "style": {
                                    "vector_budget": 384,
                                    "vector_length_scale": 1.75
                                }
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    let objects = json["targets"]["objects"]
        .as_array()
        .expect("visualization target registry should expose scene objects");
    let target = objects
        .iter()
        .find(|target| target["scope_id"] == "free-layer")
        .expect("free-layer target should be present");

    assert_eq!(target["settings"]["vectors_visible"], true);
    assert_eq!(target["settings"]["vector_budget"], 384);
    assert_eq!(target["settings"]["vector_length_scale"], 1.75);
    assert_eq!(target["override"]["style"]["vector_budget"], 384);
    assert_eq!(target["override"]["style"]["vector_length_scale"], 1.75);
}

#[tokio::test]
async fn visualization_state_rejects_invalid_target_vector_style_controls() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "overrides": [
                            {
                                "scope": "object",
                                "scope_id": "free-layer",
                                "style": { "vector_length_scale": 5.5 }
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn visualization_state_accepts_zero_vector_budgets() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "layers": {
                            "airbox": {
                                "vectors": {
                                    "density": 0,
                                    "domain": "airbox_only"
                                }
                            }
                        },
                        "overrides": [
                            {
                                "scope": "object",
                                "scope_id": "free-layer",
                                "display": {
                                    "vectors": { "density": 0 }
                                },
                                "style": {
                                    "vector_budget": 0
                                }
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["layers"]["airbox"]["vectors"]["density"], 0);
    assert_eq!(json["overrides"][0]["display"]["vectors"]["density"], 0);
    assert_eq!(json["overrides"][0]["style"]["vector_budget"], 0);
}

#[tokio::test]
async fn visualization_state_rejects_invalid_airbox_vector_domain() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "layers": {
                            "airbox": {
                                "vectors": {
                                    "domain": "magnetic_only"
                                }
                            }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let json = body_json(response).await;
    assert_eq!(
        json["error"],
        "layers.airbox.vectors.domain must be airbox_only"
    );
}

#[tokio::test]
async fn visualization_state_rejects_invalid_camera_patch() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "camera": {
                            "projection": "perspective",
                            "position": [0.0, 0.0, 0.0],
                            "target": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let json = body_json(response).await;
    assert_eq!(
        json["error"],
        "camera.position must not equal camera.target"
    );
}

#[tokio::test]
async fn visualization_camera_patch_publishes_visualization_state_invalidation() {
    let state = test_app_state_with_live_session().await;
    let mut events = state.current_live_realtime_events.subscribe();
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "camera": {
                            "position": [1.0e-6, 2.0e-6, 3.0e-6],
                            "target": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .expect("camera patch should publish a realtime event")
        .expect("realtime channel should stay open");
    let json: serde_json::Value =
        serde_json::from_str(&event.json).expect("event payload should be valid JSON");
    let changes = json["payload"]["changes"]
        .as_array()
        .expect("resource.batch_changed should include changes");
    assert!(
        changes.iter().any(|change| {
            change["recommended_fetch"] == "/v2/sessions/current/visualization/state"
        }),
        "camera patch must invalidate the visualization state resource: {json:#}"
    );
    let forbidden_fetches = [
        "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
        "/v2/sessions/current/data/domain/topology",
        "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full",
    ];
    for forbidden_fetch in forbidden_fetches {
        assert!(
            changes
                .iter()
                .all(|change| change["recommended_fetch"] != forbidden_fetch),
            "visualization-only patch must not invalidate {forbidden_fetch}: {json:#}"
        );
    }
}

#[tokio::test]
async fn visualization_client_ack_records_frontend_feedback() {
    let state = test_app_state_with_live_session().await;
    let mut events = state.current_live_realtime_events.subscribe();
    let app = build_v2_router().with_state(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/visualization/client-acks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "client_id": "browser-1",
                        "client_label": "operator viewport",
                        "viewport_id": "slot-main",
                        "revision": 41,
                        "status": "rendered",
                        "effective_render_mode": "surface"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["client_id"], "browser-1");
    assert_eq!(json["viewport_id"], "slot-main");
    assert_eq!(json["revision"], 41);
    assert_eq!(json["status"], "rendered");
    assert_eq!(json["effective_render_mode"], "surface");
    assert!(json["received_at_unix_ms"].as_u64().unwrap_or(0) > 0);

    let resource_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/client-acks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resource_response.status(), StatusCode::OK);

    let resource_json = body_json(resource_response).await;
    assert_eq!(resource_json["revision"], 1);
    assert_eq!(resource_json["entries"].as_array().unwrap().len(), 1);
    assert_eq!(resource_json["entries"][0]["client_id"], "browser-1");

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .expect("client ack should publish a realtime event")
        .expect("realtime channel should stay open");
    let event_json: serde_json::Value =
        serde_json::from_str(&event.json).expect("event payload should be valid JSON");
    let changes = event_json["payload"]["changes"]
        .as_array()
        .expect("resource.batch_changed should include changes");
    assert!(
        changes.iter().any(|change| {
            change["resource"] == "visualization_client_acks"
                && change["recommended_fetch"] == "/v2/sessions/current/visualization/client-acks"
        }),
        "client ACK must invalidate the acknowledgement resource: {event_json:#}"
    );
}

#[tokio::test]
async fn visualization_client_ack_rejects_empty_client_id() {
    let app = build_v2_router().with_state(test_app_state_with_live_session().await);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/visualization/client-acks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "client_id": " ",
                        "revision": 41,
                        "status": "applied"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let json = body_json(response).await;
    assert_eq!(json["error"], "client_id must not be empty");
}

// ─── scalar history endpoints ───────────────────────────────────────────────

#[tokio::test]
async fn scalar_history_returns_windowed_columnar_rows() {
    let state = test_app_state_with_live_session().await;
    {
        let mut guard = state.current_live_state.write().await;
        let snapshot = guard
            .as_mut()
            .expect("test live session should be initialized");
        snapshot.scalar_rows = vec![
            sample_scalar_row(1, 1e-12, 6.9),
            sample_scalar_row(2, 2e-12, 7.3),
        ];
        snapshot.scalar_revision = 2;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/scalars?since_revision=1&limit=1&columns=time,e_total,mx")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let json = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{json:#}");
    assert_eq!(json["revision"], 2);
    assert_eq!(json["total_rows"], 2);
    assert_eq!(json["returned_rows"], 1);
    assert_eq!(
        json["columns"],
        serde_json::json!(["step", "time", "e_total", "mx"])
    );
    assert_eq!(json["rows"], serde_json::json!([[2.0, 2e-12, 7.3, 0.2]]));
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
async fn visualization_state_patch_persists_nested_layer_sampling_and_fem_state() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let patched = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "layers": {
                            "bounds": { "visible": true },
                            "surface": { "visible": false, "opacity": 0.42 },
                            "wireframe": { "visible": true },
                            "points": { "visible": true },
                            "vectors": { "visible": true, "density": 8, "domain": "magnetic_only" },
                            "airbox": {
                                "visible": true,
                                "opacity": 0.25,
                                "bounds": { "visible": true },
                                "wireframe": { "visible": true },
                                "vectors": { "visible": true, "domain": "airbox_only" }
                            }
                        },
                        "sampling": {
                            "max_points": 4096,
                            "max_glyphs": 512,
                            "max_bytes": 262144,
                            "progressive": false
                        },
                        "fem": {
                            "topology_mode": "volume",
                            "volume_edges_budget": 2048
                        },
                        "trim": {
                            "enabled": true,
                            "axes": {
                                "x": { "enabled": true, "min_percent": 10.0, "max_percent": 85.0 },
                                "y": { "enabled": false, "min_percent": 0.0, "max_percent": 100.0 },
                                "z": { "enabled": true, "min_percent": 0.0, "max_percent": 37.5 }
                            }
                        },
                        "clip": {
                            "enabled": true,
                            "axis": "z",
                            "position_percent": 37.5,
                            "flipped": true
                        },
                        "slice": {
                            "mesh_quality_metric": "skewness",
                            "mesh_color_scale": "hot",
                            "mesh_filter_expression": "quality < 0.2",
                            "mesh_shrink_factor": 0.75
                        },
                        "vector_style": {
                            "color_mode": "magnitude",
                            "mono_color": "#ff3366",
                            "alpha": 0.5,
                            "length_scale": 1.25,
                            "thickness": 2.0,
                            "ferromagnet_visibility": "ghost"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(patched.status(), StatusCode::OK);
    let patched_json = body_json(patched).await;
    assert_eq!(patched_json["layers"]["bounds"]["visible"], true);
    assert_eq!(patched_json["layers"]["surface"]["visible"], false);
    assert_eq!(patched_json["layers"]["wireframe"]["visible"], true);
    assert_eq!(patched_json["layers"]["points"]["visible"], true);
    assert_eq!(patched_json["layers"]["airbox"]["visible"], true);
    assert_eq!(patched_json["layers"]["airbox"]["bounds"]["visible"], true);
    assert_eq!(patched_json["sampling"]["max_points"], 4096);
    assert_eq!(patched_json["sampling"]["max_glyphs"], 512);
    assert_eq!(patched_json["fem"]["topology_mode"], "volume");
    assert_eq!(patched_json["trim"]["enabled"], true);
    assert_eq!(patched_json["trim"]["axes"]["x"]["min_percent"], 10.0);
    assert_eq!(patched_json["trim"]["axes"]["z"]["max_percent"], 37.5);
    assert_eq!(patched_json["clip"]["enabled"], true);
    assert_eq!(patched_json["clip"]["axis"], "z");
    assert_eq!(patched_json["slice"]["mesh_quality_metric"], "skewness");
    assert_eq!(patched_json["slice"]["mesh_color_scale"], "hot");
    assert_eq!(
        patched_json["slice"]["mesh_filter_expression"],
        "quality < 0.2"
    );
    assert_eq!(patched_json["slice"]["mesh_shrink_factor"], 0.75);
    assert_eq!(patched_json["vector_style"]["color_mode"], "magnitude");

    let fetched = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(fetched.status(), StatusCode::OK);
    let fetched_json = body_json(fetched).await;
    assert_eq!(fetched_json["layers"]["bounds"]["visible"], true);
    assert_eq!(fetched_json["layers"]["surface"]["visible"], false);
    assert_eq!(fetched_json["layers"]["surface"]["opacity"], 0.42);
    assert_eq!(fetched_json["layers"]["airbox"]["bounds"]["visible"], true);
    assert_eq!(fetched_json["layers"]["airbox"]["opacity"], 0.25);
    assert_eq!(fetched_json["layers"]["vectors"]["visible"], true);
    assert_eq!(fetched_json["layers"]["vectors"]["density"], 8);
    assert_eq!(fetched_json["sampling"]["max_glyphs"], 512);
    assert_eq!(fetched_json["sampling"]["max_bytes"], 262144);
    assert_eq!(fetched_json["sampling"]["progressive"], false);
    assert_eq!(fetched_json["fem"]["volume_edges_budget"], 2048);
    assert_eq!(fetched_json["trim"]["axes"]["x"]["max_percent"], 85.0);
    assert_eq!(fetched_json["clip"]["position_percent"], 37.5);
    assert_eq!(fetched_json["clip"]["flipped"], true);
    assert_eq!(fetched_json["slice"]["mesh_quality_metric"], "skewness");
    assert_eq!(fetched_json["slice"]["mesh_color_scale"], "hot");
    assert_eq!(
        fetched_json["slice"]["mesh_filter_expression"],
        "quality < 0.2"
    );
    assert_eq!(fetched_json["slice"]["mesh_shrink_factor"], 0.75);
    assert_eq!(fetched_json["vector_style"]["mono_color"], "#ff3366");
    assert_eq!(
        fetched_json["vector_style"]["ferromagnet_visibility"],
        "ghost"
    );

    let presentation = state.current_display_presentation.read().await;
    assert!(presentation.visualization_layers.is_some());
    assert!(presentation.visualization_sampling.is_some());
    assert!(presentation.visualization_fem.is_some());
    assert!(presentation.visualization_trim.is_some());
    assert!(presentation.visualization_clip.is_some());
    assert!(presentation.visualization_slice.is_some());
    assert!(presentation.visualization_vector_style.is_some());
}

#[tokio::test]
async fn visualization_airbox_layer_patch_supersedes_initial_airbox_override() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());

    let seeded = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "overrides": [
                            {
                                "scope": "airbox",
                                "scope_id": "airbox",
                                "visible": false,
                                "display": { "visible": false },
                                "quantity": { "active_quantity_id": "h_demag" }
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(seeded.status(), StatusCode::OK);
    let seeded_json = body_json(seeded).await;
    assert_eq!(
        seeded_json["targets"]["airbox"]["settings"]["visible"],
        false
    );
    assert_eq!(
        seeded_json["targets"]["airbox"]["settings"]["active_quantity_id"],
        "h_demag"
    );

    let patched = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "layers": {
                            "airbox": {
                                "visible": true,
                                "wireframe": { "visible": true }
                            }
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(patched.status(), StatusCode::OK);

    let fetched = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(fetched.status(), StatusCode::OK);
    let fetched_json = body_json(fetched).await;
    assert_eq!(fetched_json["layers"]["airbox"]["visible"], true);
    assert_eq!(
        fetched_json["targets"]["airbox"]["settings"]["visible"],
        true
    );
    assert_eq!(
        fetched_json["targets"]["airbox"]["settings"]["active_quantity_id"],
        "h_demag"
    );
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
async fn mesh_object_quality_returns_normalized_scope_statistics() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.mesh_workspace = Some(serde_json::json!({
            "effective_per_object_targets": {
                "body": { "marker": 7, "maximum_element_size": 2e-9 }
            },
            "mesh_statistics": sample_scoped_mesh_statistics()
        }));
        snapshot.mesh_revision = 21;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/objects/body/quality")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 21);
    assert_eq!(json["quality"]["marker"], 7);
    assert_eq!(json["quality"]["global"]["marker"], 7);
    assert_eq!(json["quality"]["global"]["element_count"], 3);
    assert_eq!(
        json["quality"]["global"]["sicn"]["histogram"][0]["count"],
        3
    );
    assert_eq!(
        json["quality"]["worst_elements"][0]["scope_label"],
        "Domain 7"
    );
    assert_eq!(
        json["quality"]["worst_elements"].as_array().unwrap().len(),
        1
    );
}

#[tokio::test]
async fn mesh_universe_quality_returns_airbox_scope_statistics() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "effective_airbox_target": { "maximum_element_size": 1e-8 },
            "mesh_statistics": sample_scoped_mesh_statistics()
        }));
        snapshot.mesh_revision = 22;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/universe/quality")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 22);
    assert_eq!(json["quality"]["quality_source"], "gmsh");
    assert_eq!(json["quality"]["global"]["kind"], "airbox");
    assert_eq!(json["quality"]["global"]["marker"], 0);
    assert_eq!(json["quality"]["global"]["element_count"], 5);
    assert_eq!(json["quality"]["global"]["volume"]["ratio"], 4.0);
    assert_eq!(
        json["quality"]["global"]["gamma"]["histogram"][0]["count"],
        5
    );
    assert_eq!(
        json["quality"]["worst_elements"][0]["scope_label"],
        "Airbox"
    );
    assert_eq!(
        json["quality"]["worst_elements"].as_array().unwrap().len(),
        1
    );
}

#[tokio::test]
async fn mesh_universe_quality_reads_scoped_statistics_from_last_build_summary() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "effective_airbox_target": { "maximum_element_size": 1e-8 },
            "last_build_summary": {
                "kind": "mesh_build_summary",
                "mesh_statistics": sample_scoped_mesh_statistics()
            }
        }));
        snapshot.mesh_revision = 23;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/universe/quality")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 23);
    assert_eq!(json["quality"]["quality_source"], "gmsh");
    assert_eq!(json["quality"]["global"]["kind"], "airbox");
    assert_eq!(json["quality"]["global"]["element_count"], 5);
    assert_eq!(json["quality"]["global"]["volume"]["ratio"], 4.0);
}

#[tokio::test]
async fn mesh_universe_quality_fallback_reports_volume_ratio() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut mesh_value =
            serde_json::to_value(sample_fem_mesh_payload()).expect("sample mesh should serialize");
        mesh_value["element_markers"] = serde_json::json!([0]);
        mesh_value["per_domain_quality"] = serde_json::json!({
            "0": {
                "n_elements": 59244,
                "sicn_min": 0.12,
                "sicn_max": 0.98,
                "sicn_mean": 0.72,
                "sicn_p5": 0.31,
                "sicn_histogram": [1, 2, 3],
                "gamma_min": 0.22,
                "gamma_mean": 0.81,
                "gamma_histogram": [4, 5, 6],
                "volume_min": 2.0e-27,
                "volume_max": 1.0e-25,
                "volume_mean": 5.0e-26,
                "volume_std": 1.0e-26,
                "avg_quality": 0.72
            }
        });
        let mesh =
            serde_json::from_value(mesh_value).expect("mesh quality payload should deserialize");
        snapshot.fem_mesh = Some(mesh);
        snapshot.mesh_workspace = Some(serde_json::json!({
            "effective_airbox_target": { "maximum_element_size": 5e-7 }
        }));
        snapshot.mesh_revision = 24;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/universe/quality")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 24);
    assert_eq!(json["quality"]["quality_source"], "per_domain_quality");
    assert_eq!(json["quality"]["global"]["element_count"], 59_244);
    let volume_ratio = json["quality"]["global"]["volume"]["ratio"]
        .as_f64()
        .expect("fallback quality should include volume ratio");
    assert!((volume_ratio - 50.0).abs() < 1.0e-9);
    assert_eq!(
        json["quality"]["global"]["characteristic_size"]["histogram"][0]["count"],
        1
    );
    assert_eq!(
        json["quality"]["global"]["edge_length"]["histogram"][0]["count"],
        3
    );
    assert_eq!(
        json["quality"]["global"]["volume"]["histogram"][0]["count"],
        1
    );
}

#[tokio::test]
async fn mesh_universe_quality_reports_airbox_size_distribution_without_quality_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut mesh = sample_fem_mesh_payload();
        mesh.element_markers = vec![0];
        mesh.per_domain_quality.clear();
        snapshot.fem_mesh = Some(mesh);
        snapshot.mesh_workspace = Some(serde_json::json!({
            "effective_airbox_target": { "maximum_element_size": 5e-7 }
        }));
        snapshot.mesh_revision = 25;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/universe/quality")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 25);
    assert_eq!(json["quality"]["global"]["kind"], "airbox");
    assert_eq!(json["quality"]["global"]["element_count"], 1);
    assert_eq!(
        json["quality"]["global"]["characteristic_size"]["histogram"][0]["count"],
        1
    );
    assert_eq!(
        json["quality"]["global"]["edge_length"]["histogram"][0]["count"],
        3
    );
    assert_eq!(
        json["quality"]["global"]["volume"]["histogram"][0]["count"],
        1
    );
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
            "mesh_pipeline_status": [
                {
                    "id": "remesh",
                    "label": "Remesh",
                    "status": "queued",
                    "detail": "queued for remesh"
                }
            ],
            "effective_airbox_target": { "hmax": "5e-9" },
            "effective_per_object_targets": { "body": { "hmax": "2e-9" } },
            "last_build_summary": {
                "elements": 42,
                "shared_domain_build_report": {
                    "build_mode": "component_aware",
                    "effective_per_object_targets": {
                        "body": {
                            "edge_hmax": 1.8e-9,
                            "edge_thickness": 12e-9,
                            "interface_thickness": 8e-9,
                            "transition_realization": "surface_shell"
                        }
                    },
                    "operation_statuses": [{
                        "kind": "boundary_layers",
                        "scope": "global",
                        "requested": true,
                        "status": "ignored",
                        "reason": "explicit target selectors required"
                    }]
                }
            },
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
    assert_eq!(json["mesh_pipeline_status"][0]["id"], "remesh");
    assert_eq!(json["mesh_pipeline_status"][0]["status"], "queued");
    assert_eq!(json["effective_airbox_target"]["hmax"], "5e-9");
    assert_eq!(json["effective_per_object_targets"]["body"]["hmax"], "2e-9");
    assert_eq!(json["last_build_summary"]["elements"], 42);
    assert_eq!(
        json["last_build_summary"]["shared_domain_build_report"]["effective_per_object_targets"]
            ["body"]["edge_hmax"],
        1.8e-9
    );
    assert_eq!(
        json["last_build_summary"]["shared_domain_build_report"]["operation_statuses"][0]["status"],
        "ignored"
    );
    assert_eq!(
        json["shared_domain_build_report"]["build_mode"],
        "component_aware"
    );
    assert_eq!(
        json["shared_domain_build_report"]["effective_per_object_targets"]["body"]
            ["edge_maximum_element_size"],
        1.8e-9
    );
    assert_eq!(
        json["shared_domain_build_report"]["operation_statuses"][0]["status"],
        "ignored"
    );
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
            "mesh_cost_report": {
                "node_count": 12,
                "element_count": 24,
                "estimated_dense_ram_gb": 0.1
            },
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
    assert_eq!(
        json["report"]["mesh_statistics"]["global"]["element_count"],
        24
    );
    assert_eq!(json["report"]["mesh_cost_report"]["element_count"], 24);
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
async fn mesh_realized_size_fields_returns_backend_truth_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "last_build_summary": {
                "size_fields_realized": {
                    "fields": [{
                        "kind": "EdgeDistanceThreshold",
                        "source": "object-edge-sizing",
                        "applied": true
                    }]
                }
            }
        }));
        snapshot.mesh_revision = 18;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 18);
    assert_eq!(
        json["realized_size_fields"]["fields"][0]["kind"],
        "EdgeDistanceThreshold"
    );
    assert_eq!(json["realized_size_fields"]["fields"][0]["applied"], true);
}

#[tokio::test]
async fn mesh_quality_gates_prefers_backend_truth_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_quality_gates": {
                "source": "backend",
                "checks": [{
                    "id": "positive_orientation",
                    "status": "pass"
                }]
            }
        }));
        snapshot.mesh_revision = 19;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/quality-gates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 19);
    assert_eq!(json["gates"]["source"], "backend");
    assert_eq!(json["gates"]["checks"][0]["id"], "positive_orientation");
}

#[tokio::test]
async fn mesh_quality_gates_returns_marked_projection_when_backend_payload_is_missing() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "mesh_quality_summary": { "sicn": { "p05": 0.34 } },
            "mesh_statistics": { "global": { "element_count": 0 } }
        }));
        snapshot.mesh_revision = 20;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/quality-gates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 20);
    assert_eq!(json["gates"]["source"], "derived_from_current_fem_mesh");
    assert_eq!(
        json["gates"]["reason"],
        "mesh_quality_gates is missing from the current mesh workspace/build report"
    );
}

#[tokio::test]
async fn mesh_active_build_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "active_build": { "build_id": "mesh-build-1", "status": "running" },
            "mesh_pipeline_status": [
                {
                    "id": "remesh",
                    "label": "Remesh",
                    "status": "queued",
                    "detail": "queued for remesh"
                }
            ],
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
        let mut scene = sample_scene_document();
        let object_mesh = fullmag_authoring::ScriptBuilderPerGeometryMeshState {
            mode: "custom".to_string(),
            maximum_element_size: Some("6e-9".to_string()),
            mesh_strategy: Some("swept_prism".to_string()),
            order: Some(1),
            through_thickness_elements: Some(1),
            through_thickness_distribution: Some("fixed".to_string()),
            sweep_face_meshing: Some("triangular".to_string()),
            edge_hmax: Some("1.8e-9".to_string()),
            edge_thickness: Some("12e-9".to_string()),
            corner_hmax: Some("1.2e-9".to_string()),
            corner_extent: Some("5e-9".to_string()),
            ..Default::default()
        };
        scene.objects[0].object_mesh = Some(object_mesh.clone());
        scene.objects[0].mesh_override = Some(object_mesh);
        let universe_mesh = fullmag_authoring::ScriptBuilderUniverseState {
            mode: "box".to_string(),
            size: Some([4.0, 5.0, 6.0]),
            center: Some([0.0, 0.0, 0.0]),
            padding: Some([1.0, 1.5, 2.0]),
            airbox_hmax: Some(8.0e-9),
            airbox_hmin: Some(2.0e-9),
            airbox_growth_rate: Some(1.4),
            airbox_grading: Some("linear".to_string()),
        };
        scene.study.universe_mesh = Some(universe_mesh.clone());
        scene.universe = Some(universe_mesh);
        snapshot.scene_document = Some(scene);
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
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("geometry"))
            .and_then(serde_json::Value::as_str),
        Some("body")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("maximum_element_size"))
            .and_then(serde_json::Value::as_str),
        Some("6e-9")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("mesh_strategy"))
            .and_then(serde_json::Value::as_str),
        Some("swept_prism")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("through_thickness_elements"))
            .and_then(serde_json::Value::as_i64),
        Some(1)
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("edge_maximum_element_size"))
            .and_then(serde_json::Value::as_str),
        Some("1.8e-9")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("edge_thickness"))
            .and_then(serde_json::Value::as_str),
        Some("12e-9")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("corner_maximum_element_size"))
            .and_then(serde_json::Value::as_str),
        Some("1.2e-9")
    );
    assert_eq!(
        mesh_options
            .get("per_geometry")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|value| value.get("corner_extent"))
            .and_then(serde_json::Value::as_str),
        Some("5e-9")
    );
    assert_eq!(
        mesh_options
            .get("scene_problem_patch")
            .and_then(|value| value.get("universe"))
            .and_then(|value| value.get("airbox_grading"))
            .and_then(serde_json::Value::as_str),
        Some("linear")
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
                solver_profile: None,
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
async fn fem_mesh_snapshot_for_current_scene_clears_mesh_dirty_tags() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 43;
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
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: None,
                latest_scalar_row: None,
                latest_fields: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(sample_fem_mesh_payload_with_manifest()),
            },
        )
        .expect("snapshot should apply");
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
    assert_eq!(json["source_scene_revision"], 43);
}

#[tokio::test]
async fn unchanged_fem_mesh_snapshot_keeps_later_dirty_scene_dirty() {
    let state = test_app_state_with_live_session().await;
    let mesh = sample_fem_mesh_payload_with_manifest();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut scene = sample_scene_document();
        scene.revision = 43;
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
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: None,
                latest_scalar_row: None,
                latest_fields: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(mesh.clone()),
            },
        )
        .expect("snapshot should apply");
    }

    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let scene = snapshot.scene_document.as_mut().expect("scene exists");
        scene.revision = 44;
        scene.objects[0].tags.push("mesh:dirty".to_string());
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
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: None,
                latest_scalar_row: None,
                latest_fields: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(mesh),
            },
        )
        .expect("snapshot should apply");
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
    assert_eq!(json["source_scene_revision"], serde_json::Value::Null);
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
async fn mesh_shared_domain_cross_section_returns_binary_fmcs_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/cross-section?plane=xy&position_percent=50&include_polygons=true&include_wireframe=true")
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
    assert_eq!(&body[..4], b"FMCS");
    assert_eq!(u32::from_le_bytes(body[4..8].try_into().unwrap()), 2);
    assert_eq!(u32::from_le_bytes(body[8..12].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(body[12..16].try_into().unwrap()), 3);
    assert_eq!(u32::from_le_bytes(body[16..20].try_into().unwrap()), 3);
    assert_eq!(u32::from_le_bytes(body[20..24].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(body[24..28].try_into().unwrap()), 3);
    assert_eq!(u32::from_le_bytes(body[28..32].try_into().unwrap()), 1);
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_image_returns_png_payload() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image?plane=xy&position_percent=50&metric=volume&color_scale=viridis&resolution=512&wireframe=true&legend=true")
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
        Some("image/png"),
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-renderer")
            .and_then(|value| value.to_str().ok()),
        Some("cross-section-image-v2"),
    );
    assert!(response.headers().contains_key("x-fullmag-image-width"));
    assert!(response.headers().contains_key("x-fullmag-image-height"));
    let body = body_bytes(response).await;
    assert_eq!(&body[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_image_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);
    let uri = "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image?plane=xy&position_percent=50&metric=volume&resolution=512";

    let first = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
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
                .uri(uri)
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
    assert!(body_bytes(second).await.is_empty());
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_image_rejects_invalid_resolution() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image?plane=xy&position_percent=50&metric=volume&resolution=128")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_image_returns_204_without_fem_mesh() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image?plane=xy&position_percent=50&metric=volume&resolution=512")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_quality_returns_parent_element_fmqs_payload() {
    let artifact_path = std::env::temp_dir().join(format!(
        "fullmag-cross-section-quality-{}-{}.fmmq",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut artifact = Vec::new();
    artifact.extend_from_slice(b"FMMQ");
    artifact.push(1);
    artifact.push(1);
    artifact.extend_from_slice(&0u16.to_le_bytes());
    artifact.extend_from_slice(&1u32.to_le_bytes());
    artifact.extend_from_slice(&0b111u32.to_le_bytes());
    artifact.extend_from_slice(&0u64.to_le_bytes());
    artifact.extend_from_slice(&0u64.to_le_bytes());
    artifact.extend_from_slice(&0.5f64.to_le_bytes());
    artifact.extend_from_slice(&0.25f64.to_le_bytes());
    artifact.extend_from_slice(&(1.0f64 / 6.0).to_le_bytes());
    fs::write(&artifact_path, &artifact).unwrap();

    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.mesh_workspace = Some(serde_json::json!({
            "quality_data_artifact": {
                "kind": "fmmq.v1",
                "schema_version": 1,
                "path": artifact_path,
                "byte_size": artifact.len(),
                "element_count": 1,
                "metrics": ["sicn", "gamma", "volume"]
            }
        }));
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality?plane=xy&position_percent=50&metric=gamma")
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
    assert_eq!(&body[..4], b"FMQS");
    assert_eq!(u32::from_le_bytes(body[4..8].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(body[8..12].try_into().unwrap()), 1);
    assert_eq!(f32::from_le_bytes(body[12..16].try_into().unwrap()), 0.25);
    assert_eq!(f32::from_le_bytes(body[16..20].try_into().unwrap()), 0.25);
    assert_eq!(f32::from_le_bytes(body[20..24].try_into().unwrap()), 0.25);
    let _ = fs::remove_file(artifact_path);
}

#[tokio::test]
async fn mesh_shared_domain_cross_section_quality_computes_parent_tet_metrics_without_artifact() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(regular_tetra_fem_mesh_payload());
        snapshot.mesh_workspace = None;
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);

    for (metric, expected) in [
        ("volume", 2.0_f32.sqrt() / 12.0),
        ("aspect_ratio", 1.0_f32),
        ("max_angle", 70.528_78_f32),
        ("min_edge", 1.0_f32),
        ("skewness", 1.0_f32),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality?plane=xy&position_percent=50&metric={metric}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK, "metric {metric}");
        let body = body_bytes(response).await;
        assert_eq!(&body[..4], b"FMQS");
        assert_eq!(u32::from_le_bytes(body[8..12].try_into().unwrap()), 1);
        assert!(
            (f32::from_le_bytes(body[20..24].try_into().unwrap()) - expected).abs() < 1.0e-4,
            "metric {metric}"
        );
    }
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
async fn mesh_shared_domain_quality_data_returns_binary_artifact() {
    let artifact_path = std::env::temp_dir().join(format!(
        "fullmag-quality-data-{}-{}.fmmq",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut artifact = Vec::new();
    artifact.extend_from_slice(b"FMMQ");
    artifact.push(1);
    artifact.push(1);
    artifact.extend_from_slice(&0u16.to_le_bytes());
    artifact.extend_from_slice(&1u32.to_le_bytes());
    artifact.extend_from_slice(&0b111u32.to_le_bytes());
    artifact.extend_from_slice(&0u64.to_le_bytes());
    artifact.extend_from_slice(&0u64.to_le_bytes());
    artifact.extend_from_slice(&0.5f64.to_le_bytes());
    artifact.extend_from_slice(&0.25f64.to_le_bytes());
    artifact.extend_from_slice(&(1.0f64 / 6.0).to_le_bytes());
    fs::write(&artifact_path, &artifact).unwrap();

    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_workspace = Some(serde_json::json!({
            "quality_data_artifact": {
                "kind": "fmmq.v1",
                "schema_version": 1,
                "path": artifact_path,
                "byte_size": artifact.len(),
                "element_count": 1,
                "metrics": ["sicn", "gamma", "volume"]
            }
        }));
        snapshot.mesh_revision = 42;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element")
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
    assert_eq!(&body[..4], b"FMMQ");
    assert_eq!(body.len(), artifact.len());
    let _ = fs::remove_file(artifact_path);
}

#[tokio::test]
async fn mesh_periodic_pairs_returns_v1_diagnostics() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_periodic_fem_mesh_payload());
        snapshot.mesh_revision = 41;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/mesh/periodic_pairs.v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["schema_version"], "periodic_pairs.v1");
    assert_eq!(json["revision"], 41);
    assert_eq!(json["pairs"][0]["pair_id"], "x_periodic");
    assert_eq!(json["pairs"][0]["source_marker"], "x_min");
    assert_eq!(json["pairs"][0]["destination_marker"], "x_max");
    assert_eq!(json["pairs"][0]["paired_node_count"], 3);
    assert_eq!(json["pairs"][0]["unpaired_source_node_count"], 0);
    assert_eq!(json["pairs"][0]["unpaired_destination_node_count"], 0);
    assert_eq!(json["pairs"][0]["max_residual_m"], 0.0);
    assert_eq!(json["pairs"][0]["rms_residual_m"], 0.0);
    assert_eq!(json["pairs"][0]["status"], "valid");
}

#[tokio::test]
async fn mesh_periodic_pairs_falls_back_to_artifact_file() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let mesh_dir = artifact_dir.join("mesh");
    fs::create_dir_all(&mesh_dir).expect("mesh artifact dir should be created");
    fs::write(
        mesh_dir.join("periodic_pairs.v1.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "periodic_pairs.v1",
            "pairs": [{
                "pair_id": "x_periodic",
                "source_marker": "x_min",
                "destination_marker": "x_max",
                "marker_a": 10,
                "marker_b": 11,
                "expected_translation_m": [1.0e-6, 0.0, 0.0],
                "paired_node_count": 3,
                "unpaired_source_node_count": 0,
                "unpaired_destination_node_count": 0,
                "max_residual_m": 0.0,
                "rms_residual_m": 0.0,
                "status": "valid"
            }]
        }))
        .expect("periodic pairs fixture should serialize"),
    )
    .expect("periodic pairs artifact should be written");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/mesh/periodic_pairs.v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["schema_version"], "periodic_pairs.v1");
    assert_eq!(json["revision"], 0);
    assert_eq!(json["pairs"][0]["pair_id"], "x_periodic");

    let _ = fs::remove_dir_all(&artifact_dir);
}

#[tokio::test]
async fn eigen_v2_artifact_endpoints_return_json_and_csv_contracts() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let eigen_dir = artifact_dir.join("eigen");
    let modes_dir = eigen_dir.join("modes").join("sample_0003");
    fs::create_dir_all(&modes_dir).expect("eigen artifact dirs should be created");
    fs::write(
        eigen_dir.join("spectrum.v2.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "eigen_spectrum.v2",
            "solver_model": "fem_eigen_floquet_dense_debug",
            "sample_count": 1,
            "samples": [{
                "sample_index": 3,
                "label": "X",
                "k_vector": [1.0, 0.0, 0.0],
                "path_s": 1.0,
                "segment_index": 0,
                "t_in_segment": 1.0,
                "modes": [{
                    "raw_mode_index": 7,
                    "branch_id": 4,
                    "frequency_real_hz": 1.5e9,
                    "frequency_imag_hz": 0.0,
                    "angular_frequency_rad_per_s": 9.42477796077e9,
                    "eigenvalue_real": 1.0,
                    "eigenvalue_imag": 0.0,
                    "norm": 1.0,
                    "max_amplitude": 1.0,
                    "dominant_polarization": "x",
                    "k_vector": [1.0, 0.0, 0.0]
                }]
            }]
        }))
        .expect("spectrum fixture should serialize"),
    )
    .expect("spectrum artifact should be written");
    fs::write(
        eigen_dir.join("branches.v2.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "solver_model": "fem_eigen_floquet_dense_debug",
            "branches": [{
                "branch_id": 4,
                "label": "acoustic",
                "points": [{
                    "sample_index": 3,
                    "raw_mode_index": 7,
                    "frequency_real_hz": 1.5e9,
                    "frequency_imag_hz": 0.0,
                    "tracking_confidence": 0.99,
                    "overlap_prev": 0.99
                }]
            }]
        }))
        .expect("branches fixture should serialize"),
    )
    .expect("branches artifact should be written");
    fs::write(
        modes_dir.join("mode_0007.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "eigen_mode.v2",
            "solver_model": "fem_eigen_floquet_dense_debug",
            "sample_index": 3,
            "raw_mode_index": 7,
            "branch_id": 4,
            "frequency_real_hz": 1.5e9,
            "frequency_imag_hz": 0.0,
            "angular_frequency_rad_per_s": 9.42477796077e9,
            "normalization": "unit_l2",
            "damping_policy": "ignore",
            "dominant_polarization": "x",
            "k_vector": [1.0, 0.0, 0.0],
            "real": [[1.0, 0.0, 0.0]],
            "imag": [[0.0, 1.0, 0.0]],
            "amplitude": [1.0],
            "phase": [0.0]
        }))
        .expect("mode fixture should serialize"),
    )
    .expect("mode artifact should be written");
    fs::write(
        eigen_dir.join("dispersion.csv"),
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score\n3,1,1,0,0,X,7,4,1500000000,9424777960.77,0,1e-9,0.99\n",
    )
    .expect("dispersion csv should be written");

    let spectrum = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/eigen/spectrum.v2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(spectrum.status(), StatusCode::OK);
    let spectrum_json = body_json(spectrum).await;
    assert_eq!(spectrum_json["schema_version"], "eigen_spectrum.v2");
    assert_eq!(spectrum_json["samples"][0]["path_s"], 1.0);

    let branches = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/eigen/branches.v2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(branches.status(), StatusCode::OK);
    let branches_json = body_json(branches).await;
    assert_eq!(branches_json["schema_version"], "eigen_branches.v2");
    assert_eq!(branches_json["branches"][0]["branch_id"], 4);

    let mode = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/eigen/modes/3/7")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mode.status(), StatusCode::OK);
    let mode_json = body_json(mode).await;
    assert_eq!(mode_json["sample_index"], 3);
    assert_eq!(mode_json["raw_mode_index"], 7);
    assert_eq!(mode_json["branch_id"], 4);

    let dispersion = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/eigen/dispersion.csv")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(dispersion.status(), StatusCode::OK);
    assert_eq!(
        dispersion.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/csv; charset=utf-8"
    );
    let csv = String::from_utf8(body_bytes(dispersion).await).expect("csv body should be utf-8");
    assert!(csv.starts_with("sample_index,path_s_rad_per_m,kx_rad_per_m"));
    assert!(csv.contains(",branch_id,"));

    let _ = fs::remove_dir_all(&artifact_dir);
}

#[tokio::test]
async fn eigen_branches_v2_missing_artifact_returns_404() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let eigen_dir = artifact_dir.join("eigen");
    fs::create_dir_all(&eigen_dir).expect("eigen artifact dir should be created");
    fs::write(
        eigen_dir.join("spectrum.v2.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "eigen_spectrum.v2",
            "solver_model": "fem_eigen_floquet_dense_debug",
            "sample_count": 0,
            "samples": []
        }))
        .expect("spectrum fixture should serialize"),
    )
    .expect("spectrum artifact should be written");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/eigen/branches.v2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = String::from_utf8(body_bytes(response).await).expect("body should be utf-8");
    assert!(body.contains("branches.v2") || body.contains("branches.v2.json"));

    let _ = fs::remove_dir_all(&artifact_dir);
}

#[tokio::test]
async fn response_magnetic_sweep_v1_endpoint_returns_artifact_json() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let response_dir = artifact_dir.join("response");
    fs::create_dir_all(&response_dir).expect("response artifact dir should be created");
    fs::write(
        response_dir.join("magnetic_response_sweep.v1.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "magnetic_response_sweep.v1",
            "solver_model": "block_real_dense_debug",
            "backend_engine_id": "fem-eigen-cpu",
            "frequencies_hz": [1.0e9],
            "frequencies_rad_per_s": [6.283185307179586e9],
            "points": [{
                "frequency_hz": 1.0e9,
                "omega_rad_per_s": 6.283185307179586e9,
                "residual_norm": 1.0e-9
            }]
        }))
        .expect("response fixture should serialize"),
    )
    .expect("response sweep artifact should be written");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["schema_version"], "magnetic_response_sweep.v1");
    assert_eq!(json["frequencies_hz"][0], 1.0e9);

    let _ = fs::remove_dir_all(&artifact_dir);
}

#[tokio::test]
async fn response_magnetic_sweep_v1_missing_artifact_returns_404() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    fs::create_dir_all(artifact_dir.join("response"))
        .expect("response artifact dir should be created");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = String::from_utf8(body_bytes(response).await).expect("body should be utf-8");
    assert!(body.contains("magnetic_response_sweep.v1.json"));

    let _ = fs::remove_dir_all(&artifact_dir);
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
async fn mesh_shared_domain_manifest_reports_clean_scene_provenance_without_build_summary() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 93;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 96;
        snapshot.scene_document = Some(scene);
        snapshot.mesh_workspace = Some(serde_json::json!({}));
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
    assert_eq!(json["revision"], 96);
    assert_eq!(json["source_scene_revision"], 93);
    assert_eq!(json["geometry_realization_revision"], 93);
}

#[tokio::test]
async fn mesh_shared_domain_manifest_keeps_provenance_unknown_for_dirty_scene_without_build_summary(
) {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 94;
    scene.objects[0].tags.push("mesh:dirty".to_string());
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 97;
        snapshot.scene_document = Some(scene);
        snapshot.mesh_workspace = Some(serde_json::json!({}));
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
    assert_eq!(json["source_scene_revision"], serde_json::Value::Null);
    assert_eq!(
        json["geometry_realization_revision"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn mesh_build_resources_report_clean_scene_provenance_without_build_summary() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 95;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_build_revision = 99;
        snapshot.scene_document = Some(scene);
        snapshot.mesh_workspace = Some(serde_json::json!({}));
    }
    let app = build_v2_router().with_state(state);

    for path in [
        "/v2/sessions/current/meshing/builds/current",
        "/v2/sessions/current/meshing/builds/latest-successful",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let json = body_json(response).await;
        assert_eq!(json["revision"], 99);
        assert_eq!(json["source_scene_revision"], 95);
        assert_eq!(json["geometry_realization_revision"], 95);
    }
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
async fn mesh_shared_domain_manifest_etag_changes_when_provenance_is_recovered() {
    let state = test_app_state_with_live_session().await;
    let mut dirty_scene = sample_scene_document();
    dirty_scene.objects[0].tags.push("mesh:dirty".to_string());
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_fem_mesh_payload_with_manifest());
        snapshot.mesh_revision = 41;
        snapshot.scene_document = Some(dirty_scene);
        snapshot.mesh_workspace = Some(serde_json::json!({}));
    }
    let app = build_v2_router().with_state(state.clone());

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
    let json = body_json(first).await;
    assert_eq!(json["source_scene_revision"], serde_json::Value::Null);

    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
    }

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

    assert_eq!(second.status(), StatusCode::OK);
    let json = body_json(second).await;
    assert_eq!(json["source_scene_revision"], 3);
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
                            "airbox_growth_rate": 1.4,
                            "airbox_grading": "linear"
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
    assert_eq!(json["config"]["airbox_growth_rate"], 1.4);
    assert_eq!(json["config"]["airbox_grading"], "linear");

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
    assert_eq!(universe.airbox_growth_rate, Some(1.4));
    assert_eq!(universe.airbox_grading.as_deref(), Some("linear"));
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
                            "edge_maximum_element_size": "1.8e-9",
                            "edge_thickness": "12e-9",
                            "corner_maximum_element_size": "1.2e-9",
                            "corner_extent": "5e-9",
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
    assert_eq!(json["config"]["edge_maximum_element_size"], "1.8e-9");
    assert_eq!(json["config"]["edge_thickness"], "12e-9");
    assert_eq!(json["config"]["corner_maximum_element_size"], "1.2e-9");
    assert_eq!(json["config"]["corner_extent"], "5e-9");

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
    assert_eq!(mesh.edge_hmax.as_deref(), Some("1.8e-9"));
    assert_eq!(mesh.edge_thickness.as_deref(), Some("12e-9"));
    assert_eq!(mesh.corner_hmax.as_deref(), Some("1.2e-9"));
    assert_eq!(mesh.corner_extent.as_deref(), Some("5e-9"));
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
    assert!(json["primitive_capabilities"]
        .as_array()
        .expect("primitive capabilities")
        .iter()
        .any(|entry| entry["id"] == "arch_waveguide" && entry["status"] == "production"));
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
    let status = response.status();
    let json = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{json:#}");
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
    let status = response.status();
    let json = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{json:#}");
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
async fn authoring_region_patch_commits_magnetization_override_without_mesh_dirty() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 23;
    let object_magnetization_ref = scene.objects[0]
        .magnetization_ref
        .clone()
        .expect("sample object has magnetization ref");
    let mut region_asset = scene.magnetization_assets[0].clone();
    region_asset.id = "mag-region".to_string();
    region_asset.name = "Region override".to_string();
    region_asset.ui_label = Some("Region override".to_string());
    scene.magnetization_assets.push(region_asset);
    scene.objects[0].tags.clear();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/regions/region:body")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "magnetization_ref": "mag-region"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let json = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{json:#}");
    let object = &json["objects"][0];
    assert_eq!(object["magnetization_ref"], object_magnetization_ref);
    assert_eq!(
        object["region_overrides"]["region:body"]["magnetization_ref"],
        "mag-region"
    );
    let mesh_dirty = object["tags"]
        .as_array()
        .map(|tags| tags.iter().any(|tag| tag == "mesh:dirty"))
        .unwrap_or(false);
    assert!(!mesh_dirty);

    let regions_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/model/regions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(regions_response.status(), StatusCode::OK);
    let regions = body_json(regions_response).await;
    assert_eq!(regions["regions"][0]["magnetization_ref"], "mag-region");
}

#[tokio::test]
async fn authoring_magnetization_asset_patch_commits_transform_and_params() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 24;
    let asset_id = scene.magnetization_assets[0].id.clone();
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);
    let asset_path_id = asset_id.replace(':', "%3A");

    let get_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v2/sessions/current/model/magnetization-assets/{asset_path_id}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let get_json = body_json(get_response).await;
    assert_eq!(get_json["asset"]["id"], asset_id);

    let patch_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/v2/sessions/current/model/magnetization-assets/{asset_path_id}"
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": 24,
                        "asset": {
                            "id": asset_id,
                            "name": "Edited texture",
                            "kind": "preset_texture",
                            "mapping": {
                                "space": "object",
                                "projection": "object_local",
                                "clamp_mode": "none"
                            },
                            "texture_transform": {
                                "translation": [1.0, 2.0, 3.0],
                                "rotation_quat": [0.0, 0.0, 0.70710678, 0.70710678],
                                "scale": [2.0, 1.0, 1.0],
                                "pivot": [0.5, 0.0, 0.0]
                            },
                            "preset_kind": "uniform",
                            "preset_params": { "direction": [0.0, 1.0, 0.0] },
                            "preset_version": 1,
                            "ui_label": "Edited texture"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let patch_status = patch_response.status();
    let patch_json = body_json(patch_response).await;
    assert_eq!(patch_status, StatusCode::OK, "{patch_json:#}");
    assert_eq!(patch_json["scene_revision"], 25);
    assert_eq!(patch_json["asset"]["name"], "Edited texture");
    assert_eq!(patch_json["asset"]["preset_params"]["direction"][1], 1.0);
    assert_eq!(
        patch_json["asset"]["texture_transform"]["translation"],
        serde_json::json!([1.0, 2.0, 3.0])
    );

    let get_after_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v2/sessions/current/model/magnetization-assets/{asset_path_id}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_after_response.status(), StatusCode::OK);
    let get_after_json = body_json(get_after_response).await;
    assert_eq!(get_after_json["asset"]["name"], "Edited texture");
    assert_eq!(
        get_after_json["asset"]["texture_transform"]["scale"],
        serde_json::json!([2.0, 1.0, 1.0])
    );
}

#[tokio::test]
async fn authoring_magnetization_asset_patch_upserts_new_asset() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = 26;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/model/magnetization-assets/mag%3Aribbon")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_revision": 26,
                        "asset": {
                            "id": "mag:ribbon",
                            "name": "Ribbon uniform",
                            "kind": "preset_texture",
                            "mapping": {
                                "space": "object",
                                "projection": "object_local",
                                "clamp_mode": "none"
                            },
                            "texture_transform": {
                                "translation": [0.0, 0.0, 0.0],
                                "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                                "scale": [1.0, 1.0, 1.0],
                                "pivot": [0.0, 0.0, 0.0]
                            },
                            "preset_kind": "uniform",
                            "preset_params": { "direction": [1.0, 0.0, 0.0] },
                            "preset_version": 1,
                            "ui_label": "Ribbon uniform"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let json = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{json:#}");
    assert_eq!(json["scene_revision"], 27);
    assert_eq!(json["asset"]["id"], "mag:ribbon");
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
async fn commands_endpoint_converts_relax_torque_tolerance_t_to_apm() {
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
                        "kind": "relax",
                        "torque_tolerance_T": 1.0e-5
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let queue = state.current_control_queue.lock().await;
    let torque_tolerance = queue
        .front()
        .and_then(|command| command.torque_tolerance)
        .expect("relax command should store canonical A/m torque tolerance");
    let expected = 1.0e-5 / (4.0 * std::f64::consts::PI * 1.0e-7);
    assert!(
        (torque_tolerance - expected).abs() < 1.0e-12,
        "expected {expected}, got {torque_tolerance}"
    );
}

#[tokio::test]
async fn commands_endpoint_enqueues_compute_fields_command() {
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
                        "kind": "compute_fields"
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
        Some("compute_fields")
    );
}

#[tokio::test]
async fn commands_endpoint_enqueues_compute_energies_command() {
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
                        "kind": "compute_energies"
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
        Some("compute_energies")
    );
}

#[tokio::test]
async fn commands_endpoint_exposes_runtime_control_readiness() {
    let state = test_app_state_with_live_session().await;
    set_running_stage_execution(&state, 7).await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.runtime_status = RuntimeStatusView {
            kind: RuntimeStatus::Running,
            code: "running".into(),
            is_busy: true,
            can_accept_commands: true,
        };
    }
    let app = build_v2_router().with_state(state.clone());

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

    let status = response.status();
    let body = body_bytes(response).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected response body: {}",
        String::from_utf8_lossy(&body)
    );
    let json: serde_json::Value = serde_json::from_slice(&body).expect("response should be json");
    let controls = json["runtime_controls"]
        .as_array()
        .expect("runtime_controls should be an array");
    assert_runtime_control(controls, "pause", true, None);
    assert_runtime_control(controls, "stop", true, None);
    assert_runtime_control(controls, "skip", true, None);
    assert_runtime_control(controls, "resume", false, Some("Runtime is not paused."));
    assert_runtime_control(controls, "solve", false, Some("Runtime is already active."));
}

#[tokio::test]
async fn commands_endpoint_keeps_compute_enabled_during_wait_for_compute_gate() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.session.status = "waiting_for_compute".into();
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 0,
                time: 0.0,
                dt: 0.0,
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
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
        crate::session::refresh_runtime_status(snapshot);
    }
    let app = build_v2_router().with_state(state);

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
    let controls = json["runtime_controls"]
        .as_array()
        .expect("runtime_controls should be an array");
    assert_runtime_control(controls, "solve", true, None);
}

#[tokio::test]
async fn commands_endpoint_disables_skip_without_active_stage() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.runtime_status = RuntimeStatusView {
            kind: RuntimeStatus::Running,
            code: "running".into(),
            is_busy: true,
            can_accept_commands: true,
        };
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 0,
            completed_stage_indexes: Vec::new(),
            stages: Vec::new(),
            stage_statuses: Vec::new(),
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::Running,
        });
    }
    let app = build_v2_router().with_state(state);

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
    let controls = json["runtime_controls"]
        .as_array()
        .expect("runtime_controls should be an array");
    assert_runtime_control(
        controls,
        "skip",
        false,
        Some("No active stage is available to skip."),
    );
}

fn assert_runtime_control(
    controls: &[serde_json::Value],
    kind: &str,
    enabled: bool,
    reason: Option<&str>,
) {
    let control = controls
        .iter()
        .find(|entry| entry["kind"] == kind)
        .unwrap_or_else(|| panic!("missing runtime control {kind}"));
    assert_eq!(control["enabled"], enabled);
    assert_eq!(
        control.get("reason").and_then(|value| value.as_str()),
        reason
    );
}

fn assert_command_invalidation(
    invalidations: &[serde_json::Value],
    resource_key: &str,
    state: &str,
) {
    let invalidation = invalidations
        .iter()
        .find(|entry| entry["resource_key"] == resource_key)
        .unwrap_or_else(|| panic!("missing command invalidation for {resource_key}"));
    assert_eq!(invalidation["state"], state);
    assert!(
        invalidation["revision"].as_u64().is_some(),
        "invalidation revision should be numeric for {resource_key}"
    );
}

#[tokio::test]
async fn commands_endpoint_persists_runtime_intent_fields() {
    let state = test_app_state_with_live_session().await;
    set_running_stage_execution(&state, 7).await;
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .header("x-request-id", "req-runtime-stop-1")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "stop",
                        "target": {
                            "kind": "stage_index",
                            "stage_index": 1
                        },
                        "reason": "user_requested",
                        "precondition": {
                            "stage_execution_revision": 7,
                            "runtime_state": "running"
                        },
                        "client_intent_id": "intent-stop-1",
                        "requested_at_unix_ms": 1_700_000_002_000u64
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = body_bytes(response).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected response body: {}",
        String::from_utf8_lossy(&body)
    );
    let submitted: serde_json::Value =
        serde_json::from_slice(&body).expect("response should be json");
    let command_id = submitted["command_id"]
        .as_str()
        .expect("command_id should be present");
    assert_eq!(submitted["request_id"], "req-runtime-stop-1");

    {
        let queue = state.current_control_queue.lock().await;
        let command = queue.front().expect("command should be queued");
        assert_eq!(command.kind, "stop");
        assert_eq!(command.reason.as_deref(), Some("user_requested"));
        assert_eq!(command.client_intent_id.as_deref(), Some("intent-stop-1"));
        assert_eq!(command.requested_at_unix_ms, Some(1_700_000_002_000));
    }

    let detail_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v2/sessions/current/simulation/commands/{command_id}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(detail_response.status(), StatusCode::OK);
    let detail = body_json(detail_response).await;
    assert_eq!(detail["kind"], "stop");
    assert_eq!(detail["request_id"], "req-runtime-stop-1");
    assert_eq!(detail["target"]["kind"], "stage_index");
    assert_eq!(detail["target"]["stage_index"], 1);
    assert_eq!(detail["reason"], "user_requested");
    assert_eq!(detail["precondition"]["stage_execution_revision"], 7);
    assert_eq!(detail["precondition"]["runtime_state"], "running");
    assert_eq!(detail["client_intent_id"], "intent-stop-1");
    assert_eq!(detail["requested_at_unix_ms"], 1_700_000_002_000u64);
    assert_eq!(detail["stage_id"], "stage-001");
    assert_eq!(detail["stage_index"], 1);
    assert_eq!(detail["run_id"], "test-run");
    assert_eq!(detail["requested_execution"]["backend"], "cpu-fdm");
    assert_eq!(detail["requested_execution"]["device"], "auto");
    assert_eq!(detail["requested_execution"]["precision"], "double");
    assert_eq!(detail["requested_execution"]["mode"], "strict");
    assert_eq!(detail["resolved_execution"]["backend"], "cpu-fdm");
    assert_eq!(detail["resolved_execution"]["device"], "cpu");
    assert_eq!(detail["resolved_execution"]["precision"], "double");
    assert_eq!(detail["resolved_execution"]["mode"], "strict");
    let invalidations = detail["resource_invalidations"]
        .as_array()
        .expect("resource_invalidations should be an array");
    assert_command_invalidation(invalidations, "simulation/commands", "observed");
    assert_command_invalidation(invalidations, "simulation/stages/execution", "expected");
    assert_command_invalidation(invalidations, "simulation/solver/status", "expected");
    assert_command_invalidation(invalidations, "diagnostics/engine-log", "expected");
    let diagnostics = detail["diagnostics"]
        .as_array()
        .expect("diagnostics should be an array");
    assert_eq!(diagnostics[0]["resource_key"], "diagnostics/engine-log");
    assert_eq!(detail["accepted_at_unix_ms"], detail["created_at_unix_ms"]);
    assert_eq!(detail["started_at_unix_ms"], 1_700_000_002_000u64);
    assert!(detail.get("terminal_at_unix_ms").is_none());
}

#[tokio::test]
async fn commands_endpoint_rejects_runtime_precondition_mismatch() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "pause",
                        "target": { "kind": "current_stage" },
                        "precondition": {
                            "runtime_state": "paused"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let json = body_json(response).await;
    assert_eq!(
        json["error"],
        "runtime_state precondition failed: expected paused, got running"
    );
}

#[tokio::test]
async fn commands_endpoint_validates_runtime_precondition_against_effective_status() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.session.status = "cancelled".into();
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: Vec::new(),
            stages: vec![StageExecutionRecord {
                stage_id: Some("stage-000".into()),
                kind: Some("relax".into()),
                status: StageLifecycleState::Cancelled,
                command_id: Some("cmd-solve".into()),
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: Some(1_700_000_001_000),
                reason: Some(fullmag_ir::StageStopReason::UserCancelled),
                artifact_refs: Vec::new(),
                checkpoint_ref: None,
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
            }],
            stage_statuses: vec![StageLifecycleState::Cancelled],
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::AwaitingCommand,
        });
        snapshot.state_version = 9;
        crate::session::refresh_runtime_status(snapshot);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "compute_fields",
                        "target": { "kind": "study" },
                        "precondition": {
                            "runtime_state": "awaiting_command",
                            "stage_execution_revision": 9
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
    assert_eq!(json["accepted"], true);
}

#[tokio::test]
async fn commands_endpoint_rejects_resource_revision_precondition_mismatches() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.mesh_revision = 5;
    }
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: SessionCommand {
                seq: 1,
                command_id: "cmd-existing".into(),
                kind: "compute_fields".into(),
                created_at_unix_ms: 1_700_000_000_000,
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
            },
            request_id: None,
            status: CommandLifecycleState::Queued,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        });
    }
    let app = build_v2_router().with_state(state);

    for (precondition, expected_error) in [
        (
            serde_json::json!({ "scene_revision": 4 }),
            "scene_revision precondition failed: expected 4, got 3",
        ),
        (
            serde_json::json!({ "mesh_revision": 6 }),
            "mesh_revision precondition failed: expected 6, got 5",
        ),
        (
            serde_json::json!({ "command_revision": 2 }),
            "command_revision precondition failed: expected 2, got 1",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v2/sessions/current/simulation/commands")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "kind": "compute_fields",
                            "precondition": precondition
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let json = body_json(response).await;
        assert_eq!(json["error"], expected_error);
    }
}

#[tokio::test]
async fn commands_endpoint_rejects_stage_target_mismatch() {
    let state = test_app_state_with_live_session().await;
    set_running_stage_execution(&state, 7).await;
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "stop",
                        "target": {
                            "kind": "stage_index",
                            "stage_index": 2
                        },
                        "precondition": {
                            "runtime_state": "running"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let json = body_json(response).await;
    assert_eq!(
        json["error"],
        "stage target mismatch: expected stage_index 1, got 2"
    );
}

#[tokio::test]
async fn commands_endpoint_rejects_solve_when_authoring_geometry_is_invalid() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].geometry.geometry_kind = "ArchWaveguide".to_string();
    scene.objects[0].geometry.geometry_params = serde_json::json!({});
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "kind": "solve" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_bytes(response).await;
    assert!(
        String::from_utf8_lossy(&body).contains("Geometry parameter 'length'"),
        "unexpected response body: {}",
        String::from_utf8_lossy(&body)
    );
}

#[tokio::test]
async fn commands_endpoint_accepts_solve_with_valid_arch_waveguide_geometry() {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.objects[0].geometry.geometry_kind = "ArchWaveguide".to_string();
    scene.objects[0].geometry.geometry_params = serde_json::json!({
        "length": 2.5e-6,
        "width": 1.0e-6,
        "height": 2e-9,
        "arch_height": 50e-9,
        "z0": -25e-9
    });
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
    }
    let app = build_v2_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "kind": "solve" }).to_string(),
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
        Some("solve")
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
    set_running_stage_execution(&state, 0).await;
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
    assert_eq!(json["revision"], 1_700_000_001_003u64);
    assert_eq!(json["commands"].as_array().map(Vec::len), Some(3));
    assert_eq!(json["commands"][0]["request_id"], "req-cmd-1");
    assert_eq!(json["commands"][1]["request_id"], "req-cmd-2");
    assert_eq!(json["commands"][2]["request_id"], "req-cmd-3");
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
    assert_eq!(json["request_id"], "req-cmd-1");
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
async fn command_detail_endpoint_exposes_stage_state_linkage() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 7;
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: vec![0],
            stages: vec![StageExecutionRecord {
                stage_id: None,
                kind: None,
                status: StageLifecycleState::Completed,
                command_id: Some("cmd-stage-0".into()),
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: Some(1_700_000_001_000),
                reason: None,
                artifact_refs: vec!["artifacts/stage-000".into()],
                checkpoint_ref: Some("cp-000041".into()),
                loaded_state_ref: Some("states/imported-state.fmstate".into()),
                resume_from_checkpoint_ref: Some("cp-000040".into()),
                state_transition: Some("restored".into()),
                metric_name: None,
                metric_value: None,
                threshold: None,
            }],
            stage_statuses: vec![StageLifecycleState::Completed],
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::Completed,
        });
    }
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: SessionCommand {
                seq: 1,
                command_id: "cmd-stage-0".into(),
                kind: "relax".into(),
                created_at_unix_ms: 1_700_000_000_000,
                target: None,
                reason: None,
                precondition: None,
                client_intent_id: None,
                requested_at_unix_ms: None,
                until_seconds: None,
                max_steps: None,
                torque_tolerance: Some(7.5),
                energy_tolerance: None,
                integrator: None,
                fixed_timestep: None,
                max_error: None,
                relax_algorithm: Some("llg_overdamped".into()),
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
            },
            request_id: None,
            status: CommandLifecycleState::Completed,
            dispatched_at_unix_ms: Some(1_700_000_000_100),
            completed_at_unix_ms: Some(1_700_000_001_000),
            completion_status: Some(CommandCompletionState::Completed),
            error: None,
        });
    }

    let app = build_v2_router().with_state(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/commands/cmd-stage-0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["stage_id"], "stage-000");
    assert_eq!(json["stage_index"], 0);
    assert_eq!(json["artifact_refs"][0], "artifacts/stage-000");
    assert_eq!(json["checkpoint_ref"], "cp-000041");
    assert_eq!(json["loaded_state_ref"], "states/imported-state.fmstate");
    assert_eq!(json["resume_from_checkpoint_ref"], "cp-000040");
    assert_eq!(json["state_transition"], "restored");
    assert_eq!(json["accepted_at_unix_ms"], 1_700_000_000_000u64);
    assert_eq!(json["started_at_unix_ms"], 1_700_000_000_100u64);
    assert_eq!(json["terminal_at_unix_ms"], 1_700_000_001_000u64);
    assert_eq!(json["torque_tolerance_apm"], 7.5);
    assert_eq!(json["torque_tolerance"], 7.5);
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
    assert_eq!(json["stages"][0]["stage_id"], "stage-000");
    assert_eq!(json["stages"][0]["index"], 0);
    assert_eq!(json["stages"][0]["label"], "Stage 1");
    assert_eq!(json["stages"][0]["command_id"], "cmd-stage-0");
    assert_eq!(
        json["stages"][0]["started_at_unix_ms"],
        1_700_000_000_000u64
    );
    assert_eq!(
        json["stages"][0]["completed_at_unix_ms"],
        1_700_000_001_000u64
    );
    assert_eq!(json["stages"][0]["artifact_refs"][0], "artifacts/stage-000");
    assert_eq!(json["stages"][0]["checkpoint_ref"], "cp-000041");
    assert_eq!(json["stages"][0]["state_transition"], "preserved");
    assert_eq!(json["stages"][1]["stage_id"], "stage-001");
    assert_eq!(json["stages"][1]["kind"], "relax");
    assert_eq!(json["stages"][1]["command_id"], "cmd-stage-1");
    assert_eq!(
        json["stages"][1]["started_at_unix_ms"],
        1_700_000_002_000u64
    );
    assert!(json["stages"][1]["completed_at_unix_ms"].is_null());
    assert_eq!(json["stages"][1]["artifact_refs"][0], "artifacts/stage-001");
    assert_eq!(
        json["stages"][1]["loaded_state_ref"],
        "states/imported-state.fmstate"
    );
    assert_eq!(json["stages"][1]["resume_from_checkpoint_ref"], "cp-000041");
    assert_eq!(json["stages"][1]["state_transition"], "restored");
}

#[tokio::test]
async fn stage_execution_endpoint_exposes_completed_relaxation_stop_metric() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 42;
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: vec![0],
            stages: vec![StageExecutionRecord {
                stage_id: Some("stage-relax".into()),
                kind: Some("relax".into()),
                status: StageLifecycleState::Completed,
                command_id: Some("cmd-relax".into()),
                started_at_unix_ms: Some(1_700_000_000_000u64),
                completed_at_unix_ms: Some(1_700_000_010_000u64),
                reason: Some(fullmag_ir::StageStopReason::Torque),
                artifact_refs: vec!["runs/run-1/stages/stage-relax".into()],
                checkpoint_ref: Some("cp-relaxed".into()),
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: Some("preserved".into()),
                metric_name: Some("max_torque_apm".into()),
                metric_value: Some(75.0f64),
                threshold: Some(80.0f64),
            }],
            stage_statuses: vec![StageLifecycleState::Completed],
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::Completed,
        });
    }

    let app = build_v2_router().with_state(state);
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
    assert_eq!(json["revision"], 42);
    assert_eq!(json["runtime_state"], "completed");
    assert_eq!(json["completed_stage_indexes"], serde_json::json!([0]));
    assert_eq!(json["stages"][0]["status"], "completed");
    assert_eq!(json["stages"][0]["command_id"], "cmd-relax");
    assert_eq!(json["stages"][0]["reason"], "torque");
    assert_eq!(json["stages"][0]["metric_name"], "max_torque_apm");
    assert_eq!(json["stages"][0]["metric_value"], 75.0);
    assert_eq!(json["stages"][0]["threshold"], 80.0);
    assert_eq!(
        json["stages"][0]["completed_at_unix_ms"],
        1_700_000_010_000u64
    );
    assert_eq!(
        json["stages"][0]["artifact_refs"][0],
        "runs/run-1/stages/stage-relax"
    );
    assert_eq!(json["stages"][0]["checkpoint_ref"], "cp-relaxed");
    assert_eq!(json["stages"][0]["stage_id"], "stage-relax");
    assert_eq!(json["stages"][0]["kind"], "relax");
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
    assert_eq!(json["max_torque_T"], 14.0);
    assert_eq!(json["max_torque_Apm"], 13.0);
    assert_eq!(json["max_torque"], 14.0);
    assert_eq!(json["last_error"], "latest runtime error");
}

#[tokio::test]
async fn solver_status_endpoint_prefers_waiting_for_compute_gate_over_stale_live_state() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.session.status = "waiting_for_compute".into();
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 0,
                time: 0.0,
                dt: 0.0,
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
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
        crate::session::refresh_runtime_status(snapshot);
    }
    let app = build_v2_router().with_state(state);

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
    assert_eq!(json["runtime_state"], "waiting_for_compute");
    assert_eq!(json["runtime_status_code"], "waiting_for_compute");
    assert_eq!(json["session_status"], "waiting_for_compute");
    assert_eq!(json["is_busy"], false);
    assert_eq!(json["can_accept_commands"], true);
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

#[tokio::test]
async fn object_metrics_endpoint_returns_zero_energies_before_solver_sample() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.state_version = 12;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/objects/body/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["object_id"], "body");
    assert_eq!(json["has_solver_sample"], false);
    assert_eq!(json["magnetization_average"]["mx"], 1.0);
    assert_eq!(json["magnetization_average"]["my"], 0.0);
    assert_eq!(json["magnetization_average"]["mz"], 0.0);
    assert_eq!(json["energies"]["total"], 0.0);
}

#[tokio::test]
async fn object_metrics_endpoint_prefers_per_object_solver_scalars() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 7,
                time: 4.2e-12,
                dt: 1.0e-13,
                e_ex: 1.0,
                e_demag: 2.0,
                e_ext: 3.0,
                e_ani: 4.0,
                e_dmi: 5.0,
                e_total: 15.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![0.1, 0.2, 0.3]),
                per_object_scalars: HashMap::from([(
                    "body".to_string(),
                    HashMap::from([
                        ("mx".to_string(), 0.25),
                        ("my".to_string(), 0.5),
                        ("mz".to_string(), 0.75),
                        ("e_ex".to_string(), 11.0),
                        ("e_demag".to_string(), 12.0),
                        ("e_ext".to_string(), 13.0),
                        ("e_ani".to_string(), 14.0),
                        ("e_dmi".to_string(), 15.0),
                        ("e_total".to_string(), 65.0),
                    ]),
                )]),
                preview_field: None,
                finished: false,
            },
        });
        snapshot.scalar_revision = 21;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/objects/body/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 21);
    assert_eq!(json["has_solver_sample"], true);
    assert_eq!(json["source"], "solver_per_object");
    assert_eq!(json["magnetization_average"]["mx"], 0.25);
    assert_eq!(json["energies"]["exchange"], 11.0);
    assert_eq!(json["energies"]["total"], 65.0);
}

#[tokio::test]
async fn object_metrics_endpoint_uses_mesh_part_node_indices_for_shared_fem_nodes() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(sample_scene_document());
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_123,
            latest_step: StepUpdateView {
                step: 7,
                time: 4.2e-12,
                dt: 1.0e-13,
                e_ex: 1.0,
                e_demag: 2.0,
                e_ext: 3.0,
                e_ani: 4.0,
                e_dmi: 5.0,
                e_total: 15.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh: Some(FemMeshPayload {
                    mesh_name: "shared-node-test-mesh".to_string(),
                    mesh_id: "shared-node-test-mesh:1".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                        [1.0, 1.0, 0.0],
                        [1.0, 0.0, 1.0],
                    ],
                    elements: vec![[1, 3, 5, 0]],
                    element_markers: vec![7],
                    boundary_faces: vec![[1, 3, 5]],
                    boundary_markers: vec![3],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    object_segments: vec![FemMeshObjectSegment {
                        object_id: "body".to_string(),
                        geometry_id: Some("body".to_string()),
                        node_start: 0,
                        node_count: 3,
                        element_start: 0,
                        element_count: 1,
                        boundary_face_start: 0,
                        boundary_face_count: 1,
                    }],
                    mesh_parts: vec![FemMeshPartPayload {
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
                        node_count: 3,
                        node_indices: vec![1, 3, 5],
                        surface_faces: vec![[1, 3, 5]],
                        bounds_min: Some([0.0, 0.0, 0.0]),
                        bounds_max: Some([1.0, 1.0, 1.0]),
                    }],
                    domain_mesh_mode: Some("shared_domain".to_string()),
                    domain_frame: None,
                    generation_id: Some("shared-node-test".to_string()),
                    per_domain_quality: Default::default(),
                }),
                magnetization: Some(vec![
                    10.0, 0.0, 0.0, 1.0, 0.0, 0.0, 20.0, 0.0, 0.0, 3.0, 0.0, 0.0, 30.0, 0.0, 0.0,
                    5.0, 0.0, 0.0,
                ]),
                per_object_scalars: HashMap::new(),
                preview_field: None,
                finished: false,
            },
        });
        snapshot.scalar_revision = 21;
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v2/sessions/current/simulation/objects/body/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["source"], "solver_global");
    assert_eq!(json["magnetization_average"]["mx"], 3.0);
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
async fn session_checkpoint_create_captures_live_magnetization() {
    let (app, state, repo_root) = test_router_with_session_store_state().await;
    set_running_stage_execution(&state, 0).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/checkpoints")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "resume",
                        "reason": "manual_test"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["checkpoint"]["checkpoint_id"], "cp-000042");
    assert_eq!(json["checkpoint"]["run_id"], "test-run");
    assert_eq!(json["checkpoint"]["step"], 42);
    assert_eq!(json["checkpoint"]["source"], "manual_test");
    assert_eq!(json["checkpoint"]["vector_count"], 2);
    assert_eq!(json["checkpoint"]["coordinate_frame"], "solver_domain");
    assert_eq!(json["checkpoint"]["resume_class"], "logical_resume");
    assert_eq!(json["checkpoint"]["stage_id"], "stage-001");
    assert_eq!(json["checkpoint"]["command_id"], "cmd-stage-1");
    let checkpoint_artifact_ref = json["checkpoint"]["artifact_ref"]
        .as_str()
        .expect("checkpoint artifact_ref should be present")
        .to_string();
    assert!(json["checkpoint"]["checksum"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    let stage_after_create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/simulation/stages/execution")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(stage_after_create_response.status(), StatusCode::OK);
    let stage_after_create = body_json(stage_after_create_response).await;
    assert_eq!(
        stage_after_create["stages"][1]["checkpoint_ref"],
        "cp-000042"
    );
    assert_eq!(
        stage_after_create["stages"][1]["state_transition"],
        "preserved"
    );
    assert!(stage_after_create["stages"][1]["artifact_refs"]
        .as_array()
        .expect("stage artifact_refs should be an array")
        .iter()
        .any(|value| value.as_str() == Some(checkpoint_artifact_ref.as_str())));

    let detail_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/persistence/checkpoints/cp-000042")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(detail_response.status(), StatusCode::OK);
    let detail = body_json(detail_response).await;
    assert_eq!(detail["checkpoint_id"], "cp-000042");
    assert_eq!(detail["vector_count"], 2);

    let restore_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/persistence/checkpoints/cp-000042/restore")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "reason": "restore_test"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(restore_response.status(), StatusCode::OK);
    let restored = body_json(restore_response).await;
    assert_eq!(restored["checkpoint"]["checkpoint_id"], "cp-000042");
    assert_eq!(restored["restore_class"], "logical_resume");
    assert_eq!(restored["restored_vector_count"], 2);
    assert_eq!(restored["field_revision"], 2);
    assert_eq!(restored["checkpoint"]["stage_id"], "stage-001");
    assert_eq!(restored["checkpoint"]["command_id"], "cmd-stage-1");

    let stage_after_restore_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/simulation/stages/execution")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(stage_after_restore_response.status(), StatusCode::OK);
    let stage_after_restore = body_json(stage_after_restore_response).await;
    assert_eq!(
        stage_after_restore["stages"][1]["resume_from_checkpoint_ref"],
        "cp-000042"
    );
    assert_eq!(
        stage_after_restore["stages"][1]["loaded_state_ref"],
        checkpoint_artifact_ref
    );
    assert_eq!(
        stage_after_restore["stages"][1]["state_transition"],
        "restored"
    );

    let status_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(status_response.status(), StatusCode::OK);
    let status = body_json(status_response).await;
    assert_eq!(status["resources"]["field_revision"], 2);

    let list_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/persistence/checkpoints")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(list_response.status(), StatusCode::OK);
    let listed = body_json(list_response).await;
    assert_eq!(listed["checkpoints"][0]["checkpoint_id"], "cp-000042");

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
async fn solver_profile_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/solver-profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn solver_profile_returns_200_with_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/solver-profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["revision"], 0);
    assert_eq!(json["state"], "disabled");
    assert!(json["latest_samples"].is_array());
    assert_eq!(json["aggregates"]["sample_count"], 0);
}

#[tokio::test]
async fn solver_profile_returns_304_when_etag_matches() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/solver-profile")
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
                .uri("/v2/sessions/current/diagnostics/solver-profile")
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
async fn gpu_telemetry_endpoint_returns_contract_shape() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/gpu")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    let status = json["status"]
        .as_str()
        .expect("gpu telemetry status should be a string");
    assert!(
        matches!(status, "available" | "ok" | "unavailable"),
        "unexpected gpu telemetry status: {status}"
    );
    assert!(
        json["sample_time_unix_ms"].as_u64().is_some(),
        "gpu telemetry should include sample_time_unix_ms"
    );
    assert!(
        json["devices"].as_array().is_some(),
        "gpu telemetry should include devices array"
    );
    if status == "unavailable" {
        assert!(
            json["reason"].as_str().is_some(),
            "unavailable gpu telemetry should include reason"
        );
    }
}

#[tokio::test]
async fn cpu_telemetry_endpoint_returns_contract_shape() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/diagnostics/cpu")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    let status = json["status"]
        .as_str()
        .expect("cpu telemetry status should be a string");
    assert!(
        matches!(status, "available" | "unavailable"),
        "unexpected cpu telemetry status: {status}"
    );
    assert!(
        json["sample_time_unix_ms"].as_u64().is_some(),
        "cpu telemetry should include sample_time_unix_ms"
    );
    assert!(
        json["logical_cpus"].as_u64().is_some(),
        "cpu telemetry should include logical_cpus"
    );
    assert!(
        json["utilization_cpu_percent"].as_f64().is_some(),
        "cpu telemetry should include host utilization"
    );
    assert!(
        json["process_cpu_percent"].as_f64().is_some(),
        "cpu telemetry should include process utilization"
    );
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
async fn asyncapi_document_matches_realtime_rust_schema_names() {
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
    let async_revision_properties = json["components"]["schemas"]["RealtimeResourceRevisionMap"]
        ["properties"]
        .as_object()
        .expect("revision map properties should be an object")
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let rust_revision_properties = serde_json::to_value(RealtimeResourceRevisionMap {
        topology_revision: 1,
        field_catalog_revision: 1,
        field_revision: 1,
        slice_revision: 1,
        artifact_revision: 1,
        command_completion_revision: 1,
        fields_revision: 1,
        scalars_revision: 1,
        domain_generation_id: 1,
        artifacts_revision: 1,
        engine_log_revision: 1,
        solver_profile_revision: 1,
        display_revision: 1,
        workspace_revision: 1,
        mesh_revision: 1,
        mesh_build_revision: 1,
        commands_revision: 1,
        stages_revision: 1,
        scene_revision: Some(1),
        visualization_state_revision: 1,
    })
    .expect("revision map should serialize")
    .as_object()
    .expect("revision map should serialize as an object")
    .keys()
    .cloned()
    .collect::<BTreeSet<_>>();
    assert_eq!(async_revision_properties, rust_revision_properties);

    let async_resource_names = json["components"]["schemas"]["RealtimeResourceChange"]
        ["properties"]["resource"]["enum"]
        .as_array()
        .expect("resource enum should be an array")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("resource enum values should be strings")
                .to_string()
        })
        .collect::<BTreeSet<_>>();
    let rust_resource_names = [
        RealtimeResourceName::Display,
        RealtimeResourceName::Workspace,
        RealtimeResourceName::Fields,
        RealtimeResourceName::Scalars,
        RealtimeResourceName::Domain,
        RealtimeResourceName::Artifacts,
        RealtimeResourceName::Logs,
        RealtimeResourceName::Diagnostics,
        RealtimeResourceName::Mesh,
        RealtimeResourceName::MeshBuilds,
        RealtimeResourceName::Commands,
        RealtimeResourceName::Stages,
        RealtimeResourceName::SceneDocument,
        RealtimeResourceName::VisualizationState,
        RealtimeResourceName::VisualizationClientAcks,
    ]
    .into_iter()
    .map(|name| {
        serde_json::to_value(name)
            .expect("resource name should serialize")
            .as_str()
            .expect("resource name should serialize as a string")
            .to_string()
    })
    .collect::<BTreeSet<_>>();
    assert_eq!(async_resource_names, rust_resource_names);
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

async fn test_router_with_fem_nodal_field() -> axum::Router {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 17;
        snapshot.fem_mesh = Some(sample_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [2.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0]
                ],
                "layout": {
                    "grid_cells": [4, 1, 1]
                }
            }
        }))
        .expect("mock FEM latest_fields should deserialize");
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
                per_object_scalars: Default::default(),
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
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
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
async fn field_vector_cached_projection_reports_point_and_value_counts_separately() {
    let app = test_router_with_mock_field().await;
    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v2/sessions/current/data/fields/m/samples/vector?component=magnitude")
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
            Some("4")
        );
        assert_eq!(
            response
                .headers()
                .get("x-fullmag-value-count")
                .and_then(|value| value.to_str().ok()),
            Some("4")
        );
        assert_eq!(
            response
                .headers()
                .get("x-fullmag-n-comp")
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
    }
}

#[tokio::test]
async fn field_vector_etag_stays_stable_when_only_snapshot_state_version_changes() {
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
    }
    let app = build_v2_router().with_state(state.clone());
    let uri = "/v2/sessions/current/data/fields/m/samples/vector?component=magnitude";

    let first = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("missing etag")
        .to_string();

    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = snapshot.state_version.wrapping_add(1);
    }

    let second = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("if-none-match", etag.as_str())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
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
async fn v2_field_catalog_rejects_non_finite_live_magnetization() {
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
                grid: [1, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![f64::NAN, 0.0, 0.0]),
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);

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
    let quantities = catalog["quantities"]
        .as_array()
        .expect("field catalog quantities should be an array");
    assert!(
        quantities
            .iter()
            .all(|entry| entry["quantity_id"].as_str() != Some("m")),
        "non-finite live magnetization must not be advertised"
    );

    let vector_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(vector_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn v2_field_catalog_rejects_fem_live_magnetization_with_wrong_point_count() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 23;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
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
                grid: [6, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![
                    1.0, 0.0, 0.0, //
                    0.0, 1.0, 0.0, //
                    0.0, 0.0, 1.0, //
                    1.0, 0.0, 0.0, //
                    0.0, 1.0, 0.0, //
                    0.0, 0.0, 1.0,
                ]),
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);

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
    let quantities = catalog["quantities"]
        .as_array()
        .expect("field catalog quantities should be an array");
    assert!(
        quantities
            .iter()
            .all(|entry| entry["quantity_id"].as_str() != Some("m")),
        "FEM live magnetization with a point count unrelated to the current mesh must not be advertised"
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
    assert_eq!(meta_response.status(), StatusCode::NOT_FOUND);

    let vector_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(vector_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn v2_field_vector_accepts_fem_live_magnetization_on_magnetic_nodes() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 23;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
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
                grid: [4, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![
                    1.0, 0.0, 0.0, //
                    0.0, 1.0, 0.0, //
                    0.0, 0.0, 1.0, //
                    -1.0, 0.0, 0.0,
                ]),
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);

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
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-point-count")
            .and_then(|value| value.to_str().ok()),
        Some("4")
    );
}

#[tokio::test]
async fn v2_field_vector_prefers_live_magnetization_over_stale_latest_field() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 24;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [9.0, 9.0, 9.0],
                    [8.0, 8.0, 8.0]
                ],
                "layout": {
                    "grid_cells": [2, 1, 1]
                }
            }
        }))
        .expect("mock latest_fields should deserialize");
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_456,
            latest_step: StepUpdateView {
                step: 8,
                time: 2.0e-9,
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
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);
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
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    let values: Vec<f64> = bytes[48..]
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    assert_eq!(values, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
}

#[tokio::test]
async fn v2_field_vector_prefers_fresh_m_preview_cache_over_stale_latest_field() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 25;
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "m": {
                "values": [
                    [9.0, 9.0, 9.0],
                    [8.0, 8.0, 8.0]
                ],
                "layout": {
                    "grid_cells": [2, 1, 1]
                }
            }
        }))
        .expect("mock latest_fields should deserialize");
        snapshot.preview_cache.insert(LivePreviewField {
            config_revision: 4,
            quantity: "m".to_string(),
            unit: "1".to_string(),
            spatial_kind: "grid".to_string(),
            quantity_domain: "magnetic_only".to_string(),
            preview_grid: [2, 1, 1],
            original_grid: [2, 1, 1],
            vector_field_values: vec![0.0, 0.0, -1.0, 0.0, -1.0, 0.0],
            x_chosen_size: 2,
            y_chosen_size: 1,
            applied_x_chosen_size: 2,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: None,
        });
        snapshot.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_789,
            latest_step: StepUpdateView {
                step: 9,
                time: 3.0e-9,
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
                magnetization: None,
                per_object_scalars: Default::default(),
                preview_field: None,
                finished: false,
            },
        });
    }
    let app = build_v2_router().with_state(state);
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
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    let values: Vec<f64> = bytes[48..]
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    assert_eq!(values, vec![0.0, 0.0, -1.0, 0.0, -1.0, 0.0]);
}

#[tokio::test]
async fn v2_field_vector_supports_mesh_scoped_samples() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 29;
        snapshot.mesh_revision = 31;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
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
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?scope_kind=airbox")
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
async fn v2_field_vector_applies_max_samples_to_scoped_samples() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 29;
        snapshot.mesh_revision = 31;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
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
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?scope_kind=airbox&max_samples=2")
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
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("sampled vector response should include etag")
        .to_string();
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    assert_eq!(&bytes[12..16], &(6u32).to_le_bytes(), "2 vector points");
    assert_eq!(&bytes[16..20], &(2u32).to_le_bytes(), "sampled grid x-size");
    let values: Vec<f64> = bytes[48..]
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    assert_eq!(values, vec![4.0, 4.1, 4.2, 6.0, 6.1, 6.2]);

    let unsampled = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?scope_kind=airbox")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let unsampled_etag = unsampled
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("unsampled vector response should include etag");
    assert_ne!(etag, unsampled_etag);
}

#[tokio::test]
async fn v2_field_vector_applies_max_samples_to_part_scope() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 29;
        snapshot.mesh_revision = 31;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
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
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?scope_kind=part&scope_id=body&max_samples=2")
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
        Some("part")
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
        Some("2")
    );
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    assert_eq!(&bytes[12..16], &(6u32).to_le_bytes(), "2 vector points");
    assert_eq!(&bytes[16..20], &(2u32).to_le_bytes(), "sampled grid x-size");
    let values: Vec<f64> = bytes[48..]
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    assert_eq!(values, vec![0.0, 0.1, 0.2, 2.0, 2.1, 2.2]);
}

#[tokio::test]
async fn v2_field_vector_rejects_max_samples_without_scope() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
                "values": [[0.0, 0.1, 0.2], [1.0, 1.1, 1.2]],
                "layout": { "grid_cells": [2, 1, 1] }
            }
        }))
        .expect("latest_fields should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?max_samples=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn v2_field_vector_rejects_magnetic_only_quantity_on_airbox_scope() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 30;
        snapshot.mesh_revision = 32;
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

    let airbox_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=airbox")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(airbox_response.status(), StatusCode::NOT_FOUND);

    let air_part_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=part&scope_id=airbox")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(air_part_response.status(), StatusCode::NOT_FOUND);

    let legacy_air_object_response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?scope_kind=object&scope_id=__air__")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(legacy_air_object_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn v2_field_vector_accepts_quantity_alias_for_scoped_airbox_samples() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut mesh = sample_scoped_fem_mesh_payload();
        mesh.mesh_parts[1].id = "part:__air__".to_string();
        snapshot.state_version = 30;
        snapshot.mesh_revision = 32;
        snapshot.fem_mesh = Some(mesh);
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
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
        .expect("scoped H_demag latest_fields should deserialize");
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/h_demag/samples/vector?component=full&scope_kind=airbox&scope_id=part%3A__air__")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-quantity-id")
            .and_then(|value| value.to_str().ok()),
        Some("H_demag")
    );
    assert_eq!(
        response
            .headers()
            .get("x-fullmag-scope-id")
            .and_then(|value| value.to_str().ok()),
        Some("part:__air__")
    );
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    let first_value = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
    assert_eq!(first_value, 4.0);
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
async fn v2_field_vector_object_scope_fallback_uses_segment_element_nodes() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        let mut mesh = sample_scoped_fem_mesh_payload();
        mesh.mesh_parts.clear();
        mesh.object_segments[0].node_start = 3;
        mesh.object_segments[0].node_count = 1;
        mesh.elements[0] = [0, 1, 2, 3];
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
        Some("4")
    );
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..4], b"FMVP");
    let first_x = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
    let fourth_x = f64::from_le_bytes(bytes[120..128].try_into().unwrap());
    assert_eq!(first_x, 0.0);
    assert_eq!(fourth_x, 3.0);
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
async fn v2_mesh_histogram_bin_elements_returns_airbox_indices() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.mesh_revision = 32;
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/study_domain/parts/airbox/histogram-bins/characteristic_size/0/elements")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["mesh_id"], "scoped-test-mesh:1");
    assert_eq!(json["part_id"], "airbox");
    assert_eq!(json["metric"], "characteristic_size");
    assert_eq!(json["bin_index"], 0);
    assert_eq!(json["element_indices"], serde_json::json!([1]));
    assert_eq!(json["node_indices"], serde_json::json!([4, 5, 6, 7]));
}

#[tokio::test]
async fn v2_mesh_histogram_bin_elements_rejects_invalid_bin() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_scoped_fem_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/parts/airbox/histogram-bins/characteristic_size/1/elements")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn v2_mesh_histogram_bin_elements_preserves_shared_node_indices() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.fem_mesh = Some(sample_shared_node_airbox_mesh_payload());
    }
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/meshing/meshes/shared-domain/parts/airbox/histogram-bins/tetra_size/0/elements")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["element_indices"], serde_json::json!([1]));
    assert_eq!(
        json["node_indices"],
        serde_json::json!([0, 1, 2, 4]),
        "histogram selection must preserve source shared-domain node ids"
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
    assert!(
        json["scalar"]["href"]
            .as_str()
            .unwrap_or("")
            .starts_with("/v2/sessions/current/data/fields/m/samples/slice/scalar?"),
        "slice scalar href should use the v2 resource path: {}",
        json["scalar"]["href"]
    );
}

#[tokio::test]
async fn slice_meta_xz_plane_returns_json() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/meta?plane=xz&cut_norm=0.0&x_size=8&y_size=4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["plane"], "xz");
    assert_eq!(json["cut_norm"], 0.0);
    assert_eq!(json["x_pixels"], 8);
    assert_eq!(json["y_pixels"], 4);
    assert!(json["etag"].is_string(), "slice/meta should include etag");
    assert!(
        json["scalar"]["href"]
            .as_str()
            .unwrap_or("")
            .contains("plane=xz"),
        "slice scalar href should preserve the requested plane: {}",
        json["scalar"]["href"]
    );
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
async fn slice_scalar_xz_returns_binary() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/scalar?plane=xz&component=x&cut_norm=0.0&x_size=8&y_size=4")
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
        "slice/scalar binary payload must not be empty for xz plane"
    );
}

#[tokio::test]
async fn field_projection_meta_returns_json_with_binary_href() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/meta?plane=xy&component=x&reduction=sum&samples=1&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["plane"], "xy");
    assert_eq!(json["component"], "c0");
    assert_eq!(json["reduction"], "sum");
    assert_eq!(json["sampling_method"], "fdm_layer_projection_nearest");
    assert!(json["occupied_count"].is_number());
    assert!(
        json["scalar"]["href"]
            .as_str()
            .unwrap_or("")
            .starts_with("/v2/sessions/current/data/fields/m/projection/scalar?"),
        "projection scalar href should use the v2 resource path: {}",
        json["scalar"]["href"]
    );
    assert!(
        json["empty_mask"]["href"]
            .as_str()
            .unwrap_or("")
            .starts_with("/v2/sessions/current/data/fields/m/projection/empty-mask?"),
        "projection empty mask href should use the v2 resource path: {}",
        json["empty_mask"]["href"]
    );
}

#[tokio::test]
async fn field_projection_meta_reports_adaptive_error_estimate_for_sampled_fallback() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/meta?plane=xy&component=x&reduction=sum&adaptive=true&min_samples=1&error_tolerance=0.0&samples=2&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(
        json["sampling_method"],
        "fdm_layer_projection_adaptive_nearest"
    );
    assert_eq!(json["error_method"], "coarse_fine_sample_delta_max_abs");
    assert!(json["error_estimate"].is_number());
}

#[tokio::test]
async fn field_projection_meta_uses_exact_fem_tetra_path_when_nodal_field_matches_mesh() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/meta?plane=xy&component=x&reduction=mean_occupied&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(
        json["sampling_method"],
        "fem_tetra_volume_projection_conservative"
    );
    assert_eq!(json["error_estimate"], 0.0);
    assert_eq!(json["error_method"], "exact_tetra_volume");
    assert_eq!(json["occupied_count"], 3);
    assert_eq!(json["empty_count"], 1);
    assert!(
        json["occupied_measure"].as_f64().unwrap() > 0.0,
        "exact FEM projection should report accumulated tetrahedral volume"
    );
}

#[tokio::test]
async fn field_projection_profile_returns_depth_samples_for_fem_pixel() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/profile?plane=xy&component=magnitude_squared&x_size=2&y_size=2&pixel_x=0&pixel_y=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["sampling_method"], "fem_tetra_depth_profile");
    assert_eq!(json["component"], "magnitude_squared");
    assert_eq!(json["sample_count"], 1);
    assert_eq!(json["samples"][0]["element_index"], 0);
    assert_eq!(json["samples"][0]["marker"], 7);
    assert_eq!(json["samples"][0]["value"], 4.0);
    assert!(
        json["samples"][0]["measure"].as_f64().unwrap() > 0.0,
        "profile sample should include the contributing tetrahedral volume"
    );
}

#[tokio::test]
async fn field_slice_matrix_json_uses_exact_fem_tetra_path() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/matrix.json?plane=xy&cut_norm=0.25&mode=exact&component=x&x_size=4&y_size=4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["schema"], "fullmag.field_2d.matrix.v1");
    assert_eq!(json["sampling_method"], "fem_tetra_linear_slice");
    assert_eq!(json["mode"], "exact");
    assert_eq!(json["component"], "c0");
    let values = json["values"].as_array().expect("matrix values");
    let finite_values: Vec<f64> = values
        .iter()
        .flat_map(|row| row.as_array().unwrap().iter())
        .filter_map(|value| value.as_f64())
        .collect();
    assert!(!finite_values.is_empty());
    assert!(finite_values
        .iter()
        .all(|value| (*value - 2.0).abs() < 1.0e-12));
    assert!(json["matrix_hash"].as_str().unwrap_or("").starts_with('"'));
}

#[tokio::test]
async fn field_slice_matrix_json_supports_fem_slab_mean() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/matrix.json?plane=xy&cut_norm=0.25&mode=slab&thickness_world=0.5&aggregation=mean&component=x&x_size=4&y_size=4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["sampling_method"], "fem_tetra_slab_sampled");
    assert_eq!(json["mode"], "slab");
    assert_eq!(json["aggregation"], "mean");
    assert_eq!(json["effective_thickness_world"], 0.5);
    let finite_values: Vec<f64> = json["values"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|row| row.as_array().unwrap().iter())
        .filter_map(|value| value.as_f64())
        .collect();
    assert!(!finite_values.is_empty());
    assert!(finite_values
        .iter()
        .all(|value| (*value - 2.0).abs() < 1.0e-12));
}

#[tokio::test]
async fn field_slice_matrix_json_rejects_slab_without_thickness() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/matrix.json?plane=xy&cut_norm=0.25&mode=slab&component=x&x_size=4&y_size=4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn field_slice_matrix_json_orientation_returns_rgba() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/matrix.json?plane=xy&cut_norm=0.25&mode=exact&color_mode=orientation&format=rgba&x_size=4&y_size=4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["color_mode"], "orientation");
    let rgba = json["rgba"].as_array().expect("rgba rows");
    let first_visible = rgba
        .iter()
        .flat_map(|row| row.as_array().unwrap().iter())
        .filter_map(|pixel| pixel.as_array())
        .find(|pixel| pixel.get(3).and_then(|v| v.as_u64()).unwrap_or(0) > 0)
        .expect("visible orientation pixel");
    let r = first_visible[0].as_u64().unwrap();
    let g = first_visible[1].as_u64().unwrap();
    let b = first_visible[2].as_u64().unwrap();
    assert!(
        r > 0 && g == 0 && b == 0,
        "expected +X orientation red, got {first_visible:?}"
    );
}

#[tokio::test]
async fn field_projection_matrix_json_returns_debug_matrix() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/matrix.json?plane=xy&component=x&mode=projection&aggregation=mean_occupied&x_size=2&y_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["mode"], "projection");
    assert_eq!(
        json["sampling_method"],
        "fem_tetra_volume_projection_conservative"
    );
    assert_eq!(json["aggregation"], "mean_occupied");
    assert!(json["values"].is_array());
}

#[tokio::test]
async fn field_slice_render_png_returns_png_with_matrix_header() {
    let app = test_router_with_fem_nodal_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/slice/render.png?plane=xy&cut_norm=0.25&mode=exact&component=x&x_size=16&y_size=16&colormap=coolwarm&auto_scale=symmetric_zero")
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
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    assert!(response.headers().get("x-fullmag-matrix-hash").is_some());
    let bytes = body_bytes(response).await;
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn field_projection_scalar_returns_binary() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/scalar?plane=xy&component=x&reduction=sum&samples=1&x_size=2&y_size=2")
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
        "projection/scalar content-type should be octet-stream, got: {ct}"
    );
    let bytes = body_bytes(response).await;
    assert!(
        !bytes.is_empty(),
        "projection/scalar binary payload must not be empty"
    );
}

#[tokio::test]
async fn field_projection_empty_mask_returns_binary() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/empty-mask?plane=xy&component=x&reduction=sum&samples=1&x_size=2&y_size=2")
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
        "projection/empty-mask content-type should be octet-stream, got: {ct}"
    );
    let bytes = body_bytes(response).await;
    assert_eq!(
        bytes.len(),
        4,
        "2x2 projection mask should contain four bytes"
    );
    assert!(
        bytes.iter().all(|value| *value == 0),
        "structured mock projection should not contain empty columns"
    );
}

#[tokio::test]
async fn field_projection_scalar_tile_returns_smaller_binary() {
    let app = test_router_with_mock_field().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/projection/scalar?plane=xy&component=x&reduction=sum&samples=1&x_size=4&y_size=4&tile_x=1&tile_y=1&tile_size=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = body_bytes(response).await;
    assert_eq!(
        bytes.len(),
        48 + 4 * 8,
        "2x2 scalar projection tile should use FMVP header plus four f64 values"
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
        paths.contains_key(
            "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/matrix.json"
        ),
        "OpenAPI missing /slice/matrix.json path"
    );
    assert!(
        paths.contains_key(
            "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/render.png"
        ),
        "OpenAPI missing /slice/render.png path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows"),
        "OpenAPI missing /slice/arrows path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/projection/meta"),
        "OpenAPI missing /projection/meta path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/projection/scalar"),
        "OpenAPI missing /projection/scalar path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/projection/matrix.json"),
        "OpenAPI missing /projection/matrix.json path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/projection/render.png"),
        "OpenAPI missing /projection/render.png path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/fields/{quantity_id}/projection/empty-mask"),
        "OpenAPI missing /projection/empty-mask path"
    );
    assert!(
        paths.contains_key("/v2/sessions/current/data/domain/slice/mesh-overlay"),
        "OpenAPI missing /data/domain/slice/mesh-overlay path"
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
        components.contains_key("FieldProjectionMeta"),
        "OpenAPI missing FieldProjectionMeta schema"
    );
    assert!(
        components.contains_key("FieldMatrixResponse"),
        "OpenAPI missing FieldMatrixResponse schema"
    );
    assert!(
        components.contains_key("FieldProjectionMaskDescriptor"),
        "OpenAPI missing FieldProjectionMaskDescriptor schema"
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
fn openapi_contains_domain_slice_mesh_overlay_contract() {
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

    let overlay_get = paths
        .get("/v2/sessions/current/data/domain/slice/mesh-overlay")
        .and_then(|p| p.get("get"))
        .expect("domain slice mesh overlay GET path missing");
    let overlay_params = overlay_get
        .get("parameters")
        .and_then(|p| p.as_array())
        .expect("domain slice mesh overlay parameters missing");
    assert!(
        overlay_params
            .iter()
            .any(|p| p.get("name").and_then(|n| n.as_str()) == Some("plane")),
        "domain slice mesh overlay should expose query param `plane`"
    );
    assert!(
        overlay_get
            .get("responses")
            .and_then(|r| r.get("409"))
            .is_some(),
        "domain slice mesh overlay should document 409 response"
    );
    assert!(
        components.contains_key("DomainSliceMeshOverlay"),
        "OpenAPI missing DomainSliceMeshOverlay schema"
    );
    assert!(
        components.contains_key("DomainSliceMeshOverlaySegment"),
        "OpenAPI missing DomainSliceMeshOverlaySegment schema"
    );
}

#[test]
fn openapi_contains_fem_cpu_relaxation_qualification_contract() {
    let openapi = crate::openapi_v2::openapi_json();
    let components = openapi
        .get("components")
        .and_then(|c| c.get("schemas"))
        .and_then(|s| s.as_object())
        .expect("OpenAPI schemas must be present");

    for schema in [
        "FemCpuRelaxationQualificationMetadata",
        "FemCpuRelaxationDemagPolicyMetadata",
        "FemCpuRelaxationDemagTimingsNs",
        "FemCpuRelaxationEnergyTerms",
    ] {
        assert!(
            components.contains_key(schema),
            "OpenAPI missing {schema} schema"
        );
    }
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
        "/v2/sessions/current/diagnostics/cpu",
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
fn openapi_visualization_state_schema_exposes_v2_layers() {
    let value = crate::openapi_v2::openapi_json();
    let schemas = value
        .get("components")
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.as_object())
        .expect("OpenAPI schemas must be present");
    let state_props = schema_property_names(schemas, "VisualizationStateResource");
    let target_registry_props = schema_property_names(schemas, "VisualizationTargetRegistryState");
    let target_entry_props = schema_property_names(schemas, "VisualizationTargetRegistryEntry");
    let target_settings_props =
        schema_property_names(schemas, "VisualizationResolvedTargetSettings");
    let override_props = schema_property_names(schemas, "VisualizationOverrideState");
    let override_display_props =
        schema_property_names(schemas, "VisualizationTargetDisplayOverride");
    let override_style_props = schema_property_names(schemas, "VisualizationTargetStyleOverride");

    for required in [
        "revision",
        "schema_version",
        "quantity",
        "layers",
        "domains",
        "sampling",
        "fdm",
        "fem",
        "slice",
        "camera",
        "clip",
        "vector_style",
        "overrides",
        "targets",
        "diagnostics",
    ] {
        assert!(
            state_props.contains(required),
            "VisualizationStateResource missing v2 field `{required}`"
        );
    }

    for compatibility_field in [
        "active_quantity_id",
        "view_mode",
        "field_component",
        "vector_glyphs",
        "max_points",
    ] {
        assert!(
            state_props.contains(compatibility_field),
            "VisualizationStateResource must retain compatibility projection `{compatibility_field}`"
        );
    }

    for required in ["airbox", "objects", "parts"] {
        assert!(
            target_registry_props.contains(required),
            "VisualizationTargetRegistryState missing field `{required}`"
        );
    }
    for required in ["scope", "scope_id", "label", "source", "settings"] {
        assert!(
            target_entry_props.contains(required),
            "VisualizationTargetRegistryEntry missing field `{required}`"
        );
    }
    for required in [
        "active_quantity_id",
        "visible",
        "bounds_visible",
        "surface_visible",
        "wireframe_visible",
        "point_color",
        "points_visible",
        "vectors_visible",
        "render_mode",
        "surface_color_source",
        "vector_budget",
        "vector_color_mode",
        "vector_length_scale",
    ] {
        assert!(
            target_settings_props.contains(required),
            "VisualizationResolvedTargetSettings missing field `{required}`"
        );
    }

    for required in [
        "scope", "scope_id", "visible", "display", "style", "quantity",
    ] {
        assert!(
            override_props.contains(required),
            "VisualizationOverrideState missing target override field `{required}`"
        );
    }
    for required in [
        "visible",
        "bounds",
        "surface",
        "wireframe",
        "points",
        "vectors",
        "opacity",
        "geometry_scope",
    ] {
        assert!(
            override_display_props.contains(required),
            "VisualizationTargetDisplayOverride missing field `{required}`"
        );
    }
    for required in [
        "surface_color_source",
        "surface_mono_color",
        "vector_color_mode",
        "vector_mono_color",
        "vector_alpha",
        "vector_budget",
        "vector_length_scale",
        "vector_thickness",
        "wireframe_color",
        "point_color",
    ] {
        assert!(
            override_style_props.contains(required),
            "VisualizationTargetStyleOverride missing field `{required}`"
        );
    }
}

#[test]
fn openapi_mesh_read_model_overlap_is_explicitly_transitional() {
    let value = crate::openapi_v2::openapi_json();
    let paths = value
        .get("paths")
        .and_then(|value| value.as_object())
        .expect("OpenAPI paths must be present");
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
            "geometry_realization_revision".to_string(),
            "last_build_error".to_string(),
            "source_scene_revision".to_string(),
        ]),
        "active/latest-success overlap must not grow beyond transitional target, provenance, and error projections"
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

    for path in [
        "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields",
        "/v2/sessions/current/meshing/meshes/shared-domain/cross-section",
        "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image",
        "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality",
        "/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element",
        "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates",
    ] {
        assert!(paths.contains_key(path), "OpenAPI missing `{path}`");
    }
    assert!(
        schemas.contains_key("MeshRealizedSizeFieldsResource"),
        "OpenAPI missing MeshRealizedSizeFieldsResource schema"
    );
    assert!(
        schemas.contains_key("MeshQualityGatesResource"),
        "OpenAPI missing MeshQualityGatesResource schema"
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

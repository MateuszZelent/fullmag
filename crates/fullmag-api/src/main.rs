use async_stream::stream;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use fullmag_authoring::{MagnetizationAsset, SceneDocument, ScriptBuilderInitialState};
use fullmag_ir::{TextureMappingIR, TextureProjectionMode, TextureTransform3DIR};
use fullmag_plan::{generate_random_unit_vectors, sample_preset_texture, TextureSamplePoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use fullmag_quantities::{quantity_spec, QuantityShape as QuantityKind};
use fullmag_runner::{
    CommandAckEvent, DisplaySelection, FemMeshPayload, LivePreviewField, MeshCommandTargetEvent,
    RuntimeEventEnvelope, StepUpdate,
};

mod artifacts;
mod assets;
mod error;
mod feature_flags;
mod field_store;
mod openapi;
mod preview;
mod quantities;
mod router_v1;
mod schemas;
mod script;
mod session;
mod session_persistence;
mod types;

#[derive(Debug, Deserialize, Default)]
struct CurrentLiveSnapshotQuery {
    #[serde(default)]
    field_transport: Option<String>,
    #[serde(default)]
    mesh_transport: Option<String>,
}

fn binary_field_transport_requested(mode: Option<&str>) -> bool {
    matches!(mode, Some("bin"))
}

fn binary_mesh_transport_requested(mode: Option<&str>) -> bool {
    matches!(mode, Some("bin"))
}

fn latest_fields_wire_value(
    snapshot: &SessionStateResponse,
    binary_field_transport: bool,
) -> Result<Value, ApiError> {
    if binary_field_transport {
        let mut metadata = snapshot.latest_fields.metadata_only_json();
        if metadata
            .as_object()
            .is_some_and(|fields| !fields.contains_key("m"))
        {
            if let Some(magnetization_field) = live_magnetization_field_metadata(snapshot) {
                if let Some(fields) = metadata.as_object_mut() {
                    fields.insert("m".to_string(), magnetization_field);
                }
            }
        }
        return Ok(metadata);
    }
    serde_json::to_value(&snapshot.latest_fields)
        .map_err(|error| ApiError::internal(format!("failed to serialize latest_fields: {}", error)))
}

fn live_magnetization_field_metadata(snapshot: &SessionStateResponse) -> Option<Value> {
    let live_state = snapshot.live_state.as_ref()?;
    let magnetization = live_state.latest_step.magnetization.as_ref()?;
    if magnetization.is_empty() || magnetization.len() % 3 != 0 {
        return None;
    }
    let node_count = (magnetization.len() / 3) as u32;
    let grid = if live_state.latest_step.grid.iter().any(|value| *value > 0) {
        live_state.latest_step.grid
    } else {
        [node_count, 1, 1]
    };
    Some(json!({
        "unit": fullmag_quantities::quantity_unit("m"),
        "n_comp": fullmag_quantities::quantity_spec("m")
            .map(|spec| spec.n_comp)
            .unwrap_or(3),
        "grid": grid,
        "domain": "magnetic_only",
        "field_revision": live_state.latest_step.step,
        "source_step": live_state.latest_step.step,
        "source_time": live_state.latest_step.time,
        "transport": "binary",
    }))
}

fn fem_mesh_wire_value(
    fem_mesh: Option<&FemMeshPayload>,
    binary_mesh_transport: bool,
) -> Result<Option<Value>, ApiError> {
    let Some(fem_mesh) = fem_mesh else {
        return Ok(None);
    };
    if !binary_mesh_transport {
        return serde_json::to_value(fem_mesh)
            .map(Some)
            .map_err(|error| ApiError::internal(format!("failed to serialize fem_mesh: {}", error)));
    }
    Ok(Some(json!({
        "mesh_name": fem_mesh.mesh_name,
        "mesh_id": fem_mesh.mesh_id,
        "generation_id": fem_mesh.generation_id,
        "mesh_parts": fem_mesh.mesh_parts,
        "object_segments": fem_mesh.object_segments,
        "domain_mesh_mode": fem_mesh.domain_mesh_mode,
        "domain_frame": fem_mesh.domain_frame,
        "per_domain_quality": fem_mesh.per_domain_quality,
        "node_count": fem_mesh.nodes.len(),
        "element_count": fem_mesh.elements.len(),
        "boundary_face_count": fem_mesh.boundary_faces.len(),
        "transport": "binary",
    })))
}

fn preview_wire_value(
    preview: Option<&PreviewState>,
    binary_field_transport: bool,
) -> Result<Option<Value>, ApiError> {
    let Some(preview) = preview else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(preview)
        .map_err(|error| ApiError::internal(format!("failed to serialize preview: {}", error)))?;
    if binary_field_transport
        && matches!(preview, PreviewState::Spatial(_))
    {
        if let Some(object) = value.as_object_mut() {
            object.insert("vector_field_values".to_string(), Value::Null);
        }
    }
    Ok(Some(value))
}

fn live_state_wire_value(
    live_state: Option<&LiveState>,
    binary_field_transport: bool,
    binary_mesh_transport: bool,
) -> Result<Option<Value>, ApiError> {
    let Some(live_state) = live_state else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(live_state)
        .map_err(|error| ApiError::internal(format!("failed to serialize live_state: {}", error)))?;
    if binary_field_transport {
        if let Some(object) = value.as_object_mut() {
            if let Some(latest_step) = object.get_mut("latest_step").and_then(Value::as_object_mut) {
                latest_step.insert("magnetization".to_string(), Value::Null);
                if binary_mesh_transport {
                    latest_step.insert("fem_mesh".to_string(), Value::Null);
                }
            }
        }
    }
    if binary_mesh_transport {
        if let Some(object) = value.as_object_mut() {
            if let Some(latest_step) = object.get_mut("latest_step").and_then(Value::as_object_mut) {
                latest_step.insert("fem_mesh".to_string(), Value::Null);
            }
        }
    }
    Ok(Some(value))
}

fn step_update_v2_wire_value(
    step_update_v2: Option<fullmag_quantities::StepUpdateV2>,
    binary_field_transport: bool,
) -> Result<Option<Value>, ApiError> {
    let Some(step_update_v2) = step_update_v2 else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(step_update_v2)
        .map_err(|error| ApiError::internal(format!("failed to serialize step_update_v2: {}", error)))?;
    if binary_field_transport {
        if let Some(object) = value.as_object_mut() {
            object.insert("frames".to_string(), Value::Array(Vec::new()));
        }
    }
    Ok(Some(value))
}

#[derive(Debug, Serialize)]
struct SessionStateResponseWire<'a> {
    session: &'a SessionManifest,
    run: Option<&'a RunManifest>,
    live_state: Option<Value>,
    runtime_status: &'a RuntimeStatusView,
    metadata: Option<&'a Value>,
    mesh_workspace: Option<&'a Value>,
    stage_execution: Option<&'a StageExecutionState>,
    scene_document: Option<&'a SceneDocument>,
    scalar_rows: &'a [ScalarRow],
    scalar_rows_total: usize,
    engine_log: &'a [EngineLogEntry],
    quantities: &'a [QuantityDescriptor],
    fem_mesh: Option<Value>,
    latest_fields: Value,
    artifacts: &'a [ArtifactEntry],
    display_selection: &'a CurrentDisplaySelection,
    preview_config: &'a CurrentPreviewConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step_update_v2: Option<Value>,
    state_version: u64,
}
use artifacts::*;
use assets::*;
use error::ApiError;
use feature_flags::FeatureFlags;
use field_store::*;
use preview::*;
use quantities::*;
use script::*;
use session::*;
use types::*;

fn parse_texture_projection_mode(value: &str) -> TextureProjectionMode {
    match value.trim().to_ascii_lowercase().as_str() {
        "object_local" => TextureProjectionMode::ObjectLocal,
        "planar_xy" => TextureProjectionMode::PlanarXy,
        "planar_xz" => TextureProjectionMode::PlanarXz,
        "planar_yz" => TextureProjectionMode::PlanarYz,
        other => {
            eprintln!(
                "[fullmag-api][mag-texture] unknown projection {:?}, falling back to object_local",
                other
            );
            TextureProjectionMode::ObjectLocal
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let repo_root = repo_root();
    let current_workspace_root = repo_root
        .join(".fullmag")
        .join("local-live")
        .join("current");
    let static_web_root = resolve_static_web_root(&repo_root);

    let feature_flags = FeatureFlags::resolve();
    if feature_flags.any_active() {
        eprintln!(
            "[fullmag-api] FEATURE FLAGS active: {}",
            feature_flags.summary()
        );
    }

    let state = Arc::new(AppState {
        repo_root: repo_root.clone(),
        current_workspace_root,
        live_channels: Arc::new(RwLock::new(HashMap::new())),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_public_snapshot: Arc::new(RwLock::new(None)),
        current_live_events: broadcast::channel(256).0,
        current_live_vector_payload_seq: Arc::new(AtomicU32::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: watch::channel(0).0,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        current_live_snapshot_version: Arc::new(AtomicU64::new(0)),
        feature_flags,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta/vision", get(vision))
        .route("/v1/runtime/capabilities", get(get_runtime_capabilities))
        .route(
            "/v1/live/current/gpu/telemetry",
            get(get_current_gpu_telemetry),
        )
        .route(
            "/v1/live/current/bootstrap",
            get(get_current_live_bootstrap),
        )
        .route("/v1/live/current/state", get(get_current_live_state))
        .route("/v1/live/current/poll", get(get_current_live_poll))
        .route("/v1/live/current/events", get(get_current_live_events))
        .route("/v1/live/current/publish", post(publish_current_live_state))
        .route(
            "/v1/live/current/create",
            post(create_current_live_workspace),
        )
        .route(
            "/v1/live/current/preview/selection",
            get(get_current_display_selection).post(set_current_preview_selection),
        )
        .route(
            "/v1/live/current/preview/quantity",
            post(set_current_preview_quantity),
        )
        .route(
            "/v1/live/current/preview/component",
            post(set_current_preview_component),
        )
        .route(
            "/v1/live/current/preview/XChosenSize",
            post(set_current_preview_x_chosen_size),
        )
        .route(
            "/v1/live/current/preview/everyN",
            post(set_current_preview_every_n),
        )
        .route(
            "/v1/live/current/preview/YChosenSize",
            post(set_current_preview_y_chosen_size),
        )
        .route(
            "/v1/live/current/preview/autoScaleEnabled",
            post(set_current_preview_auto_scale),
        )
        .route(
            "/v1/live/current/preview/maxPoints",
            post(set_current_preview_max_points),
        )
        .route(
            "/v1/live/current/preview/layer",
            post(set_current_preview_layer),
        )
        .route(
            "/v1/live/current/preview/allLayers",
            post(set_current_preview_all_layers),
        )
        .route(
            "/v1/live/current/preview/refresh",
            post(refresh_current_preview),
        )
        // ── Data-plane field store (read-only, no command queue) ───────
        .route(
            "/v1/live/current/fields/catalog",
            get(get_live_field_catalog),
        )
        // ── Scalar history (read-only, full history for charts) ───────
        .route("/v1/live/current/scalars", get(get_current_live_scalars))
        // ── Feature flags (diagnostics) ──────────────────────────────
        .route("/v1/live/feature-flags", get(get_feature_flags))
        .route(
            "/v1/live/current/fields/:quantity/vector",
            get(get_live_field_vector),
        )
        .route(
            "/v1/live/current/fields/:quantity/meta",
            get(get_live_field_meta),
        )
        .route(
            "/v1/live/current/fem-mesh/topology",
            get(get_live_fem_mesh_topology),
        )
        .route(
            "/v1/live/current/commands",
            post(enqueue_current_live_command),
        )
        .route(
            "/v1/live/current/commands/next",
            get(dequeue_current_live_command),
        )
        .route(
            "/v1/live/current/control/wait",
            get(wait_current_live_control),
        )
        .route(
            "/v1/live/current/assets/import",
            post(import_current_live_asset),
        )
        .route(
            "/v1/live/current/state/export",
            post(export_current_live_state),
        )
        .route(
            "/v1/live/current/state/import",
            post(import_current_live_state),
        )
        .route(
            "/v1/live/current/script/sync",
            post(sync_current_live_script),
        )
        .route("/v1/live/current/scene", post(update_current_live_scene))
        .route(
            "/v1/live/current/artifacts",
            get(list_current_live_artifacts),
        )
        .route(
            "/v1/live/current/artifacts/file",
            get(read_current_live_artifact),
        )
        .route(
            "/v1/live/current/eigen/spectrum",
            get(get_current_live_eigen_spectrum),
        )
        .route(
            "/v1/live/current/eigen/mode",
            get(get_current_live_eigen_mode),
        )
        .route(
            "/v1/live/current/eigen/dispersion",
            get(get_current_live_eigen_dispersion),
        )
        .route(
            "/v1/live/current/eigen/branches",
            get(get_current_live_eigen_branches),
        )
        .route("/v1/docs/physics", get(list_physics_docs))
        .route("/v1/quantities/catalog", get(get_quantities_catalog))
        .route("/v1/run", post(start_run))
        // ── Session persistence ────────────────────────────────────────
        .route(
            "/v1/live/current/session/export",
            post(session_persistence::export_session),
        )
        .route(
            "/v1/live/current/session/import/inspect",
            post(session_persistence::import_session_inspect),
        )
        .route(
            "/v1/live/current/session/import/commit",
            post(session_persistence::import_session_commit),
        )
        .route(
            "/v1/live/current/checkpoints",
            get(session_persistence::list_checkpoints),
        )
        .route(
            "/v1/live/current/recovery",
            get(session_persistence::list_recovery),
        )
        .route(
            "/v1/live/current/recovery/clear",
            post(session_persistence::clear_recovery),
        )
        // ── WebSocket ──────────────────────────────────────────────────
        .route("/ws/live/current", get(ws_current_live))
        .route("/ws/live/:run_id", get(ws_live))
        // ── New resource-first API (v1) ────────────────────────────────
        .merge(router_v1::build_v1_router())
        // ── OpenAPI / Swagger ──────────────────────────────────────────
        .merge(utoipa_swagger_ui::SwaggerUi::new("/v1/docs/swagger")
            .url("/v1/openapi.json", <openapi::ApiDoc as utoipa::OpenApi>::openapi()))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    let app = if let Some(static_root) = static_web_root {
        info!(path = %static_root.display(), "serving built control room");
        app.fallback_service(
            ServeDir::new(&static_root)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(static_root.join("index.html"))),
        )
    } else {
        app
    };

    let port: u16 = std::env::var("FULLMAG_API_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(%addr, "starting fullmag-api");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("binding API listener should succeed");

    axum::serve(listener, app)
        .await
        .expect("serving API should succeed");
}

fn resolve_static_web_root(repo_root: &Path) -> Option<PathBuf> {
    if std::env::var("FULLMAG_DISABLE_STATIC_CONTROL_ROOM")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        return None;
    }

    let candidates = [
        std::env::var_os("FULLMAG_WEB_STATIC_DIR").map(PathBuf::from),
        Some(repo_root.join(".fullmag").join("local").join("web")),
        Some(repo_root.join("apps").join("web").join("out")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.join("index.html").is_file())
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "fullmag-api",
    })
}

async fn vision() -> Json<VisionResponse> {
    Json(VisionResponse {
        north_star:
            "Describe one physical problem and execute it through FDM, FEM, or hybrid plans.",
        modes: ["strict", "extended", "hybrid"],
        runtime_spine: "current-live",
    })
}

async fn get_runtime_capabilities(
    State(state): State<Arc<AppState>>,
) -> Json<fullmag_runner::HostCapabilityMatrix> {
    let runtimes_dir = state.repo_root.join("runtimes");
    Json(fullmag_runner::RuntimeRegistry::discover(&runtimes_dir).capability_matrix())
}

async fn get_quantities_catalog() -> Json<fullmag_quantities::QuantityCatalogResponse> {
    Json(fullmag_quantities::QuantityCatalogResponse::build())
}

async fn get_current_gpu_telemetry() -> Result<Json<GpuTelemetryResponse>, ApiError> {
    let output = tokio::task::spawn_blocking(sample_gpu_telemetry)
        .await
        .map_err(|error| {
            ApiError::internal(format!("gpu telemetry task join failed: {error}"))
        })??;
    Ok(Json(output))
}

pub(crate) fn sample_gpu_telemetry() -> Result<GpuTelemetryResponse, ApiError> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|error| ApiError::internal(format!("failed to launch nvidia-smi: {error}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("nvidia-smi exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(ApiError::internal(format!(
            "failed to sample GPU telemetry: {detail}"
        )));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        ApiError::internal(format!("nvidia-smi emitted invalid UTF-8: {error}"))
    })?;

    let mut devices = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let parts = line.split(',').map(|part| part.trim()).collect::<Vec<_>>();
        if parts.len() != 7 {
            return Err(ApiError::internal(format!(
                "unexpected nvidia-smi output shape: '{line}'"
            )));
        }
        devices.push(GpuTelemetryDevice {
            index: parts[0].parse().map_err(|error| {
                ApiError::internal(format!("failed to parse GPU index from '{line}': {error}"))
            })?,
            name: parts[1].to_string(),
            utilization_gpu_percent: parts[2].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU utilization from '{line}': {error}"
                ))
            })?,
            utilization_memory_percent: parts[3].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory utilization from '{line}': {error}"
                ))
            })?,
            memory_used_mb: parts[4].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory used from '{line}': {error}"
                ))
            })?,
            memory_total_mb: parts[5].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory total from '{line}': {error}"
                ))
            })?,
            temperature_c: parts[6].parse().ok(),
        });
    }

    Ok(GpuTelemetryResponse {
        sample_time_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
        devices,
    })
}

async fn get_current_live_bootstrap(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CurrentLiveSnapshotQuery>,
) -> Result<Response, ApiError> {
    let binary_field_transport = binary_field_transport_requested(query.field_transport.as_deref());
    let binary_mesh_transport = binary_mesh_transport_requested(query.mesh_transport.as_deref());
    // Try to serve from the live state directly (serialize on-demand).
    // The publish hot path no longer eagerly serializes the full snapshot,
    // so we serialize here when the HTTP endpoint is actually called.
    if let Some(live) = state.current_live_state.read().await.as_ref() {
        let public_json = serialize_current_live_response(
            live,
            true,
            binary_field_transport,
            binary_mesh_transport,
        )
            .map_err(|e| ApiError::internal(format!("failed to serialize live state: {}", e)))?;
        // Update the cached snapshot opportunistically for SSE consumers.
        *state.current_live_public_snapshot.write().await = Some(public_json.clone());
        let current_version = live.state_version;
        let (preview_source_step, preview_vector_len, preview_vector_avg) =
            preview_debug_metrics(live.preview.as_ref());
        let live_mag_len = live
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.magnetization.as_ref())
            .map(|values| values.len())
            .unwrap_or(0);
        let live_mag_avg = live
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.magnetization.as_ref())
            .and_then(|values| average_vector_components(values, 3));
        state
            .current_live_snapshot_version
            .store(current_version, std::sync::atomic::Ordering::Relaxed);
        eprintln!(
            "[fullmag-api] TX -> frontend bootstrap version={} step={} scalar_rows={} live_mag_len={} live_mag_avg={} preview={} preview_step={} preview_vec_len={} preview_vec_avg={} fields={}",
            current_version,
            live.live_state.as_ref().map(|state| state.latest_step.step).unwrap_or(0),
            live.scalar_rows.len(),
            live_mag_len,
            format_debug_vector_average(live_mag_avg),
            live.preview.is_some(),
            preview_source_step,
            preview_vector_len,
            format_debug_vector_average(preview_vector_avg),
            live.latest_fields.len(),
        );
        let json = bootstrap_workspace_payload(&public_json)?;
        return Ok(([(CONTENT_TYPE, "application/json")], json).into_response());
    }

    // No live workspace — auto-create a bootstrapping interactive workspace
    // so the control room can immediately transition out of the loading state.
    let json = auto_create_workspace(&state).await?;
    let payload = bootstrap_workspace_payload(&json)?;
    Ok(([(CONTENT_TYPE, "application/json")], payload).into_response())
}

/// Create an empty interactive workspace and publish it to the live state.
/// Returns the serialized public snapshot JSON.
async fn auto_create_workspace(state: &AppState) -> Result<String, ApiError> {
    let now = unix_time_millis_now();
    let session_id = format!("ui-session-{}-{}", now, std::process::id());
    let run_id = format!("run-{}", &session_id);
    let artifact_dir = state
        .repo_root
        .join(".fullmag")
        .join("local-live")
        .join("history")
        .join(&session_id)
        .join("artifacts");
    let _ = std::fs::create_dir_all(&artifact_dir);

    let publish_req = CurrentLivePublishRequest {
        session_id: session_id.clone(),
        session: Some(SessionManifest {
            session_id: session_id.clone(),
            run_id,
            status: "interactive".to_string(),
            interactive_session_requested: true,
            script_path: String::new(),
            problem_name: "New Simulation".to_string(),
            requested_backend: "auto".to_string(),
            explicit_selection: false,
            requested_device: "auto".to_string(),
            requested_precision: "double".to_string(),
            requested_mode: "strict".to_string(),
            requested_cpu_threads: None,
            execution_mode: "strict".to_string(),
            precision: "double".to_string(),
            resolved_backend: None,
            resolved_device: None,
            resolved_precision: None,
            resolved_mode: None,
            resolved_runtime_family: None,
            resolved_engine_id: None,
            resolved_worker: None,
            resolved_cpu_threads: None,
            resolved_fallback: None,
            artifact_dir: artifact_dir.display().to_string(),
            started_at_unix_ms: now,
            finished_at_unix_ms: now,
            plan_summary: json!({}),
        }),
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
        fem_mesh: None,
    };

    let next = default_current_live_state(&publish_req);
    let ws_messages = build_current_live_ws_messages(state, &next)?;
    let public_json = serialize_current_live_response(&next, true, false, false)?;
    *state.current_live_state.write().await = Some(next);
    *state.current_live_public_snapshot.write().await = Some(public_json.clone());
    send_current_live_ws_messages(state, ws_messages);
    Ok(public_json)
}

fn bootstrap_workspace_payload(snapshot_json: &str) -> Result<String, ApiError> {
    let value: Value = serde_json::from_str(snapshot_json).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse workspace bootstrap snapshot: {error}"
        ))
    })?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::internal("workspace bootstrap snapshot must be a JSON object"))?;
    object.insert("mode".to_string(), Value::String("workspace".to_string()));
    serde_json::to_string(&Value::Object(object)).map_err(|error| {
        ApiError::internal(format!("failed to encode workspace bootstrap: {error}"))
    })
}

/// POST /v1/live/current/create — create a bootstrapping workspace in-process.
///
/// Called by the web UI when the user clicks "Create New Simulation" and no
/// live workspace exists yet (hub mode). Creates a minimal bootstrapping
/// `SessionStateResponse`, publishes it, and returns the bootstrap payload so
/// the client can immediately transition out of the loading state.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct CreateWorkspaceRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    backend: Option<String>,
}

async fn create_current_live_workspace(
    State(state): State<Arc<AppState>>,
    Json(_req): Json<CreateWorkspaceRequest>,
) -> Result<Response, ApiError> {
    // If a workspace already exists, serialize and return its bootstrap payload.
    if let Some(live) = state.current_live_state.read().await.as_ref() {
        let public_json = serialize_current_live_response(live, true, false, false)
            .map_err(|e| ApiError::internal(format!("failed to serialize live state: {}", e)))?;
        let json = bootstrap_workspace_payload(&public_json)?;
        return Ok(([(CONTENT_TYPE, "application/json")], json).into_response());
    }

    let json = auto_create_workspace(&state).await?;
    let payload = bootstrap_workspace_payload(&json)?;
    Ok(([(CONTENT_TYPE, "application/json")], payload).into_response())
}

async fn get_current_live_state(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CurrentLiveSnapshotQuery>,
) -> Result<Response, ApiError> {
    get_current_live_bootstrap(State(state), Query(query)).await
}

async fn get_current_live_poll(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CurrentLivePollQuery>,
) -> Result<Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if query
        .since_version
        .is_some_and(|since_version| since_version >= snapshot.state_version)
    {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let scalar_rows_delta_start = query.scalar_rows_total.unwrap_or(0);
    let scalar_rows_delta = snapshot
        .scalar_rows
        .len()
        .saturating_sub(scalar_rows_delta_start);
    let (preview_source_step, preview_vector_len, preview_vector_avg) =
        preview_debug_metrics(snapshot.preview.as_ref());
    let live_mag_len = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len())
        .unwrap_or(0);
    let live_mag_avg = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .and_then(|values| average_vector_components(values, 3));
    eprintln!(
        "[fullmag-api] TX -> frontend poll version={} since={} delta_rows={} step={} live_mag_len={} live_mag_avg={} preview={} preview_step={} preview_vec_len={} preview_vec_avg={} fields={}",
        snapshot.state_version,
        query.since_version.unwrap_or(0),
        scalar_rows_delta,
        snapshot
            .live_state
            .as_ref()
            .map(|state| state.latest_step.step)
            .unwrap_or(0),
        live_mag_len,
        format_debug_vector_average(live_mag_avg),
        snapshot.preview.is_some(),
        preview_source_step,
        preview_vector_len,
        format_debug_vector_average(preview_vector_avg),
        snapshot.latest_fields.len(),
    );
    let json = serialize_current_live_poll_response(
        snapshot,
        scalar_rows_delta_start,
        binary_field_transport_requested(query.field_transport.as_deref()),
        binary_mesh_transport_requested(query.mesh_transport.as_deref()),
    )?;
    Ok(([(CONTENT_TYPE, "application/json")], json).into_response())
}

/// `GET /v1/live/current/scalars` — return the full scalar history for the
/// current workspace.  The frontend fetches this once on tab open and then
/// appends WS chart_state deltas.
async fn get_current_live_scalars(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    Ok(Json(serde_json::json!({
        "scalar_rows": rows,
        "scalar_rows_total": rows.len(),
    })))
}

/// `GET /v1/live/feature-flags` — return the current feature flags.
async fn get_feature_flags(State(state): State<Arc<AppState>>) -> Json<FeatureFlags> {
    Json(state.feature_flags.clone())
}

async fn get_current_display_selection(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CurrentDisplaySelection>, ApiError> {
    Ok(Json(state.current_display_selection.read().await.clone()))
}

async fn get_current_live_events(
    State(state): State<Arc<AppState>>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let mut rx = state.current_live_events.subscribe();
    let initial_snapshot = state
        .current_live_public_snapshot
        .read()
        .await
        .as_ref()
        .cloned();
    let stream = stream! {
        if let Some(json) = initial_snapshot {
            yield Ok(Event::default().event("session_state").data(json));
        }

        loop {
            match rx.recv().await {
                Ok(_) => {
                    let current_json = state
                        .current_live_public_snapshot
                        .read()
                        .await
                        .as_ref()
                        .cloned();
                    if let Some(json) = current_json {
                        yield Ok(Event::default().event("session_state").data(json));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn is_preview_control_command(command: &SessionCommand) -> bool {
    matches!(
        command.kind.as_str(),
        "display_selection_update" | "preview_update" | "preview_refresh"
    )
}

async fn enqueue_current_control_command(
    state: &Arc<AppState>,
    mut command: SessionCommand,
) -> SessionCommand {
    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    command.seq = seq;
    state
        .current_control_queue
        .lock()
        .await
        .push_back(command.clone());
    let _ = state.current_control_events.send(seq);
    command
}

async fn take_next_current_control_command_after(
    state: &Arc<AppState>,
    after_seq: u64,
    include_preview: bool,
) -> Option<SessionCommand> {
    let mut queue = state.current_control_queue.lock().await;
    let mut index = 0usize;
    while index < queue.len() {
        let Some(command) = queue.get(index) else {
            break;
        };
        if command.seq <= after_seq {
            let _ = queue.remove(index);
            continue;
        }
        if !include_preview && is_preview_control_command(command) {
            index += 1;
            continue;
        }
        return queue.remove(index);
    }
    None
}

fn build_preview_control_command(
    display_selection: &CurrentDisplaySelection,
    refresh_only: bool,
) -> SessionCommand {
    let preview_config = display_selection.preview_request();
    SessionCommand {
        seq: 0,
        command_id: format!(
            "cmd-{}",
            if refresh_only {
                format!("preview-refresh-{}", uuid_v4_hex())
            } else {
                format!("display-selection-{}", uuid_v4_hex())
            }
        ),
        kind: if refresh_only {
            "preview_refresh".to_string()
        } else {
            "display_selection_update".to_string()
        },
        created_at_unix_ms: unix_time_millis_now(),
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
        display_selection: Some(display_selection.clone()),
        preview_config: Some(preview_config),
        stages: None,
    }
}

fn canonicalize_display_selection(selection: &mut DisplaySelection) -> Result<(), ApiError> {
    selection.kind = DisplaySelection::kind_for_quantity(&selection.quantity);
    if selection.component.trim().is_empty()
        && !matches!(selection.kind, fullmag_runner::DisplayKind::GlobalScalar)
    {
        selection.component = "3D".to_string();
    }
    Ok(())
}

async fn publish_current_live_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CurrentLivePublishRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let publish_start = std::time::Instant::now();
    let has_live_state_update = req.live_state.is_some();
    let has_scalar_row_update = req.latest_scalar_row.is_some();
    let has_latest_fields_update = req.latest_fields.is_some();
    let allow_previous_preview_fallback = !req.clear_preview_cache;
    let reset_preview = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|existing| existing.session.session_id != req.session_id)
        .unwrap_or(false);
    if reset_preview {
        let display_selection = CurrentDisplaySelection::default();
        *state.current_display_selection.write().await = display_selection.clone();
        state.current_control_queue.lock().await.clear();
        *state.current_control_next_seq.lock().await = 0;
        let _ = state.current_control_events.send(0);
        let _ = std::fs::remove_dir_all(&state.current_workspace_root);
    }
    let display_selection = state.current_display_selection.read().await.clone();
    let selected_cached_preview_updated = req
        .preview_fields
        .as_ref()
        .is_some_and(|fields| cached_preview_update_matches_selection(fields, &display_selection));
    let has_cached_preview_update = req.clear_preview_cache || selected_cached_preview_updated;
    let preview_config = display_selection.preview_request();
    let mut current = state.current_live_state.write().await;
    let mut next = match current.take() {
        Some(existing) if existing.session.session_id == req.session_id => existing,
        _ => default_current_live_state(&req),
    };
    let previous_preview = next.preview.clone();
    let apply_start = std::time::Instant::now();
    apply_current_live_publish(&mut next, req)?;
    let apply_ms = apply_start.elapsed().as_micros();
    next.display_selection = display_selection.clone();
    next.preview_config = preview_config.clone();
    if next.scene_document.is_none() && !next.session.script_path.trim().is_empty() {
        match load_scene_document_state(
            &state.repo_root,
            &state.current_workspace_root,
            Path::new(next.session.script_path.trim()),
        ) {
            Ok(scene_document) => {
                next.builder_adapter = scene_document_builder_projection(&scene_document).ok();
                next.scene_document = Some(scene_document);
            }
            Err(e) => {
                eprintln!(
                    "[fullmag-api] failed to load scene document for '{}': {:?}",
                    next.session.script_path.trim(),
                    e
                );
            }
        }
    }
    let has_fresh_preview = live_state_has_fresh_preview(next.live_state.as_ref());
    let should_rebuild_preview = !state.feature_flags.disable_preview_3d
        && (has_fresh_preview
            || has_latest_fields_update
            || has_cached_preview_update
            || (matches!(
                next.display_selection.selection.kind,
                fullmag_runner::DisplayKind::GlobalScalar
            ) && (has_live_state_update || has_scalar_row_update)));
    let preview_start = std::time::Instant::now();
    next.preview = if should_rebuild_preview {
        let rebuilt = build_preview_state(&next, &next.display_selection, &preview_config);
        if allow_previous_preview_fallback {
            rebuilt.or(previous_preview)
        } else {
            rebuilt
        }
    } else {
        previous_preview
    };
    let preview_ms = preview_start.elapsed().as_micros();
    let serialize_start = std::time::Instant::now();
    let ws_subscribers = state.current_live_events.receiver_count();
    let session_state_messages = if ws_subscribers == 0 {
        Vec::new()
    } else {
        // Compute delta: send only rows added since the last WS broadcast.
        // Track the cursor and quantities hash so we avoid re-sending stale data.
        let scalar_delta_start = next.scalar_rows_ws_cursor;
        let new_quantities_hash = quantities_hash(&next.quantities);
        let quantities_changed = new_quantities_hash != next.quantities_ws_hash;

        // ── Sparse FEM mesh: only send when generation_id changed ──
        let current_fem_gen = next.fem_mesh.as_ref().and_then(|m| m.generation_id.clone());
        let fem_mesh_changed = current_fem_gen != next.ws_sent_fem_mesh_generation;

        // ── Sparse preview: only generate vector_payload_id when fingerprint changed ──
        let current_preview_fp = next.preview.as_ref().map(|p| p.fingerprint());
        let preview_changed = current_preview_fp != next.ws_sent_preview_fingerprint;

        // ── Sparse latest_fields: only send when content hash changed ──
        let current_fields_hash = next.latest_fields.content_hash();
        // Important: latest_fields.content_hash() is intentionally cheap
        // (keys + shape), so value-only updates may keep the same hash.
        // When the publish payload carries latest_fields, treat that as a
        // definitive signal that field buffers changed and must be broadcast.
        let latest_fields_changed =
            has_latest_fields_update || current_fields_hash != next.ws_sent_latest_fields_hash;

        // ── Sparse envelope: only send heavy static fields when version changed ──
        let envelope_changed = next.envelope_version != next.ws_sent_envelope_version;

        let messages = build_current_live_ws_messages_delta(
            &state,
            &next,
            scalar_delta_start,
            quantities_changed,
            fem_mesh_changed,
            preview_changed,
            latest_fields_changed,
            envelope_changed,
        )?;
        // Advance cursors and update fingerprints BEFORE storing.
        next.scalar_rows_ws_cursor = next.scalar_rows.len();
        if quantities_changed {
            next.quantities_ws_hash = new_quantities_hash;
        }
        if fem_mesh_changed {
            next.ws_sent_fem_mesh_generation = current_fem_gen;
        }
        if preview_changed {
            next.ws_sent_preview_fingerprint = current_preview_fp;
        }
        if latest_fields_changed {
            next.ws_sent_latest_fields_hash = current_fields_hash;
        }
        if envelope_changed {
            next.ws_sent_envelope_version = next.envelope_version;
        }
        // Log sparse stats periodically to verify savings.
        let step = next
            .live_state
            .as_ref()
            .map(|l| l.latest_step.step)
            .unwrap_or(0);
        if step > 0 && step % 200 == 0 {
            let total_bytes: usize = messages
                .iter()
                .map(|m| match m {
                    CurrentLiveWireMessage::Text(t) => t.len(),
                    CurrentLiveWireMessage::Binary(b) => b.len(),
                })
                .sum();
            eprintln!(
                "[fullmag-api] WS delta step={step}: {n} msgs, {kb:.1} KB, envelope={env}",
                n = messages.len(),
                kb = total_bytes as f64 / 1024.0,
                env = if envelope_changed { "full" } else { "sparse" },
            );
        }
        messages
    };
    let serialize_ms = serialize_start.elapsed().as_micros();

    // Lazy memoization: bump state version and only rebuild full JSON snapshot
    // when requested by HTTP endpoints (bootstrap / state).
    next.state_version = next.state_version.wrapping_add(1);
    let current_state_version = next.state_version;
    let (preview_source_step, preview_vector_len, preview_vector_avg) =
        preview_debug_metrics(next.preview.as_ref());
    let live_mag_len = next
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len())
        .unwrap_or(0);
    let live_mag_avg = next
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .and_then(|values| average_vector_components(values, 3));
    eprintln!(
        "[fullmag-api] publish -> live snapshot version={} session={} run={} step={} scalar_rows={} live_mag_len={} live_mag_avg={} preview={} preview_step={} preview_vec_len={} preview_vec_avg={} fields={} ws_messages={}",
        current_state_version,
        next.session.session_id,
        next.run.as_ref().map(|run| run.run_id.as_str()).unwrap_or("-"),
        next
            .live_state
            .as_ref()
            .map(|state| state.latest_step.step)
            .unwrap_or(0),
        next.scalar_rows.len(),
        live_mag_len,
        format_debug_vector_average(live_mag_avg),
        next.preview.is_some(),
        preview_source_step,
        preview_vector_len,
        format_debug_vector_average(preview_vector_avg),
        next.latest_fields.len(),
        session_state_messages.len(),
    );
    *current = Some(next);
    drop(current);

    // Truly lazy snapshot: only bump the state version counter.
    // Full JSON serialization is deferred to the HTTP handler that actually
    // needs it (bootstrap / state endpoint) via version comparison.
    // This eliminates ~2-10ms of synchronous JSON serialization from the hot
    // publish path that runs every 50ms during a solver run.
    let snapshot_ms: u128 = 0;

    send_current_live_ws_messages(&state, session_state_messages);

    let publish_elapsed_us = publish_start.elapsed().as_micros();
    if publish_elapsed_us > 50_000 {
        eprintln!(
            "[fullmag-api] PERF: publish took {:.1}ms (apply={:.1}ms preview={:.1}ms serialize={:.1}ms snapshot={:.1}ms)",
            publish_elapsed_us as f64 / 1000.0,
            apply_ms as f64 / 1000.0,
            preview_ms as f64 / 1000.0,
            serialize_ms as f64 / 1000.0,
            snapshot_ms as f64 / 1000.0,
        );
    }

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn set_current_preview_quantity(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewQuantityRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "quantity",
        move |config| {
            config.quantity = req.quantity;
        },
    )
    .await
}

async fn set_current_preview_selection(
    State(state): State<Arc<AppState>>,
    Json(selection): Json<DisplaySelection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "selection",
        move |current| {
            *current = selection;
        },
    )
    .await
}

async fn set_current_preview_component(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewComponentRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "component",
        move |config| {
            config.component = req.component;
        },
    )
    .await
}

async fn set_current_preview_x_chosen_size(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewXChosenSizeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "x_chosen_size",
        move |config| {
            config.x_chosen_size = req.x_chosen_size as u32;
        },
    )
    .await
}

async fn set_current_preview_every_n(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewEveryNRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "every_n",
        move |config| {
            config.every_n = req.every_n.clamp(1, u32::MAX as usize) as u32;
        },
    )
    .await
}

async fn set_current_preview_y_chosen_size(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewYChosenSizeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "y_chosen_size",
        move |config| {
            config.y_chosen_size = req.y_chosen_size as u32;
        },
    )
    .await
}

async fn set_current_preview_auto_scale(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewAutoScaleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "auto_scale",
        move |config| {
            config.auto_scale_enabled = req.auto_scale_enabled;
        },
    )
    .await
}

async fn set_current_preview_max_points(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewMaxPointsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "max_points",
        move |config| {
            config.max_points = req.max_points.min(u32::MAX as usize) as u32;
        },
    )
    .await
}

async fn set_current_preview_layer(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewLayerRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, PreviewControlMode::Update, "layer", move |config| {
        config.layer = req.layer as u32;
    })
    .await
}

async fn set_current_preview_all_layers(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewAllLayersRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(
        &state,
        PreviewControlMode::Update,
        "all_layers",
        move |config| {
            config.all_layers = req.all_layers;
        },
    )
    .await
}

async fn refresh_current_preview(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, PreviewControlMode::Refresh, "refresh", |_config| {}).await
}

async fn enqueue_current_live_command(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionCommandRequest>,
) -> Result<Json<SessionCommandResponse>, ApiError> {
    let session_id = current_live_session_id(&state).await?;
    let command = enqueue_current_control_command(&state, build_session_command(req)?).await;
    eprintln!(
        "[fullmag-api] RX <- frontend command {} seq={} id={}",
        command.kind, command.seq, command.command_id
    );
    if let Some(mesh_options) = command.mesh_options.as_ref() {
        eprintln!("[fullmag-api]    mesh_options: {}", mesh_options);
    }
    if let Some(mesh_target) = command.mesh_target.as_ref() {
        eprintln!("[fullmag-api]    mesh_target: {:?}", mesh_target);
    }
    if let Some(mesh_reason) = command.mesh_reason.as_ref() {
        eprintln!("[fullmag-api]    mesh_reason: {}", mesh_reason);
    }
    let ack_json = serialize_runtime_event(&build_command_ack_event(&session_id, &command))?;
    let _ = state
        .current_live_events
        .send(CurrentLiveWireMessage::Text(ack_json));
    eprintln!(
        "[fullmag-api] TX -> frontend ack {} seq={} id={}",
        command.kind, command.seq, command.command_id
    );
    let response = SessionCommandResponse {
        command_id: command.command_id.clone(),
        session_id,
        seq: command.seq,
        kind: command.kind.clone(),
        queued_path: format!("memory://current/{}", command.command_id),
    };
    Ok(Json(response))
}

async fn dequeue_current_live_command(
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let command = take_next_current_control_command_after(&state, 0, false).await;
    match command {
        Some(command) => Ok(Json(command).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn wait_current_live_control(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ControlWaitQuery>,
) -> Result<Response, ApiError> {
    let _ = current_live_session_id(&state).await?;
    if let Some(command) =
        take_next_current_control_command_after(&state, query.after_seq, true).await
    {
        return Ok(Json(command).into_response());
    }

    let timeout_ms = query.timeout_ms.clamp(100, 20_000);
    let mut rx = state.current_control_events.subscribe();
    let state_for_wait = Arc::clone(&state);
    let waited = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async move {
        loop {
            rx.changed()
                .await
                .map_err(|_| ApiError::internal("control command stream closed"))?;
            if let Some(command) =
                take_next_current_control_command_after(&state_for_wait, query.after_seq, true)
                    .await
            {
                return Ok::<SessionCommand, ApiError>(command);
            }
        }
    })
    .await;

    match waited {
        Ok(Ok(command)) => Ok(Json(command).into_response()),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn import_current_live_asset(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportSessionAssetRequest>,
) -> Result<Json<SessionAssetImportResponse>, ApiError> {
    let response = import_asset_for_current_workspace(&state, req).await?;
    Ok(Json(response))
}

async fn export_current_live_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExportMagnetizationStateRequest>,
) -> Result<Json<ExportMagnetizationStateResponse>, ApiError> {
    let response = export_magnetization_state_for_current_workspace(&state, req).await?;
    Ok(Json(response))
}

async fn import_current_live_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportMagnetizationStateRequest>,
) -> Result<Json<ImportMagnetizationStateResponse>, ApiError> {
    let response = import_magnetization_state_for_current_workspace(&state, req).await?;
    Ok(Json(response))
}

async fn list_current_live_artifacts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ArtifactEntry>>, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot);
    drop(current);
    Ok(Json(read_artifacts_from_dir(artifact_dir.as_deref())?))
}

async fn read_current_live_artifact(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ArtifactFileQuery>,
) -> Result<Response, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    drop(current);

    let relative = sanitize_artifact_relative_path(&query.path)?;
    let artifact_path = artifact_dir.join(&relative);
    if !artifact_path.exists() || !artifact_path.is_file() {
        return Err(ApiError::not_found(format!(
            "artifact '{}' was not found",
            query.path
        )));
    }

    let content_type = match artifact_path.extension().and_then(|ext| ext.to_str()) {
        Some("json") => "application/json; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let bytes = std::fs::read(&artifact_path)
        .map_err(|error| ApiError::internal(format!("failed to read artifact: {}", error)))?;
    Ok(([(CONTENT_TYPE, content_type)], bytes).into_response())
}

async fn get_current_live_eigen_spectrum(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    for candidate in ["eigen/spectrum.json", "eigen/metadata/eigen_summary.json"] {
        if try_resolve_artifact_path(&artifact_dir, candidate)?.is_some() {
            return Ok(Json(read_json_artifact_value(&artifact_dir, candidate)?));
        }
    }
    Err(ApiError::not_found(
        "no eigen spectrum artifact found in the active workspace",
    ))
}

async fn get_current_live_eigen_mode(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EigenModeQuery>,
) -> Result<Json<Value>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    // Try V2 sample-indexed path first, then fall back to legacy flat path
    let relative_path = if let Some(sample_idx) = query.sample_index {
        format!(
            "eigen/modes/sample_{:04}/mode_{:04}.json",
            sample_idx, query.index
        )
    } else {
        format!("eigen/modes/mode_{:04}.json", query.index)
    };
    match read_json_artifact_value(&artifact_dir, &relative_path) {
        Ok(value) => Ok(Json(value)),
        Err(_) if query.sample_index.is_some() => {
            // Fallback: try legacy flat path when sample path doesn't exist
            let legacy_path = format!("eigen/modes/mode_{:04}.json", query.index);
            Ok(Json(read_json_artifact_value(&artifact_dir, &legacy_path)?))
        }
        Err(err) => Err(err),
    }
}

async fn get_current_live_eigen_dispersion(
    State(state): State<Arc<AppState>>,
) -> Result<Json<EigenDispersionResponse>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let csv_path = "eigen/dispersion/branch_table.csv";
    let csv_content = read_text_artifact_value(&artifact_dir, csv_path)?;
    let path_metadata =
        if try_resolve_artifact_path(&artifact_dir, "eigen/dispersion/path.json")?.is_some() {
            Some(read_json_artifact_value(
                &artifact_dir,
                "eigen/dispersion/path.json",
            )?)
        } else {
            None
        };
    Ok(Json(EigenDispersionResponse {
        csv_path: csv_path.to_string(),
        path_metadata,
        rows: parse_eigen_dispersion_csv(&csv_content)?,
    }))
}

/// Serve V2 tracked-branch artifact (eigen/branches.json).
/// Returns 404 if the artifact doesn't exist (single-k solve or legacy run).
async fn get_current_live_eigen_branches(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    match try_resolve_artifact_path(&artifact_dir, "eigen/branches.json")? {
        Some(_) => Ok(Json(read_json_artifact_value(
            &artifact_dir,
            "eigen/branches.json",
        )?)),
        None => Err(ApiError::not_found(
            "no eigen/branches.json artifact found (single-k solve or legacy run)",
        )),
    }
}

/// POST /v1/run — start a simulation run and broadcast live updates.
async fn start_run(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let output_dir = PathBuf::from(&req.output_dir);
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| ApiError::internal(format!("failed to create output dir: {}", e)))?;

    let run_id = format!("run-{}", uuid_v4_hex());
    let (tx, _) = broadcast::channel::<StepUpdate>(256);
    {
        let mut channels = state.live_channels.write().await;
        channels.insert(run_id.clone(), tx.clone());
    }

    let problem = req.problem;
    let until = req.until_seconds;
    let channels = state.live_channels.clone();
    let rid = run_id.clone();

    // Spawn runner in a blocking task (runner is synchronous)
    tokio::task::spawn_blocking(move || {
        let result = fullmag_runner::run_problem_with_callback(
            &problem,
            until,
            &output_dir,
            10, // send magnetization every 10 steps
            |update| {
                let _ = tx.send(update);
                fullmag_runner::StepAction::Continue
            },
        );
        match result {
            Ok(_) => info!(run_id = %rid, "run completed successfully"),
            Err(e) => tracing::error!(run_id = %rid, "run failed: {}", e),
        }
        // Dropping tx closes the broadcast channel; subscribers will see Closed.
        drop(tx);
        // Schedule cleanup of the channel registry entry.
        let handle = tokio::runtime::Handle::current();
        handle.spawn(async move {
            channels.write().await.remove(&rid);
        });
    });

    Ok(Json(serde_json::json!({
        "status": "started",
        "run_id": run_id,
        "message": format!("simulation started, connect to /ws/live/{} for updates", run_id)
    })))
}

/// GET /ws/live/:run_id — WebSocket endpoint for live step updates.
async fn ws_live(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, ApiError> {
    let channels = state.live_channels.read().await;
    let tx = channels
        .get(&run_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("no active run with id '{}'", run_id)))?;
    drop(channels);
    Ok(ws.on_upgrade(move |socket| handle_ws(socket, tx)))
}

async fn ws_current_live(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, ApiError> {
    Ok(ws.on_upgrade(move |socket| handle_current_live_ws(socket, state)))
}

async fn handle_ws(mut socket: WebSocket, tx: broadcast::Sender<StepUpdate>) {
    let mut rx = tx.subscribe();

    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(update) => {
                        let finished = update.finished;
                        // Q16/Q17: serialize the canonical V2 format for external consumers.
                        let v2 = update.to_v2();
                        let json = match serde_json::to_string(&v2) {
                            Ok(j) => j,
                            Err(_) => continue,
                        };
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break; // client disconnected
                        }
                        if finished {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("ws client lagged {n} messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Check for client disconnect
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

async fn handle_current_live_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let initial_snapshot = {
        let current = state.current_live_state.read().await;
        current
            .as_ref()
            .map(|snapshot| build_current_live_ws_messages(&state, snapshot))
            .transpose()
    };
    match initial_snapshot {
        Ok(Some(messages)) => {
            for message in messages {
                let outbound = match message {
                    CurrentLiveWireMessage::Text(text) => Message::Text(text.into()),
                    CurrentLiveWireMessage::Binary(bytes) => Message::Binary(bytes.into()),
                };
                if socket.send(outbound).await.is_err() {
                    return;
                }
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                "failed to serialize initial current-live session_state: {:?}",
                error
            );
            return;
        }
    }

    let mut rx = state.current_live_events.subscribe();
    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(message) => {
                        let outbound = match message {
                            CurrentLiveWireMessage::Text(text) => Message::Text(text.into()),
                            CurrentLiveWireMessage::Binary(bytes) => Message::Binary(bytes.into()),
                        };
                        if socket.send(outbound).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

fn build_session_command(req: SessionCommandRequest) -> Result<SessionCommand, ApiError> {
    let kind = req.kind.trim().to_lowercase();
    if !matches!(
        kind.as_str(),
        "run"
            | "relax"
            | "close"
            | "stop"
            | "break"
            | "pause"
            | "resume"
            | "remesh"
            | "solve"
            | "compute"
            | "load_state"
            | "run_sequence"
            | "skip"
    ) {
        return Err(ApiError::bad_request(format!(
            "unsupported command kind '{}'",
            req.kind
        )));
    }
    if kind == "run" && req.until_seconds.unwrap_or(0.0) <= 0.0 {
        return Err(ApiError::bad_request(
            "run command requires positive until_seconds",
        ));
    }
    if kind == "relax" && req.max_steps.unwrap_or(0) == 0 {
        return Err(ApiError::bad_request(
            "relax command requires positive max_steps",
        ));
    }
    if kind == "load_state"
        && req
            .state_path
            .as_ref()
            .map(|path| path.trim().is_empty())
            .unwrap_or(true)
    {
        return Err(ApiError::bad_request(
            "load_state command requires state_path",
        ));
    }
    if kind == "run_sequence" {
        let stages = req.stages.as_ref();
        if stages.map_or(true, |s| s.is_empty()) {
            return Err(ApiError::bad_request(
                "run_sequence command requires at least one stage",
            ));
        }
    }
    if kind == "remesh" && req.mesh_target.is_none() {
        return Err(ApiError::bad_request("remesh command requires mesh_target"));
    }
    if kind != "remesh" && req.mesh_target.is_some() {
        return Err(ApiError::bad_request(
            "mesh_target is supported only for remesh commands",
        ));
    }
    if kind != "remesh" && req.mesh_reason.is_some() {
        return Err(ApiError::bad_request(
            "mesh_reason is supported only for remesh commands",
        ));
    }

    Ok(SessionCommand {
        seq: 0,
        command_id: format!("cmd-{}", uuid_v4_hex()),
        kind,
        created_at_unix_ms: unix_time_millis_now(),
        until_seconds: req.until_seconds,
        max_steps: req.max_steps,
        torque_tolerance: req.torque_tolerance,
        energy_tolerance: req.energy_tolerance,
        integrator: req.integrator,
        fixed_timestep: req.fixed_timestep,
        max_error: req.max_error,
        relax_algorithm: req.relax_algorithm,
        relax_alpha: req.relax_alpha,
        mesh_options: req.mesh_options,
        mesh_target: req.mesh_target,
        mesh_reason: req.mesh_reason,
        state_path: req.state_path,
        state_format: req.state_format,
        state_dataset: req.state_dataset,
        state_sample_index: req.state_sample_index,
        display_selection: None,
        preview_config: None,
        stages: req.stages,
    })
}

async fn import_asset_for_current_workspace(
    state: &Arc<AppState>,
    req: ImportSessionAssetRequest,
) -> Result<SessionAssetImportResponse, ApiError> {
    let (session_id, imports_dir) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let session_id = snapshot.session.session_id.clone();
        let artifact_dir = current_artifact_dir(snapshot)
            .unwrap_or_else(|| state.current_workspace_root.join("artifacts"));
        (session_id, artifact_dir.join("imports"))
    };

    let response = import_asset_into_dir(state, &session_id, imports_dir.clone(), req)?;
    let artifacts = read_artifacts_from_dir(imports_dir.parent())?;
    let (messages, public_json) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        snapshot.artifacts = artifacts;
        let messages = build_current_live_ws_messages(&state, snapshot)?;
        let public_json = serialize_current_live_response(snapshot, true, false, false)?;
        (messages, public_json)
    };
    *state.current_live_public_snapshot.write().await = Some(public_json);
    send_current_live_ws_messages(&state, messages);
    Ok(response)
}

fn import_asset_into_dir(
    state: &AppState,
    session_id: &str,
    imports_dir: PathBuf,
    req: ImportSessionAssetRequest,
) -> Result<SessionAssetImportResponse, ApiError> {
    let safe_file_name = sanitize_file_name(&req.file_name);
    if safe_file_name.is_empty() {
        return Err(ApiError::bad_request("file_name must not be empty"));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.content_base64)
        .map_err(|error| ApiError::bad_request(format!("invalid base64 payload: {}", error)))?;

    std::fs::create_dir_all(&imports_dir)?;

    let asset_id = format!("asset-{}", uuid_v4_hex());
    let stored_name = format!("{}-{}", asset_id, safe_file_name);
    let stored_path = imports_dir.join(&stored_name);
    std::fs::write(&stored_path, &bytes)?;

    let summary = summarize_uploaded_asset(&safe_file_name, &bytes)?;
    let response = SessionAssetImportResponse {
        asset_id: asset_id.clone(),
        session_id: session_id.to_string(),
        stored_path: make_repo_relative(&state.repo_root, &stored_path),
        target_realization: req.target_realization,
        summary,
    };

    let manifest_path = imports_dir.join(format!("{}.asset.json", asset_id));
    let manifest_text = serde_json::to_string_pretty(&response).map_err(|error| {
        ApiError::internal(format!("failed to serialize asset manifest: {}", error))
    })?;
    std::fs::write(manifest_path, manifest_text)?;

    Ok(response)
}

#[derive(Debug, Deserialize)]
struct ReadMagnetizationStateHelperResponse {
    format: String,
    dataset: Option<String>,
    sample_index: Option<i64>,
    vector_count: usize,
    values: Vec<[f64; 3]>,
}

fn normalize_magnetization_state_format(
    requested: Option<&str>,
    file_name: Option<&str>,
) -> Result<String, ApiError> {
    let normalized = requested
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(value) = normalized {
        return match value.as_str() {
            "json" => Ok("json".to_string()),
            "zarr" => Ok("zarr".to_string()),
            "h5" | "hdf5" => Ok("h5".to_string()),
            _ => Err(ApiError::bad_request(format!(
                "unsupported magnetization state format '{}'",
                value
            ))),
        };
    }

    let lower = file_name.unwrap_or_default().to_lowercase();
    if lower.ends_with(".zarr.zip") || lower.ends_with(".zarr") {
        return Ok("zarr".to_string());
    }
    if lower.ends_with(".h5") || lower.ends_with(".hdf5") {
        return Ok("h5".to_string());
    }
    Ok("json".to_string())
}

fn preferred_magnetization_state_suffix(format: &str) -> &'static str {
    match format {
        "json" => ".json",
        "zarr" => ".zarr.zip",
        "h5" => ".h5",
        _ => ".json",
    }
}

fn ensure_magnetization_state_file_name(file_name: &str, format: &str) -> String {
    let safe = sanitize_file_name(file_name);
    if safe.is_empty() {
        return default_magnetization_state_file_name(format);
    }
    let lower = safe.to_lowercase();
    if format == "zarr" && lower.ends_with(".zarr") {
        return format!("{safe}.zip");
    }
    if format == "h5" && (lower.ends_with(".h5") || lower.ends_with(".hdf5")) {
        return safe;
    }
    if lower.ends_with(preferred_magnetization_state_suffix(format)) {
        return safe;
    }
    format!("{safe}{}", preferred_magnetization_state_suffix(format))
}

fn default_magnetization_state_file_name(format: &str) -> String {
    let timestamp = unix_time_millis_now();
    format!(
        "m_state_{}{}",
        timestamp,
        preferred_magnetization_state_suffix(format)
    )
}

fn magnetization_state_json_payload(values: &[[f64; 3]]) -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "kind": "magnetization_state",
        "observable": "m",
        "format": "json",
        "vector_count": values.len(),
        "values": values,
    }))
    .expect("magnetization state JSON encoding should succeed")
}

fn flat_magnetization_to_vectors(values: &[f64]) -> Result<Vec<[f64; 3]>, ApiError> {
    if values.len() % 3 != 0 {
        return Err(ApiError::internal(format!(
            "expected flat magnetization length divisible by 3, got {}",
            values.len()
        )));
    }
    Ok(values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect())
}

fn current_workspace_magnetization_source(
    snapshot: &SessionStateResponse,
    artifact_dir: &Path,
    repo_root: &Path,
) -> Result<Vec<[f64; 3]>, ApiError> {
    if let Some(live_state) = snapshot.live_state.as_ref() {
        if let Some(values) = live_state.latest_step.magnetization.as_ref() {
            return flat_magnetization_to_vectors(values);
        }
    }

    for candidate in ["m_final.json", "m_initial.json"] {
        let path = artifact_dir.join(candidate);
        if path.is_file() {
            return read_magnetization_state_with_python(repo_root, &path, None, None, None)
                .map(|loaded| loaded.values);
        }
    }

    Err(ApiError::not_found(
        "no current magnetization state is available yet for export",
    ))
}

async fn export_magnetization_state_for_current_workspace(
    state: &Arc<AppState>,
    req: ExportMagnetizationStateRequest,
) -> Result<ExportMagnetizationStateResponse, ApiError> {
    let (artifact_dir, vectors) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let artifact_dir = current_artifact_dir(snapshot)
            .unwrap_or_else(|| state.current_workspace_root.join("artifacts"));
        let vectors =
            current_workspace_magnetization_source(snapshot, &artifact_dir, &state.repo_root)?;
        (artifact_dir, vectors)
    };

    let format =
        normalize_magnetization_state_format(req.format.as_deref(), req.file_name.as_deref())?;
    let file_name = req
        .file_name
        .as_deref()
        .map(|value| ensure_magnetization_state_file_name(value, &format))
        .unwrap_or_else(|| default_magnetization_state_file_name(&format));
    let exports_dir = artifact_dir.join("exports");
    let export_path = exports_dir.join(&file_name);
    std::fs::create_dir_all(&exports_dir)?;

    if format == "json" {
        std::fs::write(&export_path, magnetization_state_json_payload(&vectors))?;
    } else {
        let temp_source_path = exports_dir.join(format!(".state-export-{}.json", uuid_v4_hex()));
        std::fs::write(
            &temp_source_path,
            magnetization_state_json_payload(&vectors),
        )?;
        let convert_result = convert_magnetization_state_with_python(
            &state.repo_root,
            &temp_source_path,
            &export_path,
            Some("json"),
            Some(&format),
            None,
            req.dataset.as_deref(),
            None,
        );
        let _ = std::fs::remove_file(&temp_source_path);
        convert_result?;
    }

    let content_base64 =
        base64::engine::general_purpose::STANDARD.encode(std::fs::read(&export_path)?);
    let vector_count = vectors.len();
    let artifacts = read_artifacts_from_dir(Some(&artifact_dir))?;
    let (messages, public_json) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        snapshot.artifacts = artifacts;
        let messages = build_current_live_ws_messages(&state, snapshot)?;
        let public_json = serialize_current_live_response(snapshot, true, false, false)?;
        (messages, public_json)
    };
    *state.current_live_public_snapshot.write().await = Some(public_json);
    send_current_live_ws_messages(&state, messages);

    Ok(ExportMagnetizationStateResponse {
        file_name,
        format,
        stored_path: make_repo_relative(&state.repo_root, &export_path),
        vector_count,
        content_base64,
    })
}

async fn import_magnetization_state_for_current_workspace(
    state: &Arc<AppState>,
    req: ImportMagnetizationStateRequest,
) -> Result<ImportMagnetizationStateResponse, ApiError> {
    let format = normalize_magnetization_state_format(req.format.as_deref(), Some(&req.file_name))?;
    let file_name = ensure_magnetization_state_file_name(&req.file_name, &format);
    let (session_id, imports_dir, session_status) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let session_id = snapshot.session.session_id.clone();
        let artifact_dir = current_artifact_dir(snapshot)
            .unwrap_or_else(|| state.current_workspace_root.join("artifacts"));
        (
            session_id,
            artifact_dir.join("imports"),
            snapshot.session.status.clone(),
        )
    };

    if req.apply_to_workspace
        && !matches!(
            session_status.as_str(),
            "awaiting_command" | "waiting_for_compute"
        )
    {
        return Err(ApiError::bad_request(
            "workspace state import can only be applied while awaiting_command or waiting_for_compute",
        ));
    }

    let imported = import_asset_into_dir(
        state,
        &session_id,
        imports_dir.clone(),
        ImportSessionAssetRequest {
            file_name: file_name.clone(),
            content_base64: req.content_base64.clone(),
            target_realization: "magnetization_state".to_string(),
        },
    )?;
    let stored_abs_path = state.repo_root.join(&imported.stored_path);
    let loaded = read_magnetization_state_with_python(
        &state.repo_root,
        &stored_abs_path,
        Some(&format),
        req.dataset.as_deref(),
        req.sample_index,
    )?;
    let command = if req.apply_to_workspace {
        Some(
            enqueue_current_control_command(
                state,
                SessionCommand {
                    seq: 0,
                    command_id: format!("cmd-{}", uuid_v4_hex()),
                    kind: "load_state".to_string(),
                    created_at_unix_ms: unix_time_millis_now(),
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
                    state_path: Some(stored_abs_path.display().to_string()),
                    state_format: Some(loaded.format.clone()),
                    state_dataset: loaded.dataset.clone(),
                    state_sample_index: req.sample_index.or(loaded.sample_index),
                    display_selection: None,
                    preview_config: None,
                    stages: None,
                },
            )
            .await,
        )
    } else {
        None
    };

    let artifacts = read_artifacts_from_dir(imports_dir.parent())?;
    let (messages, public_json) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        snapshot.artifacts = artifacts;
        if req.attach_to_script_builder {
            if snapshot.scene_document.is_none() && !snapshot.session.script_path.trim().is_empty()
            {
                let scene_document = load_scene_document_state(
                    &state.repo_root,
                    &state.current_workspace_root,
                    Path::new(snapshot.session.script_path.trim()),
                )?;
                snapshot.builder_adapter = scene_document_builder_projection(&scene_document).ok();
                snapshot.scene_document = Some(scene_document);
            }
            if let Some(scene_document) = snapshot.scene_document.as_mut() {
                scene_document.study.initial_state = Some(ScriptBuilderInitialState {
                    magnet_name: None,
                    source_path: stored_abs_path.display().to_string(),
                    format: loaded.format.clone(),
                    dataset: loaded.dataset.clone(),
                    sample_index: req.sample_index.or(loaded.sample_index),
                });
                scene_document.revision = scene_document.revision.saturating_add(1);
                snapshot.builder_adapter = scene_document_builder_projection(scene_document).ok();
            }
        }
        let messages = build_current_live_ws_messages(&state, snapshot)?;
        let public_json = serialize_current_live_response(snapshot, true, false, false)?;
        (messages, public_json)
    };
    *state.current_live_public_snapshot.write().await = Some(public_json);
    send_current_live_ws_messages(&state, messages);

    if let Some(command) = command {
        let _ = command;
    }

    Ok(ImportMagnetizationStateResponse {
        asset_id: imported.asset_id,
        session_id,
        stored_path: imported.stored_path,
        file_name,
        format: loaded.format,
        vector_count: loaded.vector_count,
        applied_to_workspace: req.apply_to_workspace,
        attached_to_script_builder: req.attach_to_script_builder,
    })
}

async fn sync_current_live_script(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScriptSyncRequest>,
) -> Result<Json<ScriptSyncResponse>, ApiError> {
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
    Ok(Json(response))
}

async fn update_current_live_scene(
    State(state): State<Arc<AppState>>,
    Json(mut scene_document): Json<SceneDocument>,
) -> Result<Json<SceneDocument>, ApiError> {
    let preset_texture_count = scene_document
        .magnetization_assets
        .iter()
        .filter(|asset| asset.kind == "preset_texture")
        .count();
    eprintln!(
        "[fullmag-api] RX <- frontend scene rev={} objects={} magnetization_assets={} preset_texture_assets={}",
        scene_document.revision,
        scene_document.objects.len(),
        scene_document.magnetization_assets.len(),
        preset_texture_count
    );
    info!(
        target: "fullmag_api::scene_sync",
        direction = "rx",
        revision = scene_document.revision,
        version = %scene_document.version,
        objects = scene_document.objects.len(),
        magnetization_assets = scene_document.magnetization_assets.len(),
        summary = %scene_magnetization_summary(&scene_document),
        "frontend scene update received"
    );
    let (
        scene_document,
        session_state_messages,
        public_json,
        preset_texture_change_logs,
        live_rebuild_stats,
    ) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        if snapshot.scene_document.is_none() && !snapshot.session.script_path.trim().is_empty() {
            let current_scene = load_scene_document_state(
                &state.repo_root,
                &state.current_workspace_root,
                Path::new(snapshot.session.script_path.trim()),
            )?;
            snapshot.builder_adapter = scene_document_builder_projection(&current_scene).ok();
            snapshot.scene_document = Some(current_scene);
        }
        let previous_scene = snapshot.scene_document.clone();
        let next_revision = snapshot
            .scene_document
            .as_ref()
            .map(|current_scene| current_scene.revision.saturating_add(1))
            .unwrap_or_else(|| scene_document.revision.saturating_add(1));
        scene_document.version = "scene.v1".to_string();
        scene_document.revision = next_revision;
        let builder_state = match scene_document_builder_projection(&scene_document) {
            Ok(state) => state,
            Err(err) => {
                info!(
                    target: "fullmag_api::scene_sync",
                    direction = "reject",
                    revision = scene_document.revision,
                    summary = %scene_magnetization_summary(&scene_document),
                    error = %err.message,
                    "frontend scene update rejected"
                );
                return Err(err);
            }
        };
        snapshot.builder_adapter = Some(builder_state);
        snapshot.scene_document = Some(scene_document.clone());
        let allow_live_magnetization_rebuild = snapshot
            .live_state
            .as_ref()
            .map(|live_state| {
                !matches!(
                    live_state.status.as_str(),
                    "running" | "materializing_script"
                )
            })
            .unwrap_or(true);
        let live_rebuild_stats = if allow_live_magnetization_rebuild {
            rebuild_live_scene_magnetization(snapshot)
        } else {
            None
        };
        let previous_preview = snapshot.preview.clone();
        snapshot.preview = build_preview_state(
            snapshot,
            &snapshot.display_selection,
            &snapshot.preview_config,
        )
        .or(previous_preview);
        // Polling clients gate updates on `state_version`, so scene-authoring
        // changes must advance it just like solver publishes do.
        snapshot.state_version = snapshot.state_version.wrapping_add(1);
        let session_state_messages = build_current_live_ws_messages(&state, snapshot)?;
        let public_json = serialize_current_live_response(snapshot, true, false, false)?;
        let preset_texture_change_logs =
            detect_preset_texture_changes(previous_scene.as_ref(), &scene_document);
        (
            scene_document,
            session_state_messages,
            public_json,
            preset_texture_change_logs,
            live_rebuild_stats,
        )
    };

    *state.current_live_public_snapshot.write().await = Some(public_json);
    send_current_live_ws_messages(&state, session_state_messages);
    eprintln!(
        "[fullmag-api] TX -> frontend scene rev={} preset_texture_assets={} status=committed",
        scene_document.revision,
        scene_document
            .magnetization_assets
            .iter()
            .filter(|asset| asset.kind == "preset_texture")
            .count()
    );
    for line in &preset_texture_change_logs {
        eprintln!("[fullmag-api][mag-texture] {}", line);
    }
    if let Some(stats) = live_rebuild_stats {
        eprintln!(
            "[fullmag-api][mag-texture] LIVE_REBUILD mesh_nodes={} magnetic_nodes={} rewritten_nodes={} rewritten_objects={} skipped_objects={} warnings={}",
            stats.mesh_nodes,
            stats.magnetic_nodes,
            stats.rewritten_nodes,
            stats.rewritten_objects,
            stats.skipped_objects,
            stats.warnings.len()
        );
        for warning in stats.warnings {
            eprintln!("[fullmag-api][mag-texture] LIVE_REBUILD_WARN {}", warning);
        }
    }
    info!(
        target: "fullmag_api::scene_sync",
        direction = "tx",
        revision = scene_document.revision,
        summary = %scene_magnetization_summary(&scene_document),
        "frontend scene update committed"
    );
    Ok(Json(scene_document))
}

#[derive(Debug, Clone, Default)]
struct LiveSceneMagnetizationRebuildStats {
    mesh_nodes: usize,
    magnetic_nodes: usize,
    rewritten_nodes: usize,
    rewritten_objects: usize,
    skipped_objects: usize,
    warnings: Vec<String>,
}

fn rebuild_live_scene_magnetization(
    snapshot: &mut SessionStateResponse,
) -> Option<LiveSceneMagnetizationRebuildStats> {
    let scene = snapshot.scene_document.as_ref()?;
    let mesh = snapshot.fem_mesh.as_ref()?;
    let node_count = mesh.nodes.len();
    if node_count == 0 {
        return Some(LiveSceneMagnetizationRebuildStats::default());
    }

    let mut stats = LiveSceneMagnetizationRebuildStats {
        mesh_nodes: node_count,
        ..LiveSceneMagnetizationRebuildStats::default()
    };

    let mut vectors = existing_live_magnetization_vectors(snapshot, node_count)
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; node_count]);
    if vectors.len() != node_count {
        vectors = vec![[0.0, 0.0, 0.0]; node_count];
    }

    let object_index = scene
        .objects
        .iter()
        .enumerate()
        .flat_map(|(index, object)| {
            let mut keys = vec![(object.id.clone(), index)];
            if !object.name.trim().is_empty() {
                keys.push((object.name.clone(), index));
            }
            keys
        })
        .collect::<HashMap<_, _>>();
    let mut node_owner: Vec<Option<usize>> = vec![None; node_count];

    for part in &mesh.mesh_parts {
        if part.role != "magnetic_object" {
            continue;
        }
        let Some(owner_id) = part
            .object_id
            .as_ref()
            .or(part.geometry_id.as_ref())
            .map(String::as_str)
        else {
            continue;
        };
        let Some(owner_index) = object_index.get(owner_id).copied() else {
            continue;
        };
        if !part.node_indices.is_empty() {
            for &node in &part.node_indices {
                let node = node as usize;
                if node < node_count && node_owner[node].is_none() {
                    node_owner[node] = Some(owner_index);
                }
            }
        } else {
            let start = part.node_start as usize;
            let end = start
                .saturating_add(part.node_count as usize)
                .min(node_count);
            for slot in node_owner.iter_mut().take(end).skip(start) {
                if slot.is_none() {
                    *slot = Some(owner_index);
                }
            }
        }
    }

    for segment in &mesh.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        let Some(owner_index) = object_index.get(segment.object_id.as_str()).copied() else {
            continue;
        };
        let start = segment.node_start as usize;
        let end = start
            .saturating_add(segment.node_count as usize)
            .min(node_count);
        for slot in node_owner.iter_mut().take(end).skip(start) {
            if slot.is_none() {
                *slot = Some(owner_index);
            }
        }
    }

    let mut nodes_by_object = vec![Vec::<usize>::new(); scene.objects.len()];
    for (node_index, owner) in node_owner.iter().enumerate() {
        if let Some(owner) = owner {
            nodes_by_object[*owner].push(node_index);
        }
    }
    stats.magnetic_nodes = nodes_by_object.iter().map(Vec::len).sum();

    let magnetization_assets = scene
        .magnetization_assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect::<HashMap<_, _>>();

    for (object_index, node_indices) in nodes_by_object.iter().enumerate() {
        if node_indices.is_empty() {
            continue;
        }
        let object = &scene.objects[object_index];
        let Some(magnetization_ref) = object.magnetization_ref.as_deref() else {
            stats.skipped_objects += 1;
            continue;
        };
        let Some(asset) = magnetization_assets.get(magnetization_ref).copied() else {
            stats.skipped_objects += 1;
            stats.warnings.push(format!(
                "object '{}' references missing magnetization '{}'",
                object.id, magnetization_ref
            ));
            continue;
        };
        let rewritten = apply_live_scene_magnetization_asset(
            asset,
            object,
            node_indices,
            &mesh.nodes,
            &mut vectors,
            &mut stats,
        );
        if rewritten {
            stats.rewritten_objects += 1;
        } else {
            stats.skipped_objects += 1;
        }
    }

    let flat = flatten_vectors(&vectors);
    if let Some(live_state) = snapshot.live_state.as_mut() {
        live_state.latest_step.magnetization = Some(flat);
    }

    let latest_m = json!({
        "layout": { "grid_cells": [node_count, 1, 1] },
        "values": vectors,
    });
    match serde_json::from_value::<LatestFields>(json!({ "m": latest_m })) {
        Ok(update) => {
            merge_latest_fields(&mut snapshot.latest_fields, update);
        }
        Err(error) => {
            stats.warnings.push(format!(
                "failed to serialize live magnetization field: {}",
                error
            ));
        }
    }

    let field_location = if snapshot.fem_mesh.is_some() {
        "node"
    } else {
        "cell"
    };
    snapshot.quantities = build_quantities(
        &snapshot.latest_fields,
        &snapshot.preview_cache,
        snapshot.live_state.as_ref(),
        snapshot.run.as_ref(),
        snapshot.metadata.as_ref(),
        &snapshot.scalar_rows,
        field_location,
    );

    Some(stats)
}

fn apply_live_scene_magnetization_asset(
    asset: &MagnetizationAsset,
    object: &fullmag_authoring::SceneObject,
    node_indices: &[usize],
    world_nodes: &[[f64; 3]],
    vectors: &mut [[f64; 3]],
    stats: &mut LiveSceneMagnetizationRebuildStats,
) -> bool {
    match asset.kind.as_str() {
        "uniform" => {
            let value = parse_uniform_value(asset).unwrap_or([1.0, 0.0, 0.0]);
            for &node in node_indices {
                vectors[node] = value;
            }
            stats.rewritten_nodes += node_indices.len();
            true
        }
        "random" | "random_seeded" => {
            let seed = asset.seed.unwrap_or(1);
            let random = generate_random_unit_vectors(seed, node_indices.len());
            for (slot, value) in node_indices.iter().zip(random.iter()) {
                vectors[*slot] = *value;
            }
            stats.rewritten_nodes += node_indices.len();
            true
        }
        "preset_texture" => {
            let preset_kind = asset.preset_kind.as_deref().unwrap_or("uniform");
            let params = asset
                .preset_params
                .as_ref()
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            let mapping = TextureMappingIR {
                space: asset.mapping.space.clone(),
                projection: parse_texture_projection_mode(&asset.mapping.projection),
                clamp_mode: asset.mapping.clamp_mode.clone(),
            };
            let texture_transform = TextureTransform3DIR {
                translation: asset.texture_transform.translation,
                rotation_quat: asset.texture_transform.rotation_quat,
                scale: asset.texture_transform.scale,
                pivot: asset.texture_transform.pivot,
            };
            let sample_points = node_indices
                .iter()
                .map(|&node_index| {
                    let world = world_nodes[node_index];
                    TextureSamplePoint {
                        position_world: world,
                        position_object: apply_inverse_object_transform(world, &object.transform),
                        active: true,
                    }
                })
                .collect::<Vec<_>>();
            match sample_preset_texture(
                preset_kind,
                &params,
                &mapping,
                &texture_transform,
                &sample_points,
            ) {
                Ok(sampled) => {
                    for (slot, value) in node_indices.iter().zip(sampled.iter()) {
                        vectors[*slot] = *value;
                    }
                    stats.rewritten_nodes += node_indices.len();
                    true
                }
                Err(error) => {
                    stats.warnings.push(format!(
                        "preset_texture '{}' for object '{}' failed: {}",
                        preset_kind, object.id, error
                    ));
                    false
                }
            }
        }
        other => {
            stats.warnings.push(format!(
                "object '{}' magnetization kind '{}' is not remapped live",
                object.id, other
            ));
            false
        }
    }
}

fn parse_uniform_value(asset: &MagnetizationAsset) -> Option<[f64; 3]> {
    let value = asset.value.as_ref()?;
    if value.len() < 3 {
        return None;
    }
    Some([value[0], value[1], value[2]])
}

fn existing_live_magnetization_vectors(
    snapshot: &SessionStateResponse,
    node_count: usize,
) -> Option<Vec<[f64; 3]>> {
    if let Some(flat) = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
    {
        if flat.len() == node_count * 3 {
            return Some(
                flat.chunks_exact(3)
                    .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                    .collect(),
            );
        }
    }
    snapshot
        .latest_fields
        .get("m")
        .and_then(parse_field_value)
        .and_then(|(vectors, _)| (vectors.len() == node_count).then_some(vectors))
}

fn apply_inverse_object_transform(
    point_world: [f64; 3],
    transform: &fullmag_authoring::Transform3D,
) -> [f64; 3] {
    let mut p = [
        point_world[0] - transform.translation[0] - transform.pivot[0],
        point_world[1] - transform.translation[1] - transform.pivot[1],
        point_world[2] - transform.translation[2] - transform.pivot[2],
    ];
    let mut inv_quat = [
        -transform.rotation_quat[0],
        -transform.rotation_quat[1],
        -transform.rotation_quat[2],
        transform.rotation_quat[3],
    ];
    let qn = (inv_quat[0] * inv_quat[0]
        + inv_quat[1] * inv_quat[1]
        + inv_quat[2] * inv_quat[2]
        + inv_quat[3] * inv_quat[3])
        .sqrt();
    if qn > 1.0e-30 {
        inv_quat = [
            inv_quat[0] / qn,
            inv_quat[1] / qn,
            inv_quat[2] / qn,
            inv_quat[3] / qn,
        ];
    }
    p = rotate_point_by_quat(p, inv_quat);
    p = [
        p[0] + transform.pivot[0],
        p[1] + transform.pivot[1],
        p[2] + transform.pivot[2],
    ];
    [
        p[0] / safe_scale_component(transform.scale[0]),
        p[1] / safe_scale_component(transform.scale[1]),
        p[2] / safe_scale_component(transform.scale[2]),
    ]
}

fn rotate_point_by_quat(point: [f64; 3], quat: [f64; 4]) -> [f64; 3] {
    let qvec = [quat[0], quat[1], quat[2]];
    let t = [
        2.0 * (qvec[1] * point[2] - qvec[2] * point[1]),
        2.0 * (qvec[2] * point[0] - qvec[0] * point[2]),
        2.0 * (qvec[0] * point[1] - qvec[1] * point[0]),
    ];
    [
        point[0] + quat[3] * t[0] + (qvec[1] * t[2] - qvec[2] * t[1]),
        point[1] + quat[3] * t[1] + (qvec[2] * t[0] - qvec[0] * t[2]),
        point[2] + quat[3] * t[2] + (qvec[0] * t[1] - qvec[1] * t[0]),
    ]
}

fn safe_scale_component(value: f64) -> f64 {
    if value.abs() > 1.0e-30 {
        value
    } else {
        1.0
    }
}

fn scene_magnetization_summary(scene: &SceneDocument) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut interesting = Vec::new();
    for asset in &scene.magnetization_assets {
        *counts.entry(asset.kind.clone()).or_insert(0) += 1;
        if asset.kind == "preset_texture" || asset.kind == "random" || asset.kind == "uniform" {
            let preset_param_keys = asset
                .preset_params
                .as_ref()
                .and_then(|value| value.as_object())
                .map(|map| map.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            interesting.push(format!(
                "{}:{}:{}:{:?}",
                asset.id,
                asset.kind,
                asset
                    .preset_kind
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or("-"),
                preset_param_keys
            ));
        }
    }
    format!("counts={counts:?}; assets={interesting:?}")
}

fn linked_objects_for_magnetization_asset(scene: &SceneDocument, asset_id: &str) -> Vec<String> {
    scene
        .objects
        .iter()
        .filter(|object| object.magnetization_ref.as_deref() == Some(asset_id))
        .map(|object| object.name.clone())
        .collect()
}

fn fmt_vec3_nm(vec: [f64; 3]) -> String {
    format!(
        "[{:+.3}, {:+.3}, {:+.3}]nm",
        vec[0] * 1.0e9,
        vec[1] * 1.0e9,
        vec[2] * 1.0e9
    )
}

fn fmt_quat4(quat: [f64; 4]) -> String {
    format!(
        "[{:+.6}, {:+.6}, {:+.6}, {:+.6}]",
        quat[0], quat[1], quat[2], quat[3]
    )
}

fn vec3_delta(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
}

fn vec3_changed(a: [f64; 3], b: [f64; 3]) -> bool {
    const EPS: f64 = 1.0e-21;
    (a[0] - b[0]).abs() > EPS || (a[1] - b[1]).abs() > EPS || (a[2] - b[2]).abs() > EPS
}

fn quat_changed(a: [f64; 4], b: [f64; 4]) -> bool {
    const EPS: f64 = 1.0e-21;
    (a[0] - b[0]).abs() > EPS
        || (a[1] - b[1]).abs() > EPS
        || (a[2] - b[2]).abs() > EPS
        || (a[3] - b[3]).abs() > EPS
}
fn fmt_preset_params(params: Option<&Value>) -> String {
    let Some(params) = params else {
        return "<none>".to_string();
    };
    let Some(map) = params.as_object() else {
        return "<non-object>".to_string();
    };
    match serde_json::to_string(map) {
        Ok(raw) => {
            const MAX: usize = 220;
            if raw.len() <= MAX {
                raw
            } else {
                format!("{}…", &raw[..MAX])
            }
        }
        Err(_) => "<invalid-json>".to_string(),
    }
}

fn detect_preset_texture_changes(
    previous: Option<&SceneDocument>,
    next: &SceneDocument,
) -> Vec<String> {
    let mut out = Vec::new();
    let previous_assets: HashMap<&str, &MagnetizationAsset> = previous
        .map(|scene| {
            scene
                .magnetization_assets
                .iter()
                .map(|asset| (asset.id.as_str(), asset))
                .collect()
        })
        .unwrap_or_default();
    let next_assets: HashMap<&str, &MagnetizationAsset> = next
        .magnetization_assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();

    let mut asset_ids: Vec<&str> = previous_assets
        .keys()
        .copied()
        .chain(next_assets.keys().copied())
        .collect();
    asset_ids.sort_unstable();
    asset_ids.dedup();

    for asset_id in asset_ids {
        let prev_asset = previous_assets.get(asset_id).copied();
        let next_asset = next_assets.get(asset_id).copied();
        match (prev_asset, next_asset) {
            (None, Some(next_asset)) => {
                if next_asset.kind != "preset_texture" {
                    continue;
                }
                let objects = linked_objects_for_magnetization_asset(next, asset_id);
                out.push(format!(
                    "ASSIGN objects={:?} asset={} preset={} mapping=({}/{}/{}) T={} S={} R={}",
                    objects,
                    next_asset.id,
                    next_asset.preset_kind.as_deref().unwrap_or("<none>"),
                    next_asset.mapping.space,
                    next_asset.mapping.projection,
                    next_asset.mapping.clamp_mode,
                    fmt_vec3_nm(next_asset.texture_transform.translation),
                    fmt_vec3_nm(next_asset.texture_transform.scale),
                    fmt_quat4(next_asset.texture_transform.rotation_quat),
                ));
            }
            (Some(prev_asset), Some(next_asset)) => {
                if prev_asset.kind != "preset_texture" && next_asset.kind != "preset_texture" {
                    continue;
                }
                let objects = linked_objects_for_magnetization_asset(next, asset_id);
                if prev_asset.kind != "preset_texture" && next_asset.kind == "preset_texture" {
                    out.push(format!(
                        "KIND_SWITCH objects={:?} asset={} {} -> preset_texture({})",
                        objects,
                        next_asset.id,
                        prev_asset.kind,
                        next_asset.preset_kind.as_deref().unwrap_or("<none>"),
                    ));
                    continue;
                }
                if prev_asset.kind == "preset_texture" && next_asset.kind != "preset_texture" {
                    out.push(format!(
                        "KIND_SWITCH objects={:?} asset={} preset_texture -> {}",
                        objects, next_asset.id, next_asset.kind
                    ));
                    continue;
                }
                let mut changes = Vec::new();
                if prev_asset.preset_kind != next_asset.preset_kind {
                    changes.push(format!(
                        "preset={} -> {}",
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>"),
                        next_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                }
                if prev_asset.preset_params != next_asset.preset_params {
                    changes.push(format!(
                        "preset_params {} -> {}",
                        fmt_preset_params(prev_asset.preset_params.as_ref()),
                        fmt_preset_params(next_asset.preset_params.as_ref()),
                    ));
                }
                if prev_asset.mapping != next_asset.mapping {
                    changes.push(format!(
                        "mapping=({}/{}/{}) -> ({}/{}/{})",
                        prev_asset.mapping.space,
                        prev_asset.mapping.projection,
                        prev_asset.mapping.clamp_mode,
                        next_asset.mapping.space,
                        next_asset.mapping.projection,
                        next_asset.mapping.clamp_mode
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.translation,
                    next_asset.texture_transform.translation,
                ) {
                    let delta = vec3_delta(
                        prev_asset.texture_transform.translation,
                        next_asset.texture_transform.translation,
                    );
                    changes.push(format!(
                        "translate Δ={} -> {}",
                        fmt_vec3_nm(delta),
                        fmt_vec3_nm(next_asset.texture_transform.translation),
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.scale,
                    next_asset.texture_transform.scale,
                ) {
                    changes.push(format!(
                        "scale {} -> {}",
                        fmt_vec3_nm(prev_asset.texture_transform.scale),
                        fmt_vec3_nm(next_asset.texture_transform.scale),
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.pivot,
                    next_asset.texture_transform.pivot,
                ) {
                    changes.push(format!(
                        "pivot {} -> {}",
                        fmt_vec3_nm(prev_asset.texture_transform.pivot),
                        fmt_vec3_nm(next_asset.texture_transform.pivot),
                    ));
                }
                if quat_changed(
                    prev_asset.texture_transform.rotation_quat,
                    next_asset.texture_transform.rotation_quat,
                ) {
                    changes.push(format!(
                        "rotation {} -> {}",
                        fmt_quat4(prev_asset.texture_transform.rotation_quat),
                        fmt_quat4(next_asset.texture_transform.rotation_quat),
                    ));
                }

                if !changes.is_empty() {
                    out.push(format!(
                        "UPDATE objects={:?} asset={} {}",
                        objects,
                        next_asset.id,
                        changes.join(" | "),
                    ));
                }
            }
            (Some(prev_asset), None) => {
                if prev_asset.kind != "preset_texture" {
                    continue;
                }
                if let Some(previous_scene) = previous {
                    let objects = linked_objects_for_magnetization_asset(previous_scene, asset_id);
                    out.push(format!(
                        "REMOVE objects={:?} asset={} preset={}",
                        objects,
                        prev_asset.id,
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                } else {
                    out.push(format!(
                        "REMOVE objects=[] asset={} preset={}",
                        prev_asset.id,
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                }
            }
            (None, None) => {}
        }
    }
    out
}

async fn list_physics_docs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let physics_dir = state.repo_root.join("docs/physics");
    let mut docs = Vec::new();
    for entry in std::fs::read_dir(&physics_dir)
        .map_err(|_| ApiError::not_found(format!("missing {}", physics_dir.display())))?
    {
        let entry = entry.map_err(ApiError::from)?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            docs.push(
                path.strip_prefix(&state.repo_root)
                    .unwrap_or(&path)
                    .display()
                    .to_string(),
            );
        }
    }
    docs.sort();
    Ok(Json(docs))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewControlMode {
    Update,
    Refresh,
}

async fn mutate_current_preview<F>(
    state: &Arc<AppState>,
    control_mode: PreviewControlMode,
    caller: &str,
    mutate: F,
) -> Result<Json<serde_json::Value>, ApiError>
where
    F: FnOnce(&mut DisplaySelection),
{
    eprintln!("[fullmag-api] mutate_current_preview caller={}", caller);
    let display_selection = {
        let mut current = state.current_display_selection.write().await;
        mutate(&mut current.selection);
        canonicalize_display_selection(&mut current.selection)?;
        current.revision = current.revision.saturating_add(1);
        current.clone()
    };
    let preview_config = display_selection.preview_request();

    let (session_id, session_state_messages, public_json) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let previous_preview = snapshot.preview.clone();
        snapshot.display_selection = display_selection.clone();
        snapshot.preview_config = preview_config.clone();
        snapshot.preview =
            build_preview_state(snapshot, &snapshot.display_selection, &preview_config)
                .or(previous_preview);
        let public_json = serialize_current_live_response(snapshot, true, false, false)?;
        (
            snapshot.session.session_id.clone(),
            build_current_live_ws_messages(&state, snapshot)?,
            public_json,
        )
    };
    *state.current_live_public_snapshot.write().await = Some(public_json);

    let command = enqueue_current_control_command(
        state,
        build_preview_control_command(
            &display_selection,
            matches!(control_mode, PreviewControlMode::Refresh),
        ),
    )
    .await;
    let ack_json = serialize_runtime_event(&build_command_ack_event(&session_id, &command))?;
    let _ = state
        .current_live_events
        .send(CurrentLiveWireMessage::Text(ack_json));
    send_current_live_ws_messages(&state, session_state_messages);
    Ok(Json(
        serde_json::json!({ "status": "ok", "control_seq": command.seq }),
    ))
}

const CURRENT_LIVE_VECTOR_FRAME_MAGIC: [u8; 4] = *b"FMVP";
const CURRENT_LIVE_VECTOR_FRAME_VERSION: u8 = 1;
const CURRENT_LIVE_VECTOR_FRAME_KIND_F64: u8 = 1;
const CURRENT_LIVE_VECTOR_FRAME_HEADER_LEN: usize = 16;

/// V2 binary frame header length.
///
/// Layout (48 bytes):
///   [0..4)   magic "FMVP"
///   [4]      version = 2
///   [5]      kind = 1 (f64)
///   [6]      n_comp (u8)
///   [7]      reserved (0)
///   [8..12)  payload_id (u32 LE)
///   [12..16) element_count (u32 LE)
///   [16..20) grid_x (u32 LE)
///   [20..24) grid_y (u32 LE)
///   [24..28) grid_z (u32 LE)
///   [28..44) quantity_id (16 bytes, null-padded UTF-8)
///   [44..48) reserved (0)
///   [48..)   f64 values
const CURRENT_LIVE_VECTOR_FRAME_V2_HEADER_LEN: usize = 48;
const CURRENT_LIVE_VECTOR_FRAME_V2_VERSION: u8 = 2;
const CURRENT_LIVE_VECTOR_FRAME_QUANTITY_ID_LEN: usize = 16;

fn next_current_live_vector_payload_id(state: &AppState) -> u32 {
    state
        .current_live_vector_payload_seq
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1)
}

fn preview_vector_values(preview: Option<&PreviewState>) -> Option<&[f64]> {
    match preview {
        Some(PreviewState::Spatial(state)) => state.vector_field_values.as_deref(),
        _ => None,
    }
}

fn average_vector_components(values: &[f64], n_comp: usize) -> Option<[f64; 3]> {
    if values.is_empty() || n_comp == 0 || values.len() < n_comp {
        return None;
    }
    let vector_count = values.len() / n_comp;
    if vector_count == 0 {
        return None;
    }
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_z = 0.0;
    for chunk in values.chunks_exact(n_comp) {
        sum_x += chunk[0];
        if n_comp > 1 {
            sum_y += chunk[1];
        }
        if n_comp > 2 {
            sum_z += chunk[2];
        }
    }
    Some([
        sum_x / vector_count as f64,
        sum_y / vector_count as f64,
        sum_z / vector_count as f64,
    ])
}

fn format_debug_vector_average(mean: Option<[f64; 3]>) -> String {
    match mean {
        Some([mx, my, mz]) => format!("[{mx:.6e}, {my:.6e}, {mz:.6e}]"),
        None => "-".to_string(),
    }
}

fn preview_debug_metrics(preview: Option<&PreviewState>) -> (u64, usize, Option<[f64; 3]>) {
    match preview {
        Some(PreviewState::Spatial(state)) => (
            state.source_step,
            state
                .vector_field_values
                .as_ref()
                .map(|values| values.len())
                .unwrap_or(0),
            state
                .vector_field_values
                .as_ref()
                .and_then(|values| average_vector_components(values, state.n_comp)),
        ),
        Some(PreviewState::GlobalScalar(state)) => (state.source_step, 0, None),
        None => (0, 0, None),
    }
}

fn ws_preview_state(
    preview: Option<&PreviewState>,
    vector_payload_id: Option<u32>,
) -> Option<PreviewState> {
    match preview {
        Some(PreviewState::Spatial(state)) => {
            let mut cloned = state.clone();
            if vector_payload_id.is_some() {
                cloned.vector_payload_id = vector_payload_id;
                cloned.vector_field_values = None;
            }
            // Strip `fem_mesh` from WS preview — the frontend must use the
            // top-level `fem_mesh` field.  Sending it twice was a major
            // bandwidth and memory waste.
            cloned.fem_mesh = None;
            Some(PreviewState::Spatial(cloned))
        }
        Some(PreviewState::GlobalScalar(state)) => Some(PreviewState::GlobalScalar(state.clone())),
        None => None,
    }
}

#[allow(dead_code)]
fn serialize_current_live_vector_binary(payload_id: u32, values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CURRENT_LIVE_VECTOR_FRAME_HEADER_LEN + values.len() * 8);
    out.extend_from_slice(&CURRENT_LIVE_VECTOR_FRAME_MAGIC);
    out.push(CURRENT_LIVE_VECTOR_FRAME_VERSION);
    out.push(CURRENT_LIVE_VECTOR_FRAME_KIND_F64);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&payload_id.to_le_bytes());
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Serialize a quantity frame to the V2 binary format (FMVP version 2).
///
/// Includes quantity_id, n_comp, and grid dimensions in the header so
/// that the frontend can identify and reconstruct spatial fields without
/// relying on a paired JSON message.
fn serialize_current_live_vector_binary_v2(
    payload_id: u32,
    quantity_id: &str,
    n_comp: u8,
    grid: [u32; 3],
    values: &[f64],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(CURRENT_LIVE_VECTOR_FRAME_V2_HEADER_LEN + values.len() * 8);
    out.extend_from_slice(&CURRENT_LIVE_VECTOR_FRAME_MAGIC);
    out.push(CURRENT_LIVE_VECTOR_FRAME_V2_VERSION);
    out.push(CURRENT_LIVE_VECTOR_FRAME_KIND_F64);
    out.push(n_comp);
    out.push(0u8); // reserved
    out.extend_from_slice(&payload_id.to_le_bytes());
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    out.extend_from_slice(&grid[0].to_le_bytes());
    out.extend_from_slice(&grid[1].to_le_bytes());
    out.extend_from_slice(&grid[2].to_le_bytes());
    // quantity_id: 16 bytes, null-padded
    let id_bytes = quantity_id.as_bytes();
    let copy_len = id_bytes
        .len()
        .min(CURRENT_LIVE_VECTOR_FRAME_QUANTITY_ID_LEN);
    out.extend_from_slice(&id_bytes[..copy_len]);
    for _ in copy_len..CURRENT_LIVE_VECTOR_FRAME_QUANTITY_ID_LEN {
        out.push(0u8);
    }
    out.extend_from_slice(&[0u8; 4]); // reserved
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Compute a cheap fingerprint for a slice of QuantityDescriptors so we
/// can skip re-broadcasting quantities when they haven't changed.
fn quantities_hash(quantities: &[crate::types::QuantityDescriptor]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    quantities.len().hash(&mut h);
    for q in quantities {
        q.id.hash(&mut h);
        q.available.hash(&mut h);
    }
    h.finish()
}

pub(crate) fn build_current_live_ws_messages(
    state: &AppState,
    snapshot: &SessionStateResponse,
) -> Result<Vec<CurrentLiveWireMessage>, ApiError> {
    // Non-delta path: send full scalar history and always include quantities.
    // Used for initial WS handshake and infrequent mutation endpoints.
    // All sparse flags are true → send everything (including envelope).
    build_current_live_ws_messages_delta(state, snapshot, 0, true, true, true, true, true)
}

/// Build WS messages using a delta slice of scalar_rows.
///
/// `scalar_rows_delta_start` — index from which to slice `scalar_rows` for the WS
/// event (0 = send full history).  `quantities_changed` controls whether
/// quantities are included in the event (omit when unchanged to save bandwidth).
///
/// The `fem_mesh_changed`, `preview_changed`, and `latest_fields_changed` flags
/// control whether the corresponding heavy payloads are included.  When `false`,
/// the field is omitted from the JSON (sparse delta) and the frontend preserves
/// the previously-received value.
fn build_current_live_ws_messages_delta(
    state: &AppState,
    snapshot: &SessionStateResponse,
    scalar_rows_delta_start: usize,
    quantities_changed: bool,
    fem_mesh_changed: bool,
    preview_changed: bool,
    latest_fields_changed: bool,
    envelope_changed: bool,
) -> Result<Vec<CurrentLiveWireMessage>, ApiError> {
    let flags = &state.feature_flags;

    // Only generate a binary vector payload when the preview fingerprint changed
    // AND 3D preview is not disabled.
    let vector_payload_id = if preview_changed && !flags.disable_preview_3d {
        preview_vector_values(snapshot.preview.as_ref())
            .map(|_| next_current_live_vector_payload_id(state))
    } else {
        None
    };
    let mut messages = Vec::new();
    if !flags.disable_preview_3d {
        if let (Some(payload_id), Some(values)) = (
            vector_payload_id,
            preview_vector_values(snapshot.preview.as_ref()),
        ) {
            // Extract V2 metadata from spatial preview if available
            let v2_meta = match snapshot.preview.as_ref() {
                Some(PreviewState::Spatial(sp)) => Some((
                    &sp.quantity,
                    sp.n_comp as u8,
                    [
                        sp.preview_grid[0] as u32,
                        sp.preview_grid[1] as u32,
                        sp.preview_grid[2] as u32,
                    ],
                )),
                _ => None,
            };
            let binary = if let Some((quantity_id, n_comp, grid)) = v2_meta {
                serialize_current_live_vector_binary_v2(
                    payload_id,
                    quantity_id,
                    n_comp,
                    grid,
                    values,
                )
            } else {
                serialize_current_live_vector_binary(payload_id, values)
            };
            messages.push(CurrentLiveWireMessage::Binary(binary));
        }
    }
    if !flags.disable_charts {
        messages.push(CurrentLiveWireMessage::Text(
            serialize_current_live_chart_event(snapshot, scalar_rows_delta_start)?,
        ));
    }
    if !flags.disable_session_state_broadcast {
        messages.push(CurrentLiveWireMessage::Text(
            serialize_current_live_session_event(
                snapshot,
                vector_payload_id,
                scalar_rows_delta_start,
                quantities_changed,
                fem_mesh_changed,
                preview_changed && !flags.disable_preview_3d,
                latest_fields_changed,
                envelope_changed,
            )?,
        ));
    }
    Ok(messages)
}

fn serialize_current_live_chart_event(
    snapshot: &SessionStateResponse,
    scalar_rows_delta_start: usize,
) -> Result<String, ApiError> {
    let delta_start = scalar_rows_delta_start.min(snapshot.scalar_rows.len());
    let scalar_rows_delta = &snapshot.scalar_rows[delta_start..];
    serde_json::to_string(&CurrentLiveEvent::ChartState {
        state: ChartStateEventView {
            scalar_rows: scalar_rows_delta,
            scalar_rows_total: snapshot.scalar_rows.len(),
        },
    })
    .map_err(|error| ApiError::internal(format!("failed to serialize chart state: {}", error)))
}

fn send_current_live_ws_messages(state: &AppState, messages: Vec<CurrentLiveWireMessage>) {
    let mut total_text_bytes: usize = 0;
    let mut total_binary_bytes: usize = 0;
    for message in &messages {
        match message {
            CurrentLiveWireMessage::Text(t) => total_text_bytes += t.len(),
            CurrentLiveWireMessage::Binary(b) => total_binary_bytes += b.len(),
        }
    }
    if total_text_bytes + total_binary_bytes > 512 * 1024 {
        eprintln!(
            "[fullmag-api] PERF: WS broadcast payload {:.1}KB text + {:.1}KB binary",
            total_text_bytes as f64 / 1024.0,
            total_binary_bytes as f64 / 1024.0,
        );
    }
    for message in messages {
        let _ = state.current_live_events.send(message);
    }
}

fn serialize_current_live_session_event(
    snapshot: &SessionStateResponse,
    vector_payload_id: Option<u32>,
    scalar_rows_delta_start: usize,
    quantities_changed: bool,
    fem_mesh_changed: bool,
    preview_changed: bool,
    latest_fields_changed: bool,
    envelope_changed: bool,
) -> Result<String, ApiError> {
    let step_update_v2 = snapshot.build_step_update_v2();
    let _ = scalar_rows_delta_start;

    // Sparse: only include preview with binary reference when it actually changed.
    let preview = if preview_changed {
        ws_preview_state(snapshot.preview.as_ref(), vector_payload_id)
    } else {
        None
    };

    // Envelope fields: only include when their version changed.
    // On a typical per-step publish, none of these change — skipping them
    // reduces the session_state message from ~1.5 MB to ~2 KB.
    let (
        session,
        run,
        capabilities,
        metadata,
        mesh_workspace,
        stage_execution,
        scene_document,
        engine_log,
        artifacts,
        display_selection,
        preview_config,
    ) = if envelope_changed {
        (
            Some(&snapshot.session),
            snapshot.run.as_ref(),
            snapshot.capabilities.as_ref(),
            snapshot.metadata.as_ref(),
            snapshot.mesh_workspace.as_ref(),
            snapshot.stage_execution.as_ref(),
            snapshot.scene_document.as_ref(),
            Some(snapshot.engine_log.as_slice()),
            Some(snapshot.artifacts.as_slice()),
            Some(&snapshot.display_selection),
            Some(&snapshot.preview_config),
        )
    } else {
        (
            None, None, None, None, None, None, None, None, None, None, None,
        )
    };

    serde_json::to_string(&CurrentLiveEvent::SessionState {
        state: SessionStateEventView {
            session_protocol_version: &snapshot.session_protocol_version,
            capability_profile_version: &snapshot.capability_profile_version,
            session,
            run,
            live_state: snapshot.live_state.as_ref(),
            runtime_status: &snapshot.runtime_status,
            capabilities,
            metadata,
            mesh_workspace,
            stage_execution,
            scene_document,
            scalar_rows: &[],
            scalar_rows_total: snapshot.scalar_rows.len(),
            engine_log,
            quantities: quantities_changed.then_some(snapshot.quantities.as_slice()),
            fem_mesh: if fem_mesh_changed {
                snapshot.fem_mesh.as_ref()
            } else {
                None
            },
            latest_fields: if latest_fields_changed {
                Some(&snapshot.latest_fields)
            } else {
                None
            },
            artifacts,
            display_selection,
            preview_config,
            preview,
            step_update_v2,
            state_version: snapshot.state_version,
        },
    })
    .map_err(|error| ApiError::internal(format!("failed to serialize current state: {}", error)))
}

pub(crate) fn serialize_current_live_response(
    snapshot: &SessionStateResponse,
    include_preview: bool,
    binary_field_transport: bool,
    binary_mesh_transport: bool,
) -> Result<String, ApiError> {
    let step_update_v2 = snapshot.build_step_update_v2();
    serde_json::to_string(&SessionStateResponseWire {
        session: &snapshot.session,
        run: snapshot.run.as_ref(),
        live_state: live_state_wire_value(
            snapshot.live_state.as_ref(),
            binary_field_transport,
            binary_mesh_transport,
        )?,
        runtime_status: &snapshot.runtime_status,
        metadata: snapshot.metadata.as_ref(),
        mesh_workspace: snapshot.mesh_workspace.as_ref(),
        stage_execution: snapshot.stage_execution.as_ref(),
        scene_document: snapshot.scene_document.as_ref(),
        scalar_rows: &snapshot.scalar_rows,
        scalar_rows_total: snapshot.scalar_rows.len(),
        engine_log: &snapshot.engine_log,
        quantities: &snapshot.quantities,
        fem_mesh: fem_mesh_wire_value(snapshot.fem_mesh.as_ref(), binary_mesh_transport)?,
        latest_fields: latest_fields_wire_value(snapshot, binary_field_transport)?,
        artifacts: &snapshot.artifacts,
        display_selection: &snapshot.display_selection,
        preview_config: &snapshot.preview_config,
        preview: if include_preview {
            preview_wire_value(snapshot.preview.as_ref(), binary_field_transport)?
        } else {
            None
        },
        step_update_v2: step_update_v2_wire_value(step_update_v2, binary_field_transport)?,
        state_version: snapshot.state_version,
    })
    .map_err(|error| ApiError::internal(format!("failed to serialize current state: {}", error)))
}

fn serialize_current_live_poll_response(
    snapshot: &SessionStateResponse,
    scalar_rows_delta_start: usize,
    binary_field_transport: bool,
    binary_mesh_transport: bool,
) -> Result<String, ApiError> {
    let step_update_v2 = snapshot.build_step_update_v2();
    let delta_start = scalar_rows_delta_start.min(snapshot.scalar_rows.len());
    serde_json::to_string(&SessionStateResponseWire {
        session: &snapshot.session,
        run: snapshot.run.as_ref(),
        live_state: live_state_wire_value(
            snapshot.live_state.as_ref(),
            binary_field_transport,
            binary_mesh_transport,
        )?,
        runtime_status: &snapshot.runtime_status,
        metadata: snapshot.metadata.as_ref(),
        mesh_workspace: snapshot.mesh_workspace.as_ref(),
        stage_execution: snapshot.stage_execution.as_ref(),
        scene_document: snapshot.scene_document.as_ref(),
        scalar_rows: &snapshot.scalar_rows[delta_start..],
        scalar_rows_total: snapshot.scalar_rows.len(),
        engine_log: &snapshot.engine_log,
        quantities: &snapshot.quantities,
        fem_mesh: fem_mesh_wire_value(snapshot.fem_mesh.as_ref(), binary_mesh_transport)?,
        latest_fields: latest_fields_wire_value(snapshot, binary_field_transport)?,
        artifacts: &snapshot.artifacts,
        display_selection: &snapshot.display_selection,
        preview_config: &snapshot.preview_config,
        preview: preview_wire_value(snapshot.preview.as_ref(), binary_field_transport)?,
        step_update_v2: step_update_v2_wire_value(step_update_v2, binary_field_transport)?,
        state_version: snapshot.state_version,
    })
    .map_err(|error| ApiError::internal(format!("failed to serialize poll state: {}", error)))
}

/// Read from AppState's live state (read lock) and serialize the full public
/// snapshot.  Used for lazy memoization instead of serializing inline during
/// publish while holding the write lock.
#[allow(dead_code)]
async fn serialize_current_live_response_from_state(state: &AppState) -> Result<String, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::internal("no live state to serialize".to_string()))?;
    serialize_current_live_response(snapshot, true, false, false)
}

fn serialize_runtime_event(event: &RuntimeEventEnvelope) -> Result<String, ApiError> {
    serde_json::to_string(event).map_err(|error| {
        ApiError::internal(format!("failed to serialize runtime event: {}", error))
    })
}

fn build_command_ack_event(session_id: &str, command: &SessionCommand) -> RuntimeEventEnvelope {
    RuntimeEventEnvelope::CommandAck(CommandAckEvent {
        session_id: session_id.to_string(),
        seq: command.seq,
        command_id: command.command_id.clone(),
        command_kind: command.kind.clone(),
        issued_at_unix_ms: command.created_at_unix_ms,
        mesh_target: command.mesh_target.as_ref().map(mesh_command_target_event),
        mesh_reason: command.mesh_reason.clone(),
        display_selection: command.display_selection.clone(),
    })
}

fn mesh_command_target_event(target: &MeshCommandTarget) -> MeshCommandTargetEvent {
    match target {
        MeshCommandTarget::StudyDomain => MeshCommandTargetEvent::StudyDomain,
        MeshCommandTarget::AdaptiveFollowup => MeshCommandTargetEvent::AdaptiveFollowup,
        MeshCommandTarget::Airbox => MeshCommandTargetEvent::Airbox,
        MeshCommandTarget::ObjectMesh { object_id } => MeshCommandTargetEvent::ObjectMesh {
            object_id: object_id.clone(),
        },
    }
}

fn live_state_has_fresh_preview(live_state: Option<&LiveState>) -> bool {
    live_state
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .is_some()
}

fn build_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
) -> Option<PreviewState> {
    match display_selection.selection.kind {
        fullmag_runner::DisplayKind::GlobalScalar => {
            build_global_scalar_preview_state(current, display_selection)
        }
        fullmag_runner::DisplayKind::VectorField | fullmag_runner::DisplayKind::SpatialScalar => {
            build_spatial_preview_state(current, display_selection, config)
        }
    }
}

fn build_spatial_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
) -> Option<PreviewState> {
    let selection = &display_selection.selection;
    let quantity = resolve_preview_quantity(current, &selection.quantity)?;
    let component = normalize_preview_component(&selection.component);
    let (source_step, source_time) = current_preview_source(current);

    if let Some(field) = current
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .filter(|field| field.config_revision == config.revision && field.quantity == quantity)
    {
        return build_preview_state_from_live_field(
            current,
            field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    if let Some(mut field) = current
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .filter(|field| field.quantity == quantity)
        .cloned()
    {
        field.config_revision = config.revision;
        return build_preview_state_from_live_field(
            current,
            &field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    if let Some(mut field) = cached_preview_field_owned(current, &quantity) {
        field.config_revision = config.revision;
        return build_preview_state_from_live_field(
            current,
            &field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    let unit = quantity_unit(&quantity).to_string();
    let display_kind = display_kind_for_quantity(&quantity).to_string();
    let quantity_domain = crate::preview::quantity_spatial_domain(&quantity).to_string();

    if let Some(mesh) = current.fem_mesh.as_ref() {
        let vectors = current_vector_field(current, &quantity)?.0;
        if vectors.len() != mesh.nodes.len() {
            return None;
        }
        let (min, max) = component_min_max(&vectors, component);
        let active_mask = crate::preview::mesh_preview_active_mask(mesh, &quantity);
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: config.revision,
            source_step,
            source_time,
            spatial_kind: "mesh".to_string(),
            quantity,
            unit,
            quantity_domain,
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
            vector_payload_id: None,
            vector_field_values: Some(flatten_vectors(&vectors)),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: Vec::new(),
            y_possible_sizes: Vec::new(),
            x_chosen_size: 0,
            y_chosen_size: 0,
            applied_x_chosen_size: 0,
            applied_y_chosen_size: 0,
            applied_layer_stride: 1,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: false,
            auto_downscale_message: None,
            preview_grid: [vectors.len(), 1, 1],
            fem_mesh: Some(mesh.clone()),
            original_node_count: Some(mesh.nodes.len()),
            original_face_count: Some(mesh.boundary_faces.len()),
            active_mask,
        }));
    }

    let (vectors, grid) = current_vector_field(current, &quantity)?;
    if vectors.is_empty() {
        return None;
    }
    let [full_x, full_y, full_z] = grid;
    if full_x == 0 || full_y == 0 || full_z == 0 || vectors.len() != full_x * full_y * full_z {
        return None;
    }

    let x_possible_sizes = candidate_preview_sizes(full_x);
    let y_possible_sizes = candidate_preview_sizes(full_y);
    let requested_x = choose_preview_size(config.x_chosen_size as usize, &x_possible_sizes, full_x);
    let requested_y = choose_preview_size(config.y_chosen_size as usize, &y_possible_sizes, full_y);

    if component == "3D" {
        let (applied_x, applied_y, stride, auto_downscaled) = if config.auto_scale_enabled {
            fit_preview_grid_3d(requested_x, requested_y, full_z, config.max_points as usize)
        } else {
            (requested_x, requested_y, 1, false)
        };
        let preview_z = full_z.div_ceil(stride).max(1);

        let vectors = resample_grid_vectors_3d(
            &vectors,
            [full_x, full_y, full_z],
            [applied_x, applied_y, preview_z],
            stride,
        );
        let (min, max) = component_min_max(&vectors, component);
        let auto_downscale_message = auto_downscaled.then(|| {
            format!(
                "Preview auto-fit from {}x{}x{} to {}x{}x{} within {} points",
                full_x, full_y, full_z, applied_x, applied_y, preview_z, config.max_points
            )
        });
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: config.revision,
            source_step,
            source_time,
            spatial_kind: "grid".to_string(),
            quantity,
            unit,
            quantity_domain,
            component: component.to_string(),
            layer: (config.layer as usize).min(full_z.saturating_sub(1)),
            all_layers: config.all_layers,
            view_type: "3D".to_string(),
            vector_payload_id: None,
            vector_field_values: Some(flatten_vectors(&vectors)),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: x_possible_sizes.clone(),
            y_possible_sizes: y_possible_sizes.clone(),
            x_chosen_size: requested_x,
            y_chosen_size: requested_y,
            applied_x_chosen_size: applied_x,
            applied_y_chosen_size: applied_y,
            applied_layer_stride: stride,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled,
            auto_downscale_message,
            preview_grid: [applied_x, applied_y, preview_z],
            fem_mesh: None,
            original_node_count: None,
            original_face_count: None,
            active_mask: None,
        }));
    }

    let layer = (config.layer as usize).min(full_z.saturating_sub(1));
    let effective_layers = if config.all_layers { full_z } else { 1 };
    let (applied_x, applied_y, auto_downscaled) = if config.auto_scale_enabled {
        fit_preview_grid_2d(
            requested_x,
            requested_y,
            effective_layers,
            config.max_points as usize,
        )
    } else {
        (requested_x, requested_y, false)
    };
    let scalar_field = resample_grid_scalar_2d(
        &vectors,
        [full_x, full_y, full_z],
        [applied_x, applied_y],
        component,
        layer,
        config.all_layers,
    );
    let (min, max) = scalar_min_max(&scalar_field);
    let auto_downscale_message = auto_downscaled.then(|| {
        format!(
            "Preview auto-fit from {}x{} to {}x{} within {} points",
            full_x, full_y, applied_x, applied_y, config.max_points
        )
    });
    Some(PreviewState::Spatial(SpatialPreviewState {
        display_kind,
        config_revision: config.revision,
        source_step,
        source_time,
        spatial_kind: "grid".to_string(),
        quantity,
        unit,
        quantity_domain,
        component: component.to_string(),
        layer,
        all_layers: config.all_layers,
        view_type: "2D".to_string(),
        vector_payload_id: None,
        vector_field_values: None,
        scalar_field,
        min,
        max,
        n_comp: 1,
        max_points: config.max_points as usize,
        data_points_count: applied_x * applied_y,
        x_possible_sizes,
        y_possible_sizes,
        x_chosen_size: requested_x,
        y_chosen_size: requested_y,
        applied_x_chosen_size: applied_x,
        applied_y_chosen_size: applied_y,
        applied_layer_stride: 1,
        auto_scale_enabled: config.auto_scale_enabled,
        auto_downscaled,
        auto_downscale_message,
        preview_grid: [applied_x, applied_y, 1],
        fem_mesh: None,
        original_node_count: None,
        original_face_count: None,
        active_mask: None,
    }))
}

fn build_global_scalar_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
) -> Option<PreviewState> {
    let quantity = resolve_global_scalar_quantity(current, &display_selection.selection.quantity)?;
    let value = current_global_scalar_value(current, &quantity)?;
    let (source_step, source_time) = current_preview_source(current);
    Some(PreviewState::GlobalScalar(GlobalScalarPreviewState {
        display_kind: display_kind_for_quantity(&quantity).to_string(),
        config_revision: display_selection.revision,
        source_step,
        source_time,
        quantity: quantity.clone(),
        unit: quantity_unit(&quantity).to_string(),
        value,
    }))
}

fn build_preview_state_from_live_field(
    current: &SessionStateResponse,
    field: &LivePreviewField,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
    component: &str,
    source_step: u64,
    source_time: f64,
) -> Option<PreviewState> {
    let preview_grid = [
        field.preview_grid[0] as usize,
        field.preview_grid[1] as usize,
        field.preview_grid[2] as usize,
    ];
    let original_grid = [
        field.original_grid[0] as usize,
        field.original_grid[1] as usize,
        field.original_grid[2] as usize,
    ];
    let vectors = field
        .vector_field_values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect::<Vec<_>>();
    let display_kind = display_kind_for_quantity(&field.quantity).to_string();

    if field.spatial_kind == "mesh" {
        let mesh = current
            .fem_mesh
            .as_ref()
            .or_else(|| {
                current
                    .live_state
                    .as_ref()
                    .and_then(|state| state.latest_step.fem_mesh.as_ref())
            })?
            .clone();
        let (min, max) = component_min_max(&vectors, component);
        let active_mask = field
            .active_mask
            .clone()
            .or_else(|| crate::preview::mesh_preview_active_mask(&mesh, &field.quantity));
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: field.config_revision,
            source_step,
            source_time,
            spatial_kind: "mesh".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            quantity_domain: field.quantity_domain.clone(),
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
            vector_payload_id: None,
            vector_field_values: Some(field.vector_field_values.clone()),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: Vec::new(),
            y_possible_sizes: Vec::new(),
            x_chosen_size: field.x_chosen_size as usize,
            y_chosen_size: field.y_chosen_size as usize,
            applied_x_chosen_size: field.applied_x_chosen_size as usize,
            applied_y_chosen_size: field.applied_y_chosen_size as usize,
            applied_layer_stride: field.applied_layer_stride as usize,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
            preview_grid,
            fem_mesh: Some(mesh.clone()),
            original_node_count: Some(mesh.nodes.len()),
            original_face_count: Some(mesh.boundary_faces.len()),
            active_mask,
        }));
    }

    let x_possible_sizes = if original_grid[0] > 0 {
        candidate_preview_sizes(original_grid[0])
    } else {
        Vec::new()
    };
    let y_possible_sizes = if original_grid[1] > 0 {
        candidate_preview_sizes(original_grid[1])
    } else {
        Vec::new()
    };

    if component == "3D" {
        let (min, max) = component_min_max(&vectors, component);
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: field.config_revision,
            source_step,
            source_time,
            spatial_kind: "grid".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            quantity_domain: field.quantity_domain.clone(),
            component: component.to_string(),
            layer: display_selection
                .selection
                .layer
                .min(field.original_grid[2].saturating_sub(1)) as usize,
            all_layers: display_selection.selection.all_layers,
            view_type: "3D".to_string(),
            vector_payload_id: None,
            vector_field_values: Some(field.vector_field_values.clone()),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes,
            y_possible_sizes,
            x_chosen_size: field.x_chosen_size as usize,
            y_chosen_size: field.y_chosen_size as usize,
            applied_x_chosen_size: field.applied_x_chosen_size as usize,
            applied_y_chosen_size: field.applied_y_chosen_size as usize,
            applied_layer_stride: field.applied_layer_stride as usize,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
            preview_grid,
            fem_mesh: None,
            original_node_count: None,
            original_face_count: None,
            active_mask: field.active_mask.clone(),
        }));
    }

    let scalar_field = sampled_grid_scalar_2d(&vectors, preview_grid, component);
    let (min, max) = scalar_min_max(&scalar_field);
    Some(PreviewState::Spatial(SpatialPreviewState {
        display_kind,
        config_revision: field.config_revision,
        source_step,
        source_time,
        spatial_kind: "grid".to_string(),
        quantity: field.quantity.clone(),
        unit: field.unit.clone(),
        quantity_domain: field.quantity_domain.clone(),
        component: component.to_string(),
        layer: display_selection
            .selection
            .layer
            .min(field.original_grid[2].saturating_sub(1)) as usize,
        all_layers: display_selection.selection.all_layers,
        view_type: "2D".to_string(),
        vector_payload_id: None,
        vector_field_values: None,
        scalar_field,
        min,
        max,
        n_comp: 1,
        max_points: config.max_points as usize,
        data_points_count: preview_grid[0] * preview_grid[1],
        x_possible_sizes,
        y_possible_sizes,
        x_chosen_size: field.x_chosen_size as usize,
        y_chosen_size: field.y_chosen_size as usize,
        applied_x_chosen_size: field.applied_x_chosen_size as usize,
        applied_y_chosen_size: field.applied_y_chosen_size as usize,
        applied_layer_stride: field.applied_layer_stride as usize,
        auto_scale_enabled: config.auto_scale_enabled,
        auto_downscaled: field.auto_downscaled,
        auto_downscale_message: field.auto_downscale_message.clone(),
        preview_grid,
        fem_mesh: None,
        original_node_count: None,
        original_face_count: None,
        active_mask: field.active_mask.clone(),
    }))
}

fn resolve_preview_quantity(current: &SessionStateResponse, requested: &str) -> Option<String> {
    let is_preview_compatible = |quantity_id: &str| {
        quantity_spec(quantity_id).is_some_and(|spec| spec.shape != QuantityKind::GlobalScalar)
    };
    if current.quantities.iter().any(|quantity| {
        quantity.available && quantity.id == requested && is_preview_compatible(&quantity.id)
    }) {
        return Some(requested.to_string());
    }
    // PH-00: explicit fallback with diagnostic log instead of silent first-available.
    let fallback = current
        .quantities
        .iter()
        .find(|quantity| quantity.available && is_preview_compatible(&quantity.id))
        .map(|quantity| quantity.id.clone());
    if let Some(ref fb) = fallback {
        eprintln!(
            "[quantities] preview fallback: requested '{}' unavailable, using '{}'",
            requested, fb
        );
    }
    fallback
}

fn resolve_global_scalar_quantity(
    current: &SessionStateResponse,
    requested: &str,
) -> Option<String> {
    let is_global_scalar = |quantity_id: &str| {
        quantity_spec(quantity_id).is_some_and(|spec| spec.shape == QuantityKind::GlobalScalar)
    };
    if current.quantities.iter().any(|quantity| {
        quantity.available && quantity.id == requested && is_global_scalar(&quantity.id)
    }) {
        return Some(requested.to_string());
    }
    // PH-00: explicit fallback with diagnostic log instead of silent first-available.
    let fallback = current
        .quantities
        .iter()
        .find(|quantity| quantity.available && is_global_scalar(&quantity.id))
        .map(|quantity| quantity.id.clone());
    if let Some(ref fb) = fallback {
        eprintln!(
            "[quantities] global scalar fallback: requested '{}' unavailable, using '{}'",
            requested, fb
        );
    }
    fallback
}

fn current_preview_source(current: &SessionStateResponse) -> (u64, f64) {
    if let Some(live_state) = current.live_state.as_ref() {
        return (live_state.latest_step.step, live_state.latest_step.time);
    }
    if let Some(row) = current.scalar_rows.last() {
        return (row.step, row.time);
    }
    if let Some(run) = current.run.as_ref() {
        return (run.total_steps as u64, run.final_time.unwrap_or(0.0));
    }
    (0, 0.0)
}

fn current_global_scalar_value(current: &SessionStateResponse, quantity: &str) -> Option<f64> {
    let metric_key = quantity_spec(quantity)?.scalar_metric_key?;
    current
        .scalar_rows
        .last()
        .and_then(|row| scalar_row_metric_value(row, metric_key))
        .or_else(|| {
            current
                .live_state
                .as_ref()
                .and_then(|state| live_step_metric_value(&state.latest_step, metric_key))
        })
        .or_else(|| run_manifest_scalar_value(current.run.as_ref(), metric_key))
}

fn scalar_row_metric_value(row: &ScalarRow, metric_key: &str) -> Option<f64> {
    match metric_key {
        "e_ex" => Some(row.e_ex),
        "e_demag" => Some(row.e_demag),
        "e_ext" => Some(row.e_ext),
        "e_ani" => Some(row.e_ani),
        "e_dmi" => Some(row.e_dmi),
        "e_total" => Some(row.e_total),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::bootstrap_workspace_payload;

    #[test]
    fn workspace_bootstrap_payload_injects_mode() {
        let payload = bootstrap_workspace_payload(r#"{"session":{"session_id":"s1"},"run":null}"#)
            .expect("workspace bootstrap payload should encode");
        let value: serde_json::Value =
            serde_json::from_str(&payload).expect("payload should be valid json");
        assert_eq!(
            value.get("mode").and_then(serde_json::Value::as_str),
            Some("workspace")
        );
        assert_eq!(
            value
                .get("session")
                .and_then(serde_json::Value::as_object)
                .and_then(|session| session.get("session_id"))
                .and_then(serde_json::Value::as_str),
            Some("s1")
        );
    }
}

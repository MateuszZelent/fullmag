use async_stream::stream;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use fullmag_runner::{FemMeshPayload, LivePreviewField, LivePreviewRequest, StepUpdate};

#[derive(Debug, Clone)]
struct AppState {
    repo_root: PathBuf,
    current_workspace_root: PathBuf,
    /// Per-run broadcast channels for live step updates.
    live_channels: Arc<RwLock<HashMap<String, broadcast::Sender<StepUpdate>>>>,
    /// Sessionless local-live workspace snapshot used by the root `/` GUI.
    current_live_state: Arc<RwLock<Option<SessionStateResponse>>>,
    /// Full current-workspace snapshots broadcast to SSE/WS clients.
    current_live_events: broadcast::Sender<String>,
    /// Preview controls for the sessionless root workspace.
    current_preview_config: Arc<RwLock<CurrentPreviewConfig>>,
    /// In-memory command queue for the root local-live workspace.
    current_command_queue: Arc<Mutex<VecDeque<SessionCommand>>>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Serialize)]
struct VisionResponse {
    north_star: &'static str,
    modes: [&'static str; 3],
    runtime_spine: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionManifest {
    session_id: String,
    run_id: String,
    status: String,
    interactive_session_requested: bool,
    script_path: String,
    problem_name: String,
    requested_backend: String,
    execution_mode: String,
    precision: String,
    artifact_dir: String,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    plan_summary: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RunManifest {
    run_id: String,
    session_id: String,
    status: String,
    total_steps: usize,
    final_time: Option<f64>,
    final_e_ex: Option<f64>,
    final_e_demag: Option<f64>,
    final_e_ext: Option<f64>,
    final_e_total: Option<f64>,
    artifact_dir: String,
}

#[derive(Debug, Serialize, Clone)]
struct ArtifactEntry {
    path: String,
    kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScalarRow {
    step: u64,
    time: f64,
    solver_dt: f64,
    e_ex: f64,
    e_demag: f64,
    e_ext: f64,
    e_total: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
    max_h_demag: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LiveState {
    status: String,
    updated_at_unix_ms: u128,
    latest_step: StepUpdateView,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct EngineLogEntry {
    timestamp_unix_ms: u128,
    level: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StepUpdateView {
    step: u64,
    time: f64,
    dt: f64,
    e_ex: f64,
    e_demag: f64,
    e_ext: f64,
    e_total: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
    #[serde(default)]
    max_h_demag: f64,
    wall_time_ns: u64,
    grid: [u32; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    fem_mesh: Option<FemMeshPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    magnetization: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_field: Option<LivePreviewField>,
    finished: bool,
}

#[derive(Debug, Serialize, Clone)]
struct SessionStateResponse {
    session: SessionManifest,
    run: Option<RunManifest>,
    live_state: Option<LiveState>,
    metadata: Option<Value>,
    scalar_rows: Vec<ScalarRow>,
    engine_log: Vec<EngineLogEntry>,
    quantities: Vec<QuantityDescriptor>,
    fem_mesh: Option<FemMeshPayload>,
    latest_fields: LatestFields,
    artifacts: Vec<ArtifactEntry>,
    preview_config: CurrentPreviewConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<PreviewState>,
}

#[derive(Debug, Serialize, Clone)]
struct QuantityDescriptor {
    id: String,
    label: String,
    kind: String,
    unit: String,
    location: String,
    available: bool,
}

#[derive(Debug, Default, Serialize, Clone)]
struct LatestFields {
    m: Option<Value>,
    h_ex: Option<Value>,
    h_demag: Option<Value>,
    h_ext: Option<Value>,
    h_eff: Option<Value>,
}

type CurrentPreviewConfig = LivePreviewRequest;

#[derive(Debug, Serialize, Clone)]
struct PreviewState {
    config_revision: u64,
    spatial_kind: String,
    quantity: String,
    unit: String,
    component: String,
    layer: usize,
    all_layers: bool,
    #[serde(rename = "type")]
    view_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    vector_field_values: Option<Vec<f64>>,
    scalar_field: Vec<[f64; 3]>,
    min: f64,
    max: f64,
    n_comp: usize,
    max_points: usize,
    data_points_count: usize,
    x_possible_sizes: Vec<usize>,
    y_possible_sizes: Vec<usize>,
    x_chosen_size: usize,
    y_chosen_size: usize,
    applied_x_chosen_size: usize,
    applied_y_chosen_size: usize,
    applied_layer_stride: usize,
    auto_scale_enabled: bool,
    auto_downscaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_downscale_message: Option<String>,
    preview_grid: [usize; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    fem_mesh: Option<FemMeshPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_face_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct PreviewQuantityRequest {
    quantity: String,
}

#[derive(Debug, Deserialize)]
struct PreviewComponentRequest {
    component: String,
}

#[derive(Debug, Deserialize)]
struct PreviewXChosenSizeRequest {
    #[serde(rename = "xChosenSize")]
    x_chosen_size: usize,
}

#[derive(Debug, Deserialize)]
struct PreviewEveryNRequest {
    #[serde(rename = "everyN")]
    every_n: usize,
}

#[derive(Debug, Deserialize)]
struct PreviewYChosenSizeRequest {
    #[serde(rename = "yChosenSize")]
    y_chosen_size: usize,
}

#[derive(Debug, Deserialize)]
struct PreviewAutoScaleRequest {
    #[serde(rename = "autoScaleEnabled")]
    auto_scale_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct PreviewLayerRequest {
    layer: usize,
}

#[derive(Debug, Deserialize)]
struct PreviewAllLayersRequest {
    #[serde(rename = "allLayers")]
    all_layers: bool,
}

#[derive(Debug, Deserialize)]
struct RunRequest {
    problem: fullmag_ir::ProblemIR,
    until_seconds: f64,
    #[serde(default = "default_output_dir")]
    output_dir: String,
}

#[derive(Debug, Deserialize)]
struct ImportSessionAssetRequest {
    file_name: String,
    content_base64: String,
    target_realization: String,
}

#[derive(Debug, Serialize)]
struct SessionAssetImportResponse {
    asset_id: String,
    session_id: String,
    stored_path: String,
    target_realization: String,
    summary: ImportedAssetSummary,
}

#[derive(Debug, Deserialize)]
struct SessionCommandRequest {
    kind: String,
    until_seconds: Option<f64>,
    max_steps: Option<u64>,
    torque_tolerance: Option<f64>,
    energy_tolerance: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CurrentLivePublishRequest {
    session_id: String,
    #[serde(default)]
    session: Option<SessionManifest>,
    #[serde(default)]
    session_status: Option<String>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    run: Option<RunManifest>,
    #[serde(default)]
    live_state: Option<LiveState>,
    #[serde(default)]
    latest_scalar_row: Option<ScalarRow>,
    #[serde(default)]
    engine_log: Option<Vec<EngineLogEntry>>,
}

#[derive(Debug, Serialize)]
struct SessionCommandResponse {
    command_id: String,
    session_id: String,
    kind: String,
    queued_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionCommand {
    command_id: String,
    kind: String,
    created_at_unix_ms: u128,
    until_seconds: Option<f64>,
    max_steps: Option<u64>,
    torque_tolerance: Option<f64>,
    energy_tolerance: Option<f64>,
}

#[derive(Debug, Serialize)]
struct ImportedAssetSummary {
    file_name: String,
    file_bytes: usize,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<BoundsSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    triangle_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    element_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    boundary_face_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct BoundsSummary {
    min: [f64; 3],
    max: [f64; 3],
    size: [f64; 3],
}

fn default_output_dir() -> String {
    ".fullmag/local-live/current/artifacts".to_string()
}

fn uuid_v4_hex() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    format!("{:016x}{:08x}", nanos, pid)
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

    let state = Arc::new(AppState {
        repo_root: repo_root.clone(),
        current_workspace_root,
        live_channels: Arc::new(RwLock::new(HashMap::new())),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_events: broadcast::channel(256).0,
        current_preview_config: Arc::new(RwLock::new(CurrentPreviewConfig::default())),
        current_command_queue: Arc::new(Mutex::new(VecDeque::new())),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta/vision", get(vision))
        .route(
            "/v1/live/current/bootstrap",
            get(get_current_live_bootstrap),
        )
        .route("/v1/live/current/state", get(get_current_live_state))
        .route("/v1/live/current/events", get(get_current_live_events))
        .route("/v1/live/current/publish", post(publish_current_live_state))
        .route(
            "/v1/live/current/preview/config",
            get(get_current_preview_config),
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
            "/v1/live/current/preview/layer",
            post(set_current_preview_layer),
        )
        .route(
            "/v1/live/current/preview/allLayers",
            post(set_current_preview_all_layers),
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
            "/v1/live/current/assets/import",
            post(import_current_live_asset),
        )
        .route(
            "/v1/live/current/artifacts",
            get(list_current_live_artifacts),
        )
        .route("/v1/docs/physics", get(list_physics_docs))
        .route("/v1/run", post(start_run))
        .route("/ws/live/current", get(ws_current_live))
        .route("/ws/live/:run_id", get(ws_live))
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

    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    info!(%addr, "starting fullmag-api");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("binding API listener should succeed");

    axum::serve(listener, app)
        .await
        .expect("serving API should succeed");
}

fn resolve_static_web_root(repo_root: &Path) -> Option<PathBuf> {
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

async fn get_current_live_bootstrap(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionStateResponse>, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(Json(snapshot))
}

async fn get_current_live_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionStateResponse>, ApiError> {
    get_current_live_bootstrap(State(state)).await
}

async fn get_current_preview_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CurrentPreviewConfig>, ApiError> {
    Ok(Json(state.current_preview_config.read().await.clone()))
}

async fn get_current_live_events(
    State(state): State<Arc<AppState>>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let mut rx = state.current_live_events.subscribe();
    let initial_snapshot = state.current_live_state.read().await.as_ref().cloned();
    let stream = stream! {
        if let Some(snapshot) = initial_snapshot {
            match serde_json::to_string(&snapshot) {
                Ok(json) => yield Ok(Event::default().event("session_state").data(json)),
                Err(error) => {
                    let json = serde_json::json!({ "error": error.to_string() }).to_string();
                    yield Ok(Event::default().event("session_error").data(json));
                    return;
                }
            }
        }

        loop {
            match rx.recv().await {
                Ok(json) => yield Ok(Event::default().event("session_state").data(json)),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn publish_current_live_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CurrentLivePublishRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let reset_preview = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|existing| existing.session.session_id != req.session_id)
        .unwrap_or(false);
    if reset_preview {
        *state.current_preview_config.write().await = CurrentPreviewConfig::default();
        state.current_command_queue.lock().await.clear();
        let _ = std::fs::remove_dir_all(&state.current_workspace_root);
    }
    let preview_config = state.current_preview_config.read().await.clone();
    let mut current = state.current_live_state.write().await;
    let mut next = match current.take() {
        Some(existing) if existing.session.session_id == req.session_id => existing,
        _ => default_current_live_state(&req),
    };
    let previous_preview = next.preview.clone();
    apply_current_live_publish(&mut next, req)?;
    next.preview_config = preview_config.clone();
    next.preview = build_preview_state(&next, &preview_config).or(previous_preview);
    let json = serde_json::to_string(&next).map_err(|error| {
        ApiError::internal(format!("failed to serialize current state: {}", error))
    })?;
    *current = Some(next);
    drop(current);

    let _ = state.current_live_events.send(json);
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn set_current_preview_quantity(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewQuantityRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.quantity = req.quantity;
    })
    .await
}

async fn set_current_preview_component(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewComponentRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.component = req.component;
    })
    .await
}

async fn set_current_preview_x_chosen_size(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewXChosenSizeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.x_chosen_size = req.x_chosen_size as u32;
    })
    .await
}

async fn set_current_preview_every_n(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewEveryNRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.every_n = req.every_n.clamp(1, u32::MAX as usize) as u32;
    })
    .await
}

async fn set_current_preview_y_chosen_size(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewYChosenSizeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.y_chosen_size = req.y_chosen_size as u32;
    })
    .await
}

async fn set_current_preview_auto_scale(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewAutoScaleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.auto_scale_enabled = req.auto_scale_enabled;
    })
    .await
}

async fn set_current_preview_layer(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewLayerRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.layer = req.layer as u32;
    })
    .await
}

async fn set_current_preview_all_layers(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewAllLayersRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    mutate_current_preview(&state, move |config| {
        config.all_layers = req.all_layers;
    })
    .await
}

async fn enqueue_current_live_command(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionCommandRequest>,
) -> Result<Json<SessionCommandResponse>, ApiError> {
    let session_id = current_live_session_id(&state).await?;
    let command = build_session_command(req)?;
    let response = SessionCommandResponse {
        command_id: command.command_id.clone(),
        session_id,
        kind: command.kind.clone(),
        queued_path: format!("memory://current/{}", command.command_id),
    };
    state.current_command_queue.lock().await.push_back(command);
    Ok(Json(response))
}

async fn dequeue_current_live_command(
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let command = state.current_command_queue.lock().await.pop_front();
    match command {
        Some(command) => Ok(Json(command).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn import_current_live_asset(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportSessionAssetRequest>,
) -> Result<Json<SessionAssetImportResponse>, ApiError> {
    let response = import_asset_for_current_workspace(&state, req).await?;
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
                        let json = match serde_json::to_string(&update) {
                            Ok(j) => j,
                            Err(_) => continue,
                        };
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break; // client disconnected
                        }
                        if update.finished {
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
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        if let Ok(json) = serde_json::to_string(&snapshot) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                return;
            }
        }
    }

    let mut rx = state.current_live_events.subscribe();
    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(json) => {
                        if socket.send(Message::Text(json.into())).await.is_err() {
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
    if !matches!(kind.as_str(), "run" | "relax" | "close" | "stop" | "pause") {
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

    Ok(SessionCommand {
        command_id: format!("cmd-{}", uuid_v4_hex()),
        kind,
        created_at_unix_ms: unix_time_millis_now(),
        until_seconds: req.until_seconds,
        max_steps: req.max_steps,
        torque_tolerance: req.torque_tolerance,
        energy_tolerance: req.energy_tolerance,
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
    let json = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        snapshot.artifacts = artifacts;
        serde_json::to_string(snapshot).map_err(|error| {
            ApiError::internal(format!("failed to serialize current state: {}", error))
        })?
    };
    let _ = state.current_live_events.send(json);
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

async fn mutate_current_preview<F>(
    state: &Arc<AppState>,
    mutate: F,
) -> Result<Json<serde_json::Value>, ApiError>
where
    F: FnOnce(&mut CurrentPreviewConfig),
{
    let preview_config = {
        let mut config = state.current_preview_config.write().await;
        mutate(&mut config);
        config.revision = config.revision.saturating_add(1);
        config.clone()
    };

    let json = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let previous_preview = snapshot.preview.clone();
        snapshot.preview_config = preview_config.clone();
        snapshot.preview = build_preview_state(snapshot, &preview_config).or(previous_preview);
        serde_json::to_string(snapshot).map_err(|error| {
            ApiError::internal(format!("failed to serialize current state: {}", error))
        })?
    };

    let _ = state.current_live_events.send(json);
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

fn build_preview_state(
    current: &SessionStateResponse,
    config: &CurrentPreviewConfig,
) -> Option<PreviewState> {
    let quantity = resolve_preview_quantity(current, &config.quantity)?;
    let component = normalize_preview_component(&config.component);
    if let Some(field) = current
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .filter(|field| field.config_revision == config.revision && field.quantity == quantity)
    {
        return build_preview_state_from_live_field(current, field, config, component);
    }

    let unit = quantity_unit(&quantity).to_string();

    if let Some(mesh) = current.fem_mesh.as_ref() {
        let vectors = current_vector_field(current, &quantity)?.0;
        if vectors.len() != mesh.nodes.len() {
            return None;
        }
        let (min, max) = component_min_max(&vectors, component);
        return Some(PreviewState {
            config_revision: config.revision,
            spatial_kind: "mesh".to_string(),
            quantity,
            unit,
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
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
        });
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
        let mut applied_x = requested_x;
        let mut applied_y = requested_y;
        let mut stride = 1usize;
        let mut preview_z = full_z;
        let mut auto_downscaled = false;
        while config.auto_scale_enabled
            && applied_x * applied_y * preview_z > config.max_points as usize
            && (applied_x > 1 || applied_y > 1 || preview_z > 1)
        {
            auto_downscaled = true;
            if applied_x >= applied_y && applied_x > 1 {
                applied_x = next_smaller_size(applied_x, &x_possible_sizes);
            } else if applied_y > 1 {
                applied_y = next_smaller_size(applied_y, &y_possible_sizes);
            } else {
                stride += 1;
                preview_z = full_z.div_ceil(stride);
            }
        }

        let vectors = resample_grid_vectors_3d(
            &vectors,
            [full_x, full_y, full_z],
            [applied_x, applied_y, preview_z],
            stride,
        );
        let (min, max) = component_min_max(&vectors, component);
        let auto_downscale_message = auto_downscaled.then(|| {
            format!(
                "Preview auto-scaled from {}x{}x{} to {}x{}x{} to stay within {} points",
                full_x, full_y, full_z, applied_x, applied_y, preview_z, config.max_points
            )
        });
        return Some(PreviewState {
            config_revision: config.revision,
            spatial_kind: "grid".to_string(),
            quantity,
            unit,
            component: component.to_string(),
            layer: (config.layer as usize).min(full_z.saturating_sub(1)),
            all_layers: config.all_layers,
            view_type: "3D".to_string(),
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
        });
    }

    let layer = (config.layer as usize).min(full_z.saturating_sub(1));
    let mut applied_x = requested_x;
    let mut applied_y = requested_y;
    let effective_layers = if config.all_layers { full_z } else { 1 };
    let mut auto_downscaled = false;
    while config.auto_scale_enabled
        && applied_x * applied_y * effective_layers > config.max_points as usize
        && (applied_x > 1 || applied_y > 1)
    {
        auto_downscaled = true;
        if applied_x >= applied_y && applied_x > 1 {
            applied_x = next_smaller_size(applied_x, &x_possible_sizes);
        } else if applied_y > 1 {
            applied_y = next_smaller_size(applied_y, &y_possible_sizes);
        }
    }
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
            "Preview auto-scaled from {}x{} to {}x{} to stay within {} points",
            full_x, full_y, applied_x, applied_y, config.max_points
        )
    });
    Some(PreviewState {
        config_revision: config.revision,
        spatial_kind: "grid".to_string(),
        quantity,
        unit,
        component: component.to_string(),
        layer,
        all_layers: config.all_layers,
        view_type: "2D".to_string(),
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
    })
}

fn build_preview_state_from_live_field(
    current: &SessionStateResponse,
    field: &LivePreviewField,
    config: &CurrentPreviewConfig,
    component: &str,
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
        return Some(PreviewState {
            config_revision: field.config_revision,
            spatial_kind: "mesh".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
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
        });
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
        return Some(PreviewState {
            config_revision: field.config_revision,
            spatial_kind: "grid".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            component: component.to_string(),
            layer: config.layer.min(field.original_grid[2].saturating_sub(1)) as usize,
            all_layers: config.all_layers,
            view_type: "3D".to_string(),
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
        });
    }

    let scalar_field = sampled_grid_scalar_2d(&vectors, preview_grid, component);
    let (min, max) = scalar_min_max(&scalar_field);
    Some(PreviewState {
        config_revision: field.config_revision,
        spatial_kind: "grid".to_string(),
        quantity: field.quantity.clone(),
        unit: field.unit.clone(),
        component: component.to_string(),
        layer: config.layer.min(field.original_grid[2].saturating_sub(1)) as usize,
        all_layers: config.all_layers,
        view_type: "2D".to_string(),
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
    })
}

fn resolve_preview_quantity(current: &SessionStateResponse, requested: &str) -> Option<String> {
    if current.quantities.iter().any(|quantity| {
        quantity.kind == "vector_field" && quantity.available && quantity.id == requested
    }) {
        return Some(requested.to_string());
    }
    current
        .quantities
        .iter()
        .find(|quantity| quantity.kind == "vector_field" && quantity.available)
        .map(|quantity| quantity.id.clone())
}

fn normalize_preview_component(component: &str) -> &str {
    match component {
        "x" | "y" | "z" => component,
        _ => "3D",
    }
}

fn quantity_unit(quantity: &str) -> &'static str {
    match quantity {
        "m" => "dimensionless",
        "H_ex" | "H_demag" | "H_ext" | "H_eff" => "A/m",
        _ => "",
    }
}

fn current_vector_field(
    current: &SessionStateResponse,
    quantity: &str,
) -> Option<(Vec<[f64; 3]>, [usize; 3])> {
    if quantity == "m" {
        let live = current.live_state.as_ref()?;
        let values = live.latest_step.magnetization.as_ref()?;
        let vectors = values
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect::<Vec<_>>();
        let grid = [
            live.latest_step.grid[0] as usize,
            live.latest_step.grid[1] as usize,
            live.latest_step.grid[2] as usize,
        ];
        return Some((vectors, grid));
    }
    let raw = match quantity {
        "H_ex" => current.latest_fields.h_ex.as_ref()?,
        "H_demag" => current.latest_fields.h_demag.as_ref()?,
        "H_ext" => current.latest_fields.h_ext.as_ref()?,
        "H_eff" => current.latest_fields.h_eff.as_ref()?,
        _ => return None,
    };
    parse_field_value(raw)
}

fn parse_field_value(raw: &Value) -> Option<(Vec<[f64; 3]>, [usize; 3])> {
    let grid = raw
        .get("layout")?
        .get("grid_cells")?
        .as_array()
        .and_then(|grid| {
            if grid.len() == 3 {
                Some([
                    grid[0].as_u64()? as usize,
                    grid[1].as_u64()? as usize,
                    grid[2].as_u64()? as usize,
                ])
            } else {
                None
            }
        })?;
    let values = raw.get("values")?.as_array()?;
    let vectors = values
        .iter()
        .filter_map(|value| {
            let vector = value.as_array()?;
            if vector.len() < 3 {
                return None;
            }
            Some([
                vector[0].as_f64()?,
                vector[1].as_f64()?,
                vector[2].as_f64()?,
            ])
        })
        .collect::<Vec<_>>();
    Some((vectors, grid))
}

fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| [vector[0], vector[1], vector[2]])
        .collect()
}

fn component_min_max(values: &[[f64; 3]], component: &str) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for [x, y, z] in values.iter().copied() {
        let value = match component {
            "x" => x,
            "y" => y,
            "z" => z,
            _ => (x * x + y * y + z * z).sqrt(),
        };
        min = min.min(value);
        max = max.max(value);
    }
    (min, max)
}

fn scalar_min_max(values: &[[f64; 3]]) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for point in values {
        min = min.min(point[2]);
        max = max.max(point[2]);
    }
    (min, max)
}

fn candidate_preview_sizes(full: usize) -> Vec<usize> {
    let mut sizes = vec![full.max(1)];
    let mut current = full.max(1);
    while current > 1 {
        current = current.div_ceil(2);
        if sizes.last().copied() != Some(current) {
            sizes.push(current);
        }
    }
    sizes
}

fn choose_preview_size(requested: usize, possible: &[usize], full: usize) -> usize {
    if requested == 0 {
        return full.max(1);
    }
    possible
        .iter()
        .copied()
        .find(|size| *size <= requested)
        .unwrap_or(1)
}

fn next_smaller_size(current: usize, possible: &[usize]) -> usize {
    let index = possible
        .iter()
        .position(|size| *size == current)
        .unwrap_or(0);
    possible.get(index + 1).copied().unwrap_or(1)
}

fn resample_grid_vectors_3d(
    values: &[[f64; 3]],
    full: [usize; 3],
    preview: [usize; 3],
    z_stride: usize,
) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = full;
    let [preview_x, preview_y, preview_z] = preview;
    let mut out = Vec::with_capacity(preview_x * preview_y * preview_z);
    for pz in 0..preview_z {
        let z_start = (pz * z_stride).min(full_z.saturating_sub(1));
        let z_end = ((pz + 1) * z_stride).min(full_z);
        for py in 0..preview_y {
            let y_start = py * full_y / preview_y;
            let y_end = ((py + 1) * full_y / preview_y).max(y_start + 1).min(full_y);
            for px in 0..preview_x {
                let x_start = px * full_x / preview_x;
                let x_end = ((px + 1) * full_x / preview_x).max(x_start + 1).min(full_x);
                let mut accum = [0.0, 0.0, 0.0];
                let mut count = 0.0;
                for z in z_start..z_end {
                    for y in y_start..y_end {
                        for x in x_start..x_end {
                            let vector = values[(z * full_y + y) * full_x + x];
                            accum[0] += vector[0];
                            accum[1] += vector[1];
                            accum[2] += vector[2];
                            count += 1.0;
                        }
                    }
                }
                out.push([accum[0] / count, accum[1] / count, accum[2] / count]);
            }
        }
    }
    out
}

fn resample_grid_scalar_2d(
    values: &[[f64; 3]],
    full: [usize; 3],
    preview: [usize; 2],
    component: &str,
    layer: usize,
    all_layers: bool,
) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = full;
    let [preview_x, preview_y] = preview;
    let z_start = if all_layers {
        0
    } else {
        layer.min(full_z.saturating_sub(1))
    };
    let z_end = if all_layers { full_z } else { z_start + 1 };
    let component_index = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => 2,
    };
    let mut out = Vec::with_capacity(preview_x * preview_y);
    for py in 0..preview_y {
        let y_start = py * full_y / preview_y;
        let y_end = ((py + 1) * full_y / preview_y).max(y_start + 1).min(full_y);
        for px in 0..preview_x {
            let x_start = px * full_x / preview_x;
            let x_end = ((px + 1) * full_x / preview_x).max(x_start + 1).min(full_x);
            let mut accum = 0.0;
            let mut count = 0.0;
            for z in z_start..z_end {
                for y in y_start..y_end {
                    for x in x_start..x_end {
                        accum += values[(z * full_y + y) * full_x + x][component_index];
                        count += 1.0;
                    }
                }
            }
            out.push([px as f64, py as f64, accum / count]);
        }
    }
    out
}

fn sampled_grid_scalar_2d(
    values: &[[f64; 3]],
    preview_grid: [usize; 3],
    component: &str,
) -> Vec<[f64; 3]> {
    let component_index = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => 2,
    };
    let mut out = Vec::with_capacity(preview_grid[0] * preview_grid[1]);
    for py in 0..preview_grid[1] {
        for px in 0..preview_grid[0] {
            let index = py * preview_grid[0] + px;
            let value = values
                .get(index)
                .map(|vector| vector[component_index])
                .unwrap_or(0.0);
            out.push([px as f64, py as f64, value]);
        }
    }
    out
}

async fn current_live_session_id(state: &AppState) -> Result<String, ApiError> {
    let current = state.current_live_state.read().await;
    current
        .as_ref()
        .map(|snapshot| snapshot.session.session_id.clone())
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))
}

fn default_current_live_state(req: &CurrentLivePublishRequest) -> SessionStateResponse {
    let now = unix_time_millis_now();
    let run_id = req
        .session
        .as_ref()
        .map(|session| session.run_id.clone())
        .or_else(|| req.run.as_ref().map(|run| run.run_id.clone()))
        .unwrap_or_else(|| format!("run-{}", req.session_id));
    let status = req
        .session
        .as_ref()
        .map(|session| session.status.clone())
        .or_else(|| req.session_status.clone())
        .or_else(|| req.live_state.as_ref().map(|state| state.status.clone()))
        .or_else(|| req.run.as_ref().map(|run| run.status.clone()))
        .unwrap_or_else(|| "bootstrapping".to_string());
    let artifact_dir = req
        .session
        .as_ref()
        .map(|session| session.artifact_dir.clone())
        .or_else(|| req.run.as_ref().map(|run| run.artifact_dir.clone()))
        .unwrap_or_default();

    SessionStateResponse {
        session: req.session.clone().unwrap_or(SessionManifest {
            session_id: req.session_id.clone(),
            run_id,
            status,
            interactive_session_requested: false,
            script_path: String::new(),
            problem_name: "Local Live Workspace".to_string(),
            requested_backend: "auto".to_string(),
            execution_mode: "strict".to_string(),
            precision: "double".to_string(),
            artifact_dir,
            started_at_unix_ms: now,
            finished_at_unix_ms: now,
            plan_summary: serde_json::json!({}),
        }),
        run: None,
        live_state: None,
        metadata: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        artifacts: Vec::new(),
        preview_config: CurrentPreviewConfig::default(),
        preview: None,
    }
}

fn apply_current_live_publish(
    current: &mut SessionStateResponse,
    req: CurrentLivePublishRequest,
) -> Result<(), ApiError> {
    if let Some(session) = req.session {
        current.session = session;
    }
    current.session.session_id = req.session_id.clone();

    if let Some(status) = req.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = req.metadata {
        current.metadata = Some(metadata);
    }
    if let Some(run) = req.run {
        current.session.run_id = run.run_id.clone();
        current.session.artifact_dir = run.artifact_dir.clone();
        current.run = Some(run);
    }
    if let Some(live_state) = req.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
            current.fem_mesh = Some(fem_mesh);
        }
        current.live_state = Some(live_state);
    }
    if let Some(row) = req.latest_scalar_row {
        upsert_scalar_row(&mut current.scalar_rows, row);
    }
    if let Some(engine_log) = req.engine_log {
        current.engine_log = engine_log;
    }

    if let Some(run) = current.run.as_ref() {
        current.session.run_id = run.run_id.clone();
        if current.session.artifact_dir.is_empty() {
            current.session.artifact_dir = run.artifact_dir.clone();
        }
    }

    if current.fem_mesh.is_none() {
        current.fem_mesh = current
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.fem_mesh.clone())
            .or_else(|| {
                current
                    .metadata
                    .as_ref()
                    .and_then(extract_fem_mesh_from_metadata)
            });
    }

    if matches!(
        current.session.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        current.session.finished_at_unix_ms = unix_time_millis_now();
    }

    let field_location = if current.fem_mesh.is_some() {
        "node"
    } else {
        "cell"
    };
    current.quantities = build_quantities(
        &current.latest_fields,
        current.live_state.as_ref(),
        current.run.as_ref(),
        current.metadata.as_ref(),
        &current.scalar_rows,
        field_location,
    );

    let artifact_dir = current_artifact_dir(current);
    if current.artifacts.is_empty()
        || current
            .live_state
            .as_ref()
            .map(|state| state.latest_step.finished)
            .unwrap_or(false)
    {
        current.artifacts = read_artifacts_from_dir(artifact_dir.as_deref())?;
    }

    Ok(())
}

fn current_artifact_dir(current: &SessionStateResponse) -> Option<PathBuf> {
    let from_run = current
        .run
        .as_ref()
        .map(|run| run.artifact_dir.as_str())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let from_session = (!current.session.artifact_dir.is_empty())
        .then(|| PathBuf::from(&current.session.artifact_dir));
    from_run.or(from_session)
}

fn read_artifacts_from_dir(artifact_dir: Option<&Path>) -> Result<Vec<ArtifactEntry>, ApiError> {
    let Some(artifact_dir) = artifact_dir else {
        return Ok(Vec::new());
    };
    if !artifact_dir.exists() {
        return Ok(Vec::new());
    }
    let mut artifacts = Vec::new();
    collect_artifacts(artifact_dir, artifact_dir, &mut artifacts)?;
    Ok(artifacts)
}

fn upsert_scalar_row(rows: &mut Vec<ScalarRow>, row: ScalarRow) {
    match rows.last_mut() {
        Some(last) if last.step == row.step => *last = row,
        _ => rows.push(row),
    }
}

fn unix_time_millis_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn collect_artifacts(
    root: &Path,
    current: &Path,
    out: &mut Vec<ArtifactEntry>,
) -> Result<(), ApiError> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_artifacts(root, &path, out)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
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
        });
    }
    out.sort_by(|lhs, rhs| lhs.path.cmp(&rhs.path));
    Ok(())
}

fn sanitize_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.replace(['/', '\\'], "_"))
        .unwrap_or_default()
}

fn make_repo_relative(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn summarize_uploaded_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".stl") {
        return summarize_stl_asset(file_name, bytes);
    }
    if lower.ends_with(".mesh.json") || lower.ends_with(".json") {
        return summarize_mesh_json_asset(file_name, bytes);
    }
    if lower.ends_with(".msh") {
        return summarize_msh_asset(file_name, bytes);
    }
    if lower.ends_with(".vtk") || lower.ends_with(".vtu") || lower.ends_with(".xdmf") {
        return Ok(ImportedAssetSummary {
            file_name: file_name.to_string(),
            file_bytes: bytes.len(),
            kind: "mesh_exchange".to_string(),
            bounds: None,
            triangle_count: None,
            node_count: None,
            element_count: None,
            boundary_face_count: None,
            note: Some(
                "Mesh exchange preview is stored on the backend, but topology summarization is deferred to the Python meshing pipeline.".to_string(),
            ),
        });
    }
    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "unknown".to_string(),
        bounds: None,
        triangle_count: None,
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: Some(
            "Backend stored the asset, but no preview parser is implemented for this format yet."
                .to_string(),
        ),
    })
}

fn summarize_mesh_json_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid mesh JSON: {}", error)))?;
    let nodes = payload
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad_request("mesh JSON must contain nodes"))?;
    let elements = payload
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad_request("mesh JSON must contain elements"))?;
    let boundary_faces = payload
        .get("boundary_faces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut points = Vec::new();
    for node in nodes {
        if let Some(point) = parse_point3_value(node) {
            points.push(point);
        }
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "tet_mesh".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: None,
        node_count: Some(nodes.len()),
        element_count: Some(elements.len()),
        boundary_face_count: Some(boundary_faces.len()),
        note: None,
    })
}

fn summarize_msh_asset(file_name: &str, bytes: &[u8]) -> Result<ImportedAssetSummary, ApiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid text MSH payload: {}", error)))?;
    let lines = text.lines().collect::<Vec<_>>();
    let mut node_count = None;
    let mut element_count = None;
    let mut note =
        "Browser/API summary supports Gmsh ASCII v2 best; full topology parsing stays in the external meshing pipeline."
            .to_string();

    if let Some(position) = lines.iter().position(|line| line.trim() == "$Nodes") {
        if let Some(value) = lines
            .get(position + 1)
            .and_then(|line| line.trim().parse::<usize>().ok())
        {
            node_count = Some(value);
        }
    }

    if let Some(position) = lines.iter().position(|line| line.trim() == "$Elements") {
        if let Some(value) = lines
            .get(position + 1)
            .and_then(|line| line.trim().parse::<usize>().ok())
        {
            element_count = Some(value);
        }
    }

    if text.contains("$Entities") {
        note = "Gmsh v4 detected. The backend stored the asset, but detailed preview still defers to Python + Gmsh.".to_string();
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "gmsh_mesh".to_string(),
        bounds: None,
        triangle_count: None,
        node_count,
        element_count,
        boundary_face_count: None,
        note: Some(note),
    })
}

fn summarize_stl_asset(file_name: &str, bytes: &[u8]) -> Result<ImportedAssetSummary, ApiError> {
    let summary = if let Some(binary) = summarize_binary_stl_asset(file_name, bytes)? {
        binary
    } else {
        summarize_ascii_stl_asset(file_name, bytes)?
    };
    Ok(summary)
}

fn summarize_binary_stl_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<Option<ImportedAssetSummary>, ApiError> {
    if bytes.len() < 84 {
        return Ok(None);
    }
    let triangle_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    if 84 + triangle_count * 50 != bytes.len() {
        return Ok(None);
    }

    let mut points = Vec::with_capacity(triangle_count * 3);
    let mut offset = 84;
    for _ in 0..triangle_count {
        offset += 12;
        for _ in 0..3 {
            let x = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64;
            let y = f32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as f64;
            let z = f32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) as f64;
            points.push([x, y, z]);
            offset += 12;
        }
        offset += 2;
    }

    Ok(Some(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "stl_surface".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: Some(triangle_count),
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: None,
    }))
}

fn summarize_ascii_stl_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid ASCII STL payload: {}", error)))?;
    let mut points = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("vertex ") {
            continue;
        }
        let values = trimmed
            .split_whitespace()
            .skip(1)
            .filter_map(|value| value.parse::<f64>().ok())
            .collect::<Vec<_>>();
        if values.len() == 3 {
            points.push([values[0], values[1], values[2]]);
        }
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "stl_surface".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: Some(points.len() / 3),
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: None,
    })
}

fn parse_point3_value(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    if array.len() < 3 {
        return None;
    }
    Some([array[0].as_f64()?, array[1].as_f64()?, array[2].as_f64()?])
}

fn bounds_from_points(points: &[[f64; 3]]) -> Option<BoundsSummary> {
    let first = *points.first()?;
    let mut min = first;
    let mut max = first;
    for [x, y, z] in points.iter().copied() {
        if x < min[0] {
            min[0] = x;
        }
        if y < min[1] {
            min[1] = y;
        }
        if z < min[2] {
            min[2] = z;
        }
        if x > max[0] {
            max[0] = x;
        }
        if y > max[1] {
            max[1] = y;
        }
        if z > max[2] {
            max[2] = z;
        }
    }
    Some(BoundsSummary {
        min,
        max,
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    })
}

fn build_quantities(
    latest_fields: &LatestFields,
    live_state: Option<&LiveState>,
    run: Option<&RunManifest>,
    metadata: Option<&Value>,
    scalar_rows: &[ScalarRow],
    field_location: &str,
) -> Vec<QuantityDescriptor> {
    let dynamic_supported = metadata
        .and_then(|value| value.get("live_preview"))
        .and_then(|value| value.get("supported_quantities"))
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let dynamic_available = |quantity_id: &str| dynamic_supported.contains(&quantity_id);
    let scalar_available = |run_value: Option<f64>| {
        !scalar_rows.is_empty() || live_state.is_some() || run_value.is_some()
    };

    vec![
        QuantityDescriptor {
            id: "m".to_string(),
            label: "Magnetization".to_string(),
            kind: "vector_field".to_string(),
            unit: "dimensionless".to_string(),
            location: field_location.to_string(),
            available: dynamic_available("m")
                || latest_fields.m.is_some()
                || live_state
                    .and_then(|state| state.latest_step.magnetization.as_ref())
                    .is_some()
                || live_state
                    .and_then(|state| state.latest_step.preview_field.as_ref())
                    .is_some_and(|field| field.quantity == "m"),
        },
        QuantityDescriptor {
            id: "H_ex".to_string(),
            label: "Exchange Field".to_string(),
            kind: "vector_field".to_string(),
            unit: "A/m".to_string(),
            location: field_location.to_string(),
            available: dynamic_available("H_ex")
                || latest_fields.h_ex.is_some()
                || live_state
                    .and_then(|state| state.latest_step.preview_field.as_ref())
                    .is_some_and(|field| field.quantity == "H_ex"),
        },
        QuantityDescriptor {
            id: "H_demag".to_string(),
            label: "Demagnetization Field".to_string(),
            kind: "vector_field".to_string(),
            unit: "A/m".to_string(),
            location: field_location.to_string(),
            available: dynamic_available("H_demag")
                || latest_fields.h_demag.is_some()
                || live_state
                    .and_then(|state| state.latest_step.preview_field.as_ref())
                    .is_some_and(|field| field.quantity == "H_demag"),
        },
        QuantityDescriptor {
            id: "H_ext".to_string(),
            label: "External Field".to_string(),
            kind: "vector_field".to_string(),
            unit: "A/m".to_string(),
            location: field_location.to_string(),
            available: dynamic_available("H_ext")
                || latest_fields.h_ext.is_some()
                || live_state
                    .and_then(|state| state.latest_step.preview_field.as_ref())
                    .is_some_and(|field| field.quantity == "H_ext"),
        },
        QuantityDescriptor {
            id: "H_eff".to_string(),
            label: "Effective Field".to_string(),
            kind: "vector_field".to_string(),
            unit: "A/m".to_string(),
            location: field_location.to_string(),
            available: dynamic_available("H_eff")
                || latest_fields.h_eff.is_some()
                || live_state
                    .and_then(|state| state.latest_step.preview_field.as_ref())
                    .is_some_and(|field| field.quantity == "H_eff"),
        },
        QuantityDescriptor {
            id: "E_ex".to_string(),
            label: "Exchange Energy".to_string(),
            kind: "global_scalar".to_string(),
            unit: "J".to_string(),
            location: "global".to_string(),
            available: scalar_available(run.and_then(|manifest| manifest.final_e_ex)),
        },
        QuantityDescriptor {
            id: "E_demag".to_string(),
            label: "Demagnetization Energy".to_string(),
            kind: "global_scalar".to_string(),
            unit: "J".to_string(),
            location: "global".to_string(),
            available: scalar_available(run.and_then(|manifest| manifest.final_e_demag)),
        },
        QuantityDescriptor {
            id: "E_ext".to_string(),
            label: "External Energy".to_string(),
            kind: "global_scalar".to_string(),
            unit: "J".to_string(),
            location: "global".to_string(),
            available: scalar_available(run.and_then(|manifest| manifest.final_e_ext)),
        },
        QuantityDescriptor {
            id: "E_total".to_string(),
            label: "Total Energy".to_string(),
            kind: "global_scalar".to_string(),
            unit: "J".to_string(),
            location: "global".to_string(),
            available: scalar_available(run.and_then(|manifest| manifest.final_e_total)),
        },
    ]
}

fn extract_fem_mesh_from_metadata(metadata: &Value) -> Option<FemMeshPayload> {
    let fem = metadata
        .get("execution_plan")?
        .get("backend_plan")?
        .get("Fem")?;
    let mesh = fem.get("mesh")?;
    serde_json::from_value(mesh.clone()).ok()
}

fn repo_root() -> PathBuf {
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

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError::internal(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": self.message,
            })),
        )
            .into_response()
    }
}

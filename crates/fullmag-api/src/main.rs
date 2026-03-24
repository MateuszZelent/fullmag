use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use fullmag_runner::StepUpdate;

#[derive(Debug, Clone)]
struct AppState {
    sessions_root: PathBuf,
    repo_root: PathBuf,
    /// Broadcast channel for live step updates.
    live_tx: broadcast::Sender<StepUpdate>,
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
    artifact_dir: String,
}

#[derive(Debug, Serialize)]
struct ArtifactEntry {
    path: String,
    kind: String,
}

#[derive(Debug, Serialize)]
struct ScalarRow {
    step: u64,
    time: f64,
    solver_dt: f64,
    e_ex: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LiveState {
    status: String,
    updated_at_unix_ms: u128,
    latest_step: StepUpdateView,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StepUpdateView {
    step: u64,
    time: f64,
    dt: f64,
    e_ex: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
    wall_time_ns: u64,
    grid: [u32; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    magnetization: Option<Vec<f64>>,
    finished: bool,
}

#[derive(Debug, Serialize)]
struct SessionStateResponse {
    session: SessionManifest,
    run: Option<RunManifest>,
    live_state: Option<LiveState>,
    metadata: Option<Value>,
    scalar_rows: Vec<ScalarRow>,
    latest_fields: LatestFields,
    artifacts: Vec<ArtifactEntry>,
}

#[derive(Debug, Default, Serialize)]
struct LatestFields {
    m: Option<Value>,
    h_ex: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RunRequest {
    problem: fullmag_ir::ProblemIR,
    until_seconds: f64,
    #[serde(default = "default_output_dir")]
    output_dir: String,
}

fn default_output_dir() -> String {
    ".fullmag/sessions/live/artifacts".to_string()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let (live_tx, _) = broadcast::channel::<StepUpdate>(256);

    let state = Arc::new(AppState {
        sessions_root: std::env::var("FULLMAG_SESSIONS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(".fullmag/sessions")),
        repo_root: repo_root(),
        live_tx,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta/vision", get(vision))
        .route("/v1/sessions", get(list_sessions))
        .route("/v1/sessions/{session_id}", get(get_session))
        .route("/v1/sessions/{session_id}/state", get(get_session_state))
        .route("/v1/sessions/{session_id}/events", get(get_session_events))
        .route("/v1/runs", get(list_runs))
        .route("/v1/runs/{run_id}", get(get_run))
        .route("/v1/runs/{run_id}/artifacts", get(list_run_artifacts))
        .route("/v1/docs/physics", get(list_physics_docs))
        .route("/v1/run", post(start_run))
        .route("/ws/live", get(ws_live))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    info!(%addr, "starting fullmag-api");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("binding API listener should succeed");

    axum::serve(listener, app)
        .await
        .expect("serving API should succeed");
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
        runtime_spine: "session",
    })
}

/// POST /v1/run — start a simulation run and broadcast live updates.
async fn start_run(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let output_dir = PathBuf::from(&req.output_dir);
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| ApiError::internal(format!("failed to create output dir: {}", e)))?;

    let tx = state.live_tx.clone();
    let problem = req.problem;
    let until = req.until_seconds;

    // Spawn runner in a blocking task (runner is synchronous)
    tokio::task::spawn_blocking(move || {
        let result = fullmag_runner::run_problem_with_callback(
            &problem,
            until,
            &output_dir,
            10, // send magnetization every 10 steps
            |update| {
                let _ = tx.send(update);
            },
        );
        match result {
            Ok(_) => info!("run completed successfully"),
            Err(e) => tracing::error!("run failed: {}", e),
        }
    });

    Ok(Json(serde_json::json!({
        "status": "started",
        "message": "simulation started, connect to /ws/live for updates"
    })))
}

/// GET /ws/live — WebSocket endpoint for live step updates.
async fn ws_live(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.live_tx.subscribe();

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

async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SessionManifest>>, ApiError> {
    Ok(Json(read_all_sessions(&state.sessions_root)?))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<SessionManifest>, ApiError> {
    let path = state.sessions_root.join(&session_id).join("session.json");
    Ok(Json(read_json_file(&path)?))
}

async fn get_session_state(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<SessionStateResponse>, ApiError> {
    let session_dir = state.sessions_root.join(&session_id);
    let session: SessionManifest = read_json_file(&session_dir.join("session.json"))?;
    let run = read_optional_json_file::<RunManifest>(&session_dir.join("run.json"))?;
    let artifact_dir = PathBuf::from(&session.artifact_dir);

    let mut artifacts = Vec::new();
    if artifact_dir.exists() {
        collect_artifacts(&artifact_dir, &artifact_dir, &mut artifacts)?;
    }

    let metadata = read_optional_json_value(&artifact_dir.join("metadata.json"))?;
    let scalar_rows = read_scalar_rows(&artifact_dir.join("scalars.csv"))?;
    let live_state = read_optional_json_file::<LiveState>(&session_dir.join("live_state.json"))?;
    let latest_fields = LatestFields {
        m: read_latest_field_json(&artifact_dir, "m")?,
        h_ex: read_latest_field_json(&artifact_dir, "H_ex")?,
    };

    Ok(Json(SessionStateResponse {
        session,
        run,
        live_state,
        metadata,
        scalar_rows,
        latest_fields,
        artifacts,
    }))
}

async fn get_session_events(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let path = state.sessions_root.join(&session_id).join("events.ndjson");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| ApiError::not_found(format!("missing {}", path.display())))?;
    let body = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| format!("data: {line}\n\n"))
        .collect::<String>();

    Ok((
        [(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")],
        body,
    )
        .into_response())
}

async fn list_runs(State(state): State<Arc<AppState>>) -> Result<Json<Vec<RunManifest>>, ApiError> {
    let sessions = read_all_sessions(&state.sessions_root)?;
    let mut runs = Vec::new();
    for session in sessions {
        let run_path = state
            .sessions_root
            .join(&session.session_id)
            .join("run.json");
        runs.push(read_json_file(&run_path)?);
    }
    Ok(Json(runs))
}

async fn get_run(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
) -> Result<Json<RunManifest>, ApiError> {
    let run_path = find_run_file(&state.sessions_root, &run_id)?;
    Ok(Json(read_json_file(&run_path)?))
}

async fn list_run_artifacts(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
) -> Result<Json<Vec<ArtifactEntry>>, ApiError> {
    let run_path = find_run_file(&state.sessions_root, &run_id)?;
    let manifest: RunManifest = read_json_file(&run_path)?;
    let artifact_dir = PathBuf::from(&manifest.artifact_dir);
    let mut artifacts = Vec::new();
    if artifact_dir.exists() {
        collect_artifacts(&artifact_dir, &artifact_dir, &mut artifacts)?;
    }
    Ok(Json(artifacts))
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

fn read_all_sessions(root: &Path) -> Result<Vec<SessionManifest>, ApiError> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut sessions: Vec<SessionManifest> = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let session_path = entry.path().join("session.json");
        if session_path.exists() {
            sessions.push(read_json_file(&session_path)?);
        }
    }
    sessions.sort_by_key(|session| session.started_at_unix_ms);
    sessions.reverse();
    Ok(sessions)
}

fn find_run_file(root: &Path, run_id: &str) -> Result<PathBuf, ApiError> {
    if !root.exists() {
        return Err(ApiError::not_found("sessions root does not exist"));
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path().join("run.json");
        if path.exists() {
            let manifest: RunManifest = read_json_file(&path)?;
            if manifest.run_id == run_id {
                return Ok(path);
            }
        }
    }

    Err(ApiError::not_found(format!("run '{run_id}' not found")))
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

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ApiError> {
    let text = std::fs::read_to_string(path)
        .map_err(|_| ApiError::not_found(format!("missing {}", path.display())))?;
    serde_json::from_str(&text).map_err(|error| {
        ApiError::internal(format!("invalid JSON in {}: {}", path.display(), error))
    })
}

fn read_optional_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, ApiError> {
    if !path.exists() {
        return Ok(None);
    }
    read_json_file(path).map(Some)
}

fn read_optional_json_value(path: &Path) -> Result<Option<Value>, ApiError> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| ApiError::not_found(format!("missing {}", path.display())))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| ApiError::internal(format!("invalid JSON in {}: {}", path.display(), error)))
}

fn read_scalar_rows(path: &Path) -> Result<Vec<ScalarRow>, ApiError> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let text = std::fs::read_to_string(path)
        .map_err(|_| ApiError::not_found(format!("missing {}", path.display())))?;
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if index == 0 || line.trim().is_empty() {
            continue;
        }
        let columns = line.split(',').collect::<Vec<_>>();
        if columns.len() != 4 {
            return Err(ApiError::internal(format!(
                "invalid scalar row {} in {}",
                index + 1,
                path.display()
            )));
        }
        rows.push(ScalarRow {
            step: columns[0].parse().map_err(|error| {
                ApiError::internal(format!("invalid scalar step in {}: {}", path.display(), error))
            })?,
            time: columns[1].parse().map_err(|error| {
                ApiError::internal(format!("invalid scalar time in {}: {}", path.display(), error))
            })?,
            solver_dt: columns[2].parse().map_err(|error| {
                ApiError::internal(format!("invalid scalar dt in {}: {}", path.display(), error))
            })?,
            e_ex: columns[3].parse().map_err(|error| {
                ApiError::internal(format!("invalid scalar E_ex in {}: {}", path.display(), error))
            })?,
        });
    }
    Ok(rows)
}

fn read_latest_field_json(artifact_dir: &Path, observable: &str) -> Result<Option<Value>, ApiError> {
    let observable_dir = artifact_dir.join("fields").join(observable);
    if !observable_dir.exists() {
        return Ok(None);
    }

    let mut latest: Option<PathBuf> = None;
    for entry in std::fs::read_dir(&observable_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match &latest {
            Some(current) if current.file_name() >= path.file_name() => {}
            _ => latest = Some(path),
        }
    }

    match latest {
        Some(path) => read_optional_json_value(&path),
        None => Ok(None),
    }
}

fn repo_root() -> PathBuf {
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

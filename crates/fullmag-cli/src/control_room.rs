use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::{io, os::unix::process::CommandExt};

use crate::live_workspace::LocalLiveWorkspace;
use crate::terminal_logs::{terminal_logger, TerminalLogSource};
use crate::types::*;

pub(crate) const LOCALHOST_HTTP_HOST: &str = "localhost";
pub(crate) const LOOPBACK_V4_OCTETS: [u8; 4] = [127, 0, 0, 1];

static RESOLVED_API_PORT: OnceLock<u16> = OnceLock::new();

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

pub(crate) fn api_port() -> u16 {
    *RESOLVED_API_PORT.get().expect("API port not yet resolved")
}

pub(crate) fn api_base_url() -> String {
    format!("http://localhost:{}", api_port())
}

pub(crate) fn swagger_ui_url() -> String {
    format!("{}/v1/docs/swagger/", api_base_url())
}

pub(crate) fn openapi_json_url() -> String {
    format!("{}/v1/openapi.json", api_base_url())
}

pub(crate) fn internal_live_api_url(path: &str) -> String {
    format!(
        "{}/v1/internal/live/current/{}",
        api_base_url(),
        path.trim_start_matches('/')
    )
}

pub(crate) fn resolve_api_port() -> Result<u16> {
    if let Ok(raw) = std::env::var("FULLMAG_API_PORT") {
        let raw = raw.trim();
        let port = raw
            .parse::<u16>()
            .with_context(|| format!("FULLMAG_API_PORT must be a valid u16 port, got '{raw}'"))?;
        if port == 0 {
            return Ok(0);
        }
        if api_is_ready(port) || port_is_bindable(port) {
            return Ok(port);
        }
        bail!("requested FULLMAG_API_PORT={port} is not bindable and does not serve a healthy fullmag-api");
    }

    if api_is_ready(8081) || port_is_bindable(8081) {
        return Ok(8081);
    }

    const CANDIDATE_API_PORTS: &[u16] = &[8080, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];
    for &port in CANDIDATE_API_PORTS {
        if api_is_ready(port) {
            return Ok(port);
        }
        if port_is_bindable(port) {
            return Ok(port);
        }
    }
    allocate_ephemeral_api_port().with_context(|| {
        format!(
            "no free API port found in {:?}, and ephemeral loopback port allocation failed",
            CANDIDATE_API_PORTS
        )
    })
}

pub(crate) fn init_api_port() -> Result<()> {
    RESOLVED_API_PORT
        .set(resolve_api_port()?)
        .map_err(|_| anyhow::anyhow!("API port already resolved"))
}

pub(crate) fn init_api_port_explicit(port: u16) -> Result<()> {
    RESOLVED_API_PORT
        .set(port)
        .map_err(|_| anyhow::anyhow!("API port already resolved"))
}

pub(crate) struct ControlRoomGuard {
    web_port: Option<u16>,
    api_child: Option<std::process::Child>,
    frontend_child: Option<std::process::Child>,
}

impl ControlRoomGuard {
    pub fn inactive() -> Self {
        Self {
            web_port: None,
            api_child: None,
            frontend_child: None,
        }
    }

    pub fn active(
        web_port: u16,
        api_child: Option<std::process::Child>,
        frontend_child: Option<std::process::Child>,
    ) -> Self {
        Self {
            web_port: Some(web_port),
            api_child,
            frontend_child,
        }
    }
}

impl Drop for ControlRoomGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.frontend_child.take() {
            terminate_child_process(&mut child);
        }
        if let Some(mut child) = self.api_child.take() {
            terminate_child_process(&mut child);
        }
        let Some(web_port) = self.web_port else {
            return;
        };
        terminal_logger().emit(
            TerminalLogSource::Cli,
            format!("tearing down control room (port {web_port})"),
        );
        stop_control_room_frontend_processes(web_port);
    }
}

pub(crate) struct ControlPlaneReady {
    pub api_port: u16,
    pub web_url: String,
    pub web_port: u16,
    pub api_child: Option<std::process::Child>,
    pub frontend_child: Option<std::process::Child>,
}

fn browser_control_room_assets(root: &Path, dev_mode: bool) -> (PathBuf, PathBuf, PathBuf, bool) {
    // Prefer apps/control-room (v2 frontend). Fall back to apps/web then apps/legacy_web.
    let v2_dir = root.join("apps").join("control-room");
    let legacy_candidates = ["apps/web", "apps/legacy_web"].map(|p| root.join(p));
    let web_dir = if v2_dir.join("dev-server.mjs").is_file() {
        v2_dir
    } else {
        legacy_candidates
            .into_iter()
            .find(|p| p.join("dev-server.mjs").is_file())
            .unwrap_or_else(|| root.join("apps").join("web"))
    };
    let repo_local_static_web_root = root.join(".fullmag").join("local").join("web");
    let repo_built_static_web_root = web_dir.join("out");
    let static_web_root = if repo_local_static_web_root.join("index.html").is_file() {
        repo_local_static_web_root
    } else {
        repo_built_static_web_root
    };
    let external_control_room_available = if dev_mode {
        command_exists("node") && web_dir.join("dev-server.mjs").is_file()
    } else {
        command_exists("node")
            && web_dir.join("dev-server.mjs").is_file()
            && static_web_root.join("index.html").is_file()
    };
    (
        web_dir,
        static_web_root,
        root.join(".fullmag").join("control-room-mode.txt"),
        external_control_room_available,
    )
}

pub(crate) fn bootstrap_control_plane(
    _session_id: &str,
    dev_mode: bool,
    requested_port: Option<u16>,
    live_workspace: Option<&LocalLiveWorkspace>,
) -> Result<ControlPlaneReady> {
    let root = repo_root();
    let log_dir = root.join(".fullmag").join("logs");
    let url_file = root.join(".fullmag").join("control-room-url.txt");
    let (web_dir, static_web_root, mode_file, external_control_room_available) =
        browser_control_room_assets(&root, dev_mode);
    fs::create_dir_all(&log_dir)?;

    let stream_api_logs_to_terminal = dev_mode
        || std::env::var("FULLMAG_API_LOG_TO_TERMINAL")
            .ok()
            .map(|raw| {
                let value = raw.trim().to_ascii_lowercase();
                value == "1" || value == "true" || value == "yes" || value == "on"
            })
            .unwrap_or(false);
    let stream_web_logs_to_terminal = dev_mode
        || std::env::var("FULLMAG_WEB_LOG_TO_TERMINAL")
            .ok()
            .map(|raw| {
                let value = raw.trim().to_ascii_lowercase();
                value == "1" || value == "true" || value == "yes" || value == "on"
            })
            .unwrap_or(false);

    let api_child = if api_port() != 0 && api_bridge_is_ready(api_port()) {
        terminal_logger().emit(
            TerminalLogSource::Api,
            format!("reusing fullmag-api on :{} ...", api_port()),
        );
        None
    } else {
        terminal_logger().emit(
            TerminalLogSource::Api,
            format!("starting fullmag-api on :{} ...", api_port()),
        );
        let api_log = fs::File::create(log_dir.join("fullmag-api.log"))
            .context("failed to create api log")?;
        let api_err = api_log.try_clone()?;
        if stream_api_logs_to_terminal {
            terminal_logger().emit(
                TerminalLogSource::Api,
                "streaming fullmag-api logs to terminal in compact labeled mode (full log still saved to .fullmag/logs/fullmag-api.log)",
            );
        } else {
            terminal_logger().emit(
                TerminalLogSource::Api,
                format!(
                    "fullmag-api logs: {}",
                    log_dir.join("fullmag-api.log").display()
                ),
            );
        }

        let self_exe = std::env::current_exe().unwrap_or_default();
        let mut api_child = spawn_fullmag_api(
            &root,
            &self_exe,
            api_log,
            api_err,
            external_control_room_available,
            stream_api_logs_to_terminal,
        )?;
        wait_for_api_ready(api_port(), &mut api_child, Duration::from_secs(60))?;
        Some(api_child)
    };

    if let Some(live_workspace) = live_workspace {
        sync_current_live_workspace_snapshot(live_workspace)?;
        live_workspace.publish_snapshot();
    }

    let web_port = resolve_web_port(requested_port, &url_file)?;
    let desired_mode = if dev_mode { "dev" } else { "static" };

    if external_control_room_available {
        let web_cache_dir = web_dir.join(".next");
        let current_mode = fs::read_to_string(&mode_file).ok();

        if port_is_listening(web_port)
            && (!frontend_is_ready(web_port)
                || current_mode.as_deref().map(str::trim) != Some(desired_mode))
        {
            terminal_logger().emit(
                TerminalLogSource::Web,
                format!("restarting control room on :{} ...", web_port),
            );
            stop_control_room_frontend_processes(web_port);
            if dev_mode {
                let _ = fs::remove_dir_all(&web_cache_dir);
            }
        }

        let mut frontend_child = None;
        if !frontend_is_ready(web_port) {
            terminal_logger().emit(
                TerminalLogSource::Web,
                format!("starting control room on :{} ...", web_port),
            );
            let web_log = fs::File::create(log_dir.join("control-room.log"))
                .context("failed to create frontend log")?;
            let web_err = web_log.try_clone()?;
            let terminal_log_file = if stream_web_logs_to_terminal {
                Some(
                    web_log
                        .try_clone()
                        .context("failed to clone frontend log file for terminal streaming")?,
                )
            } else {
                None
            };

            let mut command = ProcessCommand::new("node");
            command
                .args([
                    "dev-server.mjs",
                    "--hostname",
                    "0.0.0.0",
                    "--port",
                    &web_port.to_string(),
                    "--api-target",
                    &api_base_url(),
                ])
                .current_dir(&web_dir)
                .env("FULLMAG_API_PROXY_TARGET", api_base_url())
                .stdin(Stdio::null());
            if stream_web_logs_to_terminal {
                terminal_logger().emit(
                    TerminalLogSource::Web,
                    "streaming control room logs to terminal in compact labeled mode (full log still saved to .fullmag/logs/control-room.log)",
                );
                command.stdout(Stdio::piped()).stderr(Stdio::piped());
            } else {
                terminal_logger().emit(
                    TerminalLogSource::Web,
                    format!(
                        "control room logs: {}",
                        log_dir.join("control-room.log").display()
                    ),
                );
                command.stdout(web_log).stderr(web_err);
            }
            configure_child_process(&mut command);

            if !dev_mode {
                command
                    .arg("--static-root")
                    .arg(&static_web_root)
                    .env("FULLMAG_STATIC_WEB_ROOT", &static_web_root);
            }

            let mut child = command
                .spawn()
                .context("failed to spawn control room server")?;
            if let Some(log_file) = terminal_log_file {
                terminal_logger().attach_child(&mut child, TerminalLogSource::Web, log_file)?;
            }
            frontend_child = Some(child);

            let _ = fs::write(&url_file, format!("http://localhost:{}", web_port));
            let _ = fs::write(&mode_file, desired_mode);

            for _ in 0..300 {
                if frontend_is_ready_for_bootstrap(web_port) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if !frontend_is_ready_for_bootstrap(web_port) {
                bail!("control room did not become ready on :{}", web_port);
            }
        } else {
            terminal_logger().emit(
                TerminalLogSource::Web,
                format!("reusing control room on :{}", web_port),
            );
        }

        return Ok(ControlPlaneReady {
            api_port: api_port(),
            web_url: format!("http://localhost:{web_port}/"),
            web_port,
            api_child,
            frontend_child,
        });
    }

    if !dev_mode {
        if !static_control_room_is_ready(api_port(), Duration::from_secs(20)) {
            bail!(
                "built control room did not become ready on :{}; rebuild the static control room with `make web-build-static` or `just build-static-control-room`, or run `fullmag --dev ...`",
                api_port()
            );
        }

        return Ok(ControlPlaneReady {
            api_port: api_port(),
            web_url: format!("http://{LOCALHOST_HTTP_HOST}:{}/", api_port()),
            web_port,
            api_child,
            frontend_child: None,
        });
    }

    bail!(
        "control room dev mode requires a local Node frontend; run `just build-static-control-room` and omit `--dev`, or install Node and keep `apps/web/dev-server.mjs` available"
    )
}

pub(crate) fn open_in_browser(ready: &ControlPlaneReady) {
    terminal_logger().emit(
        TerminalLogSource::Web,
        format!("gui server: {}", ready.web_url),
    );
    terminal_logger().emit(
        TerminalLogSource::Api,
        format!("swagger ui: {}", swagger_ui_url()),
    );
    terminal_logger().emit(
        TerminalLogSource::Api,
        format!("openapi json: {}", openapi_json_url()),
    );
    if let Ok(opener) = which_opener() {
        let _ = ProcessCommand::new(opener)
            .arg(&ready.web_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn find_fullmag_ui_binary() -> Result<PathBuf> {
    let root = repo_root();
    let self_exe = std::env::current_exe().unwrap_or_default();
    let candidates = [
        self_exe.with_file_name(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join(".fullmag")
            .join("local")
            .join("bin")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join("target")
            .join("debug")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join("target")
            .join("release")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join("target")
            .join(std::env::consts::ARCH)
            .join("debug")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join("target")
            .join("x86_64-pc-windows-msvc")
            .join("debug")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
        root.join("target")
            .join("x86_64-pc-windows-msvc")
            .join("release")
            .join(format!("fullmag-ui{EXE_SUFFIX}")),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| anyhow::anyhow!("fullmag-ui not built yet"))
}

pub(crate) fn open_in_tauri(
    ready: &ControlPlaneReady,
    intent: &str,
) -> Result<std::process::Child> {
    let ui_exe = find_fullmag_ui_binary()?;
    let mut command = ProcessCommand::new(&ui_exe);
    command
        .env("FULLMAG_UI_URL", &ready.web_url)
        .env(
            "FULLMAG_API_BASE",
            format!("http://localhost:{}/", ready.api_port),
        )
        .env("FULLMAG_LAUNCH_INTENT", intent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_child_process(&mut command);
    let child = command
        .spawn()
        .with_context(|| format!("failed to launch fullmag-ui: {}", ui_exe.display()))?;
    Ok(child)
}

pub(crate) fn spawn_control_room(
    session_id: &str,
    dev_mode: bool,
    requested_port: Option<u16>,
    live_workspace: &LocalLiveWorkspace,
) -> Result<(
    u16,
    Option<std::process::Child>,
    Option<std::process::Child>,
)> {
    let ready =
        bootstrap_control_plane(session_id, dev_mode, requested_port, Some(live_workspace))?;
    open_in_browser(&ready);
    Ok((ready.web_port, ready.api_child, ready.frontend_child))
}

pub(crate) fn sync_current_live_workspace_snapshot(
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    let snapshot = live_workspace.snapshot().snapshot();
    sync_current_live_snapshot(
        snapshot
            .session
            .as_ref()
            .map(|session| session.session_id.as_str())
            .unwrap_or("current"),
        &snapshot,
    )
}

fn resolve_web_port(requested: Option<u16>, url_file: &Path) -> Result<u16> {
    const CANDIDATE_PORTS: &[u16] = &[3000, 3001, 3002, 3003, 3004, 3005, 3010];

    if let Some(port) = requested {
        return Ok(port);
    }

    if let Ok(stored) = fs::read_to_string(url_file) {
        let stored = stored.trim();
        if let Some(port_str) = stored.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                if port_is_listening(port) {
                    return Ok(port);
                }
                if port_is_bindable(port) {
                    return Ok(port);
                }
            }
        }
    }

    for &port in CANDIDATE_PORTS {
        if port_is_listening(port) {
            return Ok(port);
        }
    }

    for &port in CANDIDATE_PORTS {
        if port_is_bindable(port) {
            return Ok(port);
        }
    }

    bail!("no free port found in {:?}", CANDIDATE_PORTS)
}

pub(crate) fn port_is_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

pub(crate) fn port_is_bindable(port: u16) -> bool {
    std::net::TcpListener::bind((std::net::Ipv4Addr::from(LOOPBACK_V4_OCTETS), port)).is_ok()
}

fn allocate_ephemeral_api_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::from(LOOPBACK_V4_OCTETS), 0))?;
    let port = listener.local_addr()?.port();
    if port == 0 {
        bail!("kernel returned port 0 for loopback API listener probe");
    }
    Ok(port)
}

fn frontend_is_ready(port: u16) -> bool {
    frontend_is_ready_with_timeout(port, Duration::from_millis(500))
}

fn frontend_is_ready_for_bootstrap(port: u16) -> bool {
    frontend_is_ready_with_timeout(port, Duration::from_secs(20))
}

fn static_control_room_is_ready(port: u16, timeout: Duration) -> bool {
    if !api_is_ready(port) {
        return false;
    }

    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .expect("static control room readiness client should build")
        .get(format!("http://{LOCALHOST_HTTP_HOST}:{port}/"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn frontend_is_ready_with_timeout(port: u16, timeout: Duration) -> bool {
    if !port_is_listening(port) {
        return false;
    }

    // Disable redirect following: a 3xx response means the server is up and responding.
    // Without this, a Next.js dev server that redirects / -> /workspace would cause reqwest
    // to follow the redirect. The redirect target is compiled lazily and may not be ready
    // within the timeout, producing a false-negative that triggers an unnecessary restart.
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("frontend readiness client should build")
        .get(format!("http://{LOCALHOST_HTTP_HOST}:{port}/"))
        .send()
        .map(|response| {
            let status = response.status();
            status.is_success() || status.is_redirection()
        })
        .unwrap_or(false)
}

fn stop_control_room_frontend_processes(port: u16) {
    let hosts = [
        "0.0.0.0".to_string(),
        std::net::Ipv4Addr::from(LOOPBACK_V4_OCTETS).to_string(),
        LOCALHOST_HTTP_HOST.to_string(),
    ];
    for host in hosts {
        for pattern in [
            format!("next dev --hostname {host} --port {port}"),
            format!("node dev-server.mjs --hostname {host} --port {port}"),
        ] {
            let _ = ProcessCommand::new("pkill")
                .args(["-f", &pattern])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while port_is_listening(port) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(crate) fn api_is_ready(port: u16) -> bool {
    let addr = std::net::SocketAddr::from((LOOPBACK_V4_OCTETS, port));
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn api_bridge_is_ready(port: u16) -> bool {
    if !api_is_ready(port) {
        return false;
    }

    let addr = std::net::SocketAddr::from((LOOPBACK_V4_OCTETS, port));
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
    let request = concat!(
        "POST /v1/internal/live/current/snapshot HTTP/1.1\r\n",
        "Host: localhost\r\n",
        "Content-Type: application/json\r\n",
        "Content-Length: 2\r\n",
        "Connection: close\r\n",
        "\r\n",
        "{}",
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200")
        || response.starts_with("HTTP/1.0 200")
        || response.starts_with("HTTP/1.1 400")
        || response.starts_with("HTTP/1.0 400")
        || response.starts_with("HTTP/1.1 422")
        || response.starts_with("HTTP/1.0 422")
}

pub(crate) fn current_live_api_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("current live API client should build")
    })
}

pub(crate) fn sync_current_live_snapshot(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("snapshot"))
        .json(&CurrentLiveSnapshotRequest {
            session_id,
            session: payload.session.as_ref(),
            session_status: payload.session_status.as_deref(),
            metadata: payload.metadata.as_ref(),
            mesh_workspace: payload.mesh_workspace.as_ref(),
            stage_execution: payload.stage_execution.as_ref(),
            run: payload.run.as_ref(),
            live_state: payload.live_state.as_ref(),
            latest_scalar_row: payload.latest_scalar_row.as_ref(),
            latest_fields: payload.latest_fields.as_ref(),
            preview_fields: payload.preview_fields.as_deref(),
            clear_preview_cache: payload.clear_preview_cache,
            engine_log: payload.engine_log.as_deref(),
            solver_profile: payload.solver_profile.as_ref(),
            fem_mesh: payload.fem_mesh.as_ref(),
        })
        .send()
        .context("failed to sync current live snapshot")?
        .error_for_status()
        .context("current live snapshot endpoint returned error")?;
    Ok(())
}

fn sync_current_live_session_frame(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("session"))
        .json(&CurrentLiveSessionFrameRequest {
            session_id,
            session: payload.session.as_ref(),
            session_status: payload.session_status.as_deref(),
            metadata: payload.metadata.as_ref(),
            mesh_workspace: payload.mesh_workspace.as_ref(),
            stage_execution: payload.stage_execution.as_ref(),
            run: payload.run.as_ref(),
        })
        .send()
        .context("failed to sync current live session frame")?
        .error_for_status()
        .context("current live session frame endpoint returned error")?;
    Ok(())
}

fn sync_current_live_runtime_frame(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("runtime"))
        .json(&CurrentLiveRuntimeFrameRequest {
            session_id,
            live_state: payload.live_state.as_ref(),
            engine_log: payload.engine_log.as_deref(),
            solver_profile: payload.solver_profile.as_ref(),
            fem_mesh: payload.fem_mesh.as_ref(),
        })
        .send()
        .context("failed to sync current live runtime frame")?
        .error_for_status()
        .context("current live runtime frame endpoint returned error")?;
    Ok(())
}

fn sync_current_live_scalar_frame(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("scalars"))
        .json(&CurrentLiveScalarFrameRequest {
            session_id,
            latest_scalar_row: payload.latest_scalar_row.as_ref(),
        })
        .send()
        .context("failed to sync current live scalar frame")?
        .error_for_status()
        .context("current live scalar frame endpoint returned error")?;
    Ok(())
}

fn sync_current_live_field_frame(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("fields"))
        .json(&CurrentLiveFieldFrameRequest {
            session_id,
            latest_fields: payload.latest_fields.as_ref(),
            preview_fields: payload.preview_fields.as_deref(),
            clear_preview_cache: payload.clear_preview_cache,
        })
        .send()
        .context("failed to sync current live field frame")?
        .error_for_status()
        .context("current live field frame endpoint returned error")?;
    Ok(())
}

pub(crate) fn sync_current_live_delta(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    if payload.session.is_some()
        || payload.session_status.is_some()
        || payload.metadata.is_some()
        || payload.mesh_workspace.is_some()
        || payload.stage_execution.is_some()
        || payload.run.is_some()
    {
        sync_current_live_session_frame(session_id, payload)?;
    }

    if payload.live_state.is_some() || payload.engine_log.is_some() || payload.fem_mesh.is_some() {
        sync_current_live_runtime_frame(session_id, payload)?;
    }

    if payload.latest_scalar_row.is_some() {
        sync_current_live_scalar_frame(session_id, payload)?;
    }

    if payload.latest_fields.is_some()
        || payload.preview_fields.is_some()
        || payload.clear_preview_cache
    {
        sync_current_live_field_frame(session_id, payload)?;
    }

    Ok(())
}

pub(crate) fn spawn_fullmag_api(
    root: &Path,
    self_exe: &Path,
    stdout: fs::File,
    stderr: fs::File,
    disable_static_control_room: bool,
    stream_logs_to_terminal: bool,
) -> Result<std::process::Child> {
    let sibling_api = self_exe.with_file_name(format!("fullmag-api{EXE_SUFFIX}"));
    let web_static_dir = {
        let repo_local = root.join(".fullmag").join("local").join("web");
        if repo_local.join("index.html").is_file() {
            repo_local
        } else {
            root.join("apps").join("web").join("out")
        }
    };
    let candidates = [
        sibling_api,
        root.join(".fullmag")
            .join("local")
            .join("bin")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join(".fullmag")
            .join("target")
            .join("release")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join(".fullmag")
            .join("target")
            .join("debug")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join("target")
            .join("release")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join("target")
            .join("debug")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join("target")
            .join("x86_64-pc-windows-msvc")
            .join("release")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        root.join("target")
            .join("x86_64-pc-windows-msvc")
            .join("debug")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
    ];

    if let Some(path) = candidates.iter().find(|candidate| candidate.exists()) {
        let mut command = ProcessCommand::new(path);
        let terminal_log_file = if stream_logs_to_terminal {
            Some(
                stdout
                    .try_clone()
                    .context("failed to clone api log file for terminal streaming")?,
            )
        } else {
            None
        };
        command
            .current_dir(root)
            .env("FULLMAG_API_PORT", api_port().to_string())
            .env("FULLMAG_WEB_STATIC_DIR", &web_static_dir)
            .stdin(Stdio::null());
        if stream_logs_to_terminal {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command.stdout(stdout).stderr(stderr);
        }
        configure_child_process(&mut command);
        configure_repo_local_library_env(&mut command, root, Some(path));
        if disable_static_control_room {
            command.env("FULLMAG_DISABLE_STATIC_CONTROL_ROOM", "1");
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn fullmag-api binary {}", path.display()))?;
        if let Some(log_file) = terminal_log_file {
            terminal_logger().attach_child(&mut child, TerminalLogSource::Api, log_file)?;
        }
        return Ok(child);
    }

    let mut command = ProcessCommand::new("cargo");
    let terminal_log_file = if stream_logs_to_terminal {
        Some(
            stdout
                .try_clone()
                .context("failed to clone api log file for terminal streaming")?,
        )
    } else {
        None
    };
    command
        .args(["run", "-p", "fullmag-api"])
        .current_dir(root)
        .env("FULLMAG_API_PORT", api_port().to_string())
        .env("FULLMAG_WEB_STATIC_DIR", &web_static_dir)
        .stdin(Stdio::null());
    if stream_logs_to_terminal {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        command.stdout(stdout).stderr(stderr);
    }
    configure_child_process(&mut command);
    configure_repo_local_library_env(&mut command, root, None);
    if disable_static_control_room {
        command.env("FULLMAG_DISABLE_STATIC_CONTROL_ROOM", "1");
    }
    let mut child = command
        .spawn()
        .context("failed to spawn fullmag-api via cargo")?;
    if let Some(log_file) = terminal_log_file {
        terminal_logger().attach_child(&mut child, TerminalLogSource::Api, log_file)?;
    }
    Ok(child)
}

#[cfg(unix)]
fn configure_child_process(command: &mut ProcessCommand) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    return Err(io::Error::from_raw_os_error(libc::ECHILD));
                }
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_child_process(_command: &mut ProcessCommand) {}

fn terminate_child_process(child: &mut std::process::Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    {
        let pgid = child.id() as i32;
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn configure_repo_local_library_env(
    command: &mut ProcessCommand,
    root: &Path,
    executable_path: Option<&Path>,
) {
    let mut library_dirs = Vec::new();
    if let Some(parent) = executable_path.and_then(|path| path.parent()) {
        library_dirs.push(parent.join("../lib"));
    }
    library_dirs.push(root.join(".fullmag").join("local").join("lib"));

    let Some(lib_dir) = library_dirs.into_iter().find(|path| path.is_dir()) else {
        return;
    };

    #[cfg(windows)]
    {
        let mut merged = OsString::from(lib_dir.as_os_str());
        if let Some(current) = std::env::var_os("PATH") {
            if !current.is_empty() {
                merged.push(";");
                merged.push(current);
            }
        }
        command.env("PATH", merged);
    }
    #[cfg(not(windows))]
    {
        let mut merged = OsString::from(lib_dir.as_os_str());
        if let Some(current) = std::env::var_os("LD_LIBRARY_PATH") {
            if !current.is_empty() {
                merged.push(":");
                merged.push(current);
            }
        }
        command.env("LD_LIBRARY_PATH", merged);
    }
}

fn wait_for_api_ready(port: u16, child: &mut std::process::Child, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if api_bridge_is_ready(port) {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .context("failed to poll fullmag-api process")?
        {
            bail!(
                "fullmag-api exited before becoming ready (status: {})",
                status
            );
        }
        if Instant::now() >= deadline {
            bail!("fullmag-api did not become ready on :{}", port);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(crate) fn which_opener() -> Result<String> {
    for cmd in ["xdg-open", "open", "wslview"] {
        if ProcessCommand::new("which")
            .arg(cmd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(cmd.to_string());
        }
    }
    bail!("no browser opener found")
}

pub(crate) fn command_exists(cmd: &str) -> bool {
    ProcessCommand::new("which")
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

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

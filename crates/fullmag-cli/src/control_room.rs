use anyhow::{bail, Context, Result};
use std::ffi::{OsStr, OsString};
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

fn web_public_host() -> String {
    if let Some(configured) = std::env::var("FULLMAG_WEB_HOST")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return configured;
    }

    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        if let Ok(output) = ProcessCommand::new("hostname").arg("-I").output() {
            if output.status.success() {
                if let Some(host) = String::from_utf8_lossy(&output.stdout)
                    .split_whitespace()
                    .find(|candidate| !candidate.contains(':'))
                {
                    return host.to_string();
                }
            }
        }
    }

    LOCALHOST_HTTP_HOST.to_string()
}

fn web_public_url(port: u16) -> String {
    let host = web_public_host();
    let formatted_host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    format!("http://{formatted_host}:{port}")
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
        if std::env::var_os("FULLMAG_ATTACHED_SESSION_ID").is_some() {
            // The scratch supervisor already verified this API before spawning
            // the attached child.  Re-reading the large OpenAPI document here
            // races with the first live snapshot on busy local Windows hosts.
            return Ok(port);
        }
        if api_bridge_is_ready(port) || port_is_bindable(port) {
            return Ok(port);
        }
        bail!("requested FULLMAG_API_PORT={port} is not bindable and does not serve a compatible fullmag-api");
    }

    if api_bridge_is_ready(8081) || port_is_bindable(8081) {
        return Ok(8081);
    }

    const CANDIDATE_API_PORTS: &[u16] = &[8080, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];
    for &port in CANDIDATE_API_PORTS {
        if api_bridge_is_ready(port) {
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

fn resolve_headless_api_port_with(
    raw: Option<&OsStr>,
    compatible: impl Fn(u16) -> bool,
) -> Result<u16> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let raw = raw.to_string_lossy();
    let port = raw
        .trim()
        .parse::<u16>()
        .with_context(|| format!("FULLMAG_API_PORT must be a valid u16 port, got '{raw}'"))?;
    if port == 0 {
        return Ok(0);
    }
    if !compatible(port) {
        bail!("headless FULLMAG_API_PORT={port} must already serve a compatible fullmag-api");
    }
    Ok(port)
}

pub(crate) fn init_headless_api_port() -> Result<()> {
    let port = resolve_headless_api_port_with(
        std::env::var_os("FULLMAG_API_PORT").as_deref(),
        api_bridge_is_ready,
    )?;
    init_api_port_explicit(port)
}

pub(crate) fn init_api_port_explicit(port: u16) -> Result<()> {
    RESOLVED_API_PORT
        .set(port)
        .map_err(|_| anyhow::anyhow!("API port already resolved"))
}

#[cfg(test)]
mod headless_api_port_tests {
    use std::ffi::OsStr;

    use super::resolve_headless_api_port_with;

    #[test]
    fn absent_headless_api_port_stays_disabled() {
        assert_eq!(resolve_headless_api_port_with(None, |_| false).unwrap(), 0);
    }

    #[test]
    fn explicit_zero_headless_api_port_stays_disabled() {
        assert_eq!(
            resolve_headless_api_port_with(Some(OsStr::new("0")), |_| false).unwrap(),
            0
        );
    }

    #[test]
    fn explicit_nonzero_headless_api_port_requires_compatible_api() {
        assert_eq!(
            resolve_headless_api_port_with(Some(OsStr::new("18233")), |port| port == 18233)
                .unwrap(),
            18233
        );
        let error =
            resolve_headless_api_port_with(Some(OsStr::new("18233")), |_| false).unwrap_err();
        assert!(error.to_string().contains("compatible fullmag-api"));
    }

    #[test]
    fn malformed_headless_api_port_fails_closed() {
        let error =
            resolve_headless_api_port_with(Some(OsStr::new("invalid")), |_| true).unwrap_err();
        assert!(error.to_string().contains("valid u16 port"));
    }
}

trait GuardedProcess {
    fn terminate(&mut self);
}

struct ChildProcess(std::process::Child);

impl GuardedProcess for ChildProcess {
    fn terminate(&mut self) {
        terminate_child_process(&mut self.0);
    }
}

struct BootstrapProcessGuard<P: GuardedProcess> {
    process: Option<P>,
}

impl<P: GuardedProcess> BootstrapProcessGuard<P> {
    fn new(process: P) -> Self {
        Self {
            process: Some(process),
        }
    }

    fn process_mut(&mut self) -> &mut P {
        self.process
            .as_mut()
            .expect("bootstrap process guard must own a process")
    }

    fn release(mut self) -> P {
        self.process
            .take()
            .expect("bootstrap process guard must own a process")
    }
}

impl<P: GuardedProcess> Drop for BootstrapProcessGuard<P> {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.terminate();
        }
    }
}

pub(crate) struct ControlRoomGuard {
    web_port: Option<u16>,
    api_child: Option<Box<dyn GuardedProcess>>,
    frontend_child: Option<Box<dyn GuardedProcess>>,
    terminal_failure_lifetime: Option<Box<dyn FnOnce()>>,
    stop_frontend_on_drop: bool,
}

impl ControlRoomGuard {
    pub fn inactive() -> Self {
        Self {
            web_port: None,
            api_child: None,
            frontend_child: None,
            terminal_failure_lifetime: None,
            stop_frontend_on_drop: false,
        }
    }

    pub fn active(
        web_port: u16,
        api_child: Option<std::process::Child>,
        frontend_child: Option<std::process::Child>,
    ) -> Self {
        let stop_frontend_on_drop = frontend_child.is_some();
        Self {
            web_port: Some(web_port),
            api_child: api_child
                .map(|child| Box::new(ChildProcess(child)) as Box<dyn GuardedProcess>),
            frontend_child: frontend_child
                .map(|child| Box::new(ChildProcess(child)) as Box<dyn GuardedProcess>),
            terminal_failure_lifetime: None,
            stop_frontend_on_drop,
        }
    }

    pub fn retain_terminal_failure_until_close(&mut self, wait_for_close: impl FnOnce() + 'static) {
        if self.api_child.is_none() && self.frontend_child.is_none() {
            return;
        }
        self.terminal_failure_lifetime = Some(Box::new(wait_for_close));
    }

    #[cfg(test)]
    fn active_for_test(
        api_child: Option<Box<dyn GuardedProcess>>,
        frontend_child: Option<Box<dyn GuardedProcess>>,
    ) -> Self {
        Self {
            web_port: None,
            api_child,
            frontend_child,
            terminal_failure_lifetime: None,
            stop_frontend_on_drop: false,
        }
    }
}

impl Drop for ControlRoomGuard {
    fn drop(&mut self) {
        if let Some(wait_for_close) = self.terminal_failure_lifetime.take() {
            wait_for_close();
        }
        let stop_frontend_on_drop = self.stop_frontend_on_drop;
        if let Some(mut child) = self.frontend_child.take() {
            child.terminate();
        }
        if let Some(mut child) = self.api_child.take() {
            child.terminate();
        }
        if !stop_frontend_on_drop {
            return;
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

fn control_room_launch_signature(dev_mode: bool, api_base_url: &str) -> String {
    let mode = if dev_mode { "dev" } else { "static" };
    format!("{mode}\n{}", api_base_url.trim_end_matches('/'))
}

fn packaged_install_root(self_exe: &Path) -> Option<PathBuf> {
    let bin_dir = self_exe.parent()?;
    if !bin_dir
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("bin")
    {
        return None;
    }
    let install_root = bin_dir.parent()?.to_path_buf();
    (install_root.join(".fullmag").is_dir() || install_root.join("web").is_dir())
        .then_some(install_root)
}

#[cfg(test)]
mod control_room_guard_tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[cfg(windows)]
    use super::command_exists;
    use super::{
        api_openapi_response_is_compatible, browser_control_room_assets, browser_open_args,
        control_room_launch_signature, packaged_install_root, wait_for_api_ready,
        BootstrapProcessGuard, ControlRoomGuard, GuardedProcess,
    };
    use std::process::Command as TestCommand;

    struct RecordingProcess {
        events: Arc<Mutex<Vec<&'static str>>>,
        label: &'static str,
    }

    impl GuardedProcess for RecordingProcess {
        fn terminate(&mut self) {
            self.events.lock().unwrap().push(self.label);
        }
    }

    #[test]
    fn reused_frontend_is_not_stopped_on_drop() {
        let guard = ControlRoomGuard::active(3100, None, None);

        assert!(!guard.stop_frontend_on_drop);
    }

    #[test]
    fn frontend_reuse_signature_tracks_mode_and_api_target() {
        assert_ne!(
            control_room_launch_signature(true, "http://localhost:8080"),
            control_room_launch_signature(true, "http://localhost:8081"),
        );
        assert_ne!(
            control_room_launch_signature(true, "http://localhost:8081"),
            control_room_launch_signature(false, "http://localhost:8081"),
        );
    }

    #[test]
    fn wsl_windows_opener_uses_cmd_start_syntax() {
        assert_eq!(
            browser_open_args(
                "/mnt/c/Windows/System32/cmd.exe",
                "http://172.17.101.240:3100/",
            ),
            vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                "http://172.17.101.240:3100/".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_windows_command_lookup_finds_cmd() {
        assert!(command_exists("cmd.exe"));
    }

    #[test]
    fn terminal_failure_lifetime_precedes_owned_process_termination() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut guard = ControlRoomGuard::active_for_test(
            Some(Box::new(RecordingProcess {
                events: Arc::clone(&events),
                label: "api-terminated",
            })),
            Some(Box::new(RecordingProcess {
                events: Arc::clone(&events),
                label: "frontend-terminated",
            })),
        );
        let failure_events = Arc::clone(&events);
        guard.retain_terminal_failure_until_close(move || {
            failure_events.lock().unwrap().push("explicit-close");
        });

        drop(guard);

        assert_eq!(
            *events.lock().unwrap(),
            vec!["explicit-close", "frontend-terminated", "api-terminated"]
        );
    }

    #[test]
    fn ordinary_owned_process_cleanup_does_not_wait_for_failure_close() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let guard = ControlRoomGuard::active_for_test(
            Some(Box::new(RecordingProcess {
                events: Arc::clone(&events),
                label: "api-terminated",
            })),
            None,
        );

        drop(guard);

        assert_eq!(*events.lock().unwrap(), vec!["api-terminated"]);
    }

    #[test]
    fn bootstrap_process_guard_terminates_unreleased_processes_only() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let guard = BootstrapProcessGuard::new(RecordingProcess {
            events: Arc::clone(&events),
            label: "bootstrap-terminated",
        });

        drop(guard);
        assert_eq!(*events.lock().unwrap(), vec!["bootstrap-terminated"]);

        events.lock().unwrap().clear();
        let guard = BootstrapProcessGuard::new(RecordingProcess {
            events: Arc::clone(&events),
            label: "released-process",
        });
        let mut released = guard.release();

        assert!(events.lock().unwrap().is_empty());
        released.terminate();
        assert_eq!(*events.lock().unwrap(), vec!["released-process"]);
    }

    #[test]
    fn api_reuse_rejects_health_only_or_stale_openapi_responses() {
        let stale = concat!(
            "HTTP/1.1 200 OK\r\n",
            "x-api-contract-version: 1.0.0\r\n\r\n",
            "{\"paths\":{",
            "\"/v2/sessions/current/model/scene\":{},",
            "\"/v2/sessions/current/data/mesh-region-memberships\":{},",
            "\"/v2/sessions/current/simulation/objects/{object_id}/metrics\":{}",
            "},\"x-fullmag-study-primitive-stage-kinds\":",
            "[\"relax\",\"run\",\"change_device\"]}",
        );
        assert!(!api_openapi_response_is_compatible(stale));

        let identity = fullmag_build_info::identity();
        let current = format!(
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "x-api-contract-version: 1.0.0\r\n\r\n",
                "{{\"paths\":{{",
                "\"/v2/sessions/current/model/scene\":{{}},",
                "\"/v2/sessions/current/data/mesh-region-memberships\":{{}},",
                "\"/v2/sessions/current/simulation/objects/{{object_id}}/metrics\":{{}}",
                "}},\"x-fullmag-study-primitive-stage-kinds\":",
                "[\"add_field_drive\",\"remove_field_drive\",\"table_autosave\",\"autosave\",\"fft_response\"],",
                "\"x-fullmag-build-identity\":{{",
                "\"built_at_utc\":\"{}\",",
                "\"git_commit\":\"{}\",",
                "\"worktree_state\":\"{}\",",
                "\"source_snapshot_sha256\":\"{}\"",
                "}}}}"
            ),
            identity.built_at_utc,
            identity.git_commit,
            identity.worktree_state,
            identity.source_snapshot_sha256,
        );
        assert!(api_openapi_response_is_compatible(&current));

        let foreign = current.replacen(identity.git_commit, &"0".repeat(40), 1);
        assert!(!api_openapi_response_is_compatible(&foreign));

        let mismatched_snapshot = if identity.source_snapshot_sha256 == "0".repeat(64) {
            "1".repeat(64)
        } else {
            "0".repeat(64)
        };
        let foreign_snapshot =
            current.replacen(identity.source_snapshot_sha256, &mismatched_snapshot, 1);
        assert!(!api_openapi_response_is_compatible(&foreign_snapshot));

        let missing_identity = current
            .split_once(",\"x-fullmag-build-identity\"")
            .map(|(prefix, _)| format!("{prefix}}}"))
            .expect("fixture should contain build identity");
        assert!(!api_openapi_response_is_compatible(&missing_identity));
    }

    #[test]
    fn startup_wait_accepts_health_ready_api_before_contract_probe_finishes() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::from(super::LOOPBACK_V4_OCTETS), 0))
            .expect("readiness fixture should bind");
        listener
            .set_nonblocking(true)
            .expect("readiness fixture should be nonblocking");
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = thread::spawn(move || {
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 4096];
                        let _ = stream.read(&mut request);
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => break,
                }
            }
        });
        let mut child = TestCommand::new("sh")
            .args(["-c", "sleep 2"])
            .spawn()
            .expect("readiness fixture child should start");

        let result = wait_for_api_ready(port, &mut child, Duration::from_millis(500));

        stop.store(true, Ordering::Release);
        let _ = child.kill();
        let _ = child.wait();
        let _ = server.join();

        assert!(
            result.is_ok(),
            "health-ready API must not be blocked by the optional contract probe: {result:?}"
        );
    }

    #[test]
    fn packaged_install_root_is_derived_from_bin_executable() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-packaged-root-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join(".fullmag")).unwrap();

        assert_eq!(
            packaged_install_root(&root.join("bin").join("fullmag")),
            Some(root.clone())
        );
        assert_eq!(
            packaged_install_root(&root.join("target").join("fullmag")),
            None
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_canonical_control_room_dev_server_fails_closed_without_legacy_fallback() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-control-room-missing-v2-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let legacy_root = root.join("apps").join("legacy".to_string() + "_web");
        std::fs::create_dir_all(&legacy_root).unwrap();
        std::fs::write(legacy_root.join("dev-server.mjs"), "legacy").unwrap();

        let error = browser_control_room_assets(&root, true).unwrap_err();

        assert!(error
            .to_string()
            .contains("apps/control-room/dev-server.mjs"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_control_room_wins_when_reference_tree_exists() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-control-room-canonical-v2-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("apps/control-room")).unwrap();
        let legacy_root = root.join("apps").join("legacy".to_string() + "_web");
        std::fs::create_dir_all(&legacy_root).unwrap();
        std::fs::write(root.join("apps/control-room/dev-server.mjs"), "v2").unwrap();
        std::fs::write(legacy_root.join("dev-server.mjs"), "legacy").unwrap();

        let (web_dir, _, _, _available) = browser_control_room_assets(&root, true).unwrap();

        assert_eq!(web_dir, root.join("apps/control-room"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub(crate) struct ControlPlaneReady {
    pub api_port: u16,
    pub web_url: String,
    pub web_port: u16,
    pub api_child: Option<std::process::Child>,
    pub frontend_child: Option<std::process::Child>,
}

fn browser_control_room_assets(
    root: &Path,
    dev_mode: bool,
) -> Result<(PathBuf, PathBuf, PathBuf, bool)> {
    // The v2 Control Room is the only supported runtime frontend. Legacy paths
    // remain reference material and must never be selected by the launcher.
    let v2_dir = root.join("apps").join("control-room");
    let dev_server = v2_dir.join("dev-server.mjs");
    if dev_mode && !dev_server.is_file() {
        bail!(
            "canonical Control Room frontend is unavailable: expected {}",
            dev_server.display()
        );
    }
    let repo_local_static_web_root = root.join(".fullmag").join("local").join("web");
    let repo_built_static_web_root = v2_dir.join("out");
    let static_web_root = if repo_local_static_web_root.join("index.html").is_file() {
        repo_local_static_web_root
    } else {
        repo_built_static_web_root
    };
    let external_control_room_available = if dev_mode {
        command_exists("node") && dev_server.is_file()
    } else {
        command_exists("node")
            && dev_server.is_file()
            && static_web_root.join("index.html").is_file()
    };
    Ok((
        v2_dir,
        static_web_root,
        root.join(".fullmag").join("control-room-mode.txt"),
        external_control_room_available,
    ))
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
        browser_control_room_assets(&root, dev_mode)?;
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
        let mut api_child = BootstrapProcessGuard::new(ChildProcess(spawn_fullmag_api(
            &root,
            &self_exe,
            api_log,
            api_err,
            external_control_room_available,
            stream_api_logs_to_terminal,
        )?));
        wait_for_api_ready(
            api_port(),
            &mut api_child.process_mut().0,
            Duration::from_secs(60),
        )?;
        Some(api_child)
    };

    if let Some(live_workspace) = live_workspace {
        // The publisher is already running and has a pending snapshot from
        // workspace startup.  Keep the first sync off the bootstrap critical
        // path so a busy API cannot delay or abort Control Room startup.
        live_workspace.publish_snapshot();
    }

    let web_port = resolve_web_port(requested_port, &url_file)?;
    let desired_signature = control_room_launch_signature(dev_mode, &api_base_url());

    if external_control_room_available {
        let web_cache_dir = web_dir.join(".next");
        let current_mode = fs::read_to_string(&mode_file).ok();

        if port_is_listening(web_port)
            && (!frontend_is_ready(web_port)
                || current_mode.as_deref().map(str::trim) != Some(desired_signature.as_str()))
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
                .env("FULLMAG_WEB_PUBLIC_HOST", web_public_host())
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

            let mut child = BootstrapProcessGuard::new(ChildProcess(
                command
                    .spawn()
                    .context("failed to spawn control room server")?,
            ));
            if let Some(log_file) = terminal_log_file {
                terminal_logger().attach_child(
                    &mut child.process_mut().0,
                    TerminalLogSource::Web,
                    log_file,
                )?;
            }
            frontend_child = Some(child);

            let _ = fs::write(&url_file, web_public_url(web_port));
            let _ = fs::write(&mode_file, &desired_signature);

            let bootstrap_deadline = Instant::now() + Duration::from_secs(90);
            let frontend_ready = loop {
                if Instant::now() >= bootstrap_deadline {
                    break false;
                }
                if frontend_is_ready_for_bootstrap(web_port) {
                    break true;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            };
            if !frontend_ready {
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
            web_url: format!("{}/", web_public_url(web_port)),
            web_port,
            api_child: api_child.map(|child| child.release().0),
            frontend_child: frontend_child.map(|child| child.release().0),
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
            web_url: format!("{}/", web_public_url(api_port())),
            web_port,
            api_child: api_child.map(|child| child.release().0),
            frontend_child: None,
        });
    }

    bail!(
        "control room dev mode requires the canonical Control Room frontend at apps/control-room/dev-server.mjs; run `just build-static-control-room` and omit `--dev`, or install the Control Room dependencies"
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
    match which_opener() {
        Ok(opener) => {
            let args = browser_open_args(&opener, &ready.web_url);
            if let Err(error) = ProcessCommand::new(&opener)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                terminal_logger().emit(
                    TerminalLogSource::Cli,
                    format!(
                        "browser auto-launch failed via {opener}: {error}; open {} manually",
                        ready.web_url
                    ),
                );
            }
        }
        Err(error) => {
            terminal_logger().emit(
                TerminalLogSource::Cli,
                format!(
                    "browser auto-launch unavailable: {error}; open {} manually",
                    ready.web_url
                ),
            );
        }
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

fn resolve_web_port(requested: Option<u16>, url_file: &Path) -> Result<u16> {
    const CANDIDATE_PORTS: &[u16] = &[3000, 3001, 3002, 3003, 3004, 3005, 3010];

    if let Some(port) = requested {
        if port_is_listening(port) || port_is_bindable(port) {
            return Ok(port);
        }
        bail!(
            "requested --web-port={port} is not available for the 0.0.0.0 frontend listener; choose another port or stop the process using it"
        );
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
    std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).is_ok()
}

#[cfg(test)]
mod web_port_tests {
    use super::{port_is_bindable, resolve_web_port};
    use std::net::TcpListener;

    #[test]
    fn wildcard_occupied_port_is_not_reported_as_bindable() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
            .expect("wildcard test listener should bind");
        let port = listener
            .local_addr()
            .expect("wildcard test listener should have an address")
            .port();

        assert!(!port_is_bindable(port));
    }

    #[test]
    fn explicit_occupied_web_port_is_rejected_before_frontend_spawn() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
            .expect("wildcard test listener should bind");
        let port = listener
            .local_addr()
            .expect("wildcard test listener should have an address")
            .port();
        let url_file = std::env::temp_dir().join(format!(
            "fullmag-control-room-port-test-{}",
            std::process::id()
        ));

        let error = resolve_web_port(Some(port), &url_file)
            .expect_err("an occupied explicit web port must fail before spawning Next");
        assert!(error.to_string().contains("--web-port"));
    }
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
            format!("next dev .*--hostname {host}.*--port {port}"),
            format!("next dev .*--hostname {host}.*-p {port}"),
            format!("next dev .*--port {port}"),
            format!("next dev .*-p {port}"),
            format!("node dev-server.mjs --hostname {host} --port {port}"),
            format!("node dev-server.mjs .*--hostname {host}.*--port {port}"),
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
    if !api_openapi_is_compatible(port) {
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

fn api_openapi_is_compatible(port: u16) -> bool {
    let addr = std::net::SocketAddr::from((LOOPBACK_V4_OCTETS, port));
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    // The v2 document is intentionally comprehensive and can exceed half a
    // megabyte on a local Windows checkout.  Keep the compatibility probe
    // bounded, but allow the full response to arrive before rejecting a
    // healthy API as incompatible.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
    if stream
        .write_all(b"GET /v2/platform/openapi.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && api_openapi_response_is_compatible(&response)
}

fn api_openapi_response_is_compatible(response: &str) -> bool {
    const REQUIRED_STAGE_KINDS: [&str; 5] = [
        "add_field_drive",
        "remove_field_drive",
        "table_autosave",
        "autosave",
        "fft_response",
    ];

    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let headers = headers.to_ascii_lowercase();
    if !(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        || !headers.contains("x-api-contract-version: 1.0.0")
    {
        return false;
    }
    let Ok(document) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let Some(paths) = document.get("paths").and_then(serde_json::Value::as_object) else {
        return false;
    };
    let Some(stage_kinds) = document
        .get("x-fullmag-study-primitive-stage-kinds")
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    if !api_build_identity_is_compatible(&document) {
        return false;
    }

    paths.contains_key("/v2/sessions/current/model/scene")
        && paths.contains_key("/v2/sessions/current/data/mesh-region-memberships")
        && paths.contains_key("/v2/sessions/current/simulation/objects/{object_id}/metrics")
        && REQUIRED_STAGE_KINDS.iter().all(|required| {
            stage_kinds
                .iter()
                .any(|kind| kind.as_str() == Some(required))
        })
}

fn api_build_identity_is_compatible(document: &serde_json::Value) -> bool {
    let Some(remote) = document
        .get("x-fullmag-build-identity")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(remote_commit) = remote.get("git_commit").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(remote_snapshot) = remote
        .get("source_snapshot_sha256")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let local = fullmag_build_info::identity();
    if remote_commit != local.git_commit {
        return false;
    }

    let local_snapshot_is_known = local.source_snapshot_sha256 != "unknown";
    let remote_snapshot_is_known = remote_snapshot != "unknown";
    if local_snapshot_is_known || remote_snapshot_is_known {
        return remote_snapshot == local.source_snapshot_sha256;
    }

    true
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

fn current_live_snapshot_api_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .expect("current live snapshot API client should build")
    })
}

pub(crate) fn sync_current_live_snapshot(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    current_live_snapshot_api_client()
        .post(internal_live_api_url("snapshot"))
        .json(&CurrentLiveSnapshotRequest {
            session_id,
            session: payload.session.as_ref(),
            session_status: payload.session_status.as_deref(),
            metadata: payload.metadata.as_ref(),
            mesh_workspace: payload.mesh_workspace.as_ref(),
            stage_execution: payload.stage_execution.as_ref(),
            simulation_preparation: payload.simulation_preparation.as_ref(),
            run: payload.run.as_ref(),
            live_state: payload.live_state.as_ref(),
            latest_scalar_row: payload.latest_scalar_row.as_ref(),
            latest_fields: payload.latest_fields.as_ref(),
            replace_latest_fields: payload.replace_latest_fields,
            field_generation: payload.field_generation.as_ref(),
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
            simulation_preparation: payload.simulation_preparation.as_ref(),
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
            replace_latest_fields: payload.replace_latest_fields,
            field_generation: payload.field_generation.as_ref(),
            preview_fields: payload.preview_fields.as_deref(),
            clear_preview_cache: payload.clear_preview_cache,
        })
        .send()
        .context("failed to sync current live field frame")?
        .error_for_status()
        .context("current live field frame endpoint returned error")?;
    Ok(())
}

fn sync_current_live_heartbeat(session_id: &str) -> Result<()> {
    current_live_api_client()
        .post(internal_live_api_url("heartbeat"))
        .json(&serde_json::json!({ "session_id": session_id }))
        .send()
        .context("failed to sync current live heartbeat")?
        .error_for_status()
        .context("current live heartbeat endpoint returned error")?;
    Ok(())
}

fn payload_has_current_live_delta(payload: &CurrentLiveSnapshotPayload) -> bool {
    payload.replace_latest_fields
        || payload.latest_scalar_row.is_some()
        || payload_routes_to_current_live_session_frame(payload)
        || payload.live_state.is_some()
        || payload.engine_log.is_some()
        || payload.solver_profile.is_some()
        || payload.fem_mesh.is_some()
        || payload.latest_fields.is_some()
        || payload.preview_fields.is_some()
        || payload.clear_preview_cache
}

fn payload_routes_to_current_live_session_frame(payload: &CurrentLiveSnapshotPayload) -> bool {
    payload.session.is_some()
        || payload.session_status.is_some()
        || payload.metadata.is_some()
        || payload.mesh_workspace.is_some()
        || payload.stage_execution.is_some()
        || payload.simulation_preparation.is_some()
        || payload.run.is_some()
}

fn sync_current_live_delta_with<SnapshotSync, ScalarSync, SessionSync, RuntimeSync, FieldSync>(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
    mut snapshot_sync: SnapshotSync,
    mut scalar_sync: ScalarSync,
    mut session_sync: SessionSync,
    mut runtime_sync: RuntimeSync,
    mut field_sync: FieldSync,
) -> Result<()>
where
    SnapshotSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    ScalarSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    SessionSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    RuntimeSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    FieldSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
{
    if payload.replace_latest_fields {
        return snapshot_sync(session_id, payload);
    }

    if payload.latest_scalar_row.is_some() {
        scalar_sync(session_id, payload)?;
    }

    if payload_routes_to_current_live_session_frame(payload) {
        session_sync(session_id, payload)?;
    }

    if payload.live_state.is_some()
        || payload.engine_log.is_some()
        || payload.solver_profile.is_some()
        || payload.fem_mesh.is_some()
    {
        runtime_sync(session_id, payload)?;
    }

    if payload.latest_fields.is_some()
        || payload.replace_latest_fields
        || payload.preview_fields.is_some()
        || payload.clear_preview_cache
    {
        field_sync(session_id, payload)?;
    }

    Ok(())
}

pub(crate) fn sync_current_live_delta(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    if !payload_has_current_live_delta(payload) {
        return sync_current_live_heartbeat(session_id);
    }
    sync_current_live_delta_with(
        session_id,
        payload,
        sync_current_live_snapshot,
        sync_current_live_scalar_frame,
        sync_current_live_session_frame,
        sync_current_live_runtime_frame,
        sync_current_live_field_frame,
    )
}

#[cfg(test)]
mod live_delta_routing_tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::{payload_routes_to_current_live_session_frame, sync_current_live_delta_with};
    use crate::simulation_preparation::SimulationPreparationState;
    use crate::types::{CurrentLiveScalarRow, CurrentLiveSnapshotPayload};

    fn payload_with_scalar_session_and_runtime() -> CurrentLiveSnapshotPayload {
        CurrentLiveSnapshotPayload {
            session_status: Some("running".to_string()),
            latest_scalar_row: Some(CurrentLiveScalarRow {
                step: 1,
                time: 0.0,
                solver_dt: 0.0,
                error_estimate: None,
                max_error: None,
                dt_suggested: None,
                rejected_attempts: 0,
                pseudo_time_s: None,
                active_runtime_s: None,
                mx: 1.0,
                my: 0.0,
                mz: 0.0,
                e_ex: 0.0,
                e_demag: 1.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 1.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                per_object_scalars: HashMap::new(),
                table_expressions: Vec::new(),
            }),
            engine_log: Some(Vec::new()),
            ..CurrentLiveSnapshotPayload::default()
        }
    }

    #[test]
    fn preparation_only_delta_routes_to_session_frame() {
        let payload = CurrentLiveSnapshotPayload {
            simulation_preparation: Some(SimulationPreparationState::new(
                "prep-routing",
                1_700_000_000_000,
            )),
            ..CurrentLiveSnapshotPayload::default()
        };

        assert!(payload_routes_to_current_live_session_frame(&payload));
    }

    #[test]
    fn scalar_frame_precedes_heavy_frames() {
        let payload = payload_with_scalar_session_and_runtime();
        let calls = RefCell::new(Vec::new());
        sync_current_live_delta_with(
            "session-1",
            &payload,
            |_, _| {
                calls.borrow_mut().push("snapshot");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("scalar");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("session");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("runtime");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("field");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls.borrow()[..3], ["scalar", "session", "runtime"]);
    }

    #[test]
    fn scalar_failure_stops_before_heavy_frames() {
        let payload = payload_with_scalar_session_and_runtime();
        let calls = RefCell::new(Vec::new());
        let error = sync_current_live_delta_with(
            "session-1",
            &payload,
            |_, _| {
                calls.borrow_mut().push("snapshot");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("scalar");
                Err(anyhow::anyhow!("scalar failed"))
            },
            |_, _| {
                calls.borrow_mut().push("session");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("runtime");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("field");
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(*calls.borrow(), ["scalar"]);
        assert!(error.to_string().contains("scalar failed"));
    }

    #[test]
    fn terminal_replacement_routes_as_one_atomic_snapshot() {
        let mut payload = payload_with_scalar_session_and_runtime();
        payload.replace_latest_fields = true;
        payload.latest_fields = Some(Default::default());
        let calls = RefCell::new(Vec::new());

        sync_current_live_delta_with(
            "session-1",
            &payload,
            |_, _| {
                calls.borrow_mut().push("snapshot");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("scalar");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("session");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("runtime");
                Ok(())
            },
            |_, _| {
                calls.borrow_mut().push("field");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*calls.borrow(), ["snapshot"]);
    }
}

/// Send a full `VisualizationStatePatch` JSON body to the visualization state endpoint before
/// the first control-room frame is painted.  Accepts the complete patch object (may include
/// `overrides`, `quantity`, `clip`, `vector_style`, `layers`, etc.).
/// Errors are non-fatal — the control room opens with defaults if the PATCH fails.
pub(crate) fn sync_initial_visualization_state(patch: serde_json::Value) -> Result<()> {
    current_live_api_client()
        .patch(format!(
            "{}/v2/sessions/current/visualization/state",
            api_base_url()
        ))
        .json(&patch)
        .send()
        .context("failed to apply initial visualization state")?
        .error_for_status()
        .context("visualization state patch endpoint returned error")?;
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
    let packaged_root = packaged_install_root(self_exe);
    let runtime_root = packaged_root.clone().unwrap_or_else(|| root.to_path_buf());
    let sibling_api = self_exe.with_file_name(format!("fullmag-api{EXE_SUFFIX}"));
    let web_static_dir = {
        let candidates = [
            runtime_root.join(".fullmag").join("local").join("web"),
            runtime_root.join("web"),
            runtime_root.join("share").join("control-room"),
            root.join(".fullmag").join("local").join("web"),
            root.join("apps").join("control-room").join("out"),
        ];
        candidates
            .into_iter()
            .find(|candidate| candidate.join("index.html").is_file())
            .unwrap_or_else(|| runtime_root.join(".fullmag").join("local").join("web"))
    };
    let candidates = [
        sibling_api,
        runtime_root
            .join("bin")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
        runtime_root
            .join(".fullmag")
            .join("local")
            .join("bin")
            .join(format!("fullmag-api{EXE_SUFFIX}")),
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
            .current_dir(&runtime_root)
            .env("FULLMAG_API_PORT", api_port().to_string())
            .env("FULLMAG_REPO_ROOT", &runtime_root)
            .env("FULLMAG_WEB_STATIC_DIR", &web_static_dir)
            .stdin(Stdio::null());
        if stream_logs_to_terminal {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command.stdout(stdout).stderr(stderr);
        }
        configure_child_process(&mut command);
        configure_repo_local_library_env(&mut command, &runtime_root, Some(path));
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

    if packaged_root.is_some() {
        bail!(
            "fullmag-api binary missing from packaged install rooted at {}",
            runtime_root.display()
        );
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
        .env("FULLMAG_REPO_ROOT", root)
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
    #[cfg(target_os = "linux")]
    let launcher_is_init = std::process::id() == 1;

    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if should_reject_reparented_child(launcher_is_init, libc::getppid()) {
                    return Err(io::Error::from_raw_os_error(libc::ECHILD));
                }
            }
            Ok(())
        });
    }
}

#[cfg(target_os = "linux")]
fn should_reject_reparented_child(
    launcher_is_init: bool,
    observed_parent_pid: libc::pid_t,
) -> bool {
    !launcher_is_init && observed_parent_pid == 1
}

#[cfg(all(test, target_os = "linux"))]
mod child_process_tests {
    use super::should_reject_reparented_child;

    #[test]
    fn allows_pid_one_when_fullmag_is_the_container_init() {
        assert!(!should_reject_reparented_child(true, 1));
    }

    #[test]
    fn rejects_reparented_child_when_fullmag_is_not_init() {
        assert!(should_reject_reparented_child(false, 1));
    }

    #[test]
    fn allows_child_with_live_non_init_parent() {
        assert!(!should_reject_reparented_child(false, 4242));
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
        // A newly spawned API is considered live once its health endpoint
        // responds.  Contract validation remains mandatory for reusing an
        // existing process, but OpenAPI generation and the internal snapshot
        // probe can legitimately lag while the runtime is under startup load.
        if api_is_ready(port) {
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
    let candidates: &[&str] = if cfg!(windows) {
        &["cmd.exe"]
    } else if is_wsl_environment() {
        &[
            "wslview",
            "cmd.exe",
            "/mnt/c/Windows/System32/cmd.exe",
            "xdg-open",
            "open",
        ]
    } else {
        &["xdg-open", "open", "wslview"]
    };
    for candidate in candidates {
        if command_available(candidate) {
            return Ok((*candidate).to_string());
        }
    }
    bail!("no browser opener found")
}

fn is_wsl_environment() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some()
}

fn command_available(command: &str) -> bool {
    if command.contains('/') {
        return Path::new(command).is_file();
    }
    command_exists(command)
}

fn browser_open_args(opener: &str, url: &str) -> Vec<String> {
    if opener
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
    {
        return vec![
            "/C".to_string(),
            "start".to_string(),
            String::new(),
            url.to_string(),
        ];
    }
    vec![url.to_string()]
}

#[cfg(windows)]
pub(crate) fn command_exists(cmd: &str) -> bool {
    ProcessCommand::new("where.exe")
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
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

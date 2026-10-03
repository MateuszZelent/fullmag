use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

const CANDIDATE_PORTS: &[u16] = &[8081, 8080, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

/// Manages a `fullmag-api` child process started alongside the Tauri window.
pub struct ApiSidecar {
    child: Child,
    port: u16,
    api_instance_id: String,
    prepared_attach: Option<fullmag_runtime_control::application_attach::PreparedApplicationAttach>,
    runtime_attach:
        Option<fullmag_runtime_control::application_attach::BackgroundApplicationAttach>,
}

impl ApiSidecar {
    /// Find the `fullmag-api` binary, pick a free port, spawn, and wait for health.
    pub fn start() -> Result<Self, String> {
        let api_exe = find_api_binary().ok_or_else(|| {
            "fullmag-api binary not found; build it with `cargo build -p fullmag-api`".to_string()
        })?;

        let port = find_free_port().ok_or("no free API port available")?;
        let repo_root = discover_repo_root(&api_exe);
        let web_static_dir = resolve_web_static_dir(&repo_root);

        let state_root = sidecar_state_root(
            &repo_root,
            std::env::var_os("FULLMAG_STATE_ROOT").map(PathBuf::from),
        )?;
        let log_dir = state_root.join("logs");
        std::fs::create_dir_all(&log_dir)
            .map_err(|e| format!("failed to create API log directory: {e}"))?;

        let stdout_file = std::fs::File::create(log_dir.join("fullmag-api.log"))
            .map_err(|e| format!("failed to create api log: {e}"))?;
        let stderr_file = stdout_file
            .try_clone()
            .map_err(|e| format!("failed to clone log handle: {e}"))?;

        let mut cmd = Command::new(&api_exe);
        cmd.current_dir(&repo_root)
            .env("FULLMAG_API_PORT", port.to_string())
            .env("FULLMAG_REPO_ROOT", &repo_root)
            .env("FULLMAG_STATE_ROOT", &state_root)
            .stdin(Stdio::null())
            .stdout(stdout_file)
            .stderr(stderr_file);

        if let Some(dir) = &web_static_dir {
            cmd.env("FULLMAG_WEB_STATIC_DIR", dir);
        }

        configure_native_library_env(&mut cmd, &repo_root, &api_exe);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn fullmag-api at {}: {e}", api_exe.display()))?;

        let mut sidecar = Self {
            child,
            port,
            api_instance_id: String::new(),
            prepared_attach: None,
            runtime_attach: None,
        };
        sidecar.wait_healthy()?;
        let binding = fullmag_runtime_control::application_attach::prepare_for_authoring(
            &repo_root,
            &state_root,
            port,
        )
        .map_err(|error| format!("API authoring binding failed: {error:#}"))?;
        sidecar.api_instance_id = binding.api_instance_id().to_string();
        sidecar.prepared_attach = Some(binding);
        Ok(sidecar)
    }

    /// Called only after the authoring window has been created.
    pub fn start_runtime_attach(&mut self) {
        let Some(prepared) = self.prepared_attach.take() else {
            return;
        };
        match prepared.start() {
            Ok(attach) => self.runtime_attach = attach,
            Err(error) => eprintln!("Native runtime attach unavailable: {error:#}"),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://localhost:{}/", self.port)
    }

    pub fn ui_url(&self) -> String {
        format!(
            "{}workspace?fullmag_api_instance={}",
            self.base_url(),
            self.api_instance_id
        )
    }

    fn wait_healthy(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return Err(format!("fullmag-api exited early with status {status}"));
            }
            if health_check(self.port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        Err(format!(
            "fullmag-api did not become healthy on :{} within {}s",
            self.port,
            HEALTH_TIMEOUT.as_secs()
        ))
    }
}

impl Drop for ApiSidecar {
    fn drop(&mut self) {
        // The observer must finish before its pinned API is terminated.
        drop(self.runtime_attach.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn find_api_binary() -> Option<PathBuf> {
    let self_exe = std::env::current_exe().ok()?;
    let self_dir = self_exe.parent()?;
    let name = format!("fullmag-api{EXE_SUFFIX}");

    let mut candidates: Vec<PathBuf> = vec![self_dir.join(&name)];

    if let Some(root) = packaged_install_root(&self_exe) {
        candidates.push(root.join("bin").join(&name));
        candidates.push(root.join(".fullmag").join("local").join("bin").join(&name));
    }

    // Walk up to find repo root and add target directories
    if let Some(root) = find_repo_root_from(&self_exe) {
        for profile in ["release", "debug"] {
            candidates.push(root.join("target").join(profile).join(&name));
            #[cfg(windows)]
            candidates.push(
                root.join("target")
                    .join("x86_64-pc-windows-msvc")
                    .join(profile)
                    .join(&name),
            );
        }
        candidates.push(root.join(".fullmag").join("local").join("bin").join(&name));
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn find_repo_root_from(start: &std::path::Path) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("FULLMAG_REPO_ROOT") {
        return Some(PathBuf::from(root));
    }
    let mut dir = start.parent();
    while let Some(d) = dir {
        if d.join("AGENTS.md").is_file()
            || d.join("Cargo.toml").is_file()
            || packaged_root_marker(d)
        {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

fn packaged_install_root(start: &std::path::Path) -> Option<PathBuf> {
    let bin_dir = start.parent()?;
    if !bin_dir
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("bin")
    {
        return None;
    }
    let install_root = bin_dir.parent()?.to_path_buf();
    packaged_root_marker(&install_root).then_some(install_root)
}

fn packaged_root_marker(root: &std::path::Path) -> bool {
    root.join(".fullmag").is_dir() || root.join("web").join("index.html").is_file()
}

fn discover_repo_root(api_exe: &std::path::Path) -> PathBuf {
    // The installed executable owns asset discovery, even if a shell still
    // carries a development checkout override.
    if let Some(root) = fullmag_runtime_control::python_runtime::packaged_windows_root(api_exe) {
        return root;
    }
    if let Ok(root) = std::env::var("FULLMAG_REPO_ROOT") {
        return PathBuf::from(root);
    }
    find_repo_root_from(api_exe).unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|e| find_repo_root_from(&e))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
    })
}

fn sidecar_state_root(
    repo_root: &std::path::Path,
    configured: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(root) =
        fullmag_runtime_control::python_runtime::validated_state_override(configured)
            .map_err(|error| error.to_string())?
    {
        return Ok(root);
    }
    fullmag_runtime_control::python_runtime::packaged_windows_state_root(repo_root)
        .map(|root| root.unwrap_or_else(|| repo_root.join(".fullmag")))
        .map_err(|error| format!("Windows package state directory unavailable: {error}"))
}

fn resolve_web_static_dir(repo_root: &std::path::Path) -> Option<PathBuf> {
    let candidates = [
        repo_root.join(".fullmag").join("local").join("web"),
        repo_root.join("web"),
        repo_root.join("share").join("control-room"),
        repo_root.join("apps").join("control-room").join("out"),
        repo_root.join("apps").join("web").join("out"),
    ];
    candidates
        .into_iter()
        .find(|p| p.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use super::{packaged_install_root, sidecar_state_root};

    #[test]
    fn explicit_state_root_is_shared_with_the_api() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("user-state");
        assert_eq!(
            sidecar_state_root(root.path(), Some(state.clone())).unwrap(),
            state
        );
    }

    #[test]
    fn relative_state_override_is_rejected_before_creating_logs() {
        let root = tempfile::tempdir().unwrap();
        assert!(sidecar_state_root(root.path(), Some("relative-state".into())).is_err());
        assert!(!root.path().join(".fullmag/logs").exists());
    }

    #[test]
    fn source_checkout_uses_its_existing_state_directory() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            sidecar_state_root(root.path(), None).unwrap(),
            root.path().join(".fullmag")
        );
    }

    #[test]
    fn packaged_install_root_is_derived_from_bin_executable() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-desktop-packaged-root-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join(".fullmag")).unwrap();

        assert_eq!(
            packaged_install_root(&root.join("bin").join("fullmag-ui")),
            Some(root.clone())
        );
        assert_eq!(
            packaged_install_root(&root.join("target").join("fullmag-ui")),
            None
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}

fn find_free_port() -> Option<u16> {
    CANDIDATE_PORTS
        .iter()
        .copied()
        .find(|&port| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok())
}

fn health_check(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
}

/// Set PATH / LD_LIBRARY_PATH so fullmag-api can find native shared libraries.
fn configure_native_library_env(
    cmd: &mut Command,
    repo_root: &std::path::Path,
    api_exe: &std::path::Path,
) {
    let mut lib_dirs: Vec<OsString> = Vec::new();

    // Sibling directory of the API binary
    if let Some(dir) = api_exe.parent() {
        lib_dirs.push(dir.into());
    }

    // native/build/lib if present
    let native_lib = repo_root.join("native").join("build").join("lib");
    if native_lib.is_dir() {
        lib_dirs.push(native_lib.into());
    }

    if lib_dirs.is_empty() {
        return;
    }

    #[cfg(windows)]
    {
        let mut path = std::env::var_os("PATH").unwrap_or_default();
        for dir in &lib_dirs {
            if !path.is_empty() {
                path.push(";");
            }
            path.push(dir);
        }
        cmd.env("PATH", path);
    }

    #[cfg(unix)]
    {
        let mut ld = std::env::var_os("LD_LIBRARY_PATH").unwrap_or_default();
        for dir in &lib_dirs {
            if !ld.is_empty() {
                ld.push(":");
            }
            ld.push(dir);
        }
        cmd.env("LD_LIBRARY_PATH", ld);
    }
}

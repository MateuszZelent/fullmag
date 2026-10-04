//! Application-owned Python selection for native Windows packages.
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Validate an explicit writable-state override before any caller creates files.
pub fn validated_state_override(value: Option<PathBuf>) -> io::Result<Option<PathBuf>> {
    let value = value.filter(|path| !path.as_os_str().is_empty());
    if value.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "FULLMAG_STATE_ROOT must be an absolute path",
        ));
    }
    Ok(value)
}

pub fn packaged_windows_python(root: &Path) -> Option<PathBuf> {
    packaged_python_for_platform(root, cfg!(windows))
}

pub fn packaged_windows_root(executable: &Path) -> Option<PathBuf> {
    let bin = executable.parent()?;
    if !bin
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("bin")
    {
        return None;
    }
    let root = bin.parent()?;
    packaged_windows_python(root).map(|_| root.to_path_buf())
}

fn packaged_python_for_platform(root: &Path, windows: bool) -> Option<PathBuf> {
    if !windows {
        return None;
    }
    // A package marker remains authoritative when its executable is missing.
    // An unreadable marker also cannot authorize an external fallback.
    let markers = [
        root.join("python/python.exe"),
        root.join("python/python312._pth"),
        root.join("share/version.json"),
    ];
    markers
        .iter()
        .any(|path| path.try_exists().unwrap_or(true))
        .then_some(())
        .or_else(|| {
            let legacy = !root.join("packages/fullmag-py/src/fullmag").is_dir()
                && root.join("bin/fullmag.exe").try_exists().unwrap_or(true)
                && (root.join("web").try_exists().unwrap_or(true)
                    || root.join(".fullmag").try_exists().unwrap_or(true));
            legacy.then_some(())
        })
        .map(|_| root.join("python/python.exe"))
}

pub fn packaged_windows_state_root(root: &Path) -> io::Result<Option<PathBuf>> {
    if packaged_windows_python(root).is_none() {
        return Ok(None);
    }
    windows_state_directory(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
    )
    .map(Some)
}

fn windows_state_directory(
    local: Option<PathBuf>,
    profile: Option<PathBuf>,
) -> io::Result<PathBuf> {
    let state = local.filter(|path| path.is_absolute())
        .or_else(|| profile.filter(|path| path.is_absolute()).map(|path| path.join("AppData/Local")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound,
            "packaged Windows runtime requires LOCALAPPDATA, USERPROFILE or explicit FULLMAG_STATE_ROOT"))?;
    Ok(state.join("Fullmag"))
}

pub fn configure_packaged_python(command: &mut Command, root: &Path) -> io::Result<()> {
    if !root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "packaged Python root must be absolute",
        ));
    }
    for name in [
        "python.exe",
        "python312.dll",
        "python3.dll",
        "python312.zip",
        "python312._pth",
        "sitecustomize.py",
        "site-packages/fullmag/__init__.py",
    ] {
        let path = root.join("python").join(name);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "packaged Python file unavailable: {}: {error}",
                    path.display()
                ),
            )
        })?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("packaged Python file invalid: {}", path.display()),
            ));
        }
    }
    if std::fs::read(root.join("python/python312._pth"))?
        != b"python312.zip\n.\nsite-packages\nimport site\n"
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "packaged Python path configuration changed",
        ));
    }
    let path = std::env::join_paths([root.join("bin"), root.join("python")])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    command
        .arg("-I")
        .arg("-u")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONUSERBASE")
        .env("PATH", path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Single Python interpreter resolver (docs/design/start-screen/docs/08-script-open.md 6.5).
//
// Every Fullmag process that needs Python (CLI, API, desktop host) must call
// `resolve_interpreter`. A candidate is accepted only after it actually ran a
// probe, so a spawnable-but-broken launcher (the Windows Microsoft Store
// `python3` alias exits non-zero) can never end the search or be reported as
// the interpreter.
// ---------------------------------------------------------------------------

/// Environment variable that explicitly selects the interpreter.
pub const PYTHON_ENV: &str = "FULLMAG_PYTHON";
/// Minimum supported CPython (`requires-python = ">=3.10"` in packages/fullmag-py).
pub const MIN_PYTHON_VERSION: (u32, u32, u32) = (3, 10, 0);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Prints the version, the executable and the comma-separated list of missing
/// hard dependencies of the `fullmag` package (`find_spec` only: nothing is imported).
const PROBE_CODE: &str = "import sys,importlib.util as u;print(*sys.version_info[:3],sep='.');print(sys.executable);print(','.join(n for n in ('numpy','zarr','h5py') if u.find_spec(n) is None))";
/// UTF-8 switch passed to every helper child; unlike `PYTHONUTF8` it also
/// works in isolated mode (`-I` implies `-E`).
const UTF8_FLAGS: [&str; 2] = ["-X", "utf8"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterpreterSource {
    /// Packaged bundle owned by the application (ADR 0047).
    Bundle,
    /// Explicit caller choice (for example `fullmag script inspect --python`).
    Explicit,
    /// `FULLMAG_PYTHON`.
    Env,
    /// Checkout-local environment (`.fullmag/local/python`, `.venv`).
    Local,
    /// Windows `py -3` launcher.
    PyLauncher,
    /// `python3` / `python` found on PATH by probing.
    PathProbe,
}

impl InterpreterSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bundle => "bundle",
            Self::Explicit => "explicit",
            Self::Env => "env",
            Self::Local => "local",
            Self::PyLauncher => "py_launcher",
            Self::PathProbe => "path_probe",
        }
    }
}

/// Why one candidate was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The process could not be spawned.
    NotRunnable(String),
    /// The process ran and failed (for example the Store alias).
    ExitStatus { code: Option<i32>, output: String },
    /// The probe did not finish within the timeout.
    Timeout,
    /// The probe succeeded but the version is below the minimum.
    TooOld { found: String },
    /// The probe succeeded but printed something that is not a version.
    Unparsable(String),
    /// A discovered (not explicitly chosen) interpreter lacks hard dependencies
    /// of the `fullmag` package, so a later helper run could only fail.
    MissingPackages(Vec<String>),
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunnable(error) => write!(f, "could not be started: {error}"),
            Self::ExitStatus { code, output } => {
                match code {
                    Some(code) => write!(f, "probe exited with status {code}")?,
                    None => write!(f, "probe was terminated by a signal")?,
                }
                if !output.is_empty() {
                    write!(f, " ({output})")?;
                }
                Ok(())
            }
            Self::Timeout => write!(
                f,
                "probe did not finish within {} s",
                PROBE_TIMEOUT.as_secs()
            ),
            Self::TooOld { found } => write!(
                f,
                "Python {found} is older than the minimum {}.{}",
                MIN_PYTHON_VERSION.0, MIN_PYTHON_VERSION.1
            ),
            Self::Unparsable(text) => write!(f, "probe printed an unrecognised version: {text}"),
            Self::MissingPackages(names) => write!(
                f,
                "required fullmag packages are not installed: {}",
                names.join(", ")
            ),
        }
    }
}

/// One rejected candidate, kept for every error message and receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tried {
    pub candidate: String,
    pub source: InterpreterSource,
    pub rejection: Rejection,
}

impl fmt::Display for Tried {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} [{}]: {}",
            self.candidate,
            self.source.as_str(),
            self.rejection
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInterpreter {
    pub path: PathBuf,
    /// `major.minor.micro` reported by the interpreter itself.
    pub version: String,
    pub source: InterpreterSource,
    /// True for the packaged bundle, which runs with `-I` and a restricted PATH.
    pub isolated: bool,
    /// Arguments `command` places before the caller's arguments.
    pub flags: Vec<String>,
    /// Candidates rejected before this one was accepted.
    pub tried: Vec<Tried>,
    /// Facts the caller should surface (for example ignored overrides).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterpreterError {
    /// No candidate passed the probe.
    NotFound { tried: Vec<Tried> },
    /// An explicit choice (`FULLMAG_PYTHON` or `--python`) does not name a
    /// usable interpreter. There is deliberately no fallback to another one.
    OverrideUnusable {
        origin: String,
        path: String,
        rejection: Rejection,
    },
    /// A packaged bundle marker exists but the bundle cannot run. There is
    /// deliberately no fallback to a system interpreter.
    BundleBroken { reason: String },
}

impl fmt::Display for InterpreterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { tried } => {
                write!(
                    f,
                    "no usable Python {}.{}+ interpreter was found",
                    MIN_PYTHON_VERSION.0, MIN_PYTHON_VERSION.1
                )?;
                if tried.is_empty() {
                    write!(f, " (no candidates were available)")?;
                } else {
                    write!(f, "; rejected candidates: ")?;
                    for (index, entry) in tried.iter().enumerate() {
                        if index > 0 {
                            write!(f, "; ")?;
                        }
                        write!(f, "{entry}")?;
                    }
                }
                write!(f, ". Install Python or set {PYTHON_ENV} to an interpreter path")
            }
            Self::OverrideUnusable {
                origin,
                path,
                rejection,
            } => write!(
                f,
                "{origin}={path} is not a usable Python interpreter: {rejection}"
            ),
            Self::BundleBroken { reason } => {
                write!(
                    f,
                    "bundled Python runtime is incomplete or invalid: {reason}"
                )
            }
        }
    }
}

impl std::error::Error for InterpreterError {}

#[derive(Debug, Clone)]
struct Candidate {
    label: String,
    program: PathBuf,
    args: Vec<String>,
    source: InterpreterSource,
}

impl Candidate {
    fn new(
        label: &str,
        program: impl Into<PathBuf>,
        args: &[&str],
        source: InterpreterSource,
    ) -> Self {
        Self {
            label: label.to_string(),
            program: program.into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            source,
        }
    }
}

struct Probed {
    version: (u32, u32, u32),
    executable: String,
    missing_packages: Vec<String>,
}

fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, Rejection> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| Rejection::NotRunnable(error.to_string()))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let err_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Rejection::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(error) => return Err(Rejection::NotRunnable(error.to_string())),
        }
    };
    Ok(std::process::Output {
        status,
        stdout: out_thread.join().unwrap_or_default(),
        stderr: err_thread.join().unwrap_or_default(),
    })
}

fn summarize_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    line.chars().take(160).collect()
}

fn probe(mut command: Command) -> Result<Probed, Rejection> {
    command.args(UTF8_FLAGS).arg("-c").arg(PROBE_CODE);
    let output = run_with_timeout(command, PROBE_TIMEOUT)?;
    if !output.status.success() {
        let mut text = summarize_output(&output.stderr);
        if text.is_empty() {
            text = summarize_output(&output.stdout);
        }
        return Err(Rejection::ExitStatus {
            code: output.status.code(),
            output: text,
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let version_text = lines.next().unwrap_or("");
    let executable = lines.next().unwrap_or("").to_string();
    let missing_packages = lines
        .next()
        .unwrap_or("")
        .split(',')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    let parts = version_text
        .split('.')
        .map(|part| part.parse::<u32>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Rejection::Unparsable(summarize_output(&output.stdout)))?;
    let [major, minor, micro] = parts[..] else {
        return Err(Rejection::Unparsable(summarize_output(&output.stdout)));
    };
    if (major, minor, micro) < MIN_PYTHON_VERSION {
        return Err(Rejection::TooOld {
            found: version_text.to_string(),
        });
    }
    Ok(Probed {
        version: (major, minor, micro),
        executable,
        missing_packages,
    })
}

fn flags_for(isolated: bool) -> Vec<String> {
    let mut flags = Vec::new();
    if isolated {
        flags.extend(["-I".to_string(), "-u".to_string()]);
    }
    flags.extend(UTF8_FLAGS.iter().map(|flag| flag.to_string()));
    flags
}

fn candidate_command(candidate: &Candidate) -> Command {
    let mut command = Command::new(&candidate.program);
    command.args(&candidate.args);
    command
}

impl Tried {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "candidate": self.candidate,
            "source": self.source.as_str(),
            "reason": self.rejection.to_string(),
        })
    }
}

impl InterpreterError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NotFound { .. } => "not_found",
            Self::OverrideUnusable { .. } => "override_unusable",
            Self::BundleBroken { .. } => "bundle_broken",
        }
    }

    /// Stable JSON shape shared by `fullmag script inspect` and the receipt.
    pub fn to_json(&self) -> serde_json::Value {
        let tried = match self {
            Self::NotFound { tried } => tried.iter().map(Tried::to_json).collect(),
            _ => Vec::new(),
        };
        serde_json::json!({
            "status": "error",
            "kind": self.kind(),
            "message": self.to_string(),
            "tried": tried,
        })
    }
}

impl ResolvedInterpreter {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "resolved",
            "path": self.path.display().to_string(),
            "version": self.version,
            "source": self.source.as_str(),
            "isolated": self.isolated,
            "flags": self.flags,
            "tried": self.tried.iter().map(Tried::to_json).collect::<Vec<_>>(),
            "notes": self.notes,
        })
    }

    /// Build a command that already carries the interpreter flags, the UTF-8
    /// switch and (for the bundle) the isolation environment. Callers append
    /// their own arguments.
    pub fn command(&self, root: &Path) -> io::Result<Command> {
        let mut command = Command::new(&self.path);
        if self.isolated {
            configure_packaged_python(&mut command, root)?;
        } else {
            command.env("PYTHONUTF8", "1");
        }
        command.args(UTF8_FLAGS);
        Ok(command)
    }
}

fn resolved_from(
    candidate: &Candidate,
    probed: Probed,
    isolated: bool,
    tried: Vec<Tried>,
    notes: Vec<String>,
) -> ResolvedInterpreter {
    let (major, minor, micro) = probed.version;
    // Launcher and PATH probes report the real executable so later spawns do
    // not depend on the launcher or on PATH order.
    let reported = PathBuf::from(&probed.executable);
    let path = match candidate.source {
        InterpreterSource::PyLauncher | InterpreterSource::PathProbe
            if !probed.executable.is_empty() && reported.is_file() =>
        {
            reported
        }
        _ => candidate.program.clone(),
    };
    ResolvedInterpreter {
        path,
        version: format!("{major}.{minor}.{micro}"),
        source: candidate.source,
        isolated,
        flags: flags_for(isolated),
        tried,
        notes,
    }
}

fn resolve_with(
    root: &Path,
    explicit: Option<OsString>,
    env_python: Option<OsString>,
    bundle: Option<PathBuf>,
    fallbacks: Vec<Candidate>,
) -> Result<ResolvedInterpreter, InterpreterError> {
    let env_python = env_python.filter(|value| !value.is_empty());
    let explicit = explicit.filter(|value| !value.is_empty());
    if let Some(bundle_python) = bundle {
        let mut notes = Vec::new();
        if let Some(ignored) = &explicit {
            notes.push(format!(
                "--python {} ignored: the packaged bundle owns Python",
                ignored.to_string_lossy()
            ));
        }
        if let Some(ignored) = &env_python {
            notes.push(format!(
                "{PYTHON_ENV}={} ignored: the packaged bundle owns Python",
                ignored.to_string_lossy()
            ));
        }
        let mut command = Command::new(&bundle_python);
        configure_packaged_python(&mut command, root).map_err(|error| {
            InterpreterError::BundleBroken {
                reason: error.to_string(),
            }
        })?;
        let candidate = Candidate::new(
            &bundle_python.display().to_string(),
            bundle_python.clone(),
            &[],
            InterpreterSource::Bundle,
        );
        let probed = probe(command).map_err(|rejection| InterpreterError::BundleBroken {
            reason: format!("{}: {rejection}", bundle_python.display()),
        })?;
        return Ok(resolved_from(&candidate, probed, true, Vec::new(), notes));
    }
    let (origin, source, chosen) = match (explicit, env_python) {
        (Some(value), _) => ("--python", InterpreterSource::Explicit, Some(value)),
        (None, value) => (PYTHON_ENV, InterpreterSource::Env, value),
    };
    if let Some(value) = chosen {
        let candidate = Candidate::new(&value.to_string_lossy(), PathBuf::from(&value), &[], source);
        return match probe(candidate_command(&candidate)) {
            Ok(probed) => Ok(resolved_from(
                &candidate,
                probed,
                false,
                Vec::new(),
                Vec::new(),
            )),
            Err(rejection) => Err(InterpreterError::OverrideUnusable {
                origin: origin.to_string(),
                path: value.to_string_lossy().into_owned(),
                rejection,
            }),
        };
    }
    let mut tried = Vec::new();
    for candidate in fallbacks {
        match probe(candidate_command(&candidate)) {
            Ok(probed) if !probed.missing_packages.is_empty() => tried.push(Tried {
                candidate: candidate.label.clone(),
                source: candidate.source,
                rejection: Rejection::MissingPackages(probed.missing_packages),
            }),
            Ok(probed) => {
                return Ok(resolved_from(&candidate, probed, false, tried, Vec::new()));
            }
            Err(rejection) => tried.push(Tried {
                candidate: candidate.label.clone(),
                source: candidate.source,
                rejection,
            }),
        }
    }
    Err(InterpreterError::NotFound { tried })
}

fn local_candidates(root: &Path) -> Vec<Candidate> {
    let mut paths = vec![
        root.join(".fullmag/local/python/Scripts/python.exe"),
        root.join(".fullmag/local/python/bin/python"),
        root.join(".fullmag/local/python/python.exe"),
        root.join(".fullmag/local/python/bin/python.exe"),
        root.join(".venv/Scripts/python.exe"),
        root.join(".venv/bin/python"),
        root.join("packages/fullmag-py/.venv/Scripts/python.exe"),
        root.join("packages/fullmag-py/.venv/bin/python"),
    ];
    if cfg!(windows) {
        paths.push(root.join("python/Scripts/python.exe"));
    }
    paths
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| {
            Candidate::new(
                &path.display().to_string(),
                path,
                &[],
                InterpreterSource::Local,
            )
        })
        .collect()
}

fn default_fallbacks(root: &Path) -> Vec<Candidate> {
    let mut candidates = local_candidates(root);
    if cfg!(windows) {
        candidates.push(Candidate::new(
            "py -3",
            "py",
            &["-3"],
            InterpreterSource::PyLauncher,
        ));
    }
    candidates.push(Candidate::new(
        "python3",
        "python3",
        &[],
        InterpreterSource::PathProbe,
    ));
    candidates.push(Candidate::new(
        "python",
        "python",
        &[],
        InterpreterSource::PathProbe,
    ));
    candidates
}

/// Resolve the one Python interpreter Fullmag uses for `root`.
///
/// Order: packaged bundle (no fallthrough) > `FULLMAG_PYTHON` (no fallthrough)
/// > checkout-local environments > `py -3` (Windows) > `python3` > `python`.
/// Successful results are cached per process; failures are re-probed.
pub fn resolve_interpreter(root: &Path) -> Result<ResolvedInterpreter, InterpreterError> {
    resolve_interpreter_with(root, None)
}

/// Like [`resolve_interpreter`] with an explicit caller choice, which ranks
/// above `FULLMAG_PYTHON` but never above a packaged bundle.
pub fn resolve_interpreter_with(
    root: &Path,
    explicit: Option<&Path>,
) -> Result<ResolvedInterpreter, InterpreterError> {
    static CACHE: OnceLock<Mutex<HashMap<String, ResolvedInterpreter>>> = OnceLock::new();
    let env_python = std::env::var_os(PYTHON_ENV);
    let explicit = explicit.map(|path| path.as_os_str().to_owned());
    let key = format!(
        "{}\u{0}{}\u{0}{}",
        root.display(),
        explicit.as_deref().unwrap_or_default().to_string_lossy(),
        env_python
            .as_deref()
            .unwrap_or_default()
            .to_string_lossy()
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|map| map.get(&key).cloned()) {
        return Ok(hit);
    }
    let resolved = resolve_with(
        root,
        explicit,
        env_python,
        packaged_windows_python(root),
        default_fallbacks(root),
    )?;
    if let Ok(mut map) = cache.lock() {
        map.insert(key, resolved.clone());
    }
    Ok(resolved)
}

#[cfg(test)]
mod resolver_tests {
    use super::*;

    /// Create a fake interpreter that prints `version` and `exe` for the probe,
    /// or exits with `exit_code` without printing a version.
    fn fake(dir: &Path, name: &str, version: &str, exit_code: i32) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.bat"));
            let body = if exit_code == 0 {
                format!("@echo off\r\necho {version}\r\necho {}\r\n", path.display())
            } else {
                format!("@echo off\r\necho Python was not found; run without arguments 1>&2\r\nexit /b {exit_code}\r\n")
            };
            std::fs::write(&path, body).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(name);
            let body = if exit_code == 0 {
                format!("#!/bin/sh\necho {version}\necho {}\n", path.display())
            } else {
                format!("#!/bin/sh\necho 'Python was not found' 1>&2\nexit {exit_code}\n")
            };
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    fn fake_with_missing(dir: &Path, name: &str, version: &str, missing: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.bat"));
            let body = format!(
                "@echo off
echo {version}
echo {}
echo {missing}
",
                path.display()
            );
            std::fs::write(&path, body).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(name);
            let body = format!(
                "#!/bin/sh
echo {version}
echo {}
echo {missing}
",
                path.display()
            );
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    fn cand(label: &str, path: PathBuf, source: InterpreterSource) -> Candidate {
        Candidate::new(label, path, &[], source)
    }

    #[test]
    fn store_alias_exiting_nonzero_is_rejected_and_search_continues() {
        let dir = tempfile::tempdir().unwrap();
        let alias = fake(dir.path(), "alias", "", 9009);
        let good = fake(dir.path(), "good", "3.12.2", 0);
        let resolved = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![
                cand("python3", alias, InterpreterSource::PathProbe),
                cand("python", good.clone(), InterpreterSource::PathProbe),
            ],
        )
        .unwrap();
        assert_eq!(resolved.version, "3.12.2");
        assert_eq!(resolved.source, InterpreterSource::PathProbe);
        assert_eq!(resolved.tried.len(), 1);
        assert_eq!(resolved.tried[0].candidate, "python3");
        assert!(matches!(
            resolved.tried[0].rejection,
            Rejection::ExitStatus {
                code: Some(9009),
                ..
            }
        ));
        assert_eq!(resolved.flags, ["-X", "utf8"]);
        assert!(!resolved.isolated);
    }

    #[test]
    fn version_below_minimum_is_rejected_with_reason() {
        let dir = tempfile::tempdir().unwrap();
        let old = fake(dir.path(), "old", "3.9.18", 0);
        let error = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![cand("python", old, InterpreterSource::PathProbe)],
        )
        .unwrap_err();
        let InterpreterError::NotFound { tried } = &error else {
            panic!("unexpected error {error:?}");
        };
        assert_eq!(
            tried[0].rejection,
            Rejection::TooOld {
                found: "3.9.18".into()
            }
        );
        let message = error.to_string();
        assert!(message.contains("3.9.18") && message.contains("older than the minimum 3.10"));
        assert!(message.contains(PYTHON_ENV));
    }

    #[test]
    fn success_reports_version_and_source() {
        let dir = tempfile::tempdir().unwrap();
        let good = fake(dir.path(), "good", "3.11.4", 0);
        let resolved = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![cand("good", good, InterpreterSource::Local)],
        )
        .unwrap();
        assert_eq!(resolved.version, "3.11.4");
        assert_eq!(resolved.source, InterpreterSource::Local);
        assert!(resolved.tried.is_empty());
    }

    #[test]
    fn env_override_wins_over_fallbacks_and_never_falls_through() {
        let dir = tempfile::tempdir().unwrap();
        let env_python = fake(dir.path(), "env", "3.13.0", 0);
        let other = fake(dir.path(), "other", "3.12.0", 0);
        let resolved = resolve_with(
            dir.path(),
            None,
            Some(env_python.clone().into_os_string()),
            None,
            vec![cand("other", other.clone(), InterpreterSource::PathProbe)],
        )
        .unwrap();
        assert_eq!(resolved.source, InterpreterSource::Env);
        assert_eq!(resolved.version, "3.13.0");

        let broken = fake(dir.path(), "broken", "", 1);
        let error = resolve_with(
            dir.path(),
            None,
            Some(broken.into_os_string()),
            None,
            vec![cand("other", other, InterpreterSource::PathProbe)],
        )
        .unwrap_err();
        assert!(matches!(error, InterpreterError::OverrideUnusable { .. }));
        assert!(error.to_string().contains(PYTHON_ENV));
    }

    #[test]
    fn error_lists_every_rejected_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let alias = fake(dir.path(), "alias", "", 9009);
        let old = fake(dir.path(), "old", "3.8.0", 0);
        let missing = dir.path().join("does-not-exist");
        let error = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![
                cand("py -3", missing, InterpreterSource::PyLauncher),
                cand("python3", alias, InterpreterSource::PathProbe),
                cand("python", old, InterpreterSource::PathProbe),
            ],
        )
        .unwrap_err();
        let message = error.to_string();
        for needle in ["py -3", "python3", "python [", "could not be started", "9009", "3.8.0"] {
            assert!(message.contains(needle), "{needle} missing from {message}");
        }
    }

    #[test]
    fn bundle_marker_without_executable_is_bundle_broken_not_a_path_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let good = fake(dir.path(), "good", "3.12.2", 0);
        let error = resolve_with(
            dir.path(),
            None,
            Some(good.clone().into_os_string()),
            Some(dir.path().join("python/python.exe")),
            vec![cand("python", good, InterpreterSource::PathProbe)],
        )
        .unwrap_err();
        assert!(matches!(error, InterpreterError::BundleBroken { .. }));
    }

    #[test]
    fn discovered_interpreter_without_fullmag_dependencies_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let bare = fake_with_missing(dir.path(), "bare", "3.12.10", "numpy,zarr");
        let full = fake(dir.path(), "full", "3.12.2", 0);
        let resolved = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![
                cand("py -3", bare.clone(), InterpreterSource::PyLauncher),
                cand("python", full, InterpreterSource::PathProbe),
            ],
        )
        .unwrap();
        assert_eq!(resolved.version, "3.12.2");
        assert_eq!(
            resolved.tried[0].rejection,
            Rejection::MissingPackages(vec!["numpy".into(), "zarr".into()])
        );
        // An explicit choice is honoured as given; dependencies are not policed.
        let explicit = resolve_with(dir.path(), Some(bare.into_os_string()), None, None, Vec::new())
            .unwrap();
        assert_eq!(explicit.source, InterpreterSource::Explicit);
    }

    #[test]
    fn explicit_choice_outranks_env_and_failures_serialize() {
        let dir = tempfile::tempdir().unwrap();
        let explicit = fake(dir.path(), "explicit", "3.12.1", 0);
        let env_python = fake(dir.path(), "env", "3.13.0", 0);
        let resolved = resolve_with(
            dir.path(),
            Some(explicit.into_os_string()),
            Some(env_python.into_os_string()),
            None,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(resolved.source, InterpreterSource::Explicit);
        assert_eq!(resolved.version, "3.12.1");
        let json = resolved.to_json();
        assert_eq!(json["status"], "resolved");
        assert_eq!(json["source"], "explicit");

        let alias = fake(dir.path(), "alias", "", 9009);
        let error = resolve_with(
            dir.path(),
            None,
            None,
            None,
            vec![cand("python3", alias, InterpreterSource::PathProbe)],
        )
        .unwrap_err();
        let json = error.to_json();
        assert_eq!(json["status"], "error");
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["tried"][0]["candidate"], "python3");
    }

    #[test]
    fn command_carries_utf8_flags() {
        let resolved = ResolvedInterpreter {
            path: PathBuf::from("python"),
            version: "3.12.2".into(),
            source: InterpreterSource::PathProbe,
            isolated: false,
            flags: flags_for(false),
            tried: Vec::new(),
            notes: Vec::new(),
        };
        let command = resolved.command(Path::new(".")).unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(args, resolved.flags);
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "PYTHONUTF8" && value.and_then(|v| v.to_str()) == Some("1")));
        assert_eq!(flags_for(true), ["-I", "-u", "-X", "utf8"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_override_rejects_relative_paths_without_creating_files() {
        for path in ["state", "../state", "."] {
            assert_eq!(
                validated_state_override(Some(path.into()))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn state_override_preserves_absolute_paths_and_empty_default() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        assert_eq!(
            validated_state_override(Some(state.clone())).unwrap(),
            Some(state)
        );
        assert_eq!(
            validated_state_override(Some(PathBuf::new())).unwrap(),
            None
        );
        assert_eq!(validated_state_override(None).unwrap(), None);
    }

    #[test]
    fn legacy_bundle_is_owned_but_source_checkout_keeps_development_selection() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("bin")).unwrap();
        std::fs::create_dir(root.join("web")).unwrap();
        std::fs::write(root.join("bin/fullmag.exe"), "fixture").unwrap();
        assert_eq!(
            packaged_python_for_platform(root, true),
            Some(root.join("python/python.exe"))
        );
        std::fs::create_dir_all(root.join("packages/fullmag-py/src/fullmag")).unwrap();
        assert_eq!(packaged_python_for_platform(root, true), None);
    }

    #[test]
    fn state_directory_requires_absolute_user_storage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        assert_eq!(
            windows_state_directory(Some(root.clone()), None).unwrap(),
            root.join("Fullmag")
        );
        assert_eq!(
            windows_state_directory(Some("relative".into()), Some(root.clone())).unwrap(),
            root.join("AppData/Local/Fullmag")
        );
        assert!(windows_state_directory(None, None).is_err());
        assert!(windows_state_directory(Some("relative".into()), None).is_err());
    }

    #[test]
    fn package_marker_prevents_external_fallback_even_without_executable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert_eq!(packaged_python_for_platform(root, true), None);
        std::fs::create_dir(root.join("share")).unwrap();
        std::fs::write(root.join("share/version.json"), "{}").unwrap();
        assert_eq!(
            packaged_python_for_platform(root, true),
            Some(root.join("python/python.exe"))
        );
        assert_eq!(packaged_python_for_platform(root, false), None);
        let mut command = Command::new(root.join("python/python.exe"));
        assert!(configure_packaged_python(&mut command, root).is_err());
    }

    #[test]
    fn packaged_command_is_isolated_and_rejects_changed_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let python = root.join("python");
        std::fs::create_dir_all(python.join("site-packages/fullmag")).unwrap();
        for name in [
            "python.exe",
            "python312.dll",
            "python3.dll",
            "python312.zip",
            "sitecustomize.py",
            "site-packages/fullmag/__init__.py",
        ] {
            std::fs::write(python.join(name), "fixture").unwrap();
        }
        std::fs::write(
            python.join("python312._pth"),
            b"python312.zip\n.\nsite-packages\nimport site\n",
        )
        .unwrap();
        let mut command = Command::new(python.join("python.exe"));
        configure_packaged_python(&mut command, root).unwrap();
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect::<Vec<_>>(),
            ["-I", "-u"]
        );
        for name in ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE"] {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            std::env::split_paths(path).collect::<Vec<_>>(),
            [root.join("bin"), python.clone()]
        );
        std::fs::write(python.join("python312._pth"), "../outside\n").unwrap();
        assert!(configure_packaged_python(&mut Command::new("unused"), root).is_err());
    }
}

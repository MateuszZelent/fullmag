//! Syntax and import check of a script for the workspace inspector.
//!
//! Runs the never-executing Python helper `inspect-script` (`ast` and
//! `importlib.util.find_spec` of top-level names only) with the one
//! interpreter `fullmag script inspect` resolves, under a short deadline, and
//! caches the answer by content digest and folder for the life of the process.
//! The script itself is never imported, compiled for execution or run. Any
//! failure leaves the caller with its static scan; nothing here guesses.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use fullmag_workspace_inspect::{apply_python_inspection, ScriptDetail};
use serde_json::Value;

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;
/// A failed check is not retried for this long, so a broken interpreter does
/// not cost a spawn on every detail request.
const FAILURE_TTL: Duration = Duration::from_secs(30);

enum Cached {
    Document(Value),
    Failed(String, Instant),
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Replace the static facts of `detail` by the parser's, when an interpreter
/// resolves and the helper answers in time. Otherwise `detail` keeps its
/// static scan and `degraded_reason` says why Python did not check it.
pub(crate) fn apply_script_check(path: &Path, detail: &mut ScriptDetail) {
    if detail.read_error.is_some() {
        return;
    }
    let Some(sha256) = detail.sha256.clone() else {
        return;
    };
    // Local modules next to the script change what resolves.
    let folder = path
        .parent()
        .map(|parent| parent.display().to_string())
        .unwrap_or_default();
    let key = format!("{sha256}\u{0}{folder}");
    let cached = {
        let guard = cache().lock().unwrap_or_else(|poison| poison.into_inner());
        match guard.get(&key) {
            Some(Cached::Document(document)) => Some(Ok(document.clone())),
            Some(Cached::Failed(reason, at)) if at.elapsed() < FAILURE_TTL => {
                Some(Err(reason.clone()))
            }
            _ => None,
        }
    };
    let outcome = cached.unwrap_or_else(|| {
        let fresh = run_helper(path);
        let mut guard = cache().lock().unwrap_or_else(|poison| poison.into_inner());
        match &fresh {
            Ok(document) => {
                guard.insert(key, Cached::Document(document.clone()));
            }
            Err(reason) => {
                guard.insert(key, Cached::Failed(reason.clone(), Instant::now()));
            }
        }
        fresh
    });
    let applied = outcome.and_then(|document| apply_python_inspection(detail, &document));
    if let Err(reason) = applied {
        detail.degraded_reason = Some(format!(
            "static line scan; Python did not check the script ({reason}); the script was not executed"
        ));
    }
}

fn run_helper(path: &Path) -> Result<Value, String> {
    let root = crate::script::repo_root();
    let real_root = crate::script::python_workspace_root(&root);
    let interpreter = crate::script::resolve_python(&root).map_err(|error| error.message)?;
    let mut command = interpreter
        .command(&real_root)
        .map_err(|error| format!("the bundled Python runtime is incomplete: {error}"))?;
    command.args(["-m", "fullmag.runtime.helper", "inspect-script", "--script"]);
    command.arg(path);
    command.env("PYTHONUNBUFFERED", "1");
    if !interpreter.isolated {
        let mut paths = Vec::new();
        for candidate in [
            real_root.join("packages").join("fullmag-py").join("src"),
            real_root.join("python").join("site-packages"),
            real_root.join(".fullmag").join("local"),
        ] {
            if candidate.is_dir() {
                paths.push(candidate.display().to_string());
            }
        }
        if let Some(existing) = std::env::var_os("PYTHONPATH") {
            if !existing.is_empty() {
                paths.push(existing.to_string_lossy().into_owned());
            }
        }
        if !paths.is_empty() {
            command.env("PYTHONPATH", paths.join(if cfg!(windows) { ";" } else { ":" }));
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", interpreter.path.display()))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stdout).take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut bytes);
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stderr).take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the Python helper exceeded the 5 second deadline".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("waiting for the Python helper failed: {error}"));
            }
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let text = String::from_utf8_lossy(&stderr);
        let last = text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(format!("the Python helper exited with {status}: {last}"));
    }
    if stdout.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("the Python helper answered with too much output".into());
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("the Python helper returned invalid JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_workspace_inspect::inspect_script;

    /// These tests need the interpreter of the environment (`FULLMAG_PYTHON`).
    fn python_available() -> bool {
        crate::script::resolve_python(&crate::script::repo_root()).is_ok()
    }

    fn check(source: &str) -> ScriptDetail {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.py");
        std::fs::write(&path, source).unwrap();
        let mut detail = inspect_script(&path);
        apply_script_check(&path, &mut detail);
        detail
    }

    #[test]
    fn a_valid_script_is_parsed_and_its_imports_are_resolved_without_running_it() {
        if !python_available() {
            eprintln!("no Python interpreter; skipped");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("executed.txt");
        let source = format!(
            "import os, json\nimport definitely_missing_module_xyz\nopen({:?}, 'w').write('x')\nos.environ.get('CHECK_ME')\n",
            marker.display().to_string()
        );
        let path = dir.path().join("sim.py");
        std::fs::write(&path, &source).unwrap();
        let mut detail = inspect_script(&path);
        assert!(detail.degraded && !detail.syntax_checked);
        apply_script_check(&path, &mut detail);
        assert!(detail.syntax_checked && !detail.degraded, "{:?}", detail.degraded_reason);
        assert_eq!(detail.degraded_reason, None);
        assert_eq!(detail.syntax.as_ref().map(|syntax| syntax.ok), Some(true));
        assert_eq!(
            detail.unresolved_imports,
            Some(vec!["definitely_missing_module_xyz".to_string()])
        );
        assert_eq!(detail.env_reads, Some(vec!["CHECK_ME".to_string()]));
        assert!(!marker.exists(), "the script must never be executed");
    }

    #[test]
    fn a_syntax_error_reports_line_and_message_and_stays_degraded() {
        if !python_available() {
            eprintln!("no Python interpreter; skipped");
            return;
        }
        let detail = check("import os\nx = (1,\ndef broken(:\n");
        let syntax = detail.syntax.expect("syntax result");
        assert!(!syntax.ok);
        assert!(syntax.line.is_some());
        assert!(syntax.message.as_deref().is_some_and(|text| !text.is_empty()));
        assert!(detail.syntax_checked);
        assert!(detail.degraded);
        assert_eq!(detail.unresolved_imports, None);
    }

    #[test]
    fn repeated_checks_of_the_same_bytes_are_served_from_the_cache() {
        if !python_available() {
            eprintln!("no Python interpreter; skipped");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cached.py");
        std::fs::write(&path, "import os\n").unwrap();
        let mut first = inspect_script(&path);
        apply_script_check(&path, &mut first);
        let started = Instant::now();
        let mut second = inspect_script(&path);
        apply_script_check(&path, &mut second);
        assert_eq!(first.syntax, second.syntax);
        assert!(second.syntax_checked);
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}

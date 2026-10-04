//! `fullmag script inspect <path> --json [--python <abs path>]`.
//!
//! Prints `fullmag.script_inspect.v1` (docs/design/start-screen/docs/08-script-open.md 6.2).
//! The script is only read and parsed: the Python helper command
//! `inspect-script` uses `ast` and `importlib.util.find_spec` for top-level
//! names and never imports or executes the file. When no interpreter resolves
//! or the helper fails, a Rust-only degraded document is produced in which
//! every fact that needs Python is `null` ("not checked"), never a guess.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use fullmag_runtime_control::python_runtime::{
    resolve_interpreter_with, InterpreterError, ResolvedInterpreter,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::args::ScriptSubcommand;
use crate::control_room::repo_root;
use crate::python_bridge::run_python_helper_with_interpreter;

pub(crate) const SCRIPT_INSPECT_SCHEMA: &str = "fullmag.script_inspect.v1";

pub(crate) fn handle_script(command: ScriptSubcommand) -> Result<()> {
    let ScriptSubcommand::Inspect { path, json, python } = command;
    if let Some(explicit) = &python {
        if !explicit.is_absolute() {
            bail!("--python must be an absolute path");
        }
    }
    let document = inspect_script(&path, python.as_deref())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&document)?);
    } else {
        println!("{}", human_summary(&document));
    }
    Ok(())
}

fn inspect_script(path: &Path, python: Option<&Path>) -> Result<Value> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("cannot read script {}", path.display()))?;
    if !metadata.is_file() {
        bail!("{} is not a file", path.display());
    }
    let root = repo_root();
    let interpreter = resolve_interpreter_with(&root, python);
    Ok(match &interpreter {
        Ok(resolved) => match run_helper(&root, resolved, path) {
            Ok(mut document) => {
                document.insert("interpreter".into(), resolved.to_json());
                Value::Object(document)
            }
            Err(reason) => degraded(path, resolved.to_json(), Some(&reason))?,
        },
        Err(error) => degraded(path, interpreter_error_json(error), None)?,
    })
}

fn interpreter_error_json(error: &InterpreterError) -> Value {
    error.to_json()
}

fn run_helper(
    root: &Path,
    interpreter: &ResolvedInterpreter,
    path: &Path,
) -> std::result::Result<Map<String, Value>, String> {
    let args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "inspect-script".to_string(),
        "--script".to_string(),
        display_path(path),
    ];
    let output = run_python_helper_with_interpreter(root, interpreter, &args, None)
        .map_err(|error| format!("{error:#}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // The last stderr line is the exception message of a Python traceback.
        let last_line = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        return Err(format!(
            "inspect-script exited with {}: {}",
            output.status,
            last_line.trim().chars().take(300).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("inspect-script returned invalid JSON: {error}"))?;
    match value {
        Value::Object(document) if document.get("schema") == Some(&json!(SCRIPT_INSPECT_SCHEMA)) => {
            Ok(document)
        }
        _ => Err(format!(
            "inspect-script did not return a {SCRIPT_INSPECT_SCHEMA} document"
        )),
    }
}

/// Path as the user would type it: no `\\?\` verbatim prefix on Windows.
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
}

#[derive(Debug, PartialEq, Eq)]
struct ByteFacts {
    sha256: String,
    bytes: usize,
    lines: usize,
    encoding: &'static str,
}

fn byte_facts(raw: &[u8]) -> ByteFacts {
    let encoding = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if std::str::from_utf8(&raw[3..]).is_ok() {
            "utf-8-bom"
        } else {
            "other"
        }
    } else if raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]) {
        "other"
    } else if std::str::from_utf8(raw).is_ok() {
        "utf-8"
    } else {
        "other"
    };
    let newlines = raw.iter().filter(|byte| **byte == b'\n').count();
    let lines = newlines + usize::from(!raw.is_empty() && !raw.ends_with(b"\n"));
    ByteFacts {
        sha256: format!("{:x}", Sha256::digest(raw)),
        bytes: raw.len(),
        lines,
        encoding,
    }
}

/// Rust-only result. Facts that require Python are `null` and `degraded` is
/// true, so a consumer can never mistake "not checked" for "clean".
fn degraded(path: &Path, interpreter: Value, helper_error: Option<&str>) -> Result<Value> {
    let raw = std::fs::read(path).map_err(|error| anyhow!("cannot read {}: {error}", path.display()))?;
    let facts = byte_facts(&raw);
    let reason = match helper_error {
        Some(error) => format!("the Python helper failed: {error}"),
        None => "no usable Python interpreter".to_string(),
    };
    Ok(json!({
        "schema": SCRIPT_INSPECT_SCHEMA,
        "degraded": true,
        "degraded_reason": reason,
        "sha256": facts.sha256,
        "bytes": facts.bytes,
        "lines": facts.lines,
        "encoding": facts.encoding,
        "syntax": { "checked": false },
        "summary": null,
        "imports": null,
        "env_reads": null,
        "declares": null,
        "interpreter": interpreter,
    }))
}

fn human_summary(document: &Value) -> String {
    let get = |key: &str| document.get(key).cloned().unwrap_or(Value::Null);
    let mut lines = vec![
        format!("sha256:   {}", get("sha256").as_str().unwrap_or("?")),
        format!("size:     {} bytes, {} lines", get("bytes"), get("lines")),
        format!("encoding: {}", get("encoding").as_str().unwrap_or("?")),
    ];
    let syntax = get("syntax");
    lines.push(match (syntax.get("ok"), syntax.get("checked")) {
        (Some(Value::Bool(true)), _) => "syntax:   ok".to_string(),
        (Some(Value::Bool(false)), _) => format!(
            "syntax:   error at line {} column {}: {}",
            syntax["line"], syntax["column"], syntax["message"].as_str().unwrap_or("")
        ),
        _ => "syntax:   not checked".to_string(),
    });
    if document.get("degraded") == Some(&Value::Bool(true)) {
        lines.push(format!(
            "degraded: {}",
            document["degraded_reason"].as_str().unwrap_or("")
        ));
    }
    let interpreter = get("interpreter");
    lines.push(match interpreter["status"].as_str() {
        Some("resolved") => format!(
            "python:   {} ({}, {})",
            interpreter["path"].as_str().unwrap_or("?"),
            interpreter["version"].as_str().unwrap_or("?"),
            interpreter["source"].as_str().unwrap_or("?")
        ),
        _ => format!("python:   {}", interpreter["message"].as_str().unwrap_or("unresolved")),
    });
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique file under the system temp dir; the OS temp cleanup owns removal.
    fn scratch_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fullmag-script-inspect-{}-{}",
            std::process::id(),
            name.replace('.', "_")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn byte_facts_detect_encoding_and_count_lines() {
        let plain = byte_facts(b"x = 1\ny = 2\n");
        assert_eq!((plain.encoding, plain.lines, plain.bytes), ("utf-8", 2, 12));
        assert_eq!(plain.sha256.len(), 64);
        let no_trailing_newline = byte_facts(b"x = 1\ny = 2");
        assert_eq!(no_trailing_newline.lines, 2);
        assert_eq!(byte_facts(b"").lines, 0);
        assert_eq!(byte_facts(b"\xEF\xBB\xBFx = 1\n").encoding, "utf-8-bom");
        assert_eq!(byte_facts(b"# \xB5\n").encoding, "other");
        assert_eq!(byte_facts(b"\xFF\xFEx\x00").encoding, "other");
    }

    #[test]
    fn degraded_document_marks_python_facts_as_not_checked() {
        let script = scratch_file("degraded.py");
        std::fs::write(&script, "import os\n").unwrap();
        let error = InterpreterError::NotFound { tried: Vec::new() };
        let document = degraded(&script, error.to_json(), None).unwrap();
        assert_eq!(document["schema"], SCRIPT_INSPECT_SCHEMA);
        assert_eq!(document["degraded"], true);
        assert_eq!(document["syntax"], json!({ "checked": false }));
        for key in ["summary", "imports", "env_reads", "declares"] {
            assert!(document[key].is_null(), "{key} must be null when unchecked");
        }
        assert_eq!(document["interpreter"]["status"], "error");
        assert_eq!(document["interpreter"]["kind"], "not_found");
        assert_eq!(document["bytes"], 10);
        assert_eq!(document["lines"], 1);
        assert!(human_summary(&document).contains("not checked"));
    }

    #[test]
    fn helper_failure_keeps_resolved_interpreter_in_degraded_document() {
        let script = scratch_file("helper_failure.py");
        std::fs::write(&script, "x = 1\n").unwrap();
        let interpreter = json!({ "status": "resolved", "path": "python", "version": "3.12.2" });
        let document = degraded(&script, interpreter, Some("boom")).unwrap();
        assert_eq!(document["interpreter"]["status"], "resolved");
        assert!(document["degraded_reason"].as_str().unwrap().contains("boom"));
    }

    #[test]
    fn display_path_drops_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.py")), r"C:\a\b.py");
        assert_eq!(display_path(Path::new("rel/b.py")), "rel/b.py");
    }

    #[test]
    fn script_is_a_registered_subcommand_not_a_script_name() {
        let raw = |parts: &[&str]| parts.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert!(!crate::is_script_mode(&raw(&["fullmag", "script", "inspect", "x.py", "--json"])));
        assert!(crate::is_script_mode(&raw(&["fullmag", "x.py"])));
    }
}

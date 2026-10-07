//! Inspector reader of a Python script: a bounded static scan, never an
//! execution and never an import.
//!
//! The Python helper behind `fullmag script inspect` parses with `ast`, but it
//! needs an interpreter and lives in a binary crate, so the local runtime API
//! cannot call it as a library function. This reader gives the same facts it
//! can derive without Python (hash, size, lines, encoding, docstring summary,
//! imported top-level names, literal environment reads) and says so with
//! `degraded: true` and `syntax_checked: false`.

use std::io::Read;
use std::path::Path;

use fullmag_workspace::{hash_file, script_meta_from_text, MAX_HASHED_BYTES, MAX_SCRIPT_BYTES};

use crate::detail::{ScriptDetail, ScriptSyntax};

const DEGRADED_REASON: &str =
    "static line scan; no Python interpreter was used and the script was not executed";

/// Read the script at `path`. Never fails: problems land in `read_error`.
pub fn inspect_script(path: &Path) -> ScriptDetail {
    let mut detail = ScriptDetail {
        read_error: None,
        sha256: None,
        bytes: None,
        lines: None,
        encoding: None,
        truncated: false,
        summary: None,
        uses_fullmag: None,
        imports: None,
        env_reads: None,
        syntax: None,
        unresolved_imports: None,
        syntax_checked: false,
        degraded: true,
        degraded_reason: Some(DEGRADED_REASON.to_string()),
    };
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => detail.bytes = Some(meta.len()),
        Ok(_) => {
            detail.read_error = Some("the path is not a file".into());
            return detail;
        }
        Err(error) => {
            detail.read_error = Some(format!("cannot read the script: {error}"));
            return detail;
        }
    }
    match hash_file(path) {
        Ok(observed) => {
            detail.sha256 = Some(observed.sha256);
            detail.bytes = Some(observed.bytes);
            detail.lines = Some(observed.lines);
        }
        Err(error) => {
            detail.degraded_reason = Some(format!(
                "{DEGRADED_REASON}; the file was not hashed ({error}, limit {} bytes)",
                MAX_HASHED_BYTES
            ));
        }
    }

    let mut head = Vec::new();
    match std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SCRIPT_BYTES + 1).read_to_end(&mut head))
    {
        Ok(_) => {}
        Err(error) => {
            detail.read_error = Some(format!("cannot read the script: {error}"));
            return detail;
        }
    }
    detail.truncated = head.len() as u64 > MAX_SCRIPT_BYTES;
    if detail.truncated {
        head.truncate(MAX_SCRIPT_BYTES as usize);
    }
    let (encoding, text) = decode(&head, detail.truncated);
    detail.encoding = Some(encoding.to_string());
    let Some(text) = text else {
        detail.degraded_reason = Some(format!(
            "{DEGRADED_REASON}; the file is not UTF-8 text, so nothing was scanned"
        ));
        return detail;
    };

    let facts = script_meta_from_text(text);
    detail.summary = facts
        .get("summary")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    detail.uses_fullmag = facts.get("uses_fullmag").and_then(|value| value.as_bool());
    detail.imports = Some(top_level_imports(text));
    detail.env_reads = Some(literal_env_reads(text));
    detail
}

/// Fill `detail` from a `fullmag.script_inspect.v1` document that the Python
/// helper `inspect-script` produced (`ast` and `find_spec` only; the script is
/// never executed). The document must describe the same bytes as `detail`;
/// otherwise nothing is changed and the reason is returned.
///
/// A syntax error is a valid answer: it sets `syntax` and keeps the static
/// scan for the other facts, with `degraded` still true. A clean parse
/// replaces imports, unresolved imports and environment reads and clears
/// `degraded`.
pub fn apply_python_inspection(
    detail: &mut ScriptDetail,
    document: &serde_json::Value,
) -> Result<(), String> {
    if document.get("schema").and_then(|value| value.as_str()) != Some("fullmag.script_inspect.v1") {
        return Err("the Python helper did not return a fullmag.script_inspect.v1 document".into());
    }
    let digest = document.get("sha256").and_then(|value| value.as_str());
    match (digest, detail.sha256.as_deref()) {
        (Some(reported), Some(own)) if reported.eq_ignore_ascii_case(own) => {}
        _ => return Err("the Python helper read different bytes than the static scan".into()),
    }
    let syntax = document
        .get("syntax")
        .and_then(|value| value.as_object())
        .ok_or("the Python helper reported no syntax result")?;
    let ok = syntax
        .get("ok")
        .and_then(|value| value.as_bool())
        .ok_or("the Python helper reported no syntax verdict")?;
    detail.syntax = Some(ScriptSyntax {
        ok,
        line: syntax.get("line").and_then(|value| value.as_u64()),
        column: syntax.get("column").and_then(|value| value.as_u64()),
        message: syntax
            .get("message")
            .and_then(|value| value.as_str())
            .map(|text| text.chars().take(300).collect()),
    });
    detail.syntax_checked = true;
    if !ok {
        detail.degraded = true;
        detail.degraded_reason = Some(
            "the script does not parse; imports and environment reads come from a line scan".into(),
        );
        return Ok(());
    }
    let strings = |value: Option<&serde_json::Value>| -> Option<Vec<String>> {
        value.and_then(|value| value.as_array()).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
    };
    if let Some(summary) = document.get("summary") {
        detail.summary = summary.as_str().map(str::to_string);
    }
    let imports = document.get("imports");
    if let Some(top_level) = strings(imports.and_then(|value| value.get("top_level"))) {
        detail.imports = Some(top_level);
    }
    detail.uses_fullmag = imports
        .and_then(|value| value.get("fullmag"))
        .and_then(|value| value.as_bool())
        .or(detail.uses_fullmag);
    detail.unresolved_imports = strings(imports.and_then(|value| value.get("unresolved")));
    if let Some(reads) = strings(document.get("env_reads")) {
        detail.env_reads = Some(reads);
    }
    detail.degraded = false;
    detail.degraded_reason = None;
    Ok(())
}

/// `("utf-8" | "utf-8-bom" | "other", decoded text if UTF-8)`. A multi-byte
/// character cut at the end of a truncated read is not an error.
fn decode(bytes: &[u8], truncated: bool) -> (&'static str, Option<&str>) {
    let (label, body) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => ("utf-8-bom", rest),
        None => ("utf-8", bytes),
    };
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return ("other", None);
    }
    match std::str::from_utf8(body) {
        Ok(text) => (label, Some(text)),
        Err(error) if truncated && error.error_len().is_none() => {
            let valid = &body[..error.valid_up_to()];
            (label, std::str::from_utf8(valid).ok())
        }
        Err(_) => ("other", None),
    }
}

/// Top-level module names of `import a.b, c as d` and `from e.f import g`
/// lines at any indentation. Relative imports and comments are skipped.
fn top_level_imports(text: &str) -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    for line in text.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("import ") {
            for item in rest.split(',') {
                let module = item.trim().split_whitespace().next().unwrap_or("");
                insert_top_level(&mut names, module);
            }
        } else if let Some(rest) = line.strip_prefix("from ") {
            let module = rest.split_whitespace().next().unwrap_or("");
            insert_top_level(&mut names, module);
        }
    }
    names.into_iter().collect()
}

fn insert_top_level(names: &mut std::collections::BTreeSet<String>, module: &str) {
    let top = module.split('.').next().unwrap_or("");
    let identifier = !top.is_empty()
        && top.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !top.starts_with(|c: char| c.is_ascii_digit());
    if identifier {
        names.insert(top.to_string());
    }
}

/// Names read through `environ["X"]`, `environ.get("X")` or `getenv("X")` with
/// a string literal key. Comment lines are skipped. Values are never read.
fn literal_env_reads(text: &str) -> Vec<String> {
    const PATTERNS: [&str; 3] = ["environ[", "environ.get(", "getenv("];
    let mut names = std::collections::BTreeSet::new();
    for line in text.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        for pattern in PATTERNS {
            let mut rest = line;
            while let Some(at) = rest.find(pattern) {
                rest = &rest[at + pattern.len()..];
                let after = rest.trim_start();
                let mut chars = after.chars();
                let Some(quote) = chars.next().filter(|c| *c == '"' || *c == '\'') else {
                    continue;
                };
                let name: String = chars.take_while(|c| *c != quote).collect();
                let valid = !name.is_empty()
                    && name.len() <= 128
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-');
                if valid {
                    names.insert(name);
                }
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "#!/usr/bin/env python\n\"\"\"Domain wall in a strip.\n\nMore.\n\"\"\"\nimport os, numpy as np\nimport fullmag as fm\nfrom fullmag.shapes import Box\nfrom . import sibling\nif True:\n    import scipy.linalg\nthreads = os.environ.get('FULLMAG_THREADS', '4')\nkey = os.environ[\"SECRET_TOKEN\"]\nhome = os.getenv('HOME')\ndynamic = os.environ[name]\n# os.getenv('COMMENTED')\nprint('SECRET-VALUE-NOT-SCANNED')\n";

    #[test]
    fn scans_facts_without_executing_or_keeping_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wall.py");
        std::fs::write(&path, SCRIPT).unwrap();
        let detail = inspect_script(&path);
        assert_eq!(detail.read_error, None);
        assert_eq!(detail.encoding.as_deref(), Some("utf-8"));
        assert_eq!(detail.bytes, Some(SCRIPT.len() as u64));
        assert_eq!(detail.lines, Some(SCRIPT.lines().count() as u64));
        assert_eq!(detail.sha256.as_deref().map(str::len), Some(64));
        assert_eq!(detail.summary.as_deref(), Some("Domain wall in a strip."));
        assert_eq!(detail.uses_fullmag, Some(true));
        assert_eq!(
            detail.imports,
            Some(vec![
                "fullmag".to_string(),
                "numpy".to_string(),
                "os".to_string(),
                "scipy".to_string()
            ])
        );
        assert_eq!(
            detail.env_reads,
            Some(vec![
                "FULLMAG_THREADS".to_string(),
                "HOME".to_string(),
                "SECRET_TOKEN".to_string()
            ])
        );
        assert!(detail.degraded && !detail.syntax_checked);
        let json = serde_json::to_string(&detail).unwrap();
        assert!(!json.contains("SECRET-VALUE-NOT-SCANNED"));
    }

    #[test]
    fn sha256_matches_the_workspace_digest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.py");
        std::fs::write(&path, "x = 1\n").unwrap();
        assert_eq!(
            inspect_script(&path).sha256,
            Some(hash_file(&path).unwrap().sha256)
        );
    }

    #[test]
    fn non_utf8_and_missing_files_are_reported_not_raised() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latin.py");
        std::fs::write(&path, [b'x', b' ', b'=', b' ', 0xE9, b'\n']).unwrap();
        let detail = inspect_script(&path);
        assert_eq!(detail.encoding.as_deref(), Some("other"));
        assert_eq!(detail.read_error, None);
        assert!(detail.sha256.is_some());
        assert_eq!(detail.imports, None);

        let missing = inspect_script(&dir.path().join("nope.py"));
        assert!(missing.read_error.is_some());
        let folder = inspect_script(dir.path());
        assert_eq!(folder.read_error.as_deref(), Some("the path is not a file"));
    }

    #[test]
    fn bom_is_labelled_and_large_files_are_truncated_for_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bom.py");
        std::fs::write(&path, b"\xEF\xBB\xBFimport fullmag\n").unwrap();
        let detail = inspect_script(&path);
        assert_eq!(detail.encoding.as_deref(), Some("utf-8-bom"));
        assert_eq!(detail.uses_fullmag, Some(true));

        let big = dir.path().join("big.py");
        let mut text = String::from("import fullmag\n");
        while (text.len() as u64) < MAX_SCRIPT_BYTES + 4096 {
            text.push_str("# filler \u{e9}\u{e9}\u{e9}\n");
        }
        std::fs::write(&big, &text).unwrap();
        let detail = inspect_script(&big);
        assert!(detail.truncated);
        assert_eq!(detail.bytes, Some(text.len() as u64));
        assert_eq!(detail.sha256.as_deref().map(str::len), Some(64));
        assert_eq!(detail.uses_fullmag, Some(true));
    }
}

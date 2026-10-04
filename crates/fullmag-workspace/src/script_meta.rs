//! Cheap facts about a Python script, gathered without executing it.
//!
//! Only derived values are produced (line count, the first docstring line, an
//! import flag). The text of the file is never kept.

use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use crate::error::Result;

/// Files larger than this are only read up to the bound.
pub const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;

const MAX_SUMMARY_CHARS: usize = 200;

/// `{lines, summary, uses_fullmag}` for the script at `path`.
///
/// Reads at most [`MAX_SCRIPT_BYTES`]; when the file is longer the object also
/// carries `"truncated": true` and `lines` counts only the part read. Nothing
/// is executed or imported. `summary` is omitted when the module has no
/// docstring.
pub fn script_meta(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_SCRIPT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > MAX_SCRIPT_BYTES;
    if truncated {
        bytes.truncate(MAX_SCRIPT_BYTES as usize);
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut meta = script_meta_from_text(&text);
    if truncated {
        meta["truncated"] = Value::Bool(true);
    }
    Ok(meta)
}

/// [`script_meta`] over text already in memory.
pub fn script_meta_from_text(text: &str) -> Value {
    let mut meta = json!({
        "lines": text.lines().count(),
        "uses_fullmag": text.lines().any(imports_fullmag),
    });
    if let Some(summary) = docstring_summary(text) {
        meta["summary"] = Value::String(summary);
    }
    meta
}

/// True for `import fullmag`, `import fullmag as fm`, `import os, fullmag.x`,
/// `from fullmag import ...` and `from fullmag.sub import ...`. A line-based
/// scan: an import inside a string literal also counts.
fn imports_fullmag(line: &str) -> bool {
    let line = line.trim_start();
    if let Some(rest) = line.strip_prefix("import ") {
        return rest.split(',').any(|item| {
            let module = item.trim().split_whitespace().next().unwrap_or("");
            is_fullmag_module(module)
        });
    }
    if let Some(rest) = line.strip_prefix("from ") {
        let module = rest.split_whitespace().next().unwrap_or("");
        return is_fullmag_module(module);
    }
    false
}

fn is_fullmag_module(module: &str) -> bool {
    module == "fullmag" || module.starts_with("fullmag.")
}

/// First non-empty line of the module docstring, if the first statement is a
/// plain string literal.
fn docstring_summary(text: &str) -> Option<String> {
    let mut rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    // Skip blank lines and comments (shebang, encoding declaration).
    loop {
        let trimmed = rest.trim_start_matches([' ', '\t', '\r', '\n', '\u{c}']);
        if let Some(after) = trimmed.strip_prefix('#') {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else {
            rest = trimmed;
            break;
        }
    }
    // Optional string prefix (raw / unicode); bytes and f-strings are not docstrings.
    let mut chars = rest.char_indices();
    let mut start = 0;
    if let Some((_, c)) = chars.next() {
        if matches!(c, 'r' | 'R' | 'u' | 'U') {
            start = c.len_utf8();
        }
    }
    let literal = &rest[start..];
    let (quote, body) = if let Some(body) = literal.strip_prefix("\"\"\"") {
        ("\"\"\"", body)
    } else if let Some(body) = literal.strip_prefix("'''") {
        ("'''", body)
    } else if let Some(body) = literal.strip_prefix('"') {
        ("\"", body)
    } else if let Some(body) = literal.strip_prefix('\'') {
        ("'", body)
    } else {
        return None;
    };
    let content = body.split(quote).next().unwrap_or(body);
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.chars().take(MAX_SUMMARY_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_summary_lines_and_import_flag() {
        let text = "#!/usr/bin/env python\n\"\"\"Domain wall in a strip.\n\nLonger text.\n\"\"\"\nimport fullmag as fm\nprint(1)\n";
        let meta = script_meta_from_text(text);
        assert_eq!(meta["summary"], "Domain wall in a strip.");
        assert_eq!(meta["lines"], 7);
        assert_eq!(meta["uses_fullmag"], true);
    }

    #[test]
    fn detects_import_forms_and_rejects_lookalikes() {
        for yes in [
            "import fullmag",
            "  import fullmag as fm",
            "import os, fullmag.shapes",
            "from fullmag import Box",
            "from fullmag.model import X",
        ] {
            assert!(imports_fullmag(yes), "{yes}");
        }
        for no in [
            "import fullmagic",
            "from fullmagnetics import x",
            "# import fullmag",
            "x = 'import fullmag'",
            "import numpy",
        ] {
            assert!(!imports_fullmag(no), "{no}");
        }
    }

    #[test]
    fn no_docstring_means_no_summary_key() {
        let meta = script_meta_from_text("x = 1\n");
        assert!(meta.get("summary").is_none());
        assert_eq!(meta["uses_fullmag"], false);
        let meta = script_meta_from_text("x = 1\n'''not first'''\n");
        assert!(meta.get("summary").is_none());
    }

    #[test]
    fn single_line_and_prefixed_docstrings() {
        assert_eq!(
            script_meta_from_text("r'Raw doc.'\n")["summary"],
            "Raw doc."
        );
        assert_eq!(
            script_meta_from_text("# c\n\n\"One line.\"\n")["summary"],
            "One line."
        );
        // f-strings and bytes are not docstrings.
        assert!(script_meta_from_text("f'x'\n").get("summary").is_none());
    }

    #[test]
    fn large_files_are_bounded_and_content_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.py");
        let mut text = String::from("import fullmag\n");
        while text.len() < 2 * 1024 * 1024 {
            text.push_str("# SECRET-MARKER filler line\n");
        }
        std::fs::write(&path, &text).unwrap();
        let meta = script_meta(&path).unwrap();
        assert_eq!(meta["truncated"], true);
        assert!(meta["lines"].as_u64().unwrap() < text.lines().count() as u64);
        assert!(!meta.to_string().contains("SECRET-MARKER"));
    }
}

//! Immutable file capture around raw Python DSL export; no profile binding or Submit.
use crate::args::ScriptCli;
use crate::types::ScriptExecutionConfig;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

const SOURCE_LIMIT: u64 = 8 * 1024 * 1024;
const RUNTIME_LIMIT: u64 = 128 * 1024 * 1024;
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const METADATA_LIMIT: usize = 8 * 1024 * 1024;

pub(crate) struct CapturedScriptSource {
    pub config: ScriptExecutionConfig,
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRecord {
    relative_path: String,
    asset_id: String,
    sha256: String,
    byte_count: u64,
    role: String,
    absolute_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    schema_version: String,
    entry_relative_path: String,
    records: Vec<FileRecord>,
    runtime: Value,
    inventory_sha256: String,
    #[serde(default)]
    observed_reads: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureEnvelope {
    #[serde(default)]
    config: Option<ScriptExecutionConfig>,
    capture: Capture,
}

fn portable_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path.is_ascii()
        && !path.contains('\\')
        && path.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.contains(':')
                && !p.chars().any(char::is_control)
        })
}

fn same_path_spelling(left: &Path, right: &Path) -> Result<bool> {
    // Reuse the launcher convention for Windows canonical verbatim prefixes.
    // Invalid Unicode is not representable in the JSON capture wire.
    left.to_str().context("capture path must be Unicode")?;
    right.to_str().context("capture path must be Unicode")?;
    let left = crate::script_launch::display_path(left);
    let right = crate::script_launch::display_path(right);
    Ok(if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    })
}

fn regular_file(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("source capture requires absolute paths");
    }
    for parent in path.ancestors() {
        let metadata = std::fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() {
            bail!("source capture refuses aliases and symlinks");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // FILE_ATTRIBUTE_REPARSE_POINT also covers junctions, not only symlinks.
            if metadata.file_attributes() & 0x400 != 0 {
                bail!("source capture refuses reparse points and junctions");
            }
        }
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) || !same_path_spelling(&std::fs::canonicalize(path)?, path)?
        || !std::fs::metadata(path)?.is_file()
    {
        bail!("source capture requires an unaliased regular file");
    }
    Ok(())
}

fn read_fixed_payload(reader: &mut impl Read, length: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    let mut extra = [0u8; 1];
    if reader.read(&mut extra)? != 0 {
        bail!("source capture file grew during read");
    }
    Ok(bytes)
}

fn read_pinned(record: &FileRecord) -> Result<Vec<u8>> {
    regular_file(&record.absolute_path)?;
    if record.byte_count > FILE_LIMIT {
        bail!("source capture file budget");
    }
    let mut file = std::fs::File::open(&record.absolute_path)?;
    let before = file.metadata()?;
    if before.len() != record.byte_count {
        bail!("source capture preimage size changed");
    }
    let bytes = read_fixed_payload(&mut file, usize::try_from(record.byte_count)?)?;
    let after = file.metadata()?;
    let end = std::fs::metadata(&record.absolute_path)?;
    if bytes.len() as u64 != record.byte_count
        || after.len() != before.len()
        || end.len() != before.len()
        || before.modified()? != after.modified()?
        || after.modified()? != end.modified()?
        || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
    {
        bail!("source capture file changed or digest mismatch");
    }
    Ok(bytes)
}

fn validate_capture(capture: &Capture, script: &Path, fullmag: &Path) -> Result<()> {
    if capture.schema_version != "fullmag.script-source-capture.v1"
        || capture.records.is_empty()
        || capture.records.len() > 8192
        || !portable_relative(&capture.entry_relative_path)
        || capture.inventory_sha256.len() != 64
    {
        bail!("invalid source capture envelope");
    }
    let mut keys = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut source_bytes = 0u64;
    let mut runtime_bytes = 0u64;
    let mut entry_found = false;
    for record in &capture.records {
        if !portable_relative(&record.relative_path)
            || !keys.insert(record.relative_path.to_ascii_lowercase())
            || !paths.insert(record.absolute_path.clone())
            || record.sha256.len() != 64
            || !record
                .sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || record.asset_id
                != format!(
                    "script-file-{:x}",
                    Sha256::digest(record.relative_path.as_bytes())
                )
        {
            bail!("invalid or colliding source capture file identity");
        }
        if record.role == "source" {
            let relative = record
                .relative_path
                .strip_prefix("source/")
                .context("source path namespace")?;
            if record.absolute_path != script.parent().context("script parent")?.join(relative) {
                bail!("source capture escapes owned script root");
            }
            source_bytes = source_bytes
                .checked_add(record.byte_count)
                .context("source size overflow")?;
        } else if record.role == "runtime" {
            if record.relative_path.starts_with("fullmag/")
                && !record.absolute_path.starts_with(fullmag)
            {
                bail!("source capture fullmag root mismatch");
            }
            runtime_bytes = runtime_bytes
                .checked_add(record.byte_count)
                .context("runtime size overflow")?;
        } else {
            bail!("unsupported source capture role");
        }
        if record.relative_path == capture.entry_relative_path {
            entry_found = record.absolute_path == script && record.role == "source";
        }
    }
    if !entry_found || source_bytes > SOURCE_LIMIT || runtime_bytes > RUNTIME_LIMIT {
        bail!("source capture entry identity or aggregate budget");
    }
    Ok(())
}

fn helper_arguments(
    script: &Path,
    fullmag: &Path,
    phase: &str,
    args: &ScriptCli,
    expected: Option<&str>,
) -> Vec<String> {
    use clap::ValueEnum;
    let helper = fullmag.join("runtime/accepted_source_capture.py");
    let mut result = vec![
        "-B".into(),
        "-S".into(),
        "-c".into(),
        "import runpy,sys; path=sys.argv.pop(1); runpy.run_path(path,run_name='__main__')".into(),
        helper.display().to_string(),
        "--phase".into(),
        phase.into(),
        "--script".into(),
        script.display().to_string(),
        "--fullmag-root".into(),
        fullmag.display().to_string(),
    ];
    if let Some(expected) = expected {
        result.extend(["--expected-inventory".into(), expected.into()]);
    }
    if let Some(value) = args.backend {
        result.extend([
            "--backend".into(),
            value.to_possible_value().unwrap().get_name().into(),
        ]);
    }
    if let Some(value) = args.mode {
        result.extend([
            "--mode".into(),
            value.to_possible_value().unwrap().get_name().into(),
        ]);
    }
    if let Some(value) = args.precision {
        result.extend([
            "--precision".into(),
            value.to_possible_value().unwrap().get_name().into(),
        ]);
    }
    result
}

fn response(args: &[String]) -> Result<CaptureEnvelope> {
    let output = crate::python_bridge::run_python_capture_helper(args, METADATA_LIMIT)?;
    if !output.status.success() {
        bail!("accepted source capture helper refused export");
    }
    let stdout = String::from_utf8(output.stdout)?;
    let json = crate::python_bridge::extract_json_from_stdout(&stdout)?;
    serde_json::from_str(json).context("invalid accepted source capture response")
}

pub(crate) fn capture_authored_script(
    script: &Path,
    args: &ScriptCli,
) -> Result<CapturedScriptSource> {
    let absolute = if script.is_absolute() {
        script.to_path_buf()
    } else {
        std::env::current_dir()?.join(script)
    };
    let script = absolute.as_path();
    regular_file(script)?;
    let root = crate::control_room::repo_root();
    let authored = root.join("packages/fullmag-py/src/fullmag");
    let fullmag = if authored.is_dir() {
        authored
    } else {
        root.join("python/site-packages/fullmag")
    };
    let first = response(&helper_arguments(script, &fullmag, "inventory", args, None))?;
    if first.config.is_some() {
        bail!("inventory must not execute authored script");
    }
    validate_capture(&first.capture, script, &fullmag)?;
    let mut files = BTreeMap::new();
    for record in &first.capture.records {
        files.insert(record.relative_path.clone(), read_pinned(record)?);
    }
    let second = response(&helper_arguments(
        script,
        &fullmag,
        "export",
        args,
        Some(&first.capture.inventory_sha256),
    ))?;
    validate_capture(&second.capture, script, &fullmag)?;
    if second.capture.inventory_sha256 != first.capture.inventory_sha256
        || serde_json::to_value(&second.capture.runtime)?
            != serde_json::to_value(&first.capture.runtime)?
        || serde_json::to_value(
            second
                .capture
                .records
                .iter()
                .map(record_identity)
                .collect::<Vec<_>>(),
        )? != serde_json::to_value(
            first
                .capture
                .records
                .iter()
                .map(record_identity)
                .collect::<Vec<_>>(),
        )?
    {
        bail!("source inventory changed during raw export");
    }
    for (before, record) in first.capture.records.iter().zip(&second.capture.records) {
        if before.absolute_path != record.absolute_path {
            bail!("capture file location changed");
        }
        let _ = read_pinned(record)?;
    }
    // Retain runtime closure and actual source reads; do not archive unrelated siblings.
    let observed: BTreeSet<&str> = second
        .capture
        .observed_reads
        .iter()
        .map(String::as_str)
        .collect();
    if observed.iter().any(|key| {
        !second
            .capture
            .records
            .iter()
            .any(|record| record.relative_path == *key)
    }) {
        bail!("capture observed an unknown file identity");
    }
    let retained: Vec<Value> = second
        .capture
        .records
        .iter()
        .filter(|record| {
            record.role == "runtime"
                || record.relative_path == second.capture.entry_relative_path
                || observed.contains(record.relative_path.as_str())
        })
        .map(record_identity)
        .collect();
    let retained_keys: BTreeSet<String> = retained
        .iter()
        .filter_map(|record| record["relative_path"].as_str().map(str::to_owned))
        .collect();
    files.retain(|key, _| retained_keys.contains(key));
    let manifest = json!({"schema_version": second.capture.schema_version, "entry_relative_path": second.capture.entry_relative_path,
        "records": retained, "runtime": second.capture.runtime,
        "observed_reads": second.capture.observed_reads, "inventory_sha256": second.capture.inventory_sha256});
    Ok(CapturedScriptSource {
        config: second
            .config
            .context("capture returned no raw authored config")?,
        manifest,
        files,
    })
}

fn record_identity(record: &FileRecord) -> Value {
    json!({"relative_path": record.relative_path, "asset_id": record.asset_id, "sha256": record.sha256,
        "byte_count": record.byte_count, "role": record.role})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_and_verbatim_windows_spellings_share_identity() {
        assert!(
            same_path_spelling(Path::new(r"\\?\D:\script.py"), Path::new(r"D:\script.py")).unwrap()
        );
        assert!(same_path_spelling(
            Path::new(r"\\?\UNC\server\share\script.py"),
            Path::new(r"\\server\share\script.py")
        )
        .unwrap());
        assert!(
            !same_path_spelling(Path::new(r"\\?\D:\script.py"), Path::new(r"D:\other.py")).unwrap()
        );
    }

    #[test]
    fn fixed_payload_reader_rejects_long_and_short_inputs() {
        let mut longer = std::io::Cursor::new([1u8, 2, 3, 4]);
        assert!(read_fixed_payload(&mut longer, 3).is_err());
        let mut shorter = std::io::Cursor::new([1u8, 2]);
        assert!(read_fixed_payload(&mut shorter, 3).is_err());
        let mut exact = std::io::Cursor::new([1u8, 2, 3]);
        assert_eq!(read_fixed_payload(&mut exact, 3).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn captured_paths_reject_escape_alias_and_control_characters() {
        for value in [
            "../a", "/a", "a/../b", "a\\b", "C:/a", "a//b", "a/./b", "a\nb",
        ] {
            assert!(!portable_relative(value), "{value}");
        }
        assert!(portable_relative("source/assets/input.json"));
    }
}

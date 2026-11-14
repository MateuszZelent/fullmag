//! Immutable file capture around raw Python DSL export; no profile binding or Submit.
use crate::script_stage_contract::ScriptExecutionConfig;
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
pub const METADATA_LIMIT: usize = 8 * 1024 * 1024;
// Mirrors script_pipeline_acceptance::MAX_SOURCE_BYTES (ADR 0036 complete-config cap).
const SCRIPT_CONFIG_EXPORT_LIMIT: usize = 16 * 1024 * 1024;

pub struct CapturedScriptSource {
    pub config: Option<ScriptExecutionConfig>,
    pub scene: Option<Value>,
    records: Vec<FileRecord>,
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
}

impl CapturedScriptSource {
    /// Recheck the complete retained source/runtime inventory after preparation.
    /// The application must not accept a partial closure or changed preimages.
    pub fn verify_unchanged(&self) -> Result<()> {
        for record in &self.records {
            read_pinned(record)?;
        }
        Ok(())
    }
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
    #[serde(default)]
    scene: Option<Value>,
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
    let left = display_path(left);
    let right = display_path(right);
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

#[derive(Default)]
pub struct CaptureOptions<'a> {
    pub backend: Option<&'a str>,
    pub mode: Option<&'a str>,
    pub precision: Option<&'a str>,
    pub scene_only: bool,
}
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { format!(r"\\{rest}") }
    else { text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text) }
}
fn helper_arguments(script: &Path, fullmag: &Path, phase: &str, options: &CaptureOptions<'_>, expected: Option<&str>) -> Vec<String> {
    let mut args = vec!["-B".into(), "-S".into(), "-c".into(),
        "import sys; sys.path[:] = [p for p in sys.path if p]; import runpy; path=sys.argv.pop(1); runpy.run_path(path,run_name='__main__')".into(),
        fullmag.join("runtime/accepted_source_capture.py").display().to_string(), "--phase".into(), phase.into(),
        "--script".into(), script.display().to_string(), "--fullmag-root".into(), fullmag.display().to_string()];
    if let Some(value) = expected { args.extend(["--expected-inventory".into(), value.into()]); }
    for (key,value) in [("--backend",options.backend),("--mode",options.mode),("--precision",options.precision)] {
        if let Some(value)=value { args.extend([key.into(),value.into()]); }
    }
    if options.scene_only { args.push("--scene-only".into()); }
    args
}
fn response(
    args: &[String],
    stdout_limit: usize,
    run: &mut impl FnMut(&[String], usize) -> Result<std::process::Output>,
) -> Result<CaptureEnvelope> {
    let output = run(args, stdout_limit)?;
    if output.stdout.len() > stdout_limit || output.stderr.len() > METADATA_LIMIT {
        bail!("accepted source capture output bound");
    }
    if !output.status.success() {
        bail!("accepted source capture helper refused export");
    }
    let stdout = String::from_utf8(output.stdout)?;
    let value = stdout
        .lines()
        .rev()
        .find(|line| {
            let value = line.trim();
            value.starts_with('{') && value.ends_with('}')
        })
        .context("could not find valid JSON object in python helper stdout")?;
    serde_json::from_str(value).context("invalid accepted source capture response")
}
pub fn capture_authored_script(script: &Path, fullmag: &Path, options: &CaptureOptions<'_>,
    mut run: impl FnMut(&[String],usize)->Result<std::process::Output>) -> Result<CapturedScriptSource> {
    let absolute = if script.is_absolute() {
        script.to_path_buf()
    } else {
        std::env::current_dir()?.join(script)
    };
    let script = absolute.as_path();
    regular_file(script)?;
    let first = response(
        &helper_arguments(script, fullmag, "inventory", options, None),
        METADATA_LIMIT,
        &mut run,
    )?;
    if first.config.is_some() || first.scene.is_some() {
        bail!("inventory must not execute authored script");
    }
    validate_capture(&first.capture, script, &fullmag)?;
    let mut files = BTreeMap::new();
    for record in &first.capture.records {
        files.insert(record.relative_path.clone(), read_pinned(record)?);
    }
    let export_limit = if options.scene_only {
        METADATA_LIMIT
    } else {
        SCRIPT_CONFIG_EXPORT_LIMIT
    };
    let second = response(
        &helper_arguments(
            script,
            fullmag,
            "export",
            options,
            Some(&first.capture.inventory_sha256),
        ),
        export_limit,
        &mut run,
    )?;
    validate_capture(&second.capture, script, fullmag)?;
    if options.scene_only {
        if second.config.is_some() || !second.scene.as_ref().is_some_and(Value::is_object) { bail!("source scene capture authoring shape"); }
    } else if second.config.is_none() || second.scene.is_some() { bail!("source config capture authoring shape"); }
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
        config: second.config,
        scene: second.scene,
        records: second.capture.records,
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

    struct CaptureFixture {
        _directory: tempfile::TempDir,
        script: PathBuf,
        fullmag: PathBuf,
        capture: Value,
    }

    impl CaptureFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let script_root = directory.path().join("scripts");
            let script = script_root.join("main.py");
            let fullmag = directory.path().join("fullmag");
            let runtime_file = fullmag.join("runtime/helper.py");
            std::fs::create_dir_all(&script_root).unwrap();
            std::fs::create_dir_all(runtime_file.parent().unwrap()).unwrap();
            std::fs::write(&script, b"pass\n").unwrap();
            std::fs::write(&runtime_file, b"helper = True\n").unwrap();

            let record = |relative_path: &str, path: &Path, role: &str| {
                let bytes = std::fs::read(path).unwrap();
                json!({
                    "relative_path": relative_path,
                    "asset_id": format!("script-file-{:x}", Sha256::digest(relative_path.as_bytes())),
                    "sha256": format!("{:x}", Sha256::digest(&bytes)),
                    "byte_count": bytes.len(),
                    "role": role,
                    "absolute_path": path.to_string_lossy(),
                })
            };
            let capture = json!({
                "schema_version": "fullmag.script-source-capture.v1",
                "entry_relative_path": "source/main.py",
                "records": [
                    record("source/main.py", &script, "source"),
                    record("fullmag/runtime/helper.py", &runtime_file, "runtime"),
                ],
                "runtime": {"python_version": "3.x", "implementation": "cpython"},
                "inventory_sha256": "a".repeat(64),
                "observed_reads": ["source/main.py"],
            });

            Self {
                _directory: directory,
                script,
                fullmag,
                capture,
            }
        }

        fn reply(&self, config: Option<Value>, scene: Option<Value>) -> Value {
            json!({"config": config, "scene": scene, "capture": self.capture.clone()})
        }

        fn invoke(
            &self,
            options: &CaptureOptions<'_>,
            inventory: Value,
            export: Value,
        ) -> (Result<CapturedScriptSource>, Vec<usize>) {
            let mut replies = [inventory, export].into_iter();
            let mut observed_limits = Vec::new();
            let result =
                capture_authored_script(&self.script, &self.fullmag, options, |_, limit| {
                    observed_limits.push(limit);
                    let reply = replies.next().expect("expected a fake helper reply");
                    Ok(successful_output(serde_json::to_vec(&reply)?))
                });
            (result, observed_limits)
        }
    }

    fn successful_output(stdout: Vec<u8>) -> std::process::Output {
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        };
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        };
        std::process::Output {
            status,
            stdout,
            stderr: Vec::new(),
        }
    }

    fn complete_config_with_padding(padding: String) -> (Value, usize) {
        let mut ir = serde_json::to_value(fullmag_ir::ProblemIR::bootstrap_example()).unwrap();
        ir.pointer_mut("/problem_meta/runtime_metadata")
            .and_then(Value::as_object_mut)
            .expect("bootstrap IR has runtime metadata")
            .insert("source_capture_test_padding".into(), Value::String(padding));
        let config = json!({
            "ir": ir,
            "antenna_inventory": {},
            "shared_geometry_assets": null,
            "default_until_seconds": null,
            "study_pipeline": null,
            "stages": [],
        });
        let byte_count = serde_json::to_vec(&config).unwrap().len();
        (config, byte_count)
    }

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
    fn revalidation_rejects_changed_inventory_even_when_not_in_retained_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.bin");
        std::fs::write(&path, b"before").unwrap();
        let capture = CapturedScriptSource {
            config: None, scene: None, manifest: json!({}), files: BTreeMap::new(),
            records: vec![FileRecord {
                relative_path: "runtime/runtime.bin".into(), asset_id: "unused".into(),
                sha256: format!("{:x}", Sha256::digest(b"before")), byte_count: 6,
                role: "runtime".into(), absolute_path: path.clone(),
            }],
        };
        capture.verify_unchanged().unwrap();
        std::fs::write(path, b"after!").unwrap();
        assert!(capture.verify_unchanged().is_err());
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

    #[test]
    fn accepts_complete_config_export_above_metadata_limit_with_phase_specific_callback_limits() {
        let fixture = CaptureFixture::new();
        let (config, config_bytes) = complete_config_with_padding("x".repeat(METADATA_LIMIT + 1));
        assert!(config_bytes > METADATA_LIMIT);
        assert!(config_bytes < SCRIPT_CONFIG_EXPORT_LIMIT);

        let inventory = fixture.reply(None, None);
        let export = fixture.reply(Some(config), None);
        let (captured, limits) = fixture.invoke(&CaptureOptions::default(), inventory, export);

        let captured = captured.expect("full config export fits its 16 MiB cap");
        assert!(captured.config.is_some());
        assert!(captured.scene.is_none());
        assert_eq!(limits, vec![METADATA_LIMIT, SCRIPT_CONFIG_EXPORT_LIMIT]);
    }

    #[test]
    fn inventory_and_scene_only_exports_keep_the_metadata_limit() {
        let fixture = CaptureFixture::new();
        let padding = "x".repeat(METADATA_LIMIT + 1);

        let mut oversized_inventory = fixture.reply(None, None);
        oversized_inventory["capture"]["runtime"]["padding"] = json!(padding.clone());
        let (inventory_result, inventory_limits) = fixture.invoke(
            &CaptureOptions::default(),
            oversized_inventory,
            fixture.reply(None, None),
        );
        assert!(
            inventory_result.is_err(),
            "oversized inventory stdout is rejected"
        );
        assert_eq!(inventory_limits, vec![METADATA_LIMIT]);

        let scene_options = CaptureOptions {
            scene_only: true,
            ..CaptureOptions::default()
        };
        let scene_export = fixture.reply(None, Some(json!({"padding": padding})));
        let (scene_result, scene_limits) =
            fixture.invoke(&scene_options, fixture.reply(None, None), scene_export);
        assert!(
            scene_result.is_err(),
            "oversized scene-only stdout is rejected"
        );
        assert_eq!(scene_limits, vec![METADATA_LIMIT, METADATA_LIMIT]);
    }

    #[test]
    fn rejects_complete_config_export_above_sixteen_mib() {
        let fixture = CaptureFixture::new();
        let (config, config_bytes) =
            complete_config_with_padding("x".repeat(SCRIPT_CONFIG_EXPORT_LIMIT + 1));
        assert!(config_bytes > SCRIPT_CONFIG_EXPORT_LIMIT);

        let inventory = fixture.reply(None, None);
        let export = fixture.reply(Some(config), None);
        let (result, limits) = fixture.invoke(&CaptureOptions::default(), inventory, export);

        assert!(result.is_err(), "config stdout above 16 MiB is rejected");
        assert_eq!(limits, vec![METADATA_LIMIT, SCRIPT_CONFIG_EXPORT_LIMIT]);
    }
}

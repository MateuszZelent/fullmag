//! `fullmag-run.json`: the record every script or project run leaves in its
//! results folder (`fullmag.run_manifest.v1`).
//!
//! It is written atomically when the run starts (`status: running`) and again
//! when it ends, so a folder that was killed mid-run still says what it was.
//! The workspace scanner and the browser inspector read it to link a result
//! folder to the script or project that produced it. The manifest never
//! holds file text or environment values, and it lives in the results folder
//! only, never next to or inside the user's `.py` or `.fms`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// File name of the manifest inside a results folder.
pub const RUN_MANIFEST_FILE: &str = "fullmag-run.json";
/// Value of `schema`.
pub const RUN_MANIFEST_SCHEMA: &str = "fullmag.run_manifest.v1";
/// A manifest larger than this is treated as damaged.
pub const MAX_RUN_MANIFEST_BYTES: u64 = 1024 * 1024;

/// What produced the results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunSource {
    /// `script` or `project`.
    pub kind: String,
    /// Absolute path as the user would type it (no `\\?\` prefix).
    pub path: String,
    /// SHA-256 of the script bytes (or of the archive) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Stable project id (projects only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Definition revision that was run (projects only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// One stage of a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StageSummary {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub steps: Option<u64>,
    #[serde(default)]
    pub time_s: Option<f64>,
}

/// One output the run produced, relative to the results folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunOutput {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunManifest {
    pub schema: String,
    pub run_id: String,
    pub source: RunSource,
    /// What the user asked for (backend, device, precision, mode, ...).
    #[cfg_attr(feature = "utoipa", schema(value_type = Object))]
    pub requested: Value,
    /// What the run resolved to; `null` until the runtime is selected.
    #[cfg_attr(feature = "utoipa", schema(value_type = Object))]
    pub resolved: Value,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// `running`, `completed`, `failed`, `cancelled` or `not_started`.
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stages: Vec<StageSummary>,
    #[serde(default)]
    pub outputs: Vec<RunOutput>,
    pub fullmag_version: String,
    /// `cli`, `desktop`, `api`, ...
    #[serde(default)]
    pub launched_by: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl RunManifest {
    pub fn new(
        run_id: impl Into<String>,
        source: RunSource,
        fullmag_version: impl Into<String>,
        started_at: impl Into<String>,
    ) -> Self {
        Self {
            schema: RUN_MANIFEST_SCHEMA.to_string(),
            run_id: run_id.into(),
            source,
            requested: Value::Null,
            resolved: Value::Null,
            started_at: started_at.into(),
            finished_at: None,
            status: "running".to_string(),
            exit_code: None,
            error: None,
            stages: Vec::new(),
            outputs: Vec::new(),
            fullmag_version: fullmag_version.into(),
            launched_by: None,
            session_id: None,
        }
    }
}

/// Path of the manifest inside `results_dir`.
pub fn manifest_path(results_dir: &Path) -> PathBuf {
    results_dir.join(RUN_MANIFEST_FILE)
}

/// Write the manifest through a temporary sibling and a rename, so a reader
/// never sees a partial document.
pub fn write_run_manifest(results_dir: &Path, manifest: &RunManifest) -> std::io::Result<()> {
    std::fs::create_dir_all(results_dir)?;
    let target = manifest_path(results_dir);
    let temporary = results_dir.join(format!(".{RUN_MANIFEST_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// Read the manifest of a results folder. `Ok(None)` when there is none; an
/// error when it exists but is damaged, oversized or of another schema.
pub fn read_run_manifest(results_dir: &Path) -> Result<Option<RunManifest>, String> {
    let path = manifest_path(results_dir);
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {RUN_MANIFEST_FILE}: {error}")),
    };
    if !meta.is_file() {
        return Err(format!("{RUN_MANIFEST_FILE} is not a file"));
    }
    if meta.len() > MAX_RUN_MANIFEST_BYTES {
        return Err(format!("{RUN_MANIFEST_FILE} is larger than 1 MiB"));
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("cannot read {RUN_MANIFEST_FILE}: {error}"))?;
    let manifest: RunManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{RUN_MANIFEST_FILE} is not a valid run manifest: {error}"))?;
    if manifest.schema != RUN_MANIFEST_SCHEMA {
        return Err(format!(
            "{RUN_MANIFEST_FILE} has schema `{}`, expected `{RUN_MANIFEST_SCHEMA}`",
            manifest.schema
        ));
    }
    Ok(Some(manifest))
}

/// The outputs worth listing in a manifest: known files and stores found in
/// the folder, its `artifacts` group and `stages/*` (at most depth 3, 200
/// entries). Paths are relative with `/` separators.
pub fn collect_outputs(results_dir: &Path) -> Vec<RunOutput> {
    let mut found = Vec::new();
    let mut directories = vec![(results_dir.to_path_buf(), 0_usize)];
    while let Some((dir, depth)) = directories.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if found.len() >= 200 {
                return found;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = entry
                .path()
                .strip_prefix(results_dir)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            if file_type.is_dir() {
                if name.to_ascii_lowercase().ends_with(".zarr") {
                    found.push(RunOutput {
                        path: relative,
                        kind: "zarr_store".into(),
                    });
                } else if depth < 3 && !name.starts_with('.') {
                    directories.push((entry.path(), depth + 1));
                }
            } else if let Some(kind) = output_kind(&name) {
                found.push(RunOutput {
                    path: relative,
                    kind: kind.into(),
                });
            }
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

fn output_kind(file_name: &str) -> Option<&'static str> {
    let lower = file_name.to_ascii_lowercase();
    match lower.as_str() {
        "metadata.json" => Some("metadata"),
        "scalars.csv" => Some("table"),
        "m_final.json" | "m_initial.json" => Some("field"),
        "sequence_manifest.json" => Some("sequence_manifest"),
        "output-storage.json" => Some("storage_receipt"),
        _ if lower.ends_with(".autosave.json") => Some("autosave_manifest"),
        _ if lower.ends_with(".h5") || lower.ends_with(".hdf5") => Some("hdf5"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> RunManifest {
        let mut manifest = RunManifest::new(
            "run-1",
            RunSource {
                kind: "script".into(),
                path: "C:/sim/wall.py".into(),
                sha256: Some("ab".repeat(32)),
                project_id: None,
                revision: None,
            },
            "0.1.0",
            "2026-10-05T10:00:00.000Z",
        );
        manifest.requested = json!({"backend": "fdm", "device": "gpu"});
        manifest.launched_by = Some("cli".into());
        manifest
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temporaries() {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = sample();
        write_run_manifest(dir.path(), &manifest).unwrap();
        let read = read_run_manifest(dir.path()).unwrap().unwrap();
        assert_eq!(read, manifest);
        assert_eq!(read.status, "running");

        manifest.status = "completed".into();
        manifest.finished_at = Some("2026-10-05T10:01:00.000Z".into());
        write_run_manifest(dir.path(), &manifest).unwrap();
        assert_eq!(
            read_run_manifest(dir.path()).unwrap().unwrap().status,
            "completed"
        );
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![RUN_MANIFEST_FILE.to_string()]);
    }

    #[test]
    fn missing_damaged_and_foreign_manifests_are_distinguished() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_run_manifest(dir.path()).unwrap(), None);
        std::fs::write(manifest_path(dir.path()), b"{not json").unwrap();
        assert!(read_run_manifest(dir.path()).unwrap_err().contains("not a valid"));
        let mut value = serde_json::to_value(sample()).unwrap();
        value["schema"] = json!("other.v9");
        std::fs::write(manifest_path(dir.path()), value.to_string()).unwrap();
        assert!(read_run_manifest(dir.path()).unwrap_err().contains("other.v9"));
    }

    #[test]
    fn outputs_list_known_files_and_stores_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("artifacts/main.zarr")).unwrap();
        std::fs::create_dir_all(root.join("stages/stage_00_relax")).unwrap();
        std::fs::write(root.join("artifacts/metadata.json"), "{}").unwrap();
        std::fs::write(root.join("artifacts/scalars.csv"), "step,time\n").unwrap();
        std::fs::write(root.join("artifacts/main.autosave.json"), "{}").unwrap();
        std::fs::write(root.join("stages/stage_00_relax/m_final.json"), "{}").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();
        let outputs = collect_outputs(root);
        let pairs: Vec<(&str, &str)> = outputs
            .iter()
            .map(|o| (o.path.as_str(), o.kind.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("artifacts/main.autosave.json", "autosave_manifest"),
                ("artifacts/main.zarr", "zarr_store"),
                ("artifacts/metadata.json", "metadata"),
                ("artifacts/scalars.csv", "table"),
                ("stages/stage_00_relax/m_final.json", "field"),
            ]
        );
    }
}

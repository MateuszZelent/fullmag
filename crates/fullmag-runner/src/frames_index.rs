//! Per-frame index of the field snapshots saved in one results leaf.
//!
//! `frames.json` (schema `fullmag.frames_index.v1`) lists one entry per saved
//! frame (a step at which at least one field quantity was written) with its
//! step, physical time, stage and the quantities that were saved. It is
//! written from facts the snapshot writers already hold (`FieldSnapshot::step`
//! and `FieldSnapshot::time`); chunks and field files are never reopened. A
//! reader (`fullmag-workspace-inspect`) can therefore list and page frames
//! without touching array data.
//!
//! The file is replaced atomically (temporary file + rename) and bounded to
//! [`MAX_FRAME_ENTRIES`] entries; past that the index stops growing and says
//! so with `truncated: true` rather than dropping data silently.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FRAMES_INDEX_SCHEMA: &str = "fullmag.frames_index.v1";
pub const FRAMES_INDEX_FILE: &str = "frames.json";
pub const MAX_FRAME_ENTRIES: usize = 100_000;
/// Past this many entries the file is rewritten only every `REWRITE_STRIDE`
/// frames (and always at `finish`), so a long run does not rewrite a large
/// document for every snapshot.
const DENSE_REWRITE_LIMIT: usize = 256;
const REWRITE_STRIDE: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrameEntry {
    pub index: u64,
    pub step: u64,
    pub time_s: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    pub quantity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// Location of the snapshot relative to the results leaf. When one frame
    /// holds several quantities this is the shared `fields` folder.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FramesIndexDocument {
    pub schema: String,
    pub truncated: bool,
    pub frames: Vec<FrameEntry>,
}

/// Appends frames and keeps `frames.json` of one results leaf current.
#[derive(Debug)]
pub struct FramesIndexWriter {
    path: PathBuf,
    stage_id: Option<String>,
    document: FramesIndexDocument,
    dirty_since_write: usize,
    max_entries: usize,
}

impl FramesIndexWriter {
    pub fn new(leaf_dir: &Path, stage_id: Option<String>) -> Self {
        Self {
            path: leaf_dir.join(FRAMES_INDEX_FILE),
            stage_id,
            document: FramesIndexDocument {
                schema: FRAMES_INDEX_SCHEMA.into(),
                truncated: false,
                frames: Vec::new(),
            },
            dirty_since_write: 0,
            max_entries: MAX_FRAME_ENTRIES,
        }
    }

    pub fn len(&self) -> usize {
        self.document.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.document.frames.is_empty()
    }

    /// Record one saved quantity at `step`. Quantities saved at the same step
    /// and time fold into one frame. Flushes per the rewrite policy.
    pub fn record(
        &mut self,
        quantity: &str,
        step: u64,
        time_s: f64,
        relative_path: String,
        bytes: Option<u64>,
    ) -> Result<(), String> {
        let merged = match self.document.frames.last_mut() {
            Some(last) if last.step == step && last.time_s == time_s => {
                if !last.quantity_ids.iter().any(|id| id == quantity) {
                    last.quantity_ids.push(quantity.to_string());
                    last.path = "fields".into();
                    last.bytes = match (last.bytes, bytes) {
                        (Some(a), Some(b)) => Some(a.saturating_add(b)),
                        _ => None,
                    };
                }
                true
            }
            _ => false,
        };
        if !merged {
            if self.document.frames.len() >= self.max_entries {
                self.document.truncated = true;
            } else {
                let index = self.document.frames.len() as u64;
                self.document.frames.push(FrameEntry {
                    index,
                    step,
                    time_s,
                    stage_id: self.stage_id.clone(),
                    quantity_ids: vec![quantity.to_string()],
                    bytes,
                    path: relative_path,
                });
            }
        }
        self.dirty_since_write += 1;
        let len = self.document.frames.len();
        if len <= DENSE_REWRITE_LIMIT || self.dirty_since_write >= REWRITE_STRIDE {
            self.flush()?;
        }
        Ok(())
    }

    /// Write the document atomically. A no-op when no frame was recorded.
    pub fn flush(&mut self) -> Result<(), String> {
        self.dirty_since_write = 0;
        if self.document.frames.is_empty() {
            return Ok(());
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|error| format!("frames index: {error}"))?;
        let temporary = parent.join(format!(".{FRAMES_INDEX_FILE}.tmp"));
        let payload = serde_json::to_vec(&self.document)
            .map_err(|error| format!("frames index: {error}"))?;
        fs::write(&temporary, payload).map_err(|error| format!("frames index: {error}"))?;
        fs::rename(&temporary, &self.path).map_err(|error| format!("frames index: {error}"))
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.flush()
    }
}

/// Relative path of a JSON snapshot file written by `write_field_snapshot_artifact`
/// for a single-region layout; the `fields/<name>` folder otherwise.
pub fn snapshot_relative_path(name: &str, step: u64, json_file: bool) -> String {
    if json_file {
        format!("fields/{name}/step_{step:06}.json")
    } else {
        format!("fields/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_leaf(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fullmag-frames-index-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(dir: &Path) -> FramesIndexDocument {
        serde_json::from_slice(&fs::read(dir.join(FRAMES_INDEX_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn records_frames_and_merges_quantities_at_one_step() {
        let dir = temp_leaf("merge");
        let mut writer = FramesIndexWriter::new(&dir, Some("relax".into()));
        writer
            .record("m", 0, 0.0, snapshot_relative_path("m", 0, true), Some(10))
            .unwrap();
        writer
            .record("m", 10, 1e-12, snapshot_relative_path("m", 10, true), Some(10))
            .unwrap();
        writer
            .record("H_eff", 10, 1e-12, snapshot_relative_path("H_eff", 10, true), Some(5))
            .unwrap();
        writer.finish().unwrap();
        let document = read(&dir);
        assert_eq!(document.schema, FRAMES_INDEX_SCHEMA);
        assert!(!document.truncated);
        assert_eq!(document.frames.len(), 2);
        assert_eq!(document.frames[0].index, 0);
        assert_eq!(document.frames[0].path, "fields/m/step_000000.json");
        assert_eq!(document.frames[1].quantity_ids, vec!["m", "H_eff"]);
        assert_eq!(document.frames[1].bytes, Some(15));
        assert_eq!(document.frames[1].stage_id.as_deref(), Some("relax"));
        assert!(!dir.join(".frames.json.tmp").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn is_bounded_and_reports_truncation() {
        let dir = temp_leaf("bound");
        let mut writer = FramesIndexWriter::new(&dir, None);
        writer.max_entries = 300;
        for step in 0..305_u64 {
            writer
                .record("m", step, step as f64, "fields/m".into(), None)
                .unwrap();
        }
        assert_eq!(writer.len(), 300);
        writer.finish().unwrap();
        let document = read(&dir);
        assert!(document.truncated);
        assert_eq!(document.frames.len(), 300);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn writes_nothing_without_frames() {
        let dir = temp_leaf("empty");
        FramesIndexWriter::new(&dir, None).finish().unwrap();
        assert!(!dir.join(FRAMES_INDEX_FILE).exists());
        fs::remove_dir_all(dir).ok();
    }
}

//! Reading the per-frame index (`frames.json`) of a results folder.
//!
//! The runner writes `frames.json` (schema `fullmag.frames_index.v1`) into
//! every results leaf (`artifacts/`, `stages/stage_NN_<kind>/`, or the folder
//! itself) next to the field snapshots it describes. This module reads those
//! documents (bounded JSON, never a chunk or a field file), joins the leaves
//! in stage order and renumbers the frames over the whole folder.
//!
//! A folder written before the index existed has no `frames.json`; it reports
//! no index rather than one reconstructed from counts, because the autosave
//! manifests carry frame counts and not per-frame step or time.

use std::path::Path;

use serde_json::Value;

use crate::detail::{FrameEntry, FramesPage, FramesStageCount, FramesSummary};
use crate::result_detail::stage_candidates;

pub const FRAMES_INDEX_SCHEMA: &str = "fullmag.frames_index.v1";
const FRAMES_INDEX_FILE: &str = "frames.json";
/// Largest `frames.json` that is read; the writer stops at 100 000 entries.
const MAX_FRAMES_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_FRAMES: usize = 100_000;
/// Most frames one page returns.
pub const FRAMES_PAGE_MAX: usize = 1000;

/// The joined index of a folder.
#[derive(Debug, Clone, PartialEq)]
pub struct FramesIndexData {
    pub frames: Vec<FrameEntry>,
    pub truncated: bool,
    pub note: Option<String>,
}

impl FramesIndexData {
    pub fn summary(&self) -> FramesSummary {
        let mut stages: Vec<FramesStageCount> = Vec::new();
        for frame in &self.frames {
            let id = frame.stage_id.clone().unwrap_or_default();
            match stages.last_mut() {
                Some(last) if last.stage_id == id => last.count += 1,
                _ => stages.push(FramesStageCount {
                    stage_id: id,
                    count: 1,
                }),
            }
        }
        FramesSummary {
            schema: FRAMES_INDEX_SCHEMA.into(),
            count: self.frames.len() as u64,
            first_step: self.frames.first().map(|frame| frame.step),
            last_step: self.frames.last().map(|frame| frame.step),
            first_time_s: self.frames.first().map(|frame| frame.time_s),
            last_time_s: self.frames.last().map(|frame| frame.time_s),
            truncated: self.truncated,
            stages,
            note: self.note.clone(),
        }
    }

    pub fn page(&self, from: u64, limit: usize) -> FramesPage {
        let limit = limit.clamp(1, FRAMES_PAGE_MAX);
        let start = usize::try_from(from).unwrap_or(usize::MAX).min(self.frames.len());
        let end = start.saturating_add(limit).min(self.frames.len());
        FramesPage {
            indexed: true,
            total: self.frames.len() as u64,
            from: start as u64,
            frames: self.frames[start..end].to_vec(),
            truncated: self.truncated,
        }
    }
}

/// Join the `frames.json` of every leaf of `dir`; `None` when no leaf has one.
pub fn read_frames(dir: &Path) -> Option<FramesIndexData> {
    let sequence = crate::result_detail::read_small_json_pub(&dir.join("sequence_manifest.json"));
    let mut frames: Vec<FrameEntry> = Vec::new();
    let mut truncated = false;
    let mut notes: Vec<String> = Vec::new();
    let mut found = false;
    for (leaf_id, _kind, leaf) in stage_candidates(dir, &sequence) {
        let file = leaf.join(FRAMES_INDEX_FILE);
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        found = true;
        if !meta.is_file() || meta.len() > MAX_FRAMES_FILE_BYTES {
            notes.push(format!("{leaf_id}: frames.json is not a readable file within the size limit"));
            continue;
        }
        let document: Option<Value> = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let Some(document) = document else {
            notes.push(format!("{leaf_id}: frames.json is not valid JSON"));
            continue;
        };
        if document.get("schema").and_then(Value::as_str) != Some(FRAMES_INDEX_SCHEMA) {
            notes.push(format!("{leaf_id}: frames.json has an unknown schema"));
            continue;
        }
        if document.get("truncated").and_then(Value::as_bool) == Some(true) {
            truncated = true;
        }
        let prefix = leaf
            .strip_prefix(dir)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .filter(|relative| !relative.is_empty());
        for raw in document
            .get("frames")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if frames.len() >= MAX_TOTAL_FRAMES {
                truncated = true;
                break;
            }
            let (Some(step), Some(time_s)) = (
                raw.get("step").and_then(Value::as_u64),
                raw.get("time_s").and_then(Value::as_f64),
            ) else {
                notes.push(format!("{leaf_id}: an entry without step or time_s was skipped"));
                continue;
            };
            let path = raw.get("path").and_then(Value::as_str).unwrap_or("");
            frames.push(FrameEntry {
                index: frames.len() as u64,
                step,
                time_s,
                stage_id: raw
                    .get("stage_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some(leaf_id.clone())),
                quantity_ids: raw
                    .get("quantity_ids")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                bytes: raw.get("bytes").and_then(Value::as_u64),
                path: match &prefix {
                    Some(prefix) => format!("{prefix}/{path}"),
                    None => path.to_string(),
                },
            });
        }
    }
    if !found {
        return None;
    }
    notes.dedup();
    notes.truncate(5);
    Some(FramesIndexData {
        frames,
        truncated,
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join("; "))
        },
    })
}

/// One page of the frame index of `dir`; an empty page with `indexed: false`
/// when the folder has no index.
pub fn read_frames_page(dir: &Path, from: u64, limit: usize) -> FramesPage {
    match read_frames(dir) {
        Some(data) => data.page(from, limit),
        None => FramesPage {
            indexed: false,
            total: 0,
            from: 0,
            frames: Vec::new(),
            truncated: false,
        },
    }
}

//! Inspector reader of a `.fms` project.

use std::path::Path;

use fullmag_application::{FileProjectRepository, ProjectRepository, ProjectSource};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::detail::{
    Citation, ExecutionSummary, ModelSummary, OutputsSummary, PreviewInfo, ProjectDetail,
    ProjectRun, ProjectSummary,
};
use crate::project::{
    short_schema_version, solver_from_scene, summary_from_scene, MAX_PROJECT_ARCHIVE_BYTES,
};
use crate::provenance::{parse_provenance, PROVENANCE_PATH};

/// Read the project at `path`. Never fails: a damaged or oversized archive is
/// reported in `read_error`.
pub fn inspect_project(path: &Path) -> ProjectDetail {
    let mut detail = empty_detail();
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            if meta.len() > MAX_PROJECT_ARCHIVE_BYTES {
                detail.read_error = Some(format!(
                    "archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
                ));
                return detail;
            }
        }
        Ok(_) => {
            detail.read_error = Some("the path is not a file".into());
            return detail;
        }
        Err(error) => {
            detail.read_error = Some(format!("cannot read the project file: {error}"));
            return detail;
        }
    }
    let opened = match FileProjectRepository::new().open(ProjectSource::Path(path.to_path_buf())) {
        Ok(opened) => opened,
        Err(error) => {
            detail.read_error = Some(error.to_string());
            return detail;
        }
    };
    let definition = &opened.envelope.definition;
    let scene = definition.scene.value();
    detail.name = Some(definition.name.clone());
    detail.project_id = Some(definition.project_id.as_str().to_string());
    detail.revision = Some(definition.revision);
    detail.schema_version = Some(short_schema_version(&opened.migration.source_schema));
    detail.solver = Some(solver_from_scene(scene).to_lowercase());
    detail.migrated = Some(opened.migration.migrated);
    detail.can_write = Some(opened.migration.can_write && opened.read_only_reason.is_none());
    detail.warnings = opened.migration.warnings.clone();
    match &opened.read_only_reason {
        Some(reason) => {
            detail.mode = Some("read_only".into());
            detail.mode_reason = Some(reason.clone());
        }
        None => detail.mode = Some("read_write".into()),
    }

    let provenance = opened
        .envelope
        .opaque_documents
        .iter()
        .find(|document| document.path() == PROVENANCE_PATH)
        .map(|document| parse_provenance(document.bytes()));
    let provenance = match provenance {
        Some(Ok(value)) => {
            detail.provenance_recorded = true;
            Some(value)
        }
        Some(Err(message)) => {
            // The archive itself opened; only its provenance is unreadable.
            detail.warnings.push(message);
            None
        }
        None => None,
    };
    if let Some(provenance) = &provenance {
        detail.authors = list_of(provenance, "authors");
        detail.history = list_of(provenance, "history");
        detail.runs = list_of(provenance, "runs");
        detail.citation = provenance
            .get("citation")
            .and_then(|value| serde_json::from_value::<Citation>(value.clone()).ok());
        detail.preview = provenance
            .get("preview")
            .and_then(|value| serde_json::from_value::<PreviewInfo>(value.clone()).ok());
    }
    detail.summary = Some(build_summary(scene, &detail.runs));
    detail
}

fn empty_detail() -> ProjectDetail {
    ProjectDetail {
        read_error: None,
        name: None,
        project_id: None,
        schema_version: None,
        revision: None,
        solver: None,
        migrated: None,
        can_write: None,
        mode: None,
        mode_reason: None,
        warnings: Vec::new(),
        summary: None,
        authors: Vec::new(),
        citation: None,
        history: Vec::new(),
        runs: Vec::new(),
        provenance_recorded: false,
        preview: None,
    }
}

fn list_of<T: DeserializeOwned>(provenance: &Value, key: &str) -> Vec<T> {
    provenance
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
        .collect()
}

/// The flat denormalised summary of the scene arranged into the inspector's
/// three groups; outputs come from the latest recorded run.
fn build_summary(scene: &Value, runs: &[ProjectRun]) -> ProjectSummary {
    let flat = summary_from_scene(scene).unwrap_or(Value::Null);
    let text = |key: &str| flat.get(key).and_then(Value::as_str).map(str::to_string);
    let texts = |key: &str| {
        flat.get(key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
    };
    let latest = runs.iter().max_by(|a, b| a.started_at.cmp(&b.started_at));
    ProjectSummary {
        model: ModelSummary {
            discretisation: text("discretisation"),
            cell_size: text("cell_size"),
            periodicity: None,
            materials: texts("materials"),
            ms: text("ms"),
            aex: text("aex"),
            alpha: text("alpha"),
            interactions: texts("interactions"),
        },
        execution: ExecutionSummary {
            integrator: text("integrator"),
            tolerance: text("tolerance"),
            excitation: excitation(scene),
        },
        outputs: OutputsSummary {
            frames: latest.and_then(|run| run.frames),
            size_bytes: latest.and_then(|run| run.output_bytes),
        },
    }
}

/// "static field" and the enabled regional drives, as a short phrase; `None`
/// when the scene states no excitation at all.
fn excitation(scene: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if scene
        .get("study")
        .and_then(|study| study.get("external_field"))
        .is_some_and(|field| field.is_array())
    {
        parts.push("static field".to_string());
    }
    let drives = scene
        .get("field_drives")
        .and_then(|drives| drives.get("drives"))
        .and_then(Value::as_array)
        .map(|drives| {
            drives
                .iter()
                .filter(|drive| drive.get("enabled").and_then(Value::as_bool) != Some(false))
                .count()
        })
        .unwrap_or(0);
    match drives {
        0 => {}
        1 => parts.push("1 field drive".to_string()),
        count => parts.push(format!("{count} field drives")),
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

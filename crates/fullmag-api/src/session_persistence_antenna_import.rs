//! Portable import of explicitly registered antenna inspection records.
//!
//! Old roots are lexical provenance only: never resolve or read the producing host.
//! Archive membership does not create stage authority; only an existing exact ref
//! may be normalized. Payload validation remains owned by the inspection reader.

use fullmag_session::{repository_path, FmsStagedPreflight};

use super::PersistedCurrentLiveSnapshot;
use crate::error::ApiError;
use crate::types::StageExecutionRecord;

const RECORD_NAME: &str = "antenna_external_lead_stage_output.v1.json";
const RECORD_NAMESPACE: &str = "antenna/external_lead_stage_outputs/";

pub(super) fn normalize_registered_refs(
    persisted: &mut PersistedCurrentLiveSnapshot,
    preflight: &FmsStagedPreflight,
) -> Result<(), ApiError> {
    // Compact snapshots intentionally do not retain solved artifacts.
    if !preflight.export_profile.include_artifacts() {
        return Ok(());
    }
    let Some(execution) = persisted.stage_execution.as_mut() else {
        return Ok(());
    };
    if !execution.stages.iter().any(|stage| {
        stage
            .artifact_refs
            .iter()
            .any(|reference| recognized(reference))
    }) {
        return Ok(());
    }
    if persisted
        .run
        .as_ref()
        .is_some_and(|run| run.run_id != persisted.session.run_id)
    {
        return Err(invalid("snapshot session and run identities disagree"));
    }
    // Match session::current_artifact_dir before the importer replaces either root.
    let old_root = persisted
        .run
        .as_ref()
        .map(|run| run.artifact_dir.as_str())
        .filter(|root| !root.is_empty())
        .unwrap_or(&persisted.session.artifact_dir);
    let replacements = planned_replacements(
        &execution.stages,
        &persisted.session.run_id,
        old_root,
        |member| preflight.contains_document(member),
    )?;
    // Validate the complete batch first; an invalid later stage changes nothing.
    for (stage_index, reference_index, relative) in replacements {
        execution.stages[stage_index].artifact_refs[reference_index] = relative;
    }
    Ok(())
}

fn invalid(message: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request(format!("invalid_fms_antenna_reference: {message}"))
}

fn recognized(reference: &str) -> bool {
    let normalized = reference.replace('\\', "/");
    normalized
        .split('/')
        .any(|component| component == RECORD_NAME)
        || normalized.starts_with(RECORD_NAMESPACE)
        || normalized.contains(&format!("/{RECORD_NAMESPACE}"))
}

fn planned_replacements(
    stages: &[StageExecutionRecord],
    run_id: &str,
    old_root: &str,
    contains_member: impl Fn(&str) -> bool,
) -> Result<Vec<(usize, usize, String)>, ApiError> {
    repository_path::validate_store_id(run_id).map_err(invalid)?;
    let mut stage_counts = std::collections::BTreeMap::new();
    for stage_id in stages.iter().filter_map(|stage| stage.stage_id.as_deref()) {
        *stage_counts.entry(stage_id).or_insert(0usize) += 1;
    }
    let mut replacements = Vec::new();
    for (stage_index, stage) in stages.iter().enumerate() {
        let mut references = stage
            .artifact_refs
            .iter()
            .enumerate()
            .filter(|(_, reference)| recognized(reference));
        let Some((reference_index, reference)) = references.next() else {
            continue;
        };
        if references.next().is_some() {
            return Err(invalid(
                "multiple registered inspection records in one stage",
            ));
        }
        let stage_id = stage
            .stage_id
            .as_deref()
            .ok_or_else(|| invalid("registered inspection lacks a runtime stage identity"))?;
        repository_path::validate_store_id(stage_id).map_err(invalid)?;
        if stage_counts.get(stage_id) != Some(&1) {
            return Err(invalid("duplicate runtime stage identity"));
        }
        let expected = format!("{RECORD_NAMESPACE}{stage_id}/{RECORD_NAME}");
        if !reference_matches(reference, old_root, &expected)? {
            return Err(invalid(
                "registered inspection is outside its original root or runtime stage",
            ));
        }
        let member = format!("runs/{run_id}/artifacts/{expected}");
        if !contains_member(&member) {
            return Err(invalid(format!(
                "registered inspection member is missing: {member}"
            )));
        }
        replacements.push((stage_index, reference_index, expected));
    }
    Ok(replacements)
}

fn reference_matches(reference: &str, old_root: &str, expected: &str) -> Result<bool, ApiError> {
    let reference = lexical_path(reference, false)?;
    if reference == expected {
        return Ok(true);
    }
    let root = lexical_path(old_root, true)?;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    Ok(reference.strip_prefix(&prefix) == Some(expected))
}

/// Parse portable POSIX, drive-absolute Windows, UNC, or relative producer paths.
/// Separators may differ across hosts; component spelling/case must agree exactly.
fn lexical_path(value: &str, root: bool) -> Result<String, ApiError> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(invalid("empty, oversized or control-containing path"));
    }
    let normalized = value.replace('\\', "/");
    let normalized = if root {
        normalized.strip_suffix('/').unwrap_or(&normalized)
    } else {
        &normalized
    };
    let bytes = normalized.as_bytes();
    let relative = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        normalized
            .get(3..)
            .filter(|_| bytes.get(2) == Some(&b'/'))
            .ok_or_else(|| invalid("drive-relative producer path is unsupported"))?
    } else if let Some(unc) = normalized.strip_prefix("//") {
        if unc.split('/').count() < 2 {
            return Err(invalid("UNC producer path lacks a server/share"));
        }
        unc
    } else {
        normalized.strip_prefix('/').unwrap_or(normalized)
    };
    // This also rejects traversal, dot aliases, repeated separators, device names,
    // ADS and extended Windows prefixes. It performs no filesystem operations.
    repository_path::validate_relative_path(relative).map_err(invalid)?;
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(id: Option<&str>, refs: &[&str]) -> StageExecutionRecord {
        serde_json::from_value(serde_json::json!({
            "stage_id": id, "status": "completed", "artifact_refs": refs,
        }))
        .unwrap()
    }

    fn relative(stage: &str) -> String {
        format!("{RECORD_NAMESPACE}{stage}/{RECORD_NAME}")
    }

    fn plan(
        stages: &[StageExecutionRecord],
        root: &str,
    ) -> Result<Vec<(usize, usize, String)>, ApiError> {
        planned_replacements(stages, "run-a", root, |member| {
            member == format!("runs/run-a/artifacts/{}", relative("stage-000"))
        })
    }

    #[test]
    fn registered_posix_windows_unc_and_relative_paths_use_only_retained_archive_member() {
        let suffix = relative("stage-000");
        for (root, reference) in [
            (
                "/gone/original/artifacts",
                format!("/gone/original/artifacts/{suffix}"),
            ),
            (
                "D:\\gone\\artifacts",
                format!("D:\\gone\\artifacts\\{}", suffix.replace('/', "\\")),
            ),
            ("D:/gone/artifacts/", format!("D:/gone/artifacts/{suffix}")),
            (
                "\\\\server\\share\\gone",
                format!("\\\\server\\share\\gone\\{}", suffix.replace('/', "\\")),
            ),
            ("relative/artifacts", format!("relative/artifacts/{suffix}")),
            ("/gone/original/artifacts", suffix.clone()),
        ] {
            assert_eq!(
                plan(&[stage(Some("stage-000"), &[&reference])], root).unwrap(),
                vec![(0, 0, suffix.clone())],
                "{reference}"
            );
        }
    }

    #[test]
    fn unknown_labels_are_not_rewritten_and_archive_members_do_not_create_authority() {
        let stages = [
            stage(
                Some("stage-000"),
                &["cp-common-state", "/old/unrelated/output.bin"],
            ),
            stage(Some("stage-001"), &[]),
        ];
        assert!(plan(&stages, "/old").unwrap().is_empty());
        let mixed = [stage(
            Some("stage-000"),
            &["cp-common-state", &relative("stage-000")],
        )];
        assert_eq!(
            plan(&mixed, "/old").unwrap(),
            vec![(0, 1, relative("stage-000"))]
        );
    }

    #[test]
    fn foreign_roots_cross_stage_aliases_and_invalid_recognized_paths_are_rejected() {
        let suffix = relative("stage-000");
        for reference in [
            format!("/foreign/{suffix}"),
            format!("/original-extra/{suffix}"),
            format!("/original/../original/{suffix}"),
            format!("/original/./{suffix}"),
            format!("/original//{suffix}"),
            format!("/original/{suffix}/"),
            format!("/original/{suffix}:stream"),
            format!("/original/{suffix}\0"),
            format!("D:original/{suffix}"),
            format!("//?/D:/original/{suffix}"),
            format!("/original/{}", relative("stage-001")),
            format!("{RECORD_NAMESPACE}stage-000/wrong.json"),
        ] {
            assert!(
                plan(&[stage(Some("stage-000"), &[&reference])], "/original").is_err(),
                "{reference}"
            );
        }
        for root in [
            "/original/..",
            "/original/.",
            "/original//",
            "D:original",
            "",
        ] {
            assert!(plan(
                &[stage(Some("stage-000"), &[&format!("/original/{suffix}")])],
                root
            )
            .is_err());
        }
    }

    #[test]
    fn missing_members_duplicate_or_missing_stage_id_and_duplicate_refs_are_rejected() {
        let suffix = relative("stage-000");
        let valid = stage(Some("stage-000"), &[&suffix]);
        assert!(planned_replacements(&[valid.clone()], "run-a", "/old", |_| false).is_err());
        assert!(plan(&[valid.clone(), stage(Some("stage-000"), &[])], "/old").is_err());
        assert!(plan(&[stage(None, &[&suffix])], "/old").is_err());
        assert!(plan(&[stage(Some("stage-000"), &[&suffix, &suffix])], "/old").is_err());
        assert!(plan(&[stage(Some("../stage-000"), &[&suffix])], "/old").is_err());
        assert!(planned_replacements(&[valid], "../run-a", "/old", |_| true).is_err());
    }

    #[test]
    fn invalid_later_stage_does_not_modify_any_input_reference() {
        let first = format!("/original/{}", relative("stage-000"));
        let stages = [
            stage(Some("stage-000"), &[&first]),
            stage(Some("stage-001"), &[&relative("stage-001")]),
        ];
        let before = stages.clone();
        assert!(plan(&stages, "/original").is_err());
        assert_eq!(stages, before);
    }
}

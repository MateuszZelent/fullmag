//! Immutable pages of the physical samples written by one accepted solver.

use anyhow::{ensure, Context, Result};
use fullmag_runtime_control::{AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::{FmsArtifactCatalogEntry, FmsArtifactStatus, SessionStore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use super::WorkerExecutionReceiptIdentity;
use super::{read_attempt_receipt, retry_store_writer_busy, write_immutable_attempt_receipt};
use crate::study_execution_contract::{
    ExactStepFinalStateBinding, HistoricalScalarCoverage, HistoricalScalarWindow,
    ScalarSeriesIdentity, FINAL_STATE_PORT,
};

const RECEIPT_FILE: &str = "scalar_history_receipt.v1.json";
const RECEIPT_SCHEMA: &str = "fullmag.scalar_history_receipt.v1";
const INDEX_SCHEMA: &str = "fullmag.accepted_scalar_history_index.v1";
const SOURCE_FILE: &str = "scalars.csv";
const INDEX_ARTIFACT_TYPE: &str = fullmag_session::FMS_ACCEPTED_SCALAR_HISTORY_INDEX_ARTIFACT_TYPE;
const PAGE_ARTIFACT_TYPE: &str = fullmag_session::FMS_ACCEPTED_SCALAR_HISTORY_PAGE_ARTIFACT_TYPE;
const MAX_LINE_BYTES: usize = 1024;
const ROWS_PER_PAGE: u64 = 256;
const MAX_PAGES: usize = fullmag_session::MAX_OUTPUT_HISTORY_PAGES;
const MAX_INDEX_BYTES: u64 = fullmag_session::MAX_OUTPUT_HISTORY_METADATA_BYTES;

const CSV_HEADER: &[u8] = b"step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_rotated_dmi,E_dmi,E_total,max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T";
const COLUMNS: [&str; 19] = [
    "step",
    "time",
    "solver_dt",
    "mx",
    "my",
    "mz",
    "e_ex",
    "e_demag",
    "e_ext",
    "e_drive",
    "e_ani",
    "e_rotated_dmi",
    "e_dmi",
    "e_total",
    "max_dm_dt",
    "max_h_eff",
    "max_h_demag",
    "max_torque_Apm",
    "max_torque_T",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScalarHistoryPage {
    first_row: u64,
    row_count: u64,
    content_sha256: String,
    byte_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScalarHistoryIndex {
    schema_version: String,
    series: ScalarSeriesIdentity,
    final_state_sha256: String,
    total_rows: u64,
    pages: Vec<ScalarHistoryPage>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScalarHistoryReceipt {
    schema_version: String,
    execution: WorkerExecutionReceiptIdentity,
    index_sha256: String,
    index_byte_count: u64,
}

impl ScalarHistoryIndex {
    fn validate(&self, series: &ScalarSeriesIdentity, state: &str) -> Result<()> {
        ensure!(
            self.schema_version == INDEX_SCHEMA
                && &self.series == series
                && self.final_state_sha256 == state
                && !self.pages.is_empty()
                && self.pages.len() <= MAX_PAGES,
            "scalar history index differs from its accepted result binding"
        );
        let mut offset = 0;
        for page in &self.pages {
            ensure!(
                page.first_row == offset
                    && (1..=ROWS_PER_PAGE).contains(&page.row_count)
                    && page.byte_count > 0
                    && page.byte_count <= page.row_count * MAX_LINE_BYTES as u64
                    && page.content_sha256.len() == 64
                    && page
                        .content_sha256
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
                "invalid scalar history page binding"
            );
            offset += page.row_count;
        }
        ensure!(
            offset == self.total_rows,
            "scalar history row count differs from its pages"
        );
        Ok(())
    }
}

fn series_for(
    step: &AcceptedWorkerStep,
    execution: &WorkerExecutionReceiptIdentity,
) -> ScalarSeriesIdentity {
    ScalarSeriesIdentity {
        run_id: step.claim.run_id.as_str().into(),
        task_id: step.claim.task_id.as_str().into(),
        step_id: step.step_id.clone(),
        case_id: execution.case_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().into(),
        ownership_epoch: step.claim.ownership_epoch.value(),
    }
}

fn final_state_digest(outputs: &[StudyOutputPayload], case_id: &str) -> Result<Option<String>> {
    let mut finals = outputs
        .iter()
        .filter(|output| output.port_id == FINAL_STATE_PORT && output.case_id == case_id);
    let Some(state) = finals.next() else {
        return Ok(None);
    };
    ensure!(
        finals.next().is_none(),
        "ambiguous final state for scalar history"
    );
    Ok(Some(fullmag_session::hex_sha256(&state.bytes)))
}

fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> Result<bool> {
    line.clear();
    let len = reader
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', line)?;
    if len == 0 {
        return Ok(false);
    }
    ensure!(
        len <= MAX_LINE_BYTES && line.ends_with(b"\n"),
        "oversized or incomplete solver scalar line"
    );
    Ok(true)
}

fn parse_row(line: &[u8]) -> Result<(u64, [f64; COLUMNS.len()])> {
    let line = std::str::from_utf8(line)?.trim_end_matches(['\r', '\n']);
    let mut fields = line.split(',');
    let step: u64 = fields.next().context("scalar row has no step")?.parse()?;
    let mut values = [0.0; COLUMNS.len()];
    values[0] = step as f64;
    for value in &mut values[1..] {
        *value = fields
            .next()
            .context("solver scalar row has too few columns")?
            .parse()?;
        ensure!(
            value.is_finite(),
            "solver scalar row contains a nonfinite value"
        );
    }
    ensure!(
        fields.next().is_none(),
        "solver scalar row has too many columns"
    );
    ensure!(
        values[2] >= 0.0,
        "solver scalar row has a negative timestep"
    );
    Ok((step, values))
}

fn read_index(
    store: &SessionStore,
    object_ref: &str,
    expected_size: Option<u64>,
) -> Result<ScalarHistoryIndex> {
    let bytes = store
        .cas()
        .get_bounded(
            object_ref,
            expected_size
                .unwrap_or(MAX_INDEX_BYTES)
                .min(MAX_INDEX_BYTES),
        )?
        .context("scalar history index is absent from CAS")?;
    ensure!(
        expected_size.is_none_or(|expected| bytes.len() as u64 == expected),
        "scalar history index size differs from its receipt"
    );
    Ok(serde_json::from_slice(&bytes)?)
}

pub(super) fn prepare_scalar_history(
    store: &SessionStore,
    attempt_dir: &Path,
    step: &AcceptedWorkerStep,
    execution: &WorkerExecutionReceiptIdentity,
    outputs: &[StudyOutputPayload],
) -> Result<()> {
    let Some(final_state_sha256) = final_state_digest(outputs, &execution.case_id)? else {
        return Ok(());
    };
    let source = fullmag_session::repository_path::checked_path(attempt_dir, SOURCE_FILE)?;
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let budget = step.claim.lease.budget.storage_bytes.saturating_sub(
        outputs.iter().fold(0u64, |sum, output| {
            sum.saturating_add(output.bytes.len() as u64)
        }),
    ) / 8;
    ensure!(
        metadata.is_file() && metadata.len() <= budget,
        "solver scalar history exceeds its reserved archive budget"
    );
    let file = File::open(source)?;
    ensure!(
        file.metadata()?.len() == metadata.len(),
        "solver scalar history length changed"
    );
    let mut reader = BufReader::new(file.take(metadata.len()));
    let mut line = Vec::with_capacity(MAX_LINE_BYTES + 1);
    ensure!(
        read_line(&mut reader, &mut line)?,
        "missing solver scalar history header"
    );
    let header = line.strip_suffix(b"\n").unwrap_or(&line);
    ensure!(
        header.strip_suffix(b"\r").unwrap_or(header) == CSV_HEADER,
        "unrecognized solver scalar history header"
    );

    let mut index = ScalarHistoryIndex {
        schema_version: INDEX_SCHEMA.into(),
        series: series_for(step, execution),
        final_state_sha256,
        total_rows: 0,
        pages: Vec::new(),
    };
    let mut page = Vec::new();
    let mut row_count = 0;
    let mut previous: Option<(u64, f64)> = None;
    let mut consumed_bytes = line.len() as u64;
    while read_line(&mut reader, &mut line)? {
        let (step, values) = parse_row(&line)?;
        ensure!(
            previous.is_none_or(|(previous_step, previous_time)| step >= previous_step
                && values[1] >= previous_time),
            "solver scalar clock regressed within one attempt"
        );
        previous = Some((step, values[1]));
        consumed_bytes += line.len() as u64;
        page.extend_from_slice(&line);
        row_count += 1;
        if row_count == ROWS_PER_PAGE {
            append_page(store, &mut index, &page, row_count)?;
            row_count = 0;
            page.clear();
        }
    }
    ensure!(
        consumed_bytes == metadata.len()
            && reader.get_ref().get_ref().metadata()?.len() == metadata.len(),
        "solver scalar history changed while being read"
    );
    if row_count > 0 {
        append_page(store, &mut index, &page, row_count)?;
    }
    if index.pages.is_empty() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(&index)?;
    ensure!(
        bytes.len() as u64 <= MAX_INDEX_BYTES
            && consumed_bytes.saturating_add(bytes.len() as u64) <= budget,
        "scalar history index exceeds its reserved archive budget"
    );
    let index_sha256 = retry_store_writer_busy(|| store.cas().put(&bytes))?;
    let receipt = ScalarHistoryReceipt {
        schema_version: RECEIPT_SCHEMA.into(),
        execution: execution.clone(),
        index_sha256,
        index_byte_count: bytes.len() as u64,
    };
    write_immutable_attempt_receipt(attempt_dir, RECEIPT_FILE, &receipt)
}

fn append_page(
    store: &SessionStore,
    index: &mut ScalarHistoryIndex,
    bytes: &[u8],
    row_count: u64,
) -> Result<()> {
    ensure!(
        index.pages.len() < MAX_PAGES,
        "scalar history exceeds the page inventory bound"
    );
    let content_sha256 = retry_store_writer_busy(|| store.cas().put(bytes))?;
    index.pages.push(ScalarHistoryPage {
        first_row: index.total_rows,
        row_count,
        content_sha256,
        byte_count: bytes.len() as u64,
    });
    index.total_rows += row_count;
    Ok(())
}

fn artifact_entry(
    series: &ScalarSeriesIdentity,
    final_state_sha256: &str,
    first_row: Option<u64>,
    content_sha256: &str,
) -> FmsArtifactCatalogEntry {
    let role = first_row.map_or_else(
        || "index.v1.json".to_string(),
        |row| format!("page-{row}.csv"),
    );
    let identity = fullmag_session::canonical_json_sha256(&json!({
        "schema": INDEX_SCHEMA, "series": series, "state": final_state_sha256, "role": role,
    }));
    FmsArtifactCatalogEntry {
        artifact_id: format!("accepted-scalar-history-{identity}"),
        task_id: series.task_id.clone(),
        attempt_id: series.attempt_id.clone(),
        ownership_epoch: series.ownership_epoch,
        logical_path: format!(
            "outputs/{}/{}/scalar-history/{}/{role}",
            series.task_id, series.attempt_id, series.case_id
        ),
        artifact_type: if first_row.is_some() {
            PAGE_ARTIFACT_TYPE
        } else {
            INDEX_ARTIFACT_TYPE
        }
        .into(),
        content_sha256: content_sha256.into(),
        object_ref: Some(content_sha256.into()),
        status: FmsArtifactStatus::Published,
        required: false,
        study_output: None,
    }
}

pub(super) fn publish_scalar_history(
    store: &SessionStore,
    attempt_dir: &Path,
    step: &AcceptedWorkerStep,
    execution: &WorkerExecutionReceiptIdentity,
    outputs: &[StudyOutputPayload],
) -> Result<()> {
    let Some(receipt) = read_attempt_receipt::<ScalarHistoryReceipt>(attempt_dir, RECEIPT_FILE)?
    else {
        return Ok(());
    };
    ensure!(
        receipt.schema_version == RECEIPT_SCHEMA
            && receipt.execution.matches_same_attempt(execution)
            && (1..=MAX_INDEX_BYTES).contains(&receipt.index_byte_count),
        "scalar history receipt differs from the completed worker attempt"
    );
    let series = series_for(step, execution);
    let state = final_state_digest(outputs, &execution.case_id)?
        .context("scalar history receipt has no completed final state")?;
    let index = read_index(store, &receipt.index_sha256, Some(receipt.index_byte_count))?;
    index.validate(&series, &state)?;
    let mut entries = Vec::with_capacity(index.pages.len() + 1);
    for page in &index.pages {
        ensure!(
            store.cas().contains(&page.content_sha256),
            "scalar history page is absent from CAS"
        );
        entries.push(artifact_entry(
            &series,
            &state,
            Some(page.first_row),
            &page.content_sha256,
        ));
    }
    entries.push(artifact_entry(&series, &state, None, &receipt.index_sha256));
    let claim = &step.claim;
    let lease = store
        .read_resource_lease(
            claim.run_id.as_str(),
            claim.lease.resource_id.as_str(),
            claim.lease.lease_token.as_str(),
        )?
        .context("scalar history publication lease missing")?;
    retry_store_writer_busy(|| store.append_artifact_catalog_entries_for_lease(&lease, &entries))?;
    Ok(())
}

fn selected_columns(requested: Option<&str>) -> Vec<usize> {
    let Some(requested) = requested else {
        return (0..COLUMNS.len()).collect();
    };
    let mut selected = vec![0];
    for name in requested.split(',').map(str::trim) {
        if let Some(index) = COLUMNS.iter().position(|column| *column == name) {
            if !selected.contains(&index) {
                selected.push(index);
            }
        }
    }
    selected
}

pub(crate) fn read_archived_scalar_window(
    store: &SessionStore,
    binding: &ExactStepFinalStateBinding,
    start: u64,
    limit: u64,
    columns: Option<&str>,
) -> Result<Option<HistoricalScalarWindow>> {
    let series = &binding.identity;
    let state = &binding.output.content_sha256;
    let expected_index = artifact_entry(series, state, None, "");
    let Some(entry) = binding
        .artifact_catalog
        .entries
        .iter()
        .find(|entry| entry.artifact_id == expected_index.artifact_id)
    else {
        return Ok(None);
    };
    let expected_index = artifact_entry(series, state, None, &entry.content_sha256);
    ensure!(
        *entry == expected_index && binding.task.artifact_ids.contains(&entry.artifact_id),
        "scalar history index is not pinned by the exact succeeded attempt"
    );
    let index = read_index(store, &entry.content_sha256, None)?;
    index.validate(series, state)?;
    let end = start.saturating_add(limit).min(index.total_rows);
    let selected = selected_columns(columns);
    let mut rows = Vec::new();
    for page in index.pages.iter().filter(|page| {
        start < end && page.first_row < end && page.first_row + page.row_count > start
    }) {
        let expected = artifact_entry(series, state, Some(page.first_row), &page.content_sha256);
        ensure!(
            binding.task.artifact_ids.contains(&expected.artifact_id)
                && binding
                    .artifact_catalog
                    .entries
                    .iter()
                    .any(|entry| entry == &expected),
            "scalar history page is not pinned by the exact succeeded attempt"
        );
        let bytes = store
            .cas()
            .get_bounded(&page.content_sha256, page.byte_count)?
            .context("scalar history page is absent from CAS")?;
        ensure!(
            bytes.len() as u64 == page.byte_count,
            "scalar history page size differs"
        );
        read_page_rows(&bytes, page, start, end, &selected, &mut rows)?;
    }
    ensure!(
        rows.len() as u64 == end.saturating_sub(start),
        "scalar history window has a row gap"
    );
    Ok(Some(HistoricalScalarWindow {
        series: series.clone(),
        artifact_id: entry.artifact_id.clone(),
        content_sha256: entry.content_sha256.clone(),
        coverage: HistoricalScalarCoverage::SolverSeries,
        total_rows: index.total_rows,
        next_start: (end < index.total_rows).then_some(end),
        columns: selected
            .into_iter()
            .map(|index| COLUMNS[index].into())
            .collect(),
        rows,
    }))
}

fn read_page_rows(
    bytes: &[u8],
    page: &ScalarHistoryPage,
    start: u64,
    end: u64,
    columns: &[usize],
    rows: &mut Vec<Vec<f64>>,
) -> Result<()> {
    let mut offset = page.first_row;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        ensure!(
            line.len() <= MAX_LINE_BYTES && line.ends_with(b"\n"),
            "incomplete archived scalar row"
        );
        let (_, values) = parse_row(line)?;
        if (start..end).contains(&offset) {
            rows.push(columns.iter().map(|index| values[*index]).collect());
        }
        offset += 1;
    }
    ensure!(
        offset == page.first_row + page.row_count,
        "scalar history page row count differs"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_session::{FmsArtifactCatalog, FmsStudyOutputManifestEntry, FmsTaskCatalogEntry};

    fn row(step: u64, energy: f64) -> Vec<u8> {
        format!("{step},{step},0,1,0,0,0,0,0,0,0,0,0,{energy},0,0,0,0,0\n").into_bytes()
    }

    #[test]
    fn reads_exact_pages_after_step_zero_and_rejects_unowned_page() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let series = ScalarSeriesIdentity {
            run_id: "run-a".into(),
            step_id: "stage-a".into(),
            task_id: "task-a".into(),
            case_id: "default".into(),
            attempt_id: "attempt-a".into(),
            ownership_epoch: 5,
        };
        let state = "a".repeat(64);
        let mut index = ScalarHistoryIndex {
            schema_version: INDEX_SCHEMA.into(),
            series: series.clone(),
            final_state_sha256: state.clone(),
            total_rows: 0,
            pages: Vec::new(),
        };
        let mut first = Vec::new();
        for step in 0..ROWS_PER_PAGE {
            first.extend(row(step, step as f64));
        }
        append_page(&store, &mut index, &first, ROWS_PER_PAGE).unwrap();
        let second = [row(ROWS_PER_PAGE, 400.0), row(ROWS_PER_PAGE + 1, 401.0)].concat();
        append_page(&store, &mut index, &second, 2).unwrap();
        let index_digest = store
            .cas()
            .put(&serde_json::to_vec(&index).unwrap())
            .unwrap();
        let mut entries: Vec<_> = index
            .pages
            .iter()
            .map(|page| artifact_entry(&series, &state, Some(page.first_row), &page.content_sha256))
            .collect();
        entries.push(artifact_entry(&series, &state, None, &index_digest));
        let mut binding = ExactStepFinalStateBinding {
            task: FmsTaskCatalogEntry {
                task_id: series.task_id.clone(),
                input_fingerprint: "b".repeat(64),
                lifecycle: fullmag_session::FmsTaskLifecycle::Succeeded,
                readiness: fullmag_session::FmsTaskReadiness::Ready,
                observation: None,
                attempt_id: Some(series.attempt_id.clone()),
                ownership_epoch: Some(series.ownership_epoch),
                resolved_input_fingerprint: None,
                artifact_ids: entries
                    .iter()
                    .map(|entry| entry.artifact_id.clone())
                    .collect(),
                resource_id: None,
                coordinator_watermark: None,
                coordinator_genesis: None,
            },
            artifact_catalog: FmsArtifactCatalog {
                schema_version: fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA.into(),
                run_id: series.run_id.clone(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                entries,
            },
            output: FmsStudyOutputManifestEntry {
                port_id: FINAL_STATE_PORT.into(),
                case_id: series.case_id.clone(),
                data_kind: "state".into(),
                codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
                artifact_id: "final-state-a".into(),
                object_ref: state.clone(),
                content_sha256: state,
            },
            identity: series.clone(),
            accepted_state_ref: None,
        };

        let first = read_archived_scalar_window(&store, &binding, 0, 1, Some("e_total"))
            .unwrap()
            .unwrap();
        assert_eq!(first.rows, vec![vec![0.0, 0.0]]);
        assert_eq!(first.next_start, Some(1));
        assert_eq!(first.series, series);

        let across =
            read_archived_scalar_window(&store, &binding, ROWS_PER_PAGE - 1, 2, Some("e_total"))
                .unwrap()
                .unwrap();
        assert_eq!(across.columns, ["step", "e_total"]);
        assert_eq!(
            across.rows,
            vec![
                vec![(ROWS_PER_PAGE - 1) as f64, (ROWS_PER_PAGE - 1) as f64],
                vec![ROWS_PER_PAGE as f64, 400.0],
            ]
        );
        assert_eq!(across.next_start, Some(ROWS_PER_PAGE + 1));
        assert_eq!(across.total_rows, ROWS_PER_PAGE + 2);

        let last = read_archived_scalar_window(
            &store,
            &binding,
            across.next_start.unwrap(),
            100,
            Some("e_total"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(last.rows, vec![vec![(ROWS_PER_PAGE + 1) as f64, 401.0]]);
        assert_eq!(last.next_start, None);

        binding.artifact_catalog.entries[1].attempt_id = "attempt-b".into();
        assert!(read_archived_scalar_window(&store, &binding, ROWS_PER_PAGE, 1, None).is_err());
        assert!(read_archived_scalar_window(&store, &binding, 0, 1, None).is_ok());
    }

    #[test]
    fn rejects_partial_and_nonfinite_solver_samples() {
        let mut input = &b"0,1,0"[..];
        let mut line = Vec::new();
        assert!(read_line(&mut input, &mut line).is_err());
        assert!(parse_row(&row(0, f64::NAN)).is_err());
    }
}

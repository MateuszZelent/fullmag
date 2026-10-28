//! Version dispatch for the existing study-output publication family.
use anyhow::{bail, Result};

/// A projection may be used only for common output binding checks. Observation
/// admission and full CAS closure must consume the original versioned manifest.
#[doc(hidden)]
pub fn read_manifest_projection(
    bytes: &[u8],
) -> Result<fullmag_session::FmsStudyOutputManifest> {
    if bytes.len() as u64 > fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES {
        bail!("study output manifest exceeds metadata decode budget");
    }
    let header: serde_json::Value = serde_json::from_slice(bytes)?;
    match header
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
    {
        Some(fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4) => {
            if bytes.len() as u64 > fullmag_session::MAX_OUTPUT_HISTORY_METADATA_BYTES {
                bail!("terminal manifest exceeds metadata budget");
            }
            let manifest: fullmag_session::FmsStudyOutputManifestV4 =
                serde_json::from_slice(bytes)?;
            manifest.validate()?;
            Ok(manifest.output_projection())
        }
        _ => {
            let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(bytes)?;
            manifest.validate()?;
            Ok(manifest)
        }
    }
}

use anyhow::Context;
use fullmag_application::TaskClaim;
use fullmag_ir::OutputIR;
use fullmag_session::*;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Read, Seek};
use std::path::Path;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventorySample {
    stream_id: String,
    ordinal: u64,
    collection: String,
    #[serde(deserialize_with = "required_option")]
    quantity_id: Option<String>,
    step: u64,
    time_s: f64,
    solver_dt_s: f64,
    relative_path: String,
    byte_offset: u64,
    writer_byte_count: u64,
    payload_codec_id: String,
    payload_codec_version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryCause {
    step: u64,
    time_s: f64,
    collection: String,
    #[serde(deserialize_with = "required_option")]
    schedule_index: Option<u64>,
    #[serde(deserialize_with = "required_option")]
    name: Option<String>,
    #[serde(deserialize_with = "required_option")]
    sample_ordinal: Option<u64>,
    cause: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum InventoryRecord {
    Header {
        schema_version: String,
        outputs: Vec<OutputIR>,
    },
    Sample(InventorySample),
    Cause(InventoryCause),
    Seal {
        schema_version: String,
        streams: BTreeMap<String, u64>,
        scalar_rows_written: u64,
        field_snapshots_written: u64,
    },
}

fn required_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(decoder)
}

fn validate_inventory_group(samples: &[InventorySample], causes: &[InventoryCause]) -> Result<()> {
    for cause in causes {
        match (cause.collection.as_str(), cause.cause.as_str()) {
            ("all", "final")
                if cause.schedule_index.is_none()
                    && cause.name.is_none()
                    && cause.sample_ordinal.is_none() => {}
            (collection @ ("scalar" | "field"), "scheduled")
                if cause.schedule_index.is_some() && cause.name.is_some() =>
            {
                if !samples.iter().any(|sample| {
                    sample.collection == collection
                        && Some(sample.ordinal) == cause.sample_ordinal
                        && sample.step == cause.step
                        && sample.time_s.to_bits() == cause.time_s.to_bits()
                        && (collection == "scalar" || sample.quantity_id == cause.name)
                }) {
                    bail!("scheduled inventory cause has no actual completed writer sample");
                }
            }
            _ => bail!("unregistered or incomplete inventory cause"),
        }
    }
    Ok(())
}

/// One bounded clock group of metadata; never a Vec of numerical frames.
fn walk_inventory(
    root: &Path,
    outputs: &[OutputIR],
    storage_budget: u64,
    mut visit: impl FnMut(&[InventorySample], &[InventoryCause]) -> Result<()>,
) -> Result<BTreeMap<String, u64>> {
    const LINE_LIMIT: u64 = 128 * 1024;
    let path = repository_path::checked_path(root, "terminal-output-inventory.v1.jsonl")?;
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > storage_budget {
        bail!("terminal inventory exceeds its admitted regular-file budget");
    }
    let mut reader = std::io::BufReader::new(file);
    let mut header = false;
    let mut sealed = false;
    let mut counts = BTreeMap::<String, u64>::new();
    let mut samples = Vec::<InventorySample>::new();
    let mut causes = Vec::<InventoryCause>::new();
    let mut clock: Option<(u64, f64)> = None;
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(LINE_LIMIT + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count as u64 > LINE_LIMIT || !line.ends_with(b"\n") || sealed {
            bail!("partial, oversized or post-seal inventory record");
        }
        let record: InventoryRecord = serde_json::from_slice(&line)?;
        let next_clock = match &record {
            InventoryRecord::Sample(sample) => Some((sample.step, sample.time_s)),
            InventoryRecord::Cause(cause) => Some((cause.step, cause.time_s)),
            _ => None,
        };
        if let Some((step, time)) = next_clock {
            if !header || !time.is_finite() {
                bail!("inventory sample has no valid header/clock");
            }
            if let Some((previous_step, previous_time)) = clock {
                if step < previous_step || time < previous_time {
                    bail!("terminal inventory clock regressed");
                }
                if step != previous_step || time.to_bits() != previous_time.to_bits() {
                    validate_inventory_group(&samples, &causes)?;
                    visit(&samples, &causes)?;
                    samples.clear();
                    causes.clear();
                }
            }
            clock = Some((step, time));
        }
        match record {
            InventoryRecord::Header {
                schema_version,
                outputs: recorded,
            } => {
                if header
                    || schema_version != "fullmag.runner.output_inventory.v1"
                    || serde_json::to_value(&recorded)? != serde_json::to_value(outputs)?
                {
                    bail!("terminal inventory configuration differs from the real output owner");
                }
                header = true;
            }
            InventoryRecord::Sample(sample) => {
                let ordinal = counts.entry(sample.stream_id.clone()).or_default();
                if sample.ordinal != *ordinal
                    || sample.writer_byte_count == 0
                    || !sample.solver_dt_s.is_finite()
                    || sample.solver_dt_s < 0.0
                    || sample.payload_codec_version != "v1"
                {
                    bail!("terminal inventory sample ordinal/clock/codec differs");
                }
                match sample.collection.as_str() {
                    "scalar"
                        if sample.stream_id == "scalar-row"
                            && sample.quantity_id.is_none()
                            && sample.relative_path == "scalars.csv"
                            && sample.writer_byte_count <= 4096
                            && sample.payload_codec_id == "fullmag.runner.scalar_csv_row" => {}
                    "field"
                        if sample.quantity_id.as_ref().is_some_and(|name| {
                            sample.stream_id == format!("field:{name}")
                                && sample.relative_path
                                    == format!("fields/{name}/step_{:06}.json", sample.step)
                        }) && sample.byte_offset == 0
                            && sample.payload_codec_id == "fullmag.runner.field_snapshot_json" => {}
                    _ => bail!("unregistered terminal inventory payload source"),
                }
                *ordinal = ordinal
                    .checked_add(1)
                    .context("inventory ordinal overflow")?;
                samples.push(sample);
            }
            InventoryRecord::Cause(cause) => causes.push(cause),
            InventoryRecord::Seal {
                schema_version,
                streams,
                scalar_rows_written,
                field_snapshots_written,
            } => {
                validate_inventory_group(&samples, &causes)?;
                visit(&samples, &causes)?;
                samples.clear();
                causes.clear();
                let fields = counts
                    .iter()
                    .filter(|(name, _)| name.starts_with("field:"))
                    .try_fold(0_u64, |count, (_, value)| count.checked_add(*value))
                    .context("inventory field count overflow")?;
                if !header
                    || schema_version != "fullmag.runner.output_inventory_seal.v1"
                    || streams != counts
                    || counts.get("scalar-row").copied().unwrap_or(0) != scalar_rows_written
                    || fields != field_snapshots_written
                {
                    bail!("terminal inventory seal does not cover all actual writer jobs");
                }
                sealed = true;
            }
        }
        if samples
            .len()
            .checked_add(causes.len())
            .context("inventory group count overflow")?
            > outputs.len().saturating_mul(4).saturating_add(32)
        {
            bail!("terminal inventory clock group exceeds its configuration-derived budget");
        }
    }
    if !sealed {
        bail!("terminal inventory has no complete writer seal");
    }
    Ok(counts)
}

fn read_sample(root: &Path, sample: &InventorySample, limit: u64) -> Result<Vec<u8>> {
    if sample.collection == "field" {
        // The existing artifact owner finalizes frame provenance after writer join.
        // Capture its actual final bytes here; the job count/clock seal is not a pre-final raw identity.
        return repository_path::read_bounded_regular_file(
            root,
            &sample.relative_path,
            usize::try_from(limit)?,
        );
    }
    if sample.writer_byte_count > limit {
        bail!("terminal scalar row exceeds the checked decode budget");
    }
    let path = repository_path::checked_path(root, &sample.relative_path)?;
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let end = sample
        .byte_offset
        .checked_add(sample.writer_byte_count)
        .context("terminal CSV range overflow")?;
    if !metadata.is_file() || end > metadata.len() || sample.writer_byte_count > 4096 {
        bail!("terminal CSV source range is invalid");
    }
    file.seek(std::io::SeekFrom::Start(sample.byte_offset))?;
    let mut bytes = vec![0; usize::try_from(sample.writer_byte_count)?];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub(crate) struct PublicationObjects<'a> {
    store: &'a SessionStore,
    claim: &'a TaskClaim,
    pub entries: BTreeMap<String, FmsArtifactCatalogEntry>,
    raw_objects: BTreeMap<String, u64>,
    raw_roles: BTreeMap<String, String>,
    raw_bytes: u64,
    catalog_bytes: u64,
}

impl<'a> PublicationObjects<'a> {
    pub fn new(store: &'a SessionStore, claim: &'a TaskClaim) -> Result<Self> {
        let existing = store.read_artifact_catalog(claim.run_id.as_str())?;
        let catalog_bytes = existing
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()?
            .map_or(0, |bytes| bytes.len() as u64);
        if catalog_bytes > MAX_TERMINAL_CATALOG_METADATA_BYTES {
            bail!("existing artifact catalog exceeds the control-document budget");
        }
        Ok(Self {
            store,
            claim,
            entries: BTreeMap::new(),
            raw_objects: BTreeMap::new(),
            raw_roles: BTreeMap::new(),
            raw_bytes: 0,
            catalog_bytes,
        })
    }

    /// Only the existing publisher owns claim-qualified artifact identity.
    pub fn stage(
        &mut self,
        artifact_type: &str,
        role: serde_json::Value,
        bytes: &[u8],
    ) -> Result<(String, String)> {
        let reference = fullmag_session::hex_sha256(bytes);
        let role_key = fullmag_session::canonical_json_sha256(
            &serde_json::json!({"artifact_type": artifact_type, "role": role}),
        );
        if self
            .raw_roles
            .get(&role_key)
            .is_some_and(|previous| previous != &reference)
        {
            bail!("the same sealed publication role changed bytes between projections");
        }
        self.raw_roles.insert(role_key, reference.clone());
        let artifact_id=fullmag_session::terminal_publication_artifact_id(
            self.claim.run_id.as_str(),self.claim.task_id.as_str(),self.claim.attempt_id.as_str(),
            self.claim.ownership_epoch.value(),artifact_type,&role,&reference)?;
        let entry = FmsArtifactCatalogEntry {
            artifact_id: artifact_id.clone(),
            task_id: self.claim.task_id.as_str().into(),
            attempt_id: self.claim.attempt_id.as_str().into(),
            ownership_epoch: self.claim.ownership_epoch.value(),
            logical_path: format!(
                "outputs/{}/{}/system/{artifact_id}.bin",
                self.claim.task_id.as_str(),
                self.claim.attempt_id.as_str()
            ),
            artifact_type: artifact_type.into(),
            content_sha256: reference.clone(),
            object_ref: Some(reference.clone()),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: None,
        };
        if let Some(previous) = self.entries.get(&artifact_id) {
            if previous != &entry {
                bail!("publication role has conflicting prepared bytes");
            }
            return Ok((artifact_id, reference));
        }
        let size = bytes.len() as u64;
        if let Some(previous) = self.raw_objects.get(&reference) {
            if *previous != size {
                bail!("publication raw object size differs");
            }
        } else {
            self.raw_bytes = self
                .raw_bytes
                .checked_add(size)
                .context("publication raw byte count overflow")?;
            if self.raw_bytes > self.claim.lease.budget.storage_bytes {
                bail!("complete terminal publication exceeds the admitted storage budget");
            }
            self.raw_objects.insert(reference.clone(), size);
        }
        self.catalog_bytes = self
            .catalog_bytes
            .checked_add(serde_json::to_vec(&entry)?.len() as u64)
            .context("terminal catalog metadata count overflow")?;
        if self.catalog_bytes > MAX_TERMINAL_CATALOG_METADATA_BYTES {
            bail!("complete terminal catalog exceeds existing control-document budget");
        }
        if self.store.cas().put(bytes)? != reference {
            bail!("terminal CAS writer returned another raw identity");
        }
        self.entries.insert(artifact_id.clone(), entry);
        Ok((artifact_id, reference))
    }
}

struct HistoryStream {
    stream_id: String,
    physical_id: String,
    quantity: String,
    unit: String,
    collection: FmsHistoryCollection,
    projection: FmsHistoryProjection,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalCursor {
    schedule_index: u64,
    name: String,
    every_s: f64,
    next_time_s: f64,
    #[serde(deserialize_with = "required_option")]
    last_sampled_time_s: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalCoverage {
    schema_version: String,
    outputs: Vec<OutputIR>,
    origin_s: f64,
    scalar_cursors: Vec<TerminalCursor>,
    field_cursors: Vec<TerminalCursor>,
    default_scalar_trace: bool,
    terminal_step: u64,
    terminal_time_s: f64,
}

pub(crate) struct PreparedHistory {
    pub indices: Vec<FmsOutputHistoryIndexBinding>,
    pub coverage: FmsOutputCoverage,
}

fn scalar_stream(name: &str) -> Result<HistoryStream> {
    let column = fullmag_application::STUDY_HISTORY_SCALAR_COLUMNS
        .iter()
        .position(|column| *column == name)
        .context("scalar history is not a column in the existing writer")?;
    Ok(HistoryStream {
        stream_id: format!("scalar:{name}"),
        physical_id: "scalar-row".into(),
        quantity: name.into(),
        unit: fullmag_runner::terminal_output_scalar_unit(name)?,
        collection: FmsHistoryCollection::Scalar,
        projection: FmsHistoryProjection::ScalarColumn {
            column_index: column as u64,
            column_name: name.into(),
        },
    })
}

fn history_streams(
    scalar: &[fullmag_runner::TerminalOutputScheduleBinding],
    field: &[fullmag_runner::TerminalOutputScheduleBinding],
) -> Result<BTreeMap<String, HistoryStream>> {
    let mut streams = BTreeMap::<String, HistoryStream>::new();
    let scalar_names: BTreeSet<String> = if scalar.is_empty() {
        fullmag_application::STUDY_HISTORY_SCALAR_COLUMNS
            .iter()
            .map(|name| (*name).to_owned())
            .collect()
    } else {
        scalar.iter().map(|binding| binding.name.clone()).collect()
    };
    for name in scalar_names {
        let stream = scalar_stream(&name)?;
        streams.insert(stream.stream_id.clone(), stream);
    }
    for binding in field {
        fullmag_runner::terminal_output_field_component_count(&binding.name)?;
        let stream = HistoryStream {
            stream_id: format!("field:{}", binding.name),
            physical_id: format!("field:{}", binding.name),
            quantity: binding.name.clone(),
            unit: fullmag_runner::terminal_output_quantity_unit(&binding.name).into(),
            collection: FmsHistoryCollection::Field,
            projection: FmsHistoryProjection::Field,
        };
        streams.insert(stream.stream_id.clone(), stream);
    }
    Ok(streams)
}

fn checked_cursors(
    actual: &[TerminalCursor],
    bindings: &[fullmag_runner::TerminalOutputScheduleBinding],
    origin: f64,
    terminal: f64,
) -> Result<Vec<FmsOutputHistoryCursor>> {
    if actual.len() != bindings.len() {
        bail!("terminal output cursor count differs from the real schedule owner");
    }
    actual
        .iter()
        .zip(bindings)
        .map(|(cursor, binding)| {
            if cursor.schedule_index != binding.schedule_index
                || cursor.name != binding.name
                || cursor.every_s.to_bits() != binding.every_seconds.to_bits()
                || !cursor.next_time_s.is_finite()
                || cursor.next_time_s < origin
                || cursor
                    .last_sampled_time_s
                    .is_some_and(|time| !time.is_finite() || time < origin || time > terminal)
            {
                bail!("terminal cursor differs from its existing schedule binding");
            }
            Ok(FmsOutputHistoryCursor {
                output_index: binding.output_index,
                schedule_index: binding.schedule_index,
                name: binding.name.clone(),
                every_seconds: binding.every_seconds,
                next_time: cursor.next_time_s,
                last_sampled_time: cursor.last_sampled_time_s,
            })
        })
        .collect()
}

fn source_causes(
    sample: &InventorySample,
    causes: &[InventoryCause],
    scalar: &[fullmag_runner::TerminalOutputScheduleBinding],
    field: &[fullmag_runner::TerminalOutputScheduleBinding],
    default_scalar: bool,
    origin: f64,
) -> Result<Vec<FmsOutputSampleCause>> {
    let mut result = BTreeSet::new();
    if sample.step == 0 && sample.time_s.to_bits() == origin.to_bits() {
        result.insert(FmsOutputSampleCause::Initial);
    }
    if default_scalar && sample.collection == "scalar" {
        result.insert(FmsOutputSampleCause::DefaultScalar);
    }
    for cause in causes {
        if cause.step != sample.step || cause.time_s.to_bits() != sample.time_s.to_bits() {
            bail!("inventory cause belongs to another clock");
        }
        match (cause.collection.as_str(), cause.cause.as_str()) {
            ("all", "final")
                if cause.schedule_index.is_none()
                    && cause.name.is_none()
                    && cause.sample_ordinal.is_none() =>
            {
                result.insert(FmsOutputSampleCause::Final);
            }
            (collection @ ("scalar" | "field"), "scheduled") => {
                let bindings = if collection == "scalar" {
                    scalar
                } else {
                    field
                };
                let index = cause
                    .schedule_index
                    .context("scheduled inventory cause has no schedule index")?;
                let binding = bindings
                    .get(usize::try_from(index)?)
                    .context("scheduled inventory index is outside its actual owner")?;
                if binding.schedule_index != index
                    || cause.name.as_deref() != Some(binding.name.as_str())
                {
                    bail!("inventory cause differs from the authored output binding");
                }
                if collection == sample.collection
                    && cause.sample_ordinal == Some(sample.ordinal)
                    && (collection == "scalar"
                        || sample.quantity_id.as_deref() == Some(binding.name.as_str()))
                {
                    result.insert(FmsOutputSampleCause::Scheduled {
                        output_index: binding.output_index,
                        schedule_index: binding.schedule_index,
                    });
                }
            }
            _ => bail!("unregistered inventory sample cause"),
        }
    }
    if result.is_empty() {
        bail!("committed sample has no actual output cause");
    }
    Ok(result.into_iter().collect())
}

fn stage_page(
    objects: &mut PublicationObjects<'_>,
    page: &mut FmsOutputHistoryPage,
    pages: &mut Vec<FmsOutputHistoryPageBinding>,
) -> Result<()> {
    if page.samples.is_empty() {
        return Ok(());
    }
    page.validate()?;
    let bytes = serde_json::to_vec(page)?;
    if bytes.len() as u64 > MAX_OUTPUT_HISTORY_METADATA_BYTES
        || pages.len() >= MAX_OUTPUT_HISTORY_PAGES
    {
        bail!("complete terminal history exceeds its checked page budget");
    }
    let count = page.samples.len() as u64;
    let (artifact_id, reference) = objects.stage(
        FMS_OUTPUT_HISTORY_PAGE_ARTIFACT_TYPE,
        serde_json::json!({"stream_id": page.stream_id, "first_ordinal": page.first_ordinal}),
        &bytes,
    )?;
    pages.push(FmsOutputHistoryPageBinding {
        first_ordinal: page.first_ordinal,
        sample_count: count,
        artifact_id,
        object_ref: reference.clone(),
        content_sha256: reference,
        byte_count: bytes.len() as u64,
    });
    page.first_ordinal = page
        .first_ordinal
        .checked_add(count)
        .context("history page ordinal overflow")?;
    page.samples.clear();
    Ok(())
}

#[derive(Clone, Default)]
struct SampleStats {
    count: u64,
    first: Option<f64>,
    last: Option<f64>,
}
impl SampleStats {
    fn add(&mut self, time: f64) -> Result<()> {
        self.count = self
            .count
            .checked_add(1)
            .context("history coverage count overflow")?;
        if self.first.is_none() {
            self.first = Some(time);
        }
        self.last = Some(time);
        Ok(())
    }
}

fn owns_cause(
    sample: &FmsOutputHistorySample,
    binding: &fullmag_runner::TerminalOutputScheduleBinding,
) -> bool {
    sample.causes.contains(&FmsOutputSampleCause::Scheduled {
        output_index: binding.output_index,
        schedule_index: binding.schedule_index,
    })
}

/// Seal existing raw sample files after the ordinary artifact owner has returned.
/// Numerical leaves are read/staged one at a time; scalar projections share them.
pub(crate) fn prepare_history(
    objects: &mut PublicationObjects<'_>,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    root: &Path,
    coverage_bytes: &[u8],
    clock: fullmag_quantities::ObservationClock,
) -> Result<PreparedHistory> {
    if coverage_bytes.len() as u64 > MAX_OUTPUT_HISTORY_METADATA_BYTES {
        bail!("terminal cursor metadata exceeds budget");
    }
    let terminal: TerminalCoverage = serde_json::from_slice(coverage_bytes)?;
    let outputs = fullmag_runner::terminal_output_configuration(problem, plan);
    let (scalar, field) = fullmag_runner::terminal_output_schedule_bindings(&outputs)?;
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        bail!("terminal history requires the actual FDM CPU plan");
    };
    if terminal.schema_version != "fullmag.runner.terminal_output_coverage.v1"
        || serde_json::to_value(&terminal.outputs)? != serde_json::to_value(&outputs)?
        || terminal.origin_s.to_bits() != fdm.time_stage.start_time_s.to_bits()
        || terminal.terminal_step != clock.accepted_step
        || terminal.terminal_time_s.to_bits() != clock.time_seconds.to_bits()
        || terminal.default_scalar_trace != scalar.is_empty()
    {
        bail!("terminal coverage metadata differs from its accepted execution");
    }
    let scalar_cursors = checked_cursors(
        &terminal.scalar_cursors,
        &scalar,
        terminal.origin_s,
        clock.time_seconds,
    )?;
    let field_cursors = checked_cursors(
        &terminal.field_cursors,
        &field,
        terminal.origin_s,
        clock.time_seconds,
    )?;
    let cells = fdm
        .grid
        .cells
        .iter()
        .try_fold(1_usize, |count, extent| count.checked_mul(*extent as usize))
        .filter(|count| *count > 0)
        .context("terminal history grid count overflow")?;
    let layout = fullmag_runner::terminal_output_field_layout(plan);
    let streams = history_streams(&scalar, &field)?;
    let mut indices = Vec::new();
    let mut coverage_streams = Vec::new();
    let mut original_seal: Option<BTreeMap<String, u64>> = None;
    let mut initial_committed = false;
    let mut all_final_committed = true;
    let mut default_last = None;
    let storage_budget = objects.claim.lease.budget.storage_bytes;
    let memory_budget = objects.claim.lease.budget.memory_bytes;
    for stream in streams.values() {
        let bindings: Vec<_> = (if stream.collection == FmsHistoryCollection::Field {
            &field
        } else {
            &scalar
        })
        .iter()
        .filter(|binding| binding.name == stream.quantity)
        .collect();
        let mut page = FmsOutputHistoryPage {
            schema_version: FMS_OUTPUT_HISTORY_PAGE_SCHEMA.into(),
            stream_id: stream.stream_id.clone(),
            first_ordinal: 0,
            samples: Vec::new(),
        };
        let mut page_bytes = 1024_u64;
        let mut pages = Vec::new();
        let mut all = SampleStats::default();
        let mut per_binding = BTreeMap::<(u64, u64), SampleStats>::new();
        let mut last_group_qualified = BTreeSet::new();
        let mut saw_final_cause = false;
        let component_count = if stream.collection == FmsHistoryCollection::Field {
            fullmag_runner::terminal_output_field_component_count(&stream.quantity)?
        } else {
            1
        };
        let frame_bound = (cells as u64)
            .checked_mul(u64::from(component_count))
            .and_then(|count| count.checked_mul(256))
            .and_then(|count| count.checked_add(MAX_OUTPUT_HISTORY_METADATA_BYTES))
            .context("history frame byte budget overflow")?;
        let leaf_budget = if stream.collection == FmsHistoryCollection::Field {
            frame_bound
                .min(memory_budget / 8)
                .min(storage_budget)
                .min(64 * 1024 * 1024)
        } else {
            4096.min(storage_budget)
        };
        if leaf_budget == 0 {
            bail!("history leaf has no admitted decode budget");
        }
        let seal = walk_inventory(root, &outputs, storage_budget, |samples, causes| {
            if causes.iter().any(|cause| {
                cause.collection == "all"
                    && cause.cause == "final"
                    && cause.step == clock.accepted_step
                    && cause.time_s.to_bits() == clock.time_seconds.to_bits()
            }) {
                saw_final_cause = true;
            }
            let mut group = Vec::new();
            for source in samples
                .iter()
                .filter(|sample| sample.stream_id == stream.physical_id)
            {
                if source.step > clock.accepted_step
                    || source.time_s < terminal.origin_s
                    || source.time_s > clock.time_seconds
                {
                    bail!("history sample lies outside the exact accepted stage prefix");
                }
                let bytes = read_sample(root, source, leaf_budget)?;
                if stream.collection == FmsHistoryCollection::Field {
                    fullmag_application::validate_study_history_field(
                        &bytes,
                        &stream.quantity,
                        &stream.unit,
                        source.step,
                        source.time_s,
                        source.solver_dt_s,
                        &layout,
                        cells,
                        component_count,
                        leaf_budget,
                    )?;
                } else {
                    fullmag_application::validate_study_history_scalar_row(
                        &bytes,
                        source.step,
                        source.time_s,
                        source.solver_dt_s,
                    )?;
                }
                fullmag_session::validate_output_history_leaf_storage(
                    &source.payload_codec_id,
                    &bytes,
                    leaf_budget,
                )
                .map_err(anyhow::Error::msg)?;
                let sample_causes = source_causes(
                    source,
                    causes,
                    &scalar,
                    &field,
                    terminal.default_scalar_trace,
                    terminal.origin_s,
                )?;
                let (artifact_id, reference) = objects.stage(
                    FMS_OUTPUT_HISTORY_SAMPLE_ARTIFACT_TYPE,
                    serde_json::json!({"stream_id": source.stream_id, "ordinal": source.ordinal}),
                    &bytes,
                )?;
                let sample = FmsOutputHistorySample {
                    ordinal: all.count,
                    step: source.step,
                    time_s: source.time_s,
                    solver_dt_s: source.solver_dt_s,
                    causes: sample_causes,
                    payload_codec_id: source.payload_codec_id.clone(),
                    payload_codec_version: source.payload_codec_version.clone(),
                    artifact_id,
                    object_ref: reference.clone(),
                    content_sha256: reference,
                    byte_count: bytes.len() as u64,
                };
                sample.validate()?;
                initial_committed |= sample.causes.contains(&FmsOutputSampleCause::Initial);
                all.add(sample.time_s)?;
                group.push(sample);
                // bytes is dropped before the next numerical sample is read.
            }
            if group.is_empty() {
                return Ok(());
            }
            last_group_qualified.clear();
            for binding in &bindings {
                let stats = per_binding
                    .entry((binding.output_index, binding.schedule_index))
                    .or_default();
                let owned: Vec<_> = group
                    .iter()
                    .filter(|sample| owns_cause(sample, binding))
                    .collect();
                if !owned.is_empty() {
                    for sample in owned {
                        stats.add(sample.time_s)?;
                    }
                    last_group_qualified.insert((binding.output_index, binding.schedule_index));
                } else if let Some(sample) = group
                    .iter()
                    .rev()
                    .find(|sample| sample.causes.contains(&FmsOutputSampleCause::Final))
                {
                    stats.add(sample.time_s)?;
                    last_group_qualified.insert((binding.output_index, binding.schedule_index));
                }
            }
            let extra_bytes = group
                .iter()
                .try_fold(0_u64, |total, sample| -> Result<u64> {
                    let bytes = u64::try_from(serde_json::to_vec(sample)?.len())?
                        .checked_add(1)
                        .context("history sample metadata byte count overflow")?;
                    total
                        .checked_add(bytes)
                        .context("history page metadata byte count overflow")
                })?;
            if group.len() > MAX_OUTPUT_HISTORY_PAGE_SAMPLES
                || extra_bytes
                    .checked_add(1024)
                    .context("page budget overflow")?
                    > MAX_OUTPUT_HISTORY_METADATA_BYTES
            {
                bail!("one source clock group exceeds the checked history page budget");
            }
            if page
                .samples
                .len()
                .checked_add(group.len())
                .context("page sample count overflow")?
                > MAX_OUTPUT_HISTORY_PAGE_SAMPLES
                || page_bytes
                    .checked_add(extra_bytes)
                    .context("page byte count overflow")?
                    > MAX_OUTPUT_HISTORY_METADATA_BYTES
            {
                stage_page(objects, &mut page, &mut pages)?;
                page_bytes = 1024;
            }
            page_bytes = page_bytes
                .checked_add(extra_bytes)
                .context("page byte count overflow")?;
            page.samples.extend(group);
            Ok(())
        })?;
        if let Some(previous) = &original_seal {
            if previous != &seal {
                bail!("terminal inventory changed between bounded projections");
            }
        } else {
            original_seal = Some(seal.clone());
        }
        if seal.get(&stream.physical_id).copied().unwrap_or(0) != all.count {
            bail!("history projection silently lost committed samples");
        }
        let final_alias = saw_final_cause
            && all.last.is_some_and(|time| {
                fullmag_runner::terminal_output_times_coalesce(time, clock.time_seconds)
            });
        if final_alias {
            let last = page
                .samples
                .last_mut()
                .context("terminal history lost its final pending page")?;
            if !last.causes.contains(&FmsOutputSampleCause::Final) {
                last.causes.push(FmsOutputSampleCause::Final);
                last.causes.sort();
            }
            for binding in &bindings {
                if !last_group_qualified.contains(&(binding.output_index, binding.schedule_index)) {
                    per_binding
                        .entry((binding.output_index, binding.schedule_index))
                        .or_default()
                        .add(last.time_s)?;
                }
            }
        }
        all_final_committed &= final_alias;
        stage_page(objects, &mut page, &mut pages)?;
        let index = FmsOutputHistoryIndex {
            schema_version: FMS_OUTPUT_HISTORY_INDEX_SCHEMA.into(),
            stream_id: stream.stream_id.clone(),
            collection: stream.collection,
            quantity_id: stream.quantity.clone(),
            unit: stream.unit.clone(),
            sample_count: all.count,
            pages,
        };
        index.validate()?;
        let bytes = serde_json::to_vec(&index)?;
        if bytes.len() as u64 > MAX_OUTPUT_HISTORY_METADATA_BYTES {
            bail!("complete history index exceeds metadata budget");
        }
        let (artifact_id, reference) = objects.stage(
            FMS_OUTPUT_HISTORY_INDEX_ARTIFACT_TYPE,
            serde_json::json!({"stream_id": stream.stream_id}),
            &bytes,
        )?;
        indices.push(FmsOutputHistoryIndexBinding {
            stream_id: stream.stream_id.clone(),
            artifact_id,
            object_ref: reference.clone(),
            content_sha256: reference,
            byte_count: bytes.len() as u64,
        });
        if terminal.default_scalar_trace && stream.collection == FmsHistoryCollection::Scalar {
            default_last = all.last;
            coverage_streams.push(FmsHistoryCoverage {
                collection: FmsHistoryCollection::DefaultScalar,
                output_index: None,
                schedule_index: None,
                name: stream.quantity.clone(),
                history_stream_id: stream.stream_id.clone(),
                projection: stream.projection.clone(),
                sample_count: all.count,
                first_sample_time_s: all.first,
                last_sample_time_s: all.last,
            });
        }
        for binding in bindings {
            let stats = per_binding
                .remove(&(binding.output_index, binding.schedule_index))
                .unwrap_or_default();
            coverage_streams.push(FmsHistoryCoverage {
                collection: stream.collection,
                output_index: Some(binding.output_index),
                schedule_index: Some(binding.schedule_index),
                name: binding.name.clone(),
                history_stream_id: stream.stream_id.clone(),
                projection: stream.projection.clone(),
                sample_count: stats.count,
                first_sample_time_s: stats.first,
                last_sample_time_s: stats.last,
            });
        }
    }
    let physical: BTreeSet<_> = streams
        .values()
        .map(|stream| stream.physical_id.as_str())
        .collect();
    if original_seal.as_ref().is_none_or(|seal| {
        seal.keys()
            .any(|stream| !physical.contains(stream.as_str()))
    }) || !initial_committed
        || !all_final_committed
    {
        bail!("terminal history does not cover the complete actual initial/final output prefix");
    }
    Ok(PreparedHistory {
        indices,
        coverage: FmsOutputCoverage {
            schema_version: "study_output_coverage.v1".into(),
            origin_s: terminal.origin_s,
            configuration_sha256: fullmag_session::canonical_json_sha256(
                &serde_json::json!({"outputs": outputs}),
            ),
            scalar_schedules: scalar_cursors,
            field_schedules: field_cursors,
            default_scalar_last_sampled_time_s: default_last,
            initial_sample_committed: initial_committed,
            final_sample_committed: all_final_committed,
            streams: coverage_streams,
        },
    })
}

/// Semantic runner artifacts. Catalog IDs are assigned only by this publisher.
#[derive(Debug, Clone)]
pub struct ObservationSourcePayloadV2 {
    pub snapshot_bytes: Vec<u8>,
    pub state_bytes: Vec<u8>,
    pub primary_preimages: Vec<fullmag_runner::TerminalPrimaryPreimage>,
    pub coverage_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedTerminalPublicationV4 {
    pub manifest: FmsStudyOutputManifestV4,
    pub entries: Vec<FmsArtifactCatalogEntry>,
}

fn bounded_cas(store: &SessionStore, reference: &str, budget: u64) -> Result<Vec<u8>> {
    let count = store
        .cas()
        .verified_length(reference)?
        .context("terminal CAS object is absent")?;
    if count == 0 || count > budget {
        bail!("terminal CAS object exceeds its checked read budget");
    }
    let raw = store
        .cas()
        .get_verified_range(reference, 0, count, budget)?
        .context("terminal CAS object disappeared")?;
    if raw.object_length != count || raw.bytes.len() as u64 != count {
        bail!("terminal CAS object length changed");
    }
    Ok(raw.bytes)
}

fn terminal_reference(
    step: &crate::study::AcceptedWorkerStep,
    snapshot: &fullmag_runner::FdmCpuAcceptedStateSnapshotV2,
) -> Result<fullmag_quantities::AcceptedStateRef> {
    let reference = fullmag_quantities::AcceptedStateRef {
        id: fullmag_quantities::AcceptedStateId {
            run_id: step.claim.run_id.as_str().into(),
            stage_id: Some(step.step_id.clone()),
            accepted_step: snapshot.clock.accepted_step,
            clock_digest: snapshot.clock_digest.clone(),
            state_digest: snapshot.state_digest.clone(),
            domain_digest: step.resolved_input.preparation.plan_fingerprint.clone(),
            plan_digest: format!(
                "sha256:{}",
                canonical_json_sha256(&serde_json::json!({
                    "schema_version": "fullmag.accepted-state-plan.v1", "problem": &step.problem,
                    "execution_plan": &step.execution_plan, "requested_execution": &step.resolved_input.requested_execution,
                }))
            ),
        },
        generation: fullmag_quantities::AcceptedStateGeneration {
            runtime_epoch: step.claim.ownership_epoch.value(),
            accepted_revision: snapshot.clock.accepted_step,
        },
    };
    reference
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(reference)
}

fn validate_primary(
    step: &crate::study::AcceptedWorkerStep,
    plan: &fullmag_ir::ExecutionPlanIR,
    source: &ObservationSourcePayloadV2,
) -> Result<(
    fullmag_runner::FdmCpuAcceptedStateSnapshotV2,
    fullmag_application::MagnetizationStateArtifact,
)> {
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        bail!("terminal package is not FDM CPU M3");
    };
    if step.resolved_input.requested_execution.device != "cpu"
        || step.resolved_input.requested_execution.precision != "double"
        || step.resolved_input.frozen_stage_context.is_none()
        || !fdm
            .spin_transport_plans
            .iter()
            .any(|transport| transport.fdm_cpu_double_transient.is_some())
    {
        bail!("terminal V2 requires explicit FDM CPU double M3 and admitted full lifecycle");
    }
    let maximum = step.claim.lease.budget.storage_bytes;
    let total = source
        .primary_preimages
        .iter()
        .try_fold(source.snapshot_bytes.len() as u64, |total, raw| {
            total.checked_add(raw.bytes.len() as u64)
        })
        .and_then(|total| total.checked_add(source.state_bytes.len() as u64))
        .context("terminal primary byte count overflow")?;
    if total > maximum || source.state_bytes.len() as u64 > 64 * 1024 * 1024 {
        bail!("terminal primary package exceeds its admitted decode budget");
    }
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "state",
        fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
        fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
        &source.state_bytes,
    )?;
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("terminal observation requires the existing raw M codec");
    };
    let snapshot = fullmag_runner::validate_terminal_primary_package(
        fdm,
        &source.snapshot_bytes,
        &source.primary_preimages,
        &state.values,
        maximum,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if state.step != snapshot.clock.accepted_step
        || state.time_s.to_bits() != snapshot.clock.time_seconds.to_bits()
        || state.solver_dt_s.to_bits()!=snapshot.clock.dt_seconds.unwrap_or(0.0).to_bits()
        || state.layout!=fullmag_runner::terminal_output_field_layout(plan)
    {
        bail!("terminal observation raw M clock differs from its single accepted bundle");
    }
    Ok((snapshot, state))
}

/// Stage under the same output publisher, before the existing immutable worker
/// completion receipt. Nothing becomes a published token until the lease append.
pub fn prepare_terminal_study_publication(
    store: &SessionStore,
    accepted: &crate::study::AcceptedStudySnapshot,
    step: &crate::study::AcceptedWorkerStep,
    plan: &fullmag_ir::ExecutionPlanIR,
    source: &ObservationSourcePayloadV2,
    outputs: &[crate::study::StudyOutputPayload],
    root: &Path,
) -> Result<PreparedTerminalPublicationV4> {
    let (snapshot, _) = validate_primary(step, plan, source)?;
    let reference = terminal_reference(step, &snapshot)?;
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        bail!("terminal plan owner differs");
    };
    let mut objects = PublicationObjects::new(store, &step.claim)?;
    let (snapshot_artifact_id, snapshot_object_ref) = objects.stage(
        FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE,
        serde_json::json!({"snapshot_schema":snapshot.schema_version}),
        &source.snapshot_bytes,
    )?;
    let (state_artifact_id, state_object_ref) = objects.stage(
        FMS_OBSERVATION_STATE_ARTIFACT_TYPE,
        serde_json::json!({"codec_id":FMS_OBSERVATION_STATE_CODEC_ID}),
        &source.state_bytes,
    )?;
    let mut carriers = Vec::with_capacity(4);
    for semantic in &snapshot.primary_carriers {
        let raw = source
            .primary_preimages
            .iter()
            .find(|raw| raw.carrier_id == semantic.carrier_id)
            .context("terminal raw primary role missing")?;
        let (artifact_id, object_ref) = objects.stage(
            FMS_ACCEPTED_PRIMARY_ARTIFACT_TYPE,
            serde_json::json!({"carrier_id":semantic.carrier_id}),
            &raw.bytes,
        )?;
        carriers.push(FmsPublishedCarrierV2 {
            carrier_id: semantic.carrier_id.clone(),
            value_digest: semantic.value_digest.clone(),
            codec_id: semantic.codec_id.clone(),
            codec_version: semantic.codec_version.clone(),
            preimage_sha256: semantic.preimage_sha256.clone(),
            byte_count: semantic.byte_count,
            artifact_id,
            content_sha256: object_ref.clone(),
            object_ref,
        });
    }
    let descriptor = FmsObservationSourceDescriptorV2 {
        schema_version: FMS_OBSERVATION_SOURCE_SCHEMA_V2.into(),
        adapter_id: "fdm_cpu_observation.v2".into(),
        accepted_state_ref: reference.clone(),
        snapshot_schema_version: snapshot.schema_version.clone(),
        snapshot_artifact_id,
        snapshot_object_ref,
        state_codec_id: FMS_OBSERVATION_STATE_CODEC_ID.into(),
        state_codec_version: "v1".into(),
        state_artifact_id,
        state_object_ref,
        grid_cells: fdm.grid.cells,
        quantity_ids: vec!["m".into()],
        primary_carriers: carriers,
    };
    let history = prepare_history(
        &mut objects,
        &step.problem,
        plan,
        root,
        &source.coverage_bytes,
        snapshot.clock,
    )?;
    let declared = accepted
        .study
        .steps
        .iter()
        .find(|authored| authored.step_id == step.step_id)
        .context("terminal stage has no accepted output contract")?;
    let mut manifest_outputs = Vec::with_capacity(outputs.len());
    let mut seen = BTreeSet::new();
    for output in outputs {
        let port = declared
            .outputs
            .iter()
            .find(|port| port.port_id == output.port_id)
            .context("terminal output port is undeclared")?;
        if !seen.insert((&output.port_id, &output.case_id)) {
            bail!("terminal output binding is duplicated");
        }
        let data_kind = crate::study::study_port_data_kind_label(&port.data_kind);
        let logical = FmsStudyArtifactOutput {
            step_id: step.step_id.clone(),
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
        };
        let raw_ref = fullmag_session::hex_sha256(&output.bytes);
        let artifact_id = format!(
            "artifact-{}",
            canonical_json_sha256(&serde_json::json!({
                "run_id":step.claim.run_id.as_str(),"task_id":step.claim.task_id.as_str(),"attempt_id":step.claim.attempt_id.as_str(),
                "ownership_epoch":step.claim.ownership_epoch.value(),"logical_output":&logical,"data_kind":data_kind,
                "codec_id":output.codec_id,"codec_version":output.codec_version,"object_ref":raw_ref,
            }))
        );
        // Use the same raw-budget accounting, then retain the established output ID.
        let (temporary,object_ref) = objects.stage(data_kind,serde_json::json!({"logical_output":logical,"codec_id":output.codec_id,"codec_version":output.codec_version}),&output.bytes)?;
        let mut entry = objects
            .entries
            .remove(&temporary)
            .context("prepared output entry missing")?;
        entry.artifact_id = artifact_id.clone();
        entry.study_output = Some(logical);
        entry.logical_path = format!(
            "outputs/{}/{}/{}/{}/output.bin",
            step.claim.task_id.as_str(),
            step.claim.attempt_id.as_str(),
            output.port_id,
            output.case_id
        );
        objects.entries.insert(artifact_id.clone(), entry);
        manifest_outputs.push(FmsStudyOutputManifestEntry {
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
            data_kind: data_kind.into(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
            artifact_id,
            content_sha256: object_ref.clone(),
            object_ref,
        });
    }
    if declared
        .outputs
        .iter()
        .any(|port| !outputs.iter().any(|output| output.port_id == port.port_id))
    {
        bail!("terminal output set is incomplete");
    }
    manifest_outputs.sort_by(|a, b| (&a.port_id, &a.case_id).cmp(&(&b.port_id, &b.case_id)));
    let manifest = FmsStudyOutputManifestV4 {
        schema_version: FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4.into(),
        run_id: step.claim.run_id.as_str().into(),
        task_id: step.claim.task_id.as_str().into(),
        step_id: step.step_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().into(),
        ownership_epoch: step.claim.ownership_epoch.value(),
        accepted_state_ref: reference,
        observation_source: descriptor,
        outputs: manifest_outputs,
        publication_kind: "completed".into(),
        historical_prefix: FmsRequiredNull,
        coverage: history.coverage,
        histories: history.indices,
    };
    manifest.validate()?;
    let bytes = serde_json::to_vec(&manifest)?;
    if bytes.len() as u64 > MAX_OUTPUT_HISTORY_METADATA_BYTES {
        bail!("terminal manifest exceeds metadata budget");
    }
    objects.stage(
        "study_output_manifest",
        serde_json::json!({"manifest_schema":FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4}),
        &bytes,
    )?;
    let prepared = PreparedTerminalPublicationV4 {
        manifest,
        entries: objects.entries.into_values().collect(),
    };
    validate_prepared_terminal_publication(store, step, &prepared)?;
    Ok(prepared)
}

/// Reopen actual published raw bytes; neither a digest-only promise nor a live
/// backend state is accepted. Also used by receipt recovery before publication.
pub fn validate_prepared_terminal_publication(
    store: &SessionStore,
    step: &crate::study::AcceptedWorkerStep,
    prepared: &PreparedTerminalPublicationV4,
) -> Result<()> {
    open_prepared_terminal_publication(store, step, prepared).map(|_| ())
}

fn open_prepared_terminal_publication(
    store: &SessionStore,
    step: &crate::study::AcceptedWorkerStep,
    prepared: &PreparedTerminalPublicationV4,
) -> Result<(
    fullmag_runner::FdmCpuAcceptedStateSnapshotV2,
    fullmag_application::MagnetizationStateArtifact,
)> {
    let manifest = &prepared.manifest;
    manifest.validate()?;
    if serde_json::to_vec(prepared)?.len() as u64 > MAX_TERMINAL_CATALOG_METADATA_BYTES {
        bail!("prepared terminal receipt metadata exceeds existing control-document budget");
    }
    let mut raw_sizes = BTreeMap::new();
    for entry in &prepared.entries {
        let reference = entry
            .object_ref
            .as_deref()
            .context("prepared terminal entry has no raw object")?;
        if raw_sizes.contains_key(reference) {
            continue;
        }
        let count = store
            .cas()
            .verified_length(reference)?
            .context("prepared terminal raw object missing")?;
        if count == 0 || count > 64 * 1024 * 1024 {
            bail!("prepared terminal raw object exceeds bounded decode budget");
        }
        raw_sizes.insert(reference.to_owned(), count);
    }
    let bytes = raw_sizes
        .values()
        .try_fold(0_u64, |count, size| count.checked_add(*size))
        .context("terminal raw inventory byte overflow")?;
    if bytes > step.claim.lease.budget.storage_bytes {
        bail!("prepared terminal raw inventory exceeds the actual admitted budget");
    }
    if manifest.run_id != step.claim.run_id.as_str()
        || manifest.task_id != step.claim.task_id.as_str()
        || manifest.step_id != step.step_id
        || manifest.attempt_id != step.claim.attempt_id.as_str()
        || manifest.ownership_epoch != step.claim.ownership_epoch.value()
    {
        bail!("prepared terminal publication differs from its accepted owner");
    }
    let catalog = FmsArtifactCatalog {
        schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
        run_id: manifest.run_id.clone(),
        revision: 1,
        updated_at: chrono::Utc::now(),
        entries: prepared.entries.clone(),
    };
    catalog.validate()?;
    let mut owners = catalog
        .entries
        .iter()
        .filter(|entry| entry.artifact_type == "study_output_manifest");
    let owner = owners
        .next()
        .context("prepared terminal manifest owner missing")?;
    if owners.next().is_some() {
        bail!("prepared terminal manifest is ambiguous");
    }
    let reference = owner
        .object_ref
        .as_deref()
        .context("prepared terminal manifest object missing")?;
    let raw = bounded_cas(store, reference, MAX_OUTPUT_HISTORY_METADATA_BYTES)?;
    let decoded: FmsStudyOutputManifestV4 = serde_json::from_slice(&raw)?;
    if decoded != *manifest {
        bail!("prepared manifest differs from its exact staged bytes");
    }
    let visited = fullmag_session::validate_terminal_publication_storage(
        &raw,
        owner,
        &catalog,
        |reference, budget| bounded_cas(store, reference, budget),
    )?;
    if catalog
        .entries
        .iter()
        .any(|entry| !visited.contains(&entry.artifact_id))
    {
        bail!("prepared terminal inventory contains an undeclared role");
    }
    let descriptor = &manifest.observation_source;
    let source = ObservationSourcePayloadV2 {
        snapshot_bytes: bounded_cas(store, &descriptor.snapshot_object_ref, 64 * 1024)?,
        state_bytes: bounded_cas(store, &descriptor.state_object_ref, 64 * 1024 * 1024)?,
        primary_preimages: descriptor
            .primary_carriers
            .iter()
            .map(|carrier| {
                Ok(fullmag_runner::TerminalPrimaryPreimage {
                    carrier_id: carrier.carrier_id.clone(),
                    bytes: bounded_cas(store, &carrier.object_ref, carrier.byte_count)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        coverage_bytes: Vec::new(),
    };
    let plan = crate::study::materialize_accepted_worker_execution_plan(store, step)?;
    let (snapshot, state) = validate_primary(step, &plan, &source)?;
    for output in &manifest.outputs {
        let raw = bounded_cas(store, &output.object_ref, 64 * 1024 * 1024)?;
        let decoded = fullmag_application::decode_study_artifact_bytes(
            &output.data_kind,
            &output.codec_id,
            &output.codec_version,
            &raw,
        )?;
        if output.data_kind=="state" && !matches!(&decoded,fullmag_application::DecodedStudyArtifact::FrozenMagnetizationState(_)) {
            bail!("terminal State output requires the explicit full frozen lifecycle envelope");
        }
        if let fullmag_application::DecodedStudyArtifact::FrozenMagnetizationState(artifact) =
            decoded
        {
            if output.data_kind=="state" {
                if artifact.state.step!=snapshot.clock.accepted_step || artifact.state.time_s.to_bits()!=snapshot.clock.time_seconds.to_bits()
                    || artifact.state.solver_dt_s.to_bits()!=snapshot.clock.dt_seconds.unwrap_or(0.0).to_bits()
                    || artifact.state.layout!=state.layout || artifact.state.values.len()!=state.values.len()
                    || artifact.state.values.iter().flatten().zip(state.values.iter().flatten()).any(|(left,right)|left.to_bits()!=right.to_bits()) {
                    bail!("terminal State output differs from the actual accepted observation bundle");
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct FrozenPrimary {schema_version:String,frozen_spins:Option<fullmag_runner::constraints::FrozenSpinsCheckpointV1>}
                let frozen_raw=source.primary_preimages.iter().find(|raw|raw.carrier_id=="fdm.cpu.frozen-constraint-state-digest.v1")
                    .context("accepted frozen primary missing")?;
                let frozen:FrozenPrimary=serde_json::from_slice(&frozen_raw.bytes)?;
                let child:Option<fullmag_runner::constraints::FrozenSpinsCheckpointV1>=artifact.frozen_spins.as_ref()
                    .map(|raw|serde_json::from_str(raw.get())).transpose()?;
                let activation:fullmag_runner::constraints::FrozenSpinsActivationSet=serde_json::from_str(artifact.frozen_activation_set.get())?;
                let primary_activation:fullmag_runner::constraints::FrozenSpinsActivationSet=serde_json::from_slice(&source.primary_preimages.iter()
                    .find(|raw|raw.carrier_id=="fdm.cpu.frozen-activation-set-digest.v1").context("accepted activation primary missing")?.bytes)?;
                if frozen.schema_version!="fullmag.fdm.frozen-primary-preimage.v1"
                    || canonical_json_sha256(&serde_json::to_value(&child)?)!=canonical_json_sha256(&serde_json::to_value(&frozen.frozen_spins)?)
                    || activation!=primary_activation {bail!("terminal State output differs from accepted frozen child/history");}
            }
            let intent = store
                .read_run_intent(step.claim.run_id.as_str())?
                .context("terminal output run intent missing")?;
            let spec: fullmag_application::RunSpecification =
                serde_json::from_value(intent.specification)?;
            let study = crate::study::load_accepted_study_snapshot(
                store,
                &spec.run_id,
                &spec.snapshot.project_id,
            )?;
            crate::frozen_stage_lifecycle::validate_terminal_output(
                store,
                &study,
                &step.claim,
                &step.step_id,
                artifact,
            )?;
        }
    }
    validate_committed_history(store, step, &plan, manifest, snapshot.clock)?;
    if terminal_reference(step, &snapshot)? != manifest.accepted_state_ref {
        bail!("terminal accepted identity differs from its immutable source");
    }
    for (semantic, published) in snapshot
        .primary_carriers
        .iter()
        .zip(&descriptor.primary_carriers)
    {
        if semantic.carrier_id != published.carrier_id
            || semantic.value_digest != published.value_digest
            || semantic.codec_id != published.codec_id
            || semantic.codec_version != published.codec_version
            || semantic.preimage_sha256 != published.preimage_sha256
            || semantic.byte_count != published.byte_count
        {
            bail!("terminal descriptor differs from the actual semantic primary package");
        }
    }
    Ok((snapshot, state))
}

pub struct LoadedStudyObservationRuntimeV2 {
    pub descriptor: FmsObservationSourceDescriptorV2,
    pub runtime: fullmag_runner::ObservationRuntime,
}

/// Cold source reconstruction after the successful attempt has released its
/// lease. Reuses immutable admission/genesis; never dispatches a solver.
pub fn load_study_observation_runtime_v2(
    store: &SessionStore,
    expected: &fullmag_quantities::AcceptedStateRef,
) -> Result<LoadedStudyObservationRuntimeV2> {
    expected
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let run = expected.id.run_id.as_str();
    let stage = expected
        .id
        .stage_id
        .as_deref()
        .context("terminal source has no stage")?;
    let task_id = task_id_for_study_step(run, stage)?;
    let run_catalog = store
        .read_run_catalog(run)?
        .context("terminal source run catalog missing")?;
    let task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("terminal source task missing")?;
    let attempt = task
        .attempt_id
        .as_deref()
        .context("terminal source attempt missing")?;
    let epoch = task
        .ownership_epoch
        .context("terminal source epoch missing")?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded || epoch != expected.generation.runtime_epoch {
        bail!("terminal observation source is not the succeeded current attempt");
    }
    let catalog = store
        .read_artifact_catalog(run)?
        .context("terminal source artifact catalog missing")?;
    catalog.validate()?;
    let mut owners = catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task_id
            && entry.attempt_id == attempt
            && entry.ownership_epoch == epoch
            && entry.status == FmsArtifactStatus::Published
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    let owner = owners
        .next()
        .context("terminal source has no published manifest")?;
    if owners.next().is_some() {
        bail!("terminal source manifest is ambiguous");
    }
    let raw = bounded_cas(
        store,
        owner
            .object_ref
            .as_deref()
            .context("terminal manifest object missing")?,
        MAX_OUTPUT_HISTORY_METADATA_BYTES,
    )?;
    let manifest: FmsStudyOutputManifestV4 = serde_json::from_slice(&raw)?;
    manifest.validate()?;
    if manifest.accepted_state_ref != *expected {
        bail!("terminal source changed its accepted identity");
    }
    let visited = fullmag_session::validate_terminal_publication_storage(
        &raw,
        owner,
        &catalog,
        |reference, budget| bounded_cas(store, reference, budget),
    )?;
    if visited.iter().any(|id| !task.artifact_ids.contains(id)) {
        bail!("terminal source graph is absent from the succeeded task inventory");
    }
    let prepared = PreparedTerminalPublicationV4 {
        manifest,
        entries: catalog
            .entries
            .iter()
            .filter(|entry| visited.contains(&entry.artifact_id))
            .cloned()
            .collect(),
    };
    let intent = store
        .read_run_intent(run)?
        .context("terminal source run intent missing")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)?;
    let accepted = crate::study::load_accepted_study_snapshot(
        store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )?;
    let step =
        crate::study::cold_accepted_worker_step(store, &accepted, stage, &task_id, attempt, epoch)?;
    let (snapshot, state) = open_prepared_terminal_publication(store, &step, &prepared)?;
    let cells = prepared.manifest.observation_source.grid_cells;
    let count = cells
        .iter()
        .try_fold(1_usize, |count, width| count.checked_mul(*width as usize))
        .context("terminal observation grid overflow")?;
    let runtime = fullmag_runner::ObservationRuntime::new(fullmag_runner::ObservationFrame {
        source: expected.id.clone(),
        clock: snapshot.clock,
        primary_carriers: snapshot
            .primary_carriers
            .iter()
            .map(|carrier| fullmag_runner::ObservationPrimaryCarrier {
                carrier_id: carrier.carrier_id.clone(),
                canonical_bytes: carrier.value_digest.as_bytes().to_vec(),
            })
            .collect(),
        grid: cells,
        n_cells: count,
        active_mask: None,
        magnetization: Some(state.values.into_iter().flatten().collect()),
        named_fields: Default::default(),
        global_scalars: None,
        available_quantity_ids: vec![fullmag_quantities::QuantityId::M],
    })
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(LoadedStudyObservationRuntimeV2 {
        descriptor: prepared.manifest.observation_source,
        runtime,
    })
}

/// Verify actual thin history leaves and coverage with the same accepted
/// quantity/layout/schedule owners used by the terminal producer.
fn validate_committed_history(
    store: &SessionStore,
    step: &crate::study::AcceptedWorkerStep,
    plan: &fullmag_ir::ExecutionPlanIR,
    manifest: &FmsStudyOutputManifestV4,
    clock: fullmag_quantities::ObservationClock,
) -> Result<()> {
    let outputs = fullmag_runner::terminal_output_configuration(&step.problem, plan);
    let (scalar, field) = fullmag_runner::terminal_output_schedule_bindings(&outputs)?;
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        bail!("history source backend differs");
    };
    let coverage = &manifest.coverage;
    if coverage.configuration_sha256
        != canonical_json_sha256(&serde_json::json!({"outputs":outputs}))
        || coverage.origin_s.to_bits() != fdm.time_stage.start_time_s.to_bits()
        || !coverage.initial_sample_committed
        || !coverage.final_sample_committed
    {
        bail!("completed history has no exact admitted configuration/initial/final coverage");
    }
    for (cursors, bindings) in [
        (&coverage.scalar_schedules, &scalar),
        (&coverage.field_schedules, &field),
    ] {
        if cursors.len() != bindings.len() {
            bail!("committed history cursor inventory differs");
        }
        for (cursor, binding) in cursors.iter().zip(bindings.iter()) {
            if cursor.output_index != binding.output_index
                || cursor.schedule_index != binding.schedule_index
                || cursor.name != binding.name
                || cursor.every_seconds.to_bits() != binding.every_seconds.to_bits()
                || cursor.next_time < coverage.origin_s
                || cursor
                    .last_sampled_time
                    .is_some_and(|time| time < coverage.origin_s || time > clock.time_seconds)
            {
                bail!("committed history cursor differs from actual schedule owner");
            }
        }
    }
    let cells = fdm
        .grid
        .cells
        .iter()
        .try_fold(1_usize, |count, width| count.checked_mul(*width as usize))
        .context("history grid overflow")?;
    let layout = fullmag_runner::terminal_output_field_layout(plan);
    let expected_streams = history_streams(&scalar, &field)?;
    if manifest.histories.len() != expected_streams.len()
        || manifest
            .histories
            .iter()
            .any(|entry| !expected_streams.contains_key(&entry.stream_id))
    {
        bail!("committed history omitted a complete actual scalar/field/default stream");
    }
    let mut actual_initial = false;
    let mut actual_final = true;
    let mut default_last = None;
    for binding in &manifest.histories {
        let raw = bounded_cas(store, &binding.object_ref, binding.byte_count)?;
        let index: FmsOutputHistoryIndex = serde_json::from_slice(&raw)?;
        index.validate()?;
        let expected_stream = expected_streams
            .get(&index.stream_id)
            .context("committed history has an undeclared logical stream")?;
        if index.quantity_id != expected_stream.quantity
            || index.unit != expected_stream.unit
            || index.collection != expected_stream.collection
        {
            bail!("committed history index differs from the canonical stream owner");
        }
        let projections: Vec<_> = coverage
            .streams
            .iter()
            .filter(|entry| entry.history_stream_id == index.stream_id)
            .collect();
        let bindings = if index.collection == FmsHistoryCollection::Field {
            &field
        } else {
            &scalar
        };
        if projections.is_empty() || index.collection == FmsHistoryCollection::DefaultScalar {
            bail!("history index has no declared projection");
        }
        let component_count = if index.collection == FmsHistoryCollection::Field {
            fullmag_runner::terminal_output_field_component_count(&index.quantity_id)?
        } else {
            1
        };
        for projection in &projections {
            if projection.name != index.quantity_id
                || projection.projection != expected_stream.projection
                || match &projection.projection {
                    FmsHistoryProjection::Field => {
                        index.collection != FmsHistoryCollection::Field
                            || index.unit
                                != fullmag_runner::terminal_output_quantity_unit(&index.quantity_id)
                    }
                    FmsHistoryProjection::ScalarColumn {
                        column_index,
                        column_name,
                    } => {
                        index.collection != FmsHistoryCollection::Scalar
                            || fullmag_application::STUDY_HISTORY_SCALAR_COLUMNS
                                .get(usize::try_from(*column_index)?)
                                .copied()
                                != Some(column_name.as_str())
                            || column_name != &index.quantity_id
                            || index.unit
                                != fullmag_runner::terminal_output_scalar_unit(column_name)?
                    }
                }
            {
                bail!("history projection quantity/unit/column differs from the canonical writer");
            }
            match projection.collection {
                FmsHistoryCollection::DefaultScalar
                    if scalar.is_empty() && index.collection == FmsHistoryCollection::Scalar => {}
                collection
                    if collection == index.collection
                        && bindings.iter().any(|entry| {
                            Some(entry.output_index) == projection.output_index
                                && Some(entry.schedule_index) == projection.schedule_index
                                && entry.name == projection.name
                        }) => {}
                _ => bail!("history projection is not an authored/default schedule"),
            }
        }
        let expected_projections =
            if index.collection == FmsHistoryCollection::Scalar && scalar.is_empty() {
                1
            } else {
                bindings
                    .iter()
                    .filter(|entry| entry.name == index.quantity_id)
                    .count()
            };
        if projections.len() != expected_projections {
            bail!("history index omitted a required projection");
        }
        let leaf_budget = if index.collection == FmsHistoryCollection::Field {
            (cells as u64)
                .checked_mul(u64::from(component_count))
                .and_then(|count| count.checked_mul(256))
                .and_then(|count| count.checked_add(MAX_OUTPUT_HISTORY_METADATA_BYTES))
                .context("history leaf budget overflow")?
                .min(step.claim.lease.budget.memory_bytes / 8)
                .min(step.claim.lease.budget.storage_bytes)
                .min(64 * 1024 * 1024)
        } else {
            4096.min(step.claim.lease.budget.storage_bytes)
        };
        let mut replay: BTreeMap<(u64, u64), (f64, Option<f64>)> = bindings
            .iter()
            .filter(|entry| entry.name == index.quantity_id)
            .map(|entry| {
                (
                    (entry.output_index, entry.schedule_index),
                    (coverage.origin_s, None),
                )
            })
            .collect();
        let mut stats = vec![SampleStats::default(); projections.len()];
        let mut group: Option<(u64, f64)> = None;
        let mut own = vec![0_u64; projections.len()];
        let mut group_total = 0_u64;
        let mut group_final = false;
        let mut stream_final = false;
        let flush = |time: f64,
                     own: &[u64],
                     total: u64,
                     final_seen: bool,
                     stats: &mut [SampleStats]|
         -> Result<()> {
            for (position, projection) in projections.iter().enumerate() {
                let count = if projection.collection == FmsHistoryCollection::DefaultScalar {
                    total
                } else if own[position] > 0 {
                    own[position]
                } else if final_seen {
                    1
                } else {
                    0
                };
                for _ in 0..count {
                    stats[position].add(time)?;
                }
            }
            Ok(())
        };
        for page in &index.pages {
            let raw = bounded_cas(store, &page.object_ref, page.byte_count)?;
            let page: FmsOutputHistoryPage = serde_json::from_slice(&raw)?;
            page.validate()?;
            for sample in &page.samples {
                if sample.time_s < coverage.origin_s
                    || sample.time_s > clock.time_seconds
                    || sample.step > clock.accepted_step
                {
                    bail!("committed history escapes accepted prefix");
                }
                if let Some((step, time)) = group {
                    if step != sample.step || time.to_bits() != sample.time_s.to_bits() {
                        flush(time, &own, group_total, group_final, &mut stats)?;
                        own.fill(0);
                        group_total = 0;
                        group_final = false;
                    }
                }
                group = Some((sample.step, sample.time_s));
                group_total = group_total
                    .checked_add(1)
                    .context("history group count overflow")?;
                for cause in &sample.causes {
                    match cause {
                        FmsOutputSampleCause::Initial
                            if sample.step == 0
                                && sample.time_s.to_bits() == coverage.origin_s.to_bits() =>
                        {
                            actual_initial = true;
                        }
                        FmsOutputSampleCause::Final
                            if fullmag_runner::terminal_output_times_coalesce(
                                sample.time_s,
                                clock.time_seconds,
                            ) =>
                        {
                            group_final = true;
                            stream_final = true;
                        }
                        FmsOutputSampleCause::DefaultScalar
                            if scalar.is_empty()
                                && index.collection == FmsHistoryCollection::Scalar => {}
                        FmsOutputSampleCause::Scheduled {
                            output_index,
                            schedule_index,
                        } if bindings.iter().any(|entry| {
                            entry.output_index == *output_index
                                && entry.schedule_index == *schedule_index
                        }) => {}
                        _ => bail!("committed history has an unregistered or false sample cause"),
                    }
                }
                for cause in &sample.causes {
                    if let FmsOutputSampleCause::Scheduled {
                        output_index,
                        schedule_index,
                    } = cause
                    {
                        if let Some(cursor) = replay.get_mut(&(*output_index, *schedule_index)) {
                            let binding = bindings
                                .iter()
                                .find(|binding| {
                                    binding.output_index == *output_index
                                        && binding.schedule_index == *schedule_index
                                })
                                .context("history replay lost its actual schedule binding")?;
                            *cursor = fullmag_runner::terminal_output_advance_existing_cursor(
                                &binding.name,
                                binding.every_seconds,
                                cursor.0,
                                cursor.1,
                                sample.time_s,
                                step.claim.lease.budget.memory_bytes / 64,
                            )
                            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                        }
                    }
                }
                for (position, projection) in projections.iter().enumerate() {
                    if sample.causes.iter().any(|cause|matches!(cause,FmsOutputSampleCause::Scheduled {output_index,schedule_index}
                        if Some(*output_index)==projection.output_index && Some(*schedule_index)==projection.schedule_index)) {
                        own[position]=own[position].checked_add(1).context("history projection count overflow")?;
                    }
                }
                let expected_codec = if index.collection == FmsHistoryCollection::Field {
                    "fullmag.runner.field_snapshot_json"
                } else {
                    "fullmag.runner.scalar_csv_row"
                };
                if sample.payload_codec_id != expected_codec || sample.byte_count > leaf_budget {
                    bail!("history leaf codec/budget differs from actual writer");
                }
                let raw = bounded_cas(store, &sample.object_ref, sample.byte_count)?;
                if index.collection == FmsHistoryCollection::Field {
                    fullmag_application::validate_study_history_field(
                        &raw,
                        &index.quantity_id,
                        &index.unit,
                        sample.step,
                        sample.time_s,
                        sample.solver_dt_s,
                        &layout,
                        cells,
                        component_count,
                        leaf_budget,
                    )?;
                } else {
                    fullmag_application::validate_study_history_scalar_row(
                        &raw,
                        sample.step,
                        sample.time_s,
                        sample.solver_dt_s,
                    )?;
                }
            }
        }
        if let Some((_, time)) = group {
            flush(time, &own, group_total, group_final, &mut stats)?;
        }
        for (key, actual) in &replay {
            let cursors = if index.collection == FmsHistoryCollection::Field {
                &coverage.field_schedules
            } else {
                &coverage.scalar_schedules
            };
            let cursor = cursors
                .iter()
                .find(|cursor| (cursor.output_index, cursor.schedule_index) == *key)
                .context("history replay cursor missing")?;
            if cursor.next_time.to_bits() != actual.0.to_bits()
                || cursor.last_sampled_time.map(f64::to_bits) != actual.1.map(f64::to_bits)
            {
                bail!("committed final cursor differs from the existing schedule owner's actual sample transitions");
            }
        }
        actual_final &= stream_final;
        for (projection, actual) in projections.iter().zip(&stats) {
            let same_time = |left: Option<f64>, right: Option<f64>| {
                left.map(f64::to_bits) == right.map(f64::to_bits)
            };
            if projection.sample_count != actual.count
                || !same_time(projection.first_sample_time_s, actual.first)
                || !same_time(projection.last_sample_time_s, actual.last)
            {
                bail!("committed history coverage differs from actual sample causes");
            }
            if projection.collection == FmsHistoryCollection::DefaultScalar {
                default_last = actual.last;
            }
        }
    }
    if !actual_initial
        || !actual_final
        || default_last.map(f64::to_bits)
            != coverage
                .default_scalar_last_sampled_time_s
                .map(f64::to_bits)
    {
        bail!("committed initial/final/default output prefix is incomplete");
    }
    for binding in scalar.iter().chain(&field) {
        if !coverage.streams.iter().any(|entry| {
            entry.output_index == Some(binding.output_index)
                && entry.schedule_index == Some(binding.schedule_index)
                && entry.name == binding.name
        }) {
            bail!("committed history omitted an authored output binding");
        }
    }
    Ok(())
}

pub(crate) fn open_published_terminal_manifest(
    store: &SessionStore,
    accepted: &crate::study::AcceptedStudySnapshot,
    claim: &TaskClaim,
    stage: &str,
    raw: &[u8],
    owner: &FmsArtifactCatalogEntry,
    catalog: &FmsArtifactCatalog,
) -> Result<Option<FmsStudyOutputManifestV4>> {
    if raw.len() as u64 > MAX_TERMINAL_CATALOG_METADATA_BYTES {
        bail!("study manifest exceeds existing control-document budget");
    }
    let header: serde_json::Value = serde_json::from_slice(raw)?;
    if header
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        != Some(FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4)
    {
        return Ok(None);
    }
    let manifest: FmsStudyOutputManifestV4 = serde_json::from_slice(raw)?;
    manifest.validate()?;
    let visited = fullmag_session::validate_terminal_publication_storage(
        raw,
        owner,
        catalog,
        |reference, budget| bounded_cas(store, reference, budget),
    )?;
    let prepared = PreparedTerminalPublicationV4 {
        manifest,
        entries: catalog
            .entries
            .iter()
            .filter(|entry| visited.contains(&entry.artifact_id))
            .cloned()
            .collect(),
    };
    let step = crate::study::cold_accepted_worker_step(
        store,
        accepted,
        stage,
        claim.task_id.as_str(),
        claim.attempt_id.as_str(),
        claim.ownership_epoch.value(),
    )?;
    validate_prepared_terminal_publication(store, &step, &prepared)?;
    Ok(Some(prepared.manifest))
}

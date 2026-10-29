//! Durable adapter between the typed application Submit contract and the
//! session store. Callers must verify and pin the project/study snapshot before
//! invoking this boundary; publication alone does not schedule a worker.

use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use crate::schemas::output_storage::OutputStorageDefaultsRequest;
use fullmag_application::{
    bind_batch_case_output_storage, expand_independent_batch,
    materialize_independent_batch_case, validate_independent_batch_cases, BatchExpansionManifest,
    BatchExpansionRequest, BatchFailurePolicy, FileProjectRepository, ProjectEnvelope,
    ProjectId, ProjectRepository, ProjectSource, RawJsonEnvelope, RunId, RunIntent,
    RunSpecification, SubmitDisposition, SubmitReceipt,
};
use fullmag_authoring::StudyPlan;
use fullmag_plan::{StudyProblemCatalog, StudyStepLoweringStatus};
use fullmag_session::{
    BatchExpansionProgressCommitDisposition, BatchIntentCommitDisposition,
    FmsBatchExpansionProgress, FmsBatchExpansionState, FmsBatchIntent, FmsRunCatalog,
    FmsRunIntent, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskPreparationReceipt,
    FmsTaskReadiness, PreparationReceiptCommitDisposition, RunBacklogFull,
    RunIntentCommitDisposition, SessionStore,
    FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA, FMS_BATCH_SUBMIT_SNAPSHOT_LEGACY_SCHEMA,
    FMS_BATCH_SUBMIT_SNAPSHOT_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
};

pub(crate) const DEFAULT_ACCEPTED_RUN_BACKLOG_LIMIT: usize = 256;
const ACCEPTED_RUN_BACKLOG_LIMIT_ENV: &str = "FULLMAG_ACCEPTED_RUN_BACKLOG_LIMIT";
static LEGACY_BATCHES_WITHOUT_OUTPUT_STORAGE_WARNED: OnceLock<Mutex<BTreeSet<String>>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchSubmitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BatchSubmitReceipt {
    pub disposition: BatchSubmitDisposition,
    pub batch_id: String,
    pub manifest_sha256: String,
    pub case_count: u64,
}

/// Resolve the batch-wide OutputStorage policy once, at Submit. Explicit
/// project policies are interpreted relative to their captured source
/// directory and override workspace defaults; steps without an explicit
/// policy inherit the resolved batch policy. A batch cannot pin conflicting
/// per-step writers or roots.
fn resolve_batch_output_storage_snapshot(
    catalog: &StudyProblemCatalog,
    defaults: &OutputStorageDefaultsRequest,
) -> Result<serde_json::Value> {
    defaults.validate().map_err(anyhow::Error::msg)?;
    let default_settings = fullmag_ir::OutputStorageIR {
        output_dir: Some(defaults.output_parent.clone()),
        temp_dir: defaults.temp_parent.clone(),
        data_format: defaults.data_format.into(),
        cleanup: defaults.cleanup.into(),
        existing_output: defaults.existing_output.into(),
    };
    let supported_formats = fullmag_runner::project_storage::supported_data_formats();
    let mut selected_settings: Option<fullmag_ir::OutputStorageIR> = None;
    let mut authoring_inputs = Vec::new();

    for entry in catalog.entries() {
        let problem = entry.problem();
        let Some(authoring_value) = problem.problem_meta.runtime_metadata.get("output_storage") else {
            continue;
        };
        let source_dir = match problem
            .problem_meta
            .runtime_metadata
            .get("output_storage_source_dir")
        {
            Some(serde_json::Value::String(path)) if !path.trim().is_empty() => {
                Some(PathBuf::from(path))
            }
            Some(_) => bail!(
                "batch step `{}` has invalid output_storage_source_dir metadata",
                entry.step_id()
            ),
            None => None,
        };

        let requested: fullmag_ir::OutputStorageIR =
            serde_json::from_value(authoring_value.clone()).with_context(|| {
                format!(
                    "batch step `{}` has invalid project OutputStorage policy",
                    entry.step_id()
                )
            })?;
        requested
            .validate()
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
            .with_context(|| {
                format!(
                    "batch step `{}` has invalid project OutputStorage paths",
                    entry.step_id()
                )
            })?;
        authoring_inputs.push(serde_json::json!({
            "step_id": entry.step_id(),
            "policy": authoring_value,
            "source_dir": source_dir,
        }));

        let resolve_path = |value: Option<&str>, fallback: Option<&str>| -> Result<Option<String>> {
            let Some(path) = value.or(fallback) else {
                return Ok(None);
            };
            let path = PathBuf::from(path);
            if path.is_absolute() {
                return Ok(Some(path.to_string_lossy().into_owned()));
            }
            let source_dir = source_dir.as_deref().with_context(|| {
                format!(
                    "batch step `{}` has a relative OutputStorage path but no output_storage_source_dir",
                    entry.step_id()
                )
            })?;
            if !source_dir.is_absolute() {
                bail!(
                    "batch step `{}` needs an absolute output_storage_source_dir to resolve `{}`",
                    entry.step_id(),
                    path.display()
                );
            }
            Ok(Some(source_dir.join(path).to_string_lossy().into_owned()))
        };
        let resolved = fullmag_ir::OutputStorageIR {
            output_dir: resolve_path(
                requested.output_dir.as_deref(),
                Some(defaults.output_parent.as_str()),
            )?,
            temp_dir: resolve_path(
                requested.temp_dir.as_deref(),
                defaults.temp_parent.as_deref(),
            )?,
            data_format: requested.data_format,
            cleanup: requested.cleanup,
            existing_output: requested.existing_output,
        };
        resolved
            .validate()
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
            .with_context(|| {
                format!(
                    "batch step `{}` resolved invalid OutputStorage paths",
                    entry.step_id()
                )
            })?;
        if !resolved
            .output_dir
            .as_deref()
            .is_some_and(|path| Path::new(path).is_absolute())
            || resolved
                .temp_dir
                .as_deref()
                .is_some_and(|path| !Path::new(path).is_absolute())
        {
            bail!(
                "batch step `{}` did not resolve OutputStorage paths to absolute paths",
                entry.step_id()
            );
        }
        if selected_settings
            .as_ref()
            .is_some_and(|selected| selected != &resolved)
        {
            bail!(
                "batch steps resolve to conflicting OutputStorage policies; one batch-wide snapshot is required"
            );
        }
        selected_settings.get_or_insert(resolved);
    }

    let resolved = selected_settings.unwrap_or(default_settings);
    if !supported_formats.contains(&resolved.data_format) {
        bail!(
            "batch requests unsupported OutputStorage format {:?}",
            resolved.data_format
        );
    }
    let expected_autosave = match resolved.data_format {
        fullmag_ir::OutputDataFormatIR::Zarr => fullmag_ir::AutosaveFormatIR::Zarr,
        fullmag_ir::OutputDataFormatIR::Hdf5 => fullmag_ir::AutosaveFormatIR::Hdf5,
    };
    for entry in catalog.entries() {
        if entry
            .problem()
            .study
            .sampling()
            .stage_autosave
            .as_ref()
            .is_some_and(|policy| policy.format != expected_autosave)
        {
            bail!(
                "batch step `{}` stage format conflicts with resolved OutputStorage; no batch was accepted",
                entry.step_id()
            );
        }
    }
    let settings = serde_json::to_value(&resolved)?;
    let defaults_value = serde_json::to_value(defaults)?;
    let source = if authoring_inputs.is_empty() {
        "workspace_defaults"
    } else {
        "project_authoring"
    };
    let mut snapshot = serde_json::json!({
        "schema_version": FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA,
        "source": source,
        "settings_sha256": fullmag_session::canonical_json_sha256(&settings),
        "workspace_defaults_sha256": fullmag_session::canonical_json_sha256(&defaults_value),
        "settings": settings
    });
    if !authoring_inputs.is_empty() {
        snapshot["authoring_policy_sha256"] = serde_json::json!(
            fullmag_session::canonical_json_sha256(&serde_json::Value::Array(authoring_inputs))
        );
    }
    Ok(snapshot)
}

pub(crate) fn configured_submit_backlog_limit() -> Result<NonZeroUsize> {
    let value = match std::env::var(ACCEPTED_RUN_BACKLOG_LIMIT_ENV) {
        Ok(raw) => raw.parse::<usize>().with_context(|| {
            format!("{ACCEPTED_RUN_BACKLOG_LIMIT_ENV} must be a positive integer")
        })?,
        Err(std::env::VarError::NotPresent) => DEFAULT_ACCEPTED_RUN_BACKLOG_LIMIT,
        Err(error) => {
            return Err(error).with_context(|| {
                format!("read {ACCEPTED_RUN_BACKLOG_LIMIT_ENV} from the process environment")
            })
        }
    };
    NonZeroUsize::new(value)
        .with_context(|| format!("{ACCEPTED_RUN_BACKLOG_LIMIT_ENV} must be greater than zero"))
}

pub(crate) use fullmag_runtime_control::accepted_store::configured_submit_store_root;
#[cfg(test)]
use fullmag_runtime_control::accepted_store::submit_store_root_for_layout;

/// Resolve one exact portable project archive before accepting a durable run.
/// `asset_paths` is an explicit ID-to-archive-path binding supplied by the
/// caller; a display name, live session or mutable cache is never a source.
pub(crate) fn commit_archived_run_intent(
    store: &SessionStore,
    intent: &RunIntent,
    archive_bytes: &[u8],
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_paths: &BTreeMap<String, String>,
) -> Result<SubmitReceipt> {
    commit_archived_run_intent_with_optional_backlog_limit(
        store,
        intent,
        archive_bytes,
        study,
        catalog,
        asset_paths,
        None,
    )
}

pub(crate) fn commit_archived_run_intent_with_backlog_limit(
    store: &SessionStore,
    intent: &RunIntent,
    archive_bytes: &[u8],
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_paths: &BTreeMap<String, String>,
    backlog_limit: NonZeroUsize,
) -> Result<SubmitReceipt> {
    commit_archived_run_intent_with_optional_backlog_limit(
        store,
        intent,
        archive_bytes,
        study,
        catalog,
        asset_paths,
        Some(backlog_limit),
    )
}

fn commit_archived_run_intent_with_optional_backlog_limit(
    store: &SessionStore,
    intent: &RunIntent,
    archive_bytes: &[u8],
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_paths: &BTreeMap<String, String>,
    backlog_limit: Option<NonZeroUsize>,
) -> Result<SubmitReceipt> {
    let opened = FileProjectRepository::new()
        .open(ProjectSource::Bytes {
            display_name: "submitted-project.fms".into(),
            bytes: archive_bytes.to_vec(),
        })
        .context("open exact submitted project archive")?;
    if opened.read_only_reason.is_some() || !opened.migration.can_write {
        bail!("submitted project archive is not writable");
    }
    if asset_paths.len() != intent.specification.immutable_assets.len() {
        bail!("asset path binding count does not match immutable run assets");
    }
    let mut asset_payloads = BTreeMap::new();
    for asset in &intent.specification.immutable_assets {
        let path = asset_paths
            .get(&asset.asset_id)
            .with_context(|| format!("missing path binding for asset `{}`", asset.asset_id))?;
        let bytes = opened
            .envelope
            .assets
            .iter()
            .find(|candidate| candidate.path() == path)
            .with_context(|| {
                format!(
                    "asset `{}` path `{path}` is absent from archive",
                    asset.asset_id
                )
            })?
            .bytes()
            .to_vec();
        asset_payloads.insert(asset.asset_id.clone(), bytes);
    }
    commit_validated_run_intent_with_optional_backlog_limit(
        store,
        intent,
        &opened.envelope,
        study,
        catalog,
        &asset_payloads,
        backlog_limit,
    )
}

pub(crate) fn commit_validated_run_intent(
    store: &SessionStore,
    intent: &RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<SubmitReceipt> {
    commit_validated_run_intent_with_optional_backlog_limit(
        store,
        intent,
        definition,
        study,
        catalog,
        asset_payloads,
        None,
    )
}

pub(crate) fn commit_validated_run_intent_with_backlog_limit(
    store: &SessionStore,
    intent: &RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: &BTreeMap<String, Vec<u8>>,
    backlog_limit: NonZeroUsize,
) -> Result<SubmitReceipt> {
    commit_validated_run_intent_with_optional_backlog_limit(
        store,
        intent,
        definition,
        study,
        catalog,
        asset_payloads,
        Some(backlog_limit),
    )
}

/// Publish a RunIntent that was fully validated and canonicalized during the
/// accepted-run preparation phase. The opaque payload binds the typed intent
/// to the exact bytes that this transaction stores; mutable store admission,
/// backlog, and idempotency checks remain inside the single writer lease.
pub(crate) fn commit_prepared_run_intent_with_backlog_limit(
    store: &SessionStore,
    prepared: &PreparedRunIntentCommit<'_>,
    backlog_limit: NonZeroUsize,
) -> Result<SubmitReceipt> {
    commit_prepared_run_intent_with_optional_backlog_limit(
        store,
        prepared,
        Some(backlog_limit),
    )
}

enum CommitAssetPayloads<'a> {
    Borrowed(&'a BTreeMap<String, Vec<u8>>),
    Owned(BTreeMap<String, Vec<u8>>),
}

impl CommitAssetPayloads<'_> {
    fn as_map(&self) -> &BTreeMap<String, Vec<u8>> {
        match self {
            Self::Borrowed(payloads) => payloads,
            Self::Owned(payloads) => payloads,
        }
    }
}

/// A private, immutable handoff from accepted-run preparation to durable
/// publication. Construction validates the typed intent and all planner
/// inputs, then binds them to the exact canonical bytes that commit will store.
/// Its fields stay private so callers cannot substitute an intent, catalog, or
/// byte payload independently after validation.
pub(crate) struct PreparedRunIntentCommit<'a> {
    durable_intent: FmsRunIntent,
    run_id: RunId,
    payload_fingerprint: String,
    definition_sha256: String,
    study_sha256: String,
    catalog_sha256: String,
    definition_bytes: Vec<u8>,
    study_bytes: Vec<u8>,
    catalog_bytes: Vec<u8>,
    asset_payloads: CommitAssetPayloads<'a>,
}

/// Prepare the expensive accepted RunIntent checks outside the live-session
/// transition. The returned payload owns the canonical definition, study,
/// catalog, and immutable asset bytes that the later commit publishes.
pub(crate) fn prepare_owned_run_intent_commit(
    intent: RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: BTreeMap<String, Vec<u8>>,
) -> Result<PreparedRunIntentCommit<'static>> {
    prepare_run_intent_commit(
        intent,
        definition,
        study,
        catalog,
        CommitAssetPayloads::Owned(asset_payloads),
    )
}

fn prepare_borrowed_run_intent_commit<'a>(
    intent: &RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: &'a BTreeMap<String, Vec<u8>>,
) -> Result<PreparedRunIntentCommit<'a>> {
    prepare_run_intent_commit(
        intent.clone(),
        definition,
        study,
        catalog,
        CommitAssetPayloads::Borrowed(asset_payloads),
    )
}

fn validate_accepted_document_sizes(definition: &[u8], study: &[u8], catalog: &[u8]) -> Result<()> {
    for (label, bytes, maximum) in [
        ("definition", definition, fullmag_runtime_control::MAX_ACCEPTED_MODEL_DOCUMENT_BYTES),
        ("Study plan", study, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES),
        ("Study catalog", catalog, fullmag_runtime_control::MAX_ACCEPTED_MODEL_DOCUMENT_BYTES),
    ] {
        if bytes.len() as u64 > maximum {
            bail!("accepted {label} requires {} bytes; its decode budget is {maximum} bytes", bytes.len());
        }
    }
    Ok(())
}

fn prepare_run_intent_commit<'a>(
    intent: RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: CommitAssetPayloads<'a>,
) -> Result<PreparedRunIntentCommit<'a>> {
    intent.validate().context("validate typed run intent")?;
    intent.specification.snapshot.verify_envelope(definition)?;
    study
        .validate_for_execution()
        .context("validate typed study plan")?;
    if intent.specification.study.study_id.as_str() != study.study_id
        || intent.specification.study.plan_version != study.schema_version
        || intent.specification.study.plan_sha256 != study.canonical_sha256()?
    {
        bail!("run study reference does not match the exact typed study plan");
    }
    catalog
        .validate_for(study)
        .context("validate immutable study problem catalog")?;
    for entry in catalog.entries() {
        if let Some(materialization) = entry.execution_materialization() {
            fullmag_application::validate_execution_materialization(materialization)
                .map_err(anyhow::Error::msg)
                .with_context(|| {
                    format!(
                        "study step `{}` has invalid execution profile provenance",
                        entry.step_id()
                    )
                })?;
        }
    }
    let execution_plan = fullmag_plan::lower_study_plan_with_catalog(study, catalog)
        .context("lower immutable submission through the canonical planner")?;
    fullmag_runtime_control::validate_requested_execution(
        &intent.specification,
        catalog,
        &execution_plan,
    )
    .context("validate execution requests before publishing the run")?;

    let definition_bytes = definition.raw_definition.raw_bytes().to_vec();
    let definition_sha256 = fullmag_session::hex_sha256(&definition_bytes);
    if definition_sha256 != intent.specification.snapshot.definition_sha256 {
        bail!("stored definition object differs from run snapshot digest");
    }
    let study_bytes = study.canonical_json_bytes()?;
    let study_sha256 = fullmag_session::hex_sha256(&study_bytes);
    if study_sha256 != intent.specification.study.plan_sha256 {
        bail!("stored study object differs from run plan digest");
    }
    let catalog_value = serde_json::to_value(catalog)?;
    let catalog_bytes = fullmag_session::canonical_json_bytes(&catalog_value);
    validate_accepted_document_sizes(&definition_bytes, &study_bytes, &catalog_bytes)?;
    let catalog_sha256 = fullmag_session::hex_sha256(&catalog_bytes);
    if intent.specification.study_catalog_sha256 != catalog_sha256 {
        bail!("run study catalog digest does not match immutable planner inputs");
    }

    let asset_payload_map = asset_payloads.as_map();
    if asset_payload_map.len() != intent.specification.immutable_assets.len() {
        bail!("run asset payload count does not match immutable asset references");
    }
    for asset in &intent.specification.immutable_assets {
        let payload = asset_payload_map
            .get(&asset.asset_id)
            .with_context(|| format!("missing immutable asset `{}`", asset.asset_id))?;
        if fullmag_session::hex_sha256(payload) != asset.content_sha256 {
            bail!(
                "immutable asset `{}` digest differs from run specification",
                asset.asset_id
            );
        }
    }
    if study.schema_version == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4 {
        let bytes = asset_payload_map
            .get(fullmag_application::SCRIPT_PIPELINE_SOURCE_ASSET_ID)
            .context("v4 Submit requires captured compiler source")?;
        let source = fullmag_application::validate_accepted_script_pipeline_source(
            study, catalog, bytes,
        )?;
        fullmag_application::validate_script_source_assets(
            &intent.specification,
            &source,
            |hash, maximum| {
                let reference = intent
                    .specification
                    .immutable_assets
                    .iter()
                    .find(|asset| asset.content_sha256 == hash)
                    .context("captured source ref missing")?;
                let bytes = asset_payload_map
                    .get(&reference.asset_id)
                    .context("captured source bytes missing")?;
                if bytes.len() as u64 > maximum {
                    bail!("captured source byte bound differs from Submit bytes");
                }
                Ok(bytes.clone())
            },
        )?;
    }

    let payload_fingerprint = intent.payload_fingerprint()?;
    let specification = serde_json::to_value(&intent.specification)?;
    let durable_intent = FmsRunIntent::new(
        intent.specification.run_id.as_str(),
        &intent.idempotency_key,
        specification,
    );
    if durable_intent.payload_sha256 != payload_fingerprint {
        bail!("application and durable run specification fingerprints differ");
    }
    durable_intent
        .validate()
        .context("validate durable run intent envelope")?;

    Ok(PreparedRunIntentCommit {
        durable_intent,
        run_id: intent.specification.run_id,
        payload_fingerprint,
        definition_sha256,
        study_sha256,
        catalog_sha256,
        definition_bytes,
        study_bytes,
        catalog_bytes,
        asset_payloads,
    })
}

fn commit_validated_run_intent_with_optional_backlog_limit(
    store: &SessionStore,
    intent: &RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: &BTreeMap<String, Vec<u8>>,
    backlog_limit: Option<NonZeroUsize>,
) -> Result<SubmitReceipt> {
    let prepared = prepare_borrowed_run_intent_commit(
        intent,
        definition,
        study,
        catalog,
        asset_payloads,
    )?;
    commit_prepared_run_intent_with_optional_backlog_limit(store, &prepared, backlog_limit)
}

fn commit_prepared_run_intent_with_optional_backlog_limit(
    store: &SessionStore,
    prepared: &PreparedRunIntentCommit<'_>,
    backlog_limit: Option<NonZeroUsize>,
) -> Result<SubmitReceipt> {
    // Every store mutation below (CAS blobs, intent publication, replay
    // verification) must belong to ONE writer lease.  The lease is re-entrant
    // on this thread, but separate short leases let two concurrent identical
    // submits interleave and make each other fail with `StoreWriterBusy`, so
    // that neither is accepted.  Holding one lease serializes the whole
    // publication: exactly one submit wins and the other observes either the
    // busy conflict or the committed intent as an idempotent replay.
    // Runtime publishers and schedulers use the same native descriptor.  Only
    // acquisition is retryable: once this lease is held, every CAS and intent
    // mutation below stays inside this one transaction and no post-publication
    // retry can duplicate or reorder a partially committed submission.
    let _publication_lease =
        fullmag_runtime_control::retry_store_writer_busy(|| store.write_transaction())?;
    let definition_object_ref = store.store_blob(&prepared.definition_bytes)?;
    if definition_object_ref != prepared.definition_sha256 {
        bail!("stored definition object differs from run snapshot digest");
    }
    let study_object_ref = store.store_blob(&prepared.study_bytes)?;
    if study_object_ref != prepared.study_sha256 {
        bail!("stored study object differs from run plan digest");
    }
    let study_catalog_object_ref = store.store_blob(&prepared.catalog_bytes)?;
    if study_catalog_object_ref != prepared.catalog_sha256 {
        bail!("stored study catalog differs from run catalog digest");
    }
    let mut asset_object_refs = BTreeMap::new();
    for (asset_id, payload) in prepared.asset_payloads.as_map() {
        asset_object_refs.insert(asset_id.clone(), store.store_blob(payload)?);
    }
    let payload_fingerprint = prepared.payload_fingerprint.as_str();
    let mut durable = prepared.durable_intent.clone();
    durable.accepted_at = Utc::now();
    durable.definition_object_ref = Some(definition_object_ref.clone());
    durable.study_object_ref = Some(study_object_ref.clone());
    durable.study_catalog_object_ref = Some(study_catalog_object_ref.clone());
    durable.asset_object_refs = asset_object_refs.clone();
    if durable.payload_sha256 != payload_fingerprint {
        bail!("application and durable run specification fingerprints differ");
    }
    let disposition = match backlog_limit {
        Some(limit) => store.commit_run_intent_with_backlog_limit(&durable, limit)?,
        None => store.commit_run_intent(&durable)?,
    };
    let (disposition, run_id) = match disposition {
        RunIntentCommitDisposition::Accepted => (
            SubmitDisposition::Accepted,
            prepared.run_id.clone(),
        ),
        RunIntentCommitDisposition::Replayed { run_id } => {
            let original = store
                .read_run_intent(&run_id)?
                .context("replayed run intent is missing")?;
            if original.definition_object_ref.as_deref() != Some(definition_object_ref.as_str()) {
                bail!("replayed run definition object differs from submitted snapshot");
            }
            if original.study_object_ref.as_deref() != Some(study_object_ref.as_str()) {
                bail!("replayed run study object differs from submitted plan");
            }
            if original.study_catalog_object_ref.as_deref()
                != Some(study_catalog_object_ref.as_str())
            {
                bail!("replayed run study catalog differs from submitted planner inputs");
            }
            if original.asset_object_refs != asset_object_refs {
                bail!("replayed run assets differ from submitted immutable payloads");
            }
            let original_specification: RunSpecification =
                serde_json::from_value(original.specification)
                    .context("replayed run specification is not typed")?;
            if original_specification.fingerprint()? != payload_fingerprint {
                bail!("replayed run specification fingerprint differs from submitted intent");
            }
            (SubmitDisposition::Replayed, RunId::parse(run_id)?)
        }
    };
    Ok(SubmitReceipt {
        disposition,
        run_id,
        payload_fingerprint: payload_fingerprint.to_owned(),
    })
}

/// Validate and durably accept one immutable independent-batch parent.
/// Acceptance pins the exact expansion manifest and all source inputs before
/// ACK; it also pins OutputStorage resolved from project authoring and
/// workspace defaults for a new Submit. It does not publish child run intents
/// or start execution.
pub(crate) fn commit_archived_batch_intent(
    store: &SessionStore,
    expected_project_id: &ProjectId,
    idempotency_key: &str,
    request: &BatchExpansionRequest,
    archive_bytes: &[u8],
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_paths: &BTreeMap<String, String>,
    output_storage_defaults: Option<OutputStorageDefaultsRequest>,
) -> Result<BatchSubmitReceipt> {
    let existing_intent = store
        .find_batch_intent(idempotency_key)
        .context("look up prior batch Submit for idempotent replay")?;
    request.template.validate().context("validate batch template RunSpec")?;
    if request.template.snapshot.project_id != *expected_project_id {
        bail!("batch template project_id differs from request path");
    }
    let opened = FileProjectRepository::new()
        .open(ProjectSource::Bytes {
            display_name: "submitted-batch-project.fms".into(),
            bytes: archive_bytes.to_vec(),
        })
        .context("open exact submitted batch project archive")?;
    if opened.read_only_reason.is_some() || !opened.migration.can_write {
        bail!("submitted batch project archive is not writable");
    }
    request
        .template
        .snapshot
        .verify_envelope(&opened.envelope)
        .context("verify batch template against exact project definition")?;
    if asset_paths.len() != request.template.immutable_assets.len() {
        bail!("batch asset path binding count does not match immutable assets");
    }
    study
        .validate_for_execution()
        .context("validate typed batch StudyPlan")?;
    if request.template.study.study_id.as_str() != study.study_id
        || request.template.study.plan_version != study.schema_version
        || request.template.study.plan_sha256 != study.canonical_sha256()?
    {
        bail!("batch template Study reference does not match the exact StudyPlan");
    }
    catalog
        .validate_for(study)
        .context("validate immutable batch StudyProblemCatalog")?;
    for entry in catalog.entries() {
        if let Some(materialization) = entry.execution_materialization() {
            fullmag_application::validate_execution_materialization(materialization)
                .map_err(anyhow::Error::msg)
                .with_context(|| {
                    format!(
                        "study step `{}` has invalid execution profile provenance",
                        entry.step_id()
                    )
                })?;
        }
    }
    let catalog_value = serde_json::to_value(catalog)?;
    let catalog_digest = fullmag_session::canonical_json_sha256(&catalog_value);
    if request.template.study_catalog_sha256 != catalog_digest {
        bail!("batch template Study catalog digest does not match planner inputs");
    }
    let source_plan = fullmag_plan::lower_study_plan_with_catalog(study, catalog)
        .context("lower batch template through the canonical planner")?;
    fullmag_runtime_control::validate_requested_execution(
        &request.template,
        catalog,
        &source_plan,
    )
    .context("validate batch template execution request")?;

    let mut asset_payloads = BTreeMap::new();
    for asset in &request.template.immutable_assets {
        let path = asset_paths
            .get(&asset.asset_id)
            .with_context(|| format!("missing batch asset path for `{}`", asset.asset_id))?;
        let payload = opened
            .envelope
            .assets
            .iter()
            .find(|candidate| candidate.path() == path)
            .with_context(|| {
                format!(
                    "batch asset `{}` path `{path}` is absent from archive",
                    asset.asset_id
                )
            })?
            .bytes()
            .to_vec();
        if fullmag_session::hex_sha256(&payload) != asset.content_sha256 {
            bail!("batch asset `{}` digest differs from template", asset.asset_id);
        }
        asset_payloads.insert(asset.asset_id.clone(), payload);
    }

    let manifest = expand_independent_batch(request.clone())
        .map_err(anyhow::Error::msg)
        .context("expand independent batch cases")?;
    // Validate every case against its own typed Study/catalog before the
    // durable parent is published. The immutable manifest keeps source refs;
    // the background expander will deterministically recreate these cases.
    validate_independent_batch_cases(&manifest, study, catalog, |materialized| {
        fullmag_runtime_control::validate_requested_execution(
            &materialized.specification,
            &materialized.catalog,
            &materialized.execution_plan,
        )
        .map_err(|error| {
            format!(
                "case `{}` execution request is invalid: {error:#}",
                materialized.case_id
            )
        })
    })
    .map_err(anyhow::Error::msg)
    .context("validate all materialized batch cases")?;

    let definition_bytes = opened.envelope.raw_definition.raw_bytes();
    let study_bytes = study.canonical_json_bytes()?;
    let catalog_bytes = fullmag_session::canonical_json_bytes(&catalog_value);
    validate_accepted_document_sizes(definition_bytes, &study_bytes, &catalog_bytes)?;
    let (snapshot_schema, output_storage_snapshot) = if let Some(existing) = existing_intent {
        let schema = existing
            .specification
            .get("schema_version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(FMS_BATCH_SUBMIT_SNAPSHOT_LEGACY_SCHEMA)
            .to_string();
        (schema, existing.specification.get("output_storage").cloned())
    } else {
        let defaults = output_storage_defaults
            .context("new batch Submit requires resolved OutputStorage defaults")?;
        let output_storage_snapshot = resolve_batch_output_storage_snapshot(catalog, &defaults)?;
        (
            FMS_BATCH_SUBMIT_SNAPSHOT_SCHEMA.to_string(),
            Some(output_storage_snapshot),
        )
    };
    let _publication_lease =
        fullmag_runtime_control::retry_store_writer_busy(|| store.write_transaction())?;
    let definition_object_ref = store.store_blob(definition_bytes)?;
    if definition_object_ref != request.template.snapshot.definition_sha256 {
        bail!("stored batch definition differs from template snapshot digest");
    }
    let study_object_ref = store.store_blob(&study_bytes)?;
    if study_object_ref != request.template.study.plan_sha256 {
        bail!("stored batch Study differs from template plan digest");
    }
    let study_catalog_object_ref = store.store_blob(&catalog_bytes)?;
    if study_catalog_object_ref != request.template.study_catalog_sha256 {
        bail!("stored batch catalog differs from template catalog digest");
    }
    let mut asset_object_refs = BTreeMap::new();
    for (asset_id, payload) in &asset_payloads {
        asset_object_refs.insert(asset_id.clone(), store.store_blob(payload)?);
    }
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    let manifest_object_ref = store.store_blob(&manifest_bytes)?;
    let mut snapshot = serde_json::json!({
        "schema_version": snapshot_schema,
        "batch_id": request.batch_id,
        "manifest_sha256": manifest.manifest_sha256,
        "request": serde_json::to_value(request)?
    });
    if let Some(output_storage_snapshot) = output_storage_snapshot {
        snapshot["output_storage"] = output_storage_snapshot;
    }
    let durable = FmsBatchIntent::new(
        request.batch_id.clone(),
        idempotency_key,
        snapshot,
        manifest_object_ref,
        definition_object_ref,
        study_object_ref,
        study_catalog_object_ref,
        asset_object_refs,
    );
    let disposition = match store.commit_batch_intent(&durable)? {
        BatchIntentCommitDisposition::Accepted => BatchSubmitDisposition::Accepted,
        BatchIntentCommitDisposition::Replayed { .. } => BatchSubmitDisposition::Replayed,
    };
    if store
        .read_batch_expansion_progress(&request.batch_id)?
        .is_none()
    {
        let initial_progress = FmsBatchExpansionProgress::new(
            &durable,
            u64::try_from(manifest.cases.len())?,
            0,
            1,
        )?;
        store.commit_batch_expansion_progress(0, &initial_progress)?;
    }
    Ok(BatchSubmitReceipt {
        disposition,
        batch_id: manifest.batch_id,
        manifest_sha256: manifest.manifest_sha256,
        case_count: u64::try_from(manifest.cases.len())?,
    })
}

/// Recover and publish a bounded number of deterministic child runs from
/// accepted batch parents. Each child intent is committed before its cursor
/// advances, so a restart between those writes replays the same child safely.
pub(crate) fn expand_pending_batch_children(
    store: &SessionStore,
    child_budget: usize,
    backlog_limit: NonZeroUsize,
) -> Result<usize> {
    if child_budget == 0 {
        return Ok(0);
    }

    let mut intents = store.list_batch_intents()?;
    let intent_count = intents.len();
    if intent_count == 0 {
        return Ok(0);
    }
    let progress_sequence_sum = intents.iter().try_fold(0u64, |sum, intent| {
        let sequence = store
            .read_batch_expansion_progress(&intent.batch_id)?
            .map_or(1, |progress| progress.sequence);
        Ok::<_, anyhow::Error>(sum.wrapping_add(sequence))
    })?;
    // The total committed sequence advances with each published child. Use it
    // as a durable round-robin start cursor so a budget smaller than the
    // number of parents rotates across scheduler polls, even after restart.
    let rotation = fair_batch_rotation_start(progress_sequence_sum, intent_count);
    intents.rotate_left(rotation);

    let mut published = 0usize;
    for (intent_index, intent) in intents.into_iter().enumerate() {
        if published >= child_budget {
            break;
        }
        let remaining_batches = intent_count - intent_index;
        let batch_budget = fair_batch_child_budget(
            child_budget - published,
            remaining_batches,
        );
        let batch_published_start = published;
        if intent.specification.get("output_storage").is_none() {
            let warned = LEGACY_BATCHES_WITHOUT_OUTPUT_STORAGE_WARNED
                .get_or_init(|| Mutex::new(BTreeSet::new()))
                .lock()
                .map(|mut warned| warned.insert(intent.batch_id.clone()))
                .unwrap_or(true);
            if warned {
                tracing::warn!(
                    batch_id = %intent.batch_id,
                    "skipping legacy batch expansion without a pinned OutputStorage snapshot"
                );
            }
            continue;
        }

        let manifest_bytes = store
            .cas()
            .get(&intent.manifest_object_ref)?
            .context("accepted batch expansion manifest is missing")?;
        intent.validate_manifest_bytes(&manifest_bytes)?;
        let manifest: BatchExpansionManifest = serde_json::from_slice(&manifest_bytes)
            .context("decode accepted batch expansion manifest")?;
        manifest
            .validate_integrity()
            .map_err(anyhow::Error::msg)
            .context("validate accepted batch expansion manifest")?;
        if manifest.manifest_sha256
            != intent
                .specification
                .get("manifest_sha256")
                .and_then(serde_json::Value::as_str)
                .context("accepted batch snapshot has no manifest digest")?
        {
            bail!("accepted batch manifest digest differs from its snapshot");
        }

        let total_cases = u64::try_from(manifest.cases.len())?;
        let mut progress = match store.read_batch_expansion_progress(&intent.batch_id)? {
            Some(progress) => progress,
            None => {
                let initial = FmsBatchExpansionProgress::new(&intent, total_cases, 0, 1)?;
                store.commit_batch_expansion_progress(0, &initial)?;
                initial
            }
        };
        if progress.total_cases != total_cases
            || progress.manifest_sha256 != manifest.manifest_sha256
            || progress.manifest_object_ref != intent.manifest_object_ref
        {
            bail!("accepted batch expansion cursor differs from its immutable manifest");
        }
        if matches!(
            progress.state,
            FmsBatchExpansionState::Complete
                | FmsBatchExpansionState::Stopped
                | FmsBatchExpansionState::Paused
                | FmsBatchExpansionState::Cancelled
        ) {
            continue;
        }

        let definition_bytes = store
            .cas()
            .get(&intent.definition_object_ref)?
            .context("accepted batch project definition is missing")?;
        let definition = project_envelope_from_accepted_definition(&definition_bytes)?;
        let study_bytes = store
            .cas()
            .get(&intent.study_object_ref)?
            .context("accepted batch StudyPlan is missing")?;
        let study: StudyPlan = serde_json::from_slice(&study_bytes)
            .context("decode accepted batch StudyPlan")?;
        let catalog_bytes = store
            .cas()
            .get(&intent.study_catalog_object_ref)?
            .context("accepted batch StudyProblemCatalog is missing")?;
        let catalog: StudyProblemCatalog = serde_json::from_slice(&catalog_bytes)
            .context("decode accepted batch StudyProblemCatalog")?;
        catalog
            .validate_for(&study)
            .context("validate accepted batch StudyProblemCatalog")?;
        let output_storage = batch_output_storage_policy(&intent)?;
        let asset_payloads = accepted_batch_asset_payloads(store, &intent)?;

        while progress.next_case_index < total_cases
            && published < child_budget
            && published - batch_published_start < batch_budget
        {
            if manifest.failure_policy == BatchFailurePolicy::StopAdmission
                && batch_has_terminal_non_success_case(
                    store,
                    &manifest,
                    progress.next_case_index,
                )?
            {
                let next_sequence = progress
                    .sequence
                    .checked_add(1)
                    .context("batch expansion sequence overflow")?;
                let stopped = FmsBatchExpansionProgress::new_stopped(
                    &intent,
                    total_cases,
                    progress.next_case_index,
                    next_sequence,
                )?;
                let mut stopped = stopped;
                stopped.commands = progress.commands.clone();
                stopped.validate_for_manifest(&intent, &manifest_bytes)?;
                match store.commit_batch_expansion_progress(progress.sequence, &stopped) {
                    Ok(BatchExpansionProgressCommitDisposition::Accepted)
                    | Ok(BatchExpansionProgressCommitDisposition::Replayed) => {}
                    Err(error) => {
                        let latest = store
                            .read_batch_expansion_progress(&intent.batch_id)?
                            .context("batch expansion cursor disappeared after stop")?;
                        if latest.state != FmsBatchExpansionState::Stopped
                            || latest.next_case_index != progress.next_case_index
                        {
                            return Err(error).context("stop batch expansion after case failure");
                        }
                    }
                }
                break;
            }

            if let Some(max_parallel_cases) = manifest.max_parallel_cases {
                let active_cases = active_published_batch_case_count(
                    store,
                    &manifest,
                    progress.next_case_index,
                )?;
                if active_cases >= max_parallel_cases as usize {
                    break;
                }
            }

            let case_index = usize::try_from(progress.next_case_index)?;
            let case = manifest
                .cases
                .get(case_index)
                .context("batch cursor points past the last expansion case")?;
            let mut case_manifest = manifest.clone();
            let materialized = materialize_independent_batch_case(
                &mut case_manifest,
                &case.case_id,
                &study,
                &catalog,
            )
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("materialize batch case `{}`", case.case_id))?;
            let materialized = bind_batch_case_output_storage(&materialized, &output_storage)
                .map_err(anyhow::Error::msg)
                .with_context(|| {
                    format!("bind OutputStorage to batch case `{}`", case.case_id)
                })?;
            if materialized.specification.run_id != case.specification.run_id
                || materialized.specification.snapshot.project_id
                    != manifest.cases[case_index].specification.snapshot.project_id
            {
                bail!("materialized batch case identity differs from its accepted manifest");
            }

            let child_intent = RunIntent::new(
                batch_case_idempotency_key(&intent.batch_id, &case.case_id),
                materialized.specification,
            );
            // The same writer lease protects the command gate, durable child
            // publication, and cursor advance. A command ACK therefore means
            // no later case can slip through this admission boundary.
            let _publication = store.write_transaction()?;
            let latest_progress = store
                .read_batch_expansion_progress(&intent.batch_id)?
                .context("accepted batch expansion cursor disappeared before child publication")?;
            if latest_progress.sequence != progress.sequence
                || latest_progress.next_case_index != progress.next_case_index
                || latest_progress.state != progress.state
            {
                progress = latest_progress;
                if matches!(
                    progress.state,
                    FmsBatchExpansionState::Complete
                        | FmsBatchExpansionState::Stopped
                        | FmsBatchExpansionState::Paused
                        | FmsBatchExpansionState::Cancelled
                ) {
                    break;
                }
                continue;
            }
            let receipt = match commit_validated_run_intent_with_backlog_limit(
                store,
                &child_intent,
                &definition,
                &materialized.study,
                &materialized.catalog,
                &asset_payloads,
                backlog_limit,
            ) {
                Ok(receipt) => receipt,
                Err(error) if error.downcast_ref::<RunBacklogFull>().is_some() => {
                    return Ok(published);
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("publish child run for batch case `{}`", case.case_id)
                    })
                }
            };
            if receipt.run_id != case.specification.run_id {
                bail!("published child run ID differs from its accepted batch case");
            }

            let next_index = progress
                .next_case_index
                .checked_add(1)
                .context("batch expansion cursor overflow")?;
            let next_sequence = progress
                .sequence
                .checked_add(1)
                .context("batch expansion sequence overflow")?;
            let mut next_progress =
                FmsBatchExpansionProgress::new(&intent, total_cases, next_index, next_sequence)?;
            next_progress.commands = progress.commands.clone();
            next_progress.validate_for_manifest(&intent, &manifest_bytes)?;
            match store.commit_batch_expansion_progress(progress.sequence, &next_progress) {
                Ok(BatchExpansionProgressCommitDisposition::Accepted)
                | Ok(BatchExpansionProgressCommitDisposition::Replayed) => {
                    progress = next_progress;
                }
                Err(error) => {
                    let latest = store
                        .read_batch_expansion_progress(&intent.batch_id)?
                        .context("batch expansion cursor disappeared after publication")?;
                    if latest.next_case_index < next_index {
                        return Err(error).context("advance accepted batch expansion cursor");
                    }
                    progress = latest;
                }
            }
            published = published
                .checked_add(1)
                .context("batch child publication count overflow")?;
        }
    }
    Ok(published)
}

fn fair_batch_rotation_start(progress_sequence_sum: u64, batch_count: usize) -> usize {
    if batch_count == 0 {
        return 0;
    }
    (progress_sequence_sum % batch_count as u64) as usize
}

fn fair_batch_child_budget(remaining_budget: usize, remaining_batches: usize) -> usize {
    if remaining_budget == 0 || remaining_batches == 0 {
        return 0;
    }
    let quotient = remaining_budget / remaining_batches;
    if remaining_budget % remaining_batches == 0 {
        quotient
    } else {
        quotient + 1
    }
}

fn batch_has_terminal_non_success_case(
    store: &SessionStore,
    manifest: &BatchExpansionManifest,
    published_prefix: u64,
) -> Result<bool> {
    for case in manifest.cases.iter().take(usize::try_from(published_prefix)?) {
        let run_id = case.specification.run_id.as_str();
        if store.read_run_intent(run_id)?.is_none() {
            bail!(
                "batch expansion cursor includes case `{}` without a durable child run",
                case.case_id
            );
        }
        let Some(catalog) = store.read_run_catalog(run_id)? else {
            continue;
        };
        if catalog.tasks.iter().any(|task| {
            matches!(
                task.lifecycle,
                FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            )
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn project_envelope_from_accepted_definition(bytes: &[u8]) -> Result<ProjectEnvelope> {
    let raw_definition = RawJsonEnvelope::from_bytes(bytes.to_vec())
        .map_err(anyhow::Error::msg)
        .context("decode accepted project definition envelope")?;
    let value = raw_definition.value();
    let object = value
        .as_object()
        .context("accepted project definition is not a JSON object")?;
    let project_id = ProjectId::parse(
        object
            .get("project_id")
            .and_then(serde_json::Value::as_str)
            .context("accepted project definition has no project_id")?,
    )
    .map_err(anyhow::Error::msg)?;
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .context("accepted project definition has no name")?;
    let schema_version = object
        .get("schema")
        .and_then(serde_json::Value::as_str)
        .context("accepted project definition has no schema")?;
    let revision = object
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .context("accepted project definition has no revision")?;
    let scene = RawJsonEnvelope::from_value(
        object
            .get("scene")
            .cloned()
            .context("accepted project definition has no scene")?,
    )
    .map_err(anyhow::Error::msg)?;

    let mut envelope = ProjectEnvelope::blank(project_id, name)?;
    envelope.definition.schema_version = schema_version.to_string();
    envelope.definition.revision = revision;
    envelope.definition.scene = scene;
    envelope.raw_definition = raw_definition;
    envelope.validate_for_save()?;
    Ok(envelope)
}

fn batch_output_storage_policy(intent: &FmsBatchIntent) -> Result<fullmag_ir::OutputStorageIR> {
    let snapshot = intent
        .specification
        .get("output_storage")
        .context("accepted batch has no pinned OutputStorage snapshot")?;
    let schema = snapshot
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        .context("accepted batch OutputStorage snapshot has no schema_version")?;
    let settings = snapshot
        .get("settings")
        .filter(|value| value.is_object())
        .context("accepted batch OutputStorage snapshot has no settings")?;
    let policy = match schema {
        FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA => {
            serde_json::from_value(settings.clone())
                .context("decode resolved batch OutputStorage settings")?
        }
        fullmag_session::FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_LEGACY_SCHEMA => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct LegacySettings {
                output_parent: String,
                #[serde(default)]
                temp_parent: Option<String>,
                #[serde(default)]
                data_format: fullmag_ir::OutputDataFormatIR,
                #[serde(default)]
                cleanup: fullmag_ir::TempCleanupIR,
                #[serde(default)]
                existing_output: fullmag_ir::ExistingOutputIR,
            }
            let legacy: LegacySettings = serde_json::from_value(settings.clone())
                .context("decode legacy batch OutputStorage settings")?;
            fullmag_ir::OutputStorageIR {
                output_dir: Some(legacy.output_parent),
                temp_dir: legacy.temp_parent,
                data_format: legacy.data_format,
                cleanup: legacy.cleanup,
                existing_output: legacy.existing_output,
            }
        }
        other => bail!("unsupported accepted batch OutputStorage schema `{other}`"),
    };
    policy
        .validate()
        .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
    if !policy
        .output_dir
        .as_deref()
        .is_some_and(|path| Path::new(path).is_absolute())
        || policy
            .temp_dir
            .as_deref()
            .is_some_and(|path| !Path::new(path).is_absolute())
    {
        bail!("accepted batch OutputStorage paths must be absolute");
    }
    Ok(policy)
}

fn accepted_batch_asset_payloads(
    store: &SessionStore,
    intent: &FmsBatchIntent,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut payloads = BTreeMap::new();
    for (asset_id, object_ref) in &intent.asset_object_refs {
        let payload = store
            .cas()
            .get(object_ref)?
            .with_context(|| format!("accepted batch asset `{asset_id}` is missing"))?;
        if fullmag_session::hex_sha256(&payload) != *object_ref {
            bail!("accepted batch asset `{asset_id}` digest differs from its CAS reference");
        }
        payloads.insert(asset_id.clone(), payload);
    }
    Ok(payloads)
}

fn active_published_batch_case_count(
    store: &SessionStore,
    manifest: &BatchExpansionManifest,
    published_prefix: u64,
) -> Result<usize> {
    let prefix = usize::try_from(published_prefix)?;
    let mut active_cases = 0usize;
    for case in manifest.cases.iter().take(prefix) {
        let run_id = case.specification.run_id.as_str();
        if store.read_run_intent(run_id)?.is_none() {
            bail!(
                "batch expansion cursor includes case `{}` without a durable child run",
                case.case_id
            );
        }
        let active = match store.read_run_catalog(run_id)? {
            None => true,
            Some(catalog) => {
                catalog.tasks.is_empty()
                    || catalog.tasks.iter().any(|task| {
                        !matches!(
                            task.lifecycle,
                            FmsTaskLifecycle::Succeeded
                                | FmsTaskLifecycle::Failed
                                | FmsTaskLifecycle::Cancelled
                                | FmsTaskLifecycle::Interrupted
                        )
                    })
            }
        };
        if active {
            active_cases = active_cases
                .checked_add(1)
                .context("active batch case count overflow")?;
        }
    }
    Ok(active_cases)
}

fn batch_case_idempotency_key(batch_id: &str, case_id: &str) -> String {
    let identity = format!("{batch_id}\0{case_id}");
    format!(
        "batch-case-{}",
        fullmag_session::hex_sha256(identity.as_bytes())
    )
}

/// Materialize task identities from the exact CAS objects accepted by Submit.
/// This boundary does not queue work, allocate a device, or start a worker.
pub(crate) fn materialize_accepted_run_catalog(
    store: &SessionStore,
    run_id: &str,
    expected_project_id: &ProjectId,
) -> Result<FmsRunCatalog> {
    let snapshot = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &fullmag_application::RunId::parse(run_id)?,
        expected_project_id,
    )?;
    let specification = &snapshot.run.specification;
    let planned_steps = snapshot
        .lowered
        .steps
        .iter()
        .filter(|step| matches!(step.status, StudyStepLoweringStatus::Planned))
        .collect::<Vec<_>>();
    let tasks = planned_steps
        .iter()
        .map(|step| {
            let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
            let input_fingerprint =
                fullmag_application::study_task_input_fingerprint(specification, step)?;
            let awaiting_reason = match step.execution_plan.as_ref() {
                Some(plan) if plan.common.resolved_backend == fullmag_ir::BackendTarget::Fem => {
                    fullmag_session::FMS_TASK_AWAITING_PREPARATION_REASON
                }
                _ => fullmag_runtime_control::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION,
            };
            Ok(FmsTaskCatalogEntry {
                task_id,
                input_fingerprint,
                lifecycle: FmsTaskLifecycle::Accepted,
                readiness: FmsTaskReadiness::Blocked {
                    reason: awaiting_reason.into(),
                },
                observation: None,
                attempt_id: None,
                ownership_epoch: None,
                resolved_input_fingerprint: None,
                artifact_ids: Vec::new(),
                resource_id: None,
                coordinator_watermark: None,
                coordinator_genesis: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if tasks.is_empty() {
        bail!("accepted study has no executable tasks to materialize");
    }
    let catalog = if let Some(existing) = store.read_run_catalog(run_id)? {
        if same_task_identity(&existing.tasks, &tasks) {
            existing
        } else {
            bail!("run catalog task identity conflicts with immutable study inputs");
        }
    } else {
        let materialized = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: Utc::now(),
            tasks,
        };
        // A busy writer leaves nothing published, so waiting longer is safe;
        // on a Windows-folder store five seconds left accepted runs in
        // recovery for a writer that was only briefly held.
        match fullmag_runtime_control::retry_store_writer_busy_within(
            RUN_CATALOG_WRITER_WAIT,
            || store.commit_run_catalog(&materialized),
        ) {
            Ok(()) => materialized,
            Err(error) => {
                if let Some(existing) = store.read_run_catalog(run_id)? {
                    if same_task_identity(&existing.tasks, &materialized.tasks) {
                        existing
                    } else {
                        return Err(error).context("publish run catalog");
                    }
                } else {
                    return Err(error).context("publish run catalog");
                }
            }
        }
    };

    // Preparation publication is idempotently repaired on every replay. FEM
    // tasks remain blocked until their native preparation evidence path exists.
    for step in planned_steps {
        let execution_plan = step
            .execution_plan
            .as_ref()
            .context("planned accepted study step has no execution plan")?;
        if execution_plan.common.resolved_backend != fullmag_ir::BackendTarget::Fdm {
            continue;
        }
        let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .context("accepted FDM task is missing from the durable run catalog")?;
        let preparation_id = format!("prep-{task_id}");
        let receipt = snapshot
            .materialize_fdm_preparation_receipt(preparation_id, &step.step_id)
            .with_context(|| format!("materialize accepted preparation for `{}`", step.step_id))?;
        let payload =
            serde_json::to_value(&receipt).context("serialize accepted FDM preparation receipt")?;
        let durable_receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step.step_id.clone(),
            task.input_fingerprint.clone(),
            receipt.preparation_id,
            receipt.plan_fingerprint,
            payload,
        )?;
        match fullmag_runtime_control::retry_store_writer_busy(|| {
            store.commit_task_preparation_receipt(&durable_receipt)
        })? {
            PreparationReceiptCommitDisposition::Accepted
            | PreparationReceiptCommitDisposition::Replayed => {}
        }
    }
    Ok(catalog)
}

/// How long run catalog publication waits for a busy session-store writer.
const RUN_CATALOG_WRITER_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

fn same_task_identity(existing: &[FmsTaskCatalogEntry], expected: &[FmsTaskCatalogEntry]) -> bool {
    existing.len() == expected.len()
        && existing.iter().zip(expected).all(|(left, right)| {
            left.task_id == right.task_id && left.input_fingerprint == right.input_fingerprint
        })
}

/// A pinned RunSpec cannot silently resolve a different explicit execution
/// intent. Device resolution is checked only where the planner publishes it;
/// all tasks remain blocked until the runtime resolves their final lane.

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ImmutableAssetReference, OpaqueAsset, ProjectId, ProjectSnapshot, RequestedExecution,
        StudyId, StudyReference,
    };
    use fullmag_authoring::{
        PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
        StudyModelReference, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
        StudyPlanMigrationDefaults, StudyPrimitiveStageKind, StudySolverConfigReference,
        STUDY_PLAN_SCHEMA_VERSION_V2,
    };
    use fullmag_ir::ProblemIR;
    use fullmag_plan::lower_study_plan_with_catalog;
    use fullmag_plan::StudyProblemCatalogEntry;
    use fullmag_runtime_control::validate_requested_execution;
    use serde_json::json;

    struct StopOnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            self.0
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    #[test]
    fn batch_publisher_budget_rotates_fairly_across_parent_batches() {
        assert_eq!(fair_batch_child_budget(32, 2), 16);
        assert_eq!(fair_batch_child_budget(2, 5), 1);
        assert_eq!(fair_batch_child_budget(0, 5), 0);
        assert_eq!(fair_batch_rotation_start(6, 3), 0);
        assert_eq!(fair_batch_rotation_start(7, 3), 1);
        assert_eq!(fair_batch_rotation_start(u64::MAX, 0), 0);
    }

    fn test_output_storage_defaults() -> OutputStorageDefaultsRequest {
        OutputStorageDefaultsRequest {
            output_parent: std::env::temp_dir()
                .join("fullmag-batch-results")
                .to_string_lossy()
                .into_owned(),
            temp_parent: None,
            data_format: crate::schemas::output_storage::OutputDataFormatSchema::Zarr,
            cleanup: crate::schemas::output_storage::TempCleanupSchema::OnSuccess,
            existing_output: crate::schemas::output_storage::ExistingOutputSchema::Timestamp,
        }
    }

    #[test]
    fn installed_submit_store_uses_new_user_state_without_creating_directories() {
        let root =
            std::env::temp_dir().join(format!("fullmag-installed-submit-{}", uuid::Uuid::new_v4()));
        let install = root.join("install");
        std::fs::create_dir_all(&install).unwrap();
        let state = root.join("user-data").join("Fullmag");
        let expected = std::fs::canonicalize(&root)
            .unwrap()
            .join("user-data/Fullmag/runs/session-store");
        assert_eq!(
            submit_store_root_for_layout(&install, &state, Some(&install), None, None, None),
            Some(expected)
        );
        assert!(!state.exists());
        assert_eq!(
            submit_store_root_for_layout(&install, &state, None, None, None, None),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_submit_store_rejects_partial_managed_environment_and_install_state() {
        let root =
            std::env::temp_dir().join(format!("fullmag-installed-submit-{}", uuid::Uuid::new_v4()));
        let install = root.join("install");
        std::fs::create_dir_all(&install).unwrap();
        let state = root.join("user-data");
        for layout in [
            (Some(root.clone().into_os_string()), None, None),
            (None, Some(root.clone().into_os_string()), None),
            (None, None, Some("worktree".into())),
            (Some("".into()), Some("".into()), Some("".into())),
        ] {
            assert_eq!(
                submit_store_root_for_layout(
                    &install,
                    &state,
                    Some(&install),
                    layout.0,
                    layout.1,
                    layout.2
                ),
                None
            );
        }
        for invalid_state in [
            install.join("data"),
            root.clone(),
            PathBuf::from("relative"),
            state.join("../escape"),
        ] {
            assert_eq!(
                submit_store_root_for_layout(
                    &install,
                    &invalid_state,
                    Some(&install),
                    None,
                    None,
                    None
                ),
                None
            );
        }
        assert_eq!(
            submit_store_root_for_layout(&root, &state, Some(&install), None, None, None),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn installed_submit_store_rejects_junction_run_directory() {
        let root =
            std::env::temp_dir().join(format!("fullmag-installed-submit-{}", uuid::Uuid::new_v4()));
        let install = root.join("install");
        let state = root.join("user-data");
        let outside = root.join("outside");
        for directory in [&install, &state, &outside] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let junction = state.join("runs");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed: {status:?}");
        let selected =
            submit_store_root_for_layout(&install, &state, Some(&install), None, None, None);
        let outside_unchanged = !outside.join("session-store").exists();
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(selected, None);
        assert!(outside_unchanged);
    }

    #[cfg(unix)]
    #[test]
    fn installed_submit_store_rejects_linked_run_directory() {
        let root =
            std::env::temp_dir().join(format!("fullmag-installed-submit-{}", uuid::Uuid::new_v4()));
        let install = root.join("install");
        let state = root.join("user-data");
        let outside = root.join("outside");
        for directory in [&install, &state, &outside] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::os::unix::fs::symlink(&outside, state.join("runs")).unwrap();
        assert_eq!(
            submit_store_root_for_layout(&install, &state, Some(&install), None, None, None),
            None
        );
        assert!(!outside.join("session-store").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_adapter_replays_across_store_restart_and_rejects_conflict() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-run-intent-adapter-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = SessionStore::open(&root).unwrap();
        let mut definition =
            ProjectEnvelope::blank(ProjectId::parse("project-test").unwrap(), "Test").unwrap();
        let asset_bytes = b"accepted asset".to_vec();
        definition.assets.push(
            OpaqueAsset::new("project/assets/accepted.bin", asset_bytes.clone(), None).unwrap(),
        );
        let archive = FileProjectRepository::new()
            .encode_archive(&definition)
            .unwrap();
        let asset_paths =
            BTreeMap::from([("asset-test".into(), "project/assets/accepted.bin".into())]);
        let study = StudyPlan::from_pipeline(
            "study-main",
            1,
            &StudyPipelineDocument {
                version: "study_pipeline.v2".into(),
                nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                    id: "step:run".into(),
                    label: "Run".into(),
                    enabled: true,
                    notes: None,
                    source: Some(StudyPipelineNodeSource::UiAuthored),
                    stage_kind: StudyPrimitiveStageKind::Run,
                    payload: [("until_seconds".into(), json!("1e-9"))]
                        .into_iter()
                        .collect(),
                })],
            },
            &StudyPlanMigrationDefaults {
                model: StudyModelReference {
                    model_id: "model:one".into(),
                    version: "v1".into(),
                },
                solver_config: StudySolverConfigReference {
                    preset_id: "solver:default".into(),
                    version: "v1".into(),
                },
                discretization: StudyDiscretizationReference {
                    recipe_id: "mesh:default".into(),
                    version: "v1".into(),
                },
                execution_profile: StudyExecutionProfileReference {
                    profile_id: "exec:auto".into(),
                    version: "v1".into(),
                },
            },
        )
        .unwrap();
        let defaults_catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                ProblemIR::bootstrap_example(),
            )],
        )
        .unwrap();
        let defaults_snapshot = resolve_batch_output_storage_snapshot(
            &defaults_catalog,
            &test_output_storage_defaults(),
        )
        .unwrap();
        assert_eq!(defaults_snapshot["source"], json!("workspace_defaults"));
        assert_eq!(
            defaults_snapshot["settings"]["output_dir"],
            json!(test_output_storage_defaults().output_parent)
        );

        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "output_storage".into(),
            json!({
                "output_dir": "authoring-results",
                "temp_dir": "authoring-tmp",
                "data_format": "zarr",
                "cleanup": "always",
                "existing_output": "error"
            }),
        );
        let missing_source_dir_catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                problem.clone(),
            )],
        )
        .unwrap();
        let missing_source_error = resolve_batch_output_storage_snapshot(
            &missing_source_dir_catalog,
            &test_output_storage_defaults(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            missing_source_error.contains("no output_storage_source_dir"),
            "{missing_source_error}"
        );
        let mut absolute_policy_problem = problem.clone();
        absolute_policy_problem
            .problem_meta
            .runtime_metadata
            .insert(
                "output_storage".into(),
                json!({
                    "output_dir": test_output_storage_defaults().output_parent,
                    "data_format": "zarr",
                    "cleanup": "always",
                    "existing_output": "error"
                }),
            );
        let absolute_policy_catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                absolute_policy_problem,
            )],
        )
        .unwrap();
        assert!(resolve_batch_output_storage_snapshot(
            &absolute_policy_catalog,
            &test_output_storage_defaults(),
        )
        .is_ok());
        problem.problem_meta.runtime_metadata.insert(
            "output_storage_source_dir".into(),
            json!(store.root().to_string_lossy().to_string()),
        );
        let catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                problem,
            )],
        )
        .unwrap();
        let catalog_value = serde_json::to_value(&catalog).unwrap();
        let mut specification = RunSpecification::new(
            ProjectSnapshot::from_envelope(&definition).unwrap(),
            StudyReference {
                study_id: StudyId::parse("study-main").unwrap(),
                plan_version: STUDY_PLAN_SCHEMA_VERSION_V2.into(),
                plan_sha256: study.canonical_sha256().unwrap(),
            },
            fullmag_session::canonical_json_sha256(&catalog_value),
            json!({"alpha": 0.01}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(fullmag_application::RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        );
        let mut asset_payloads = BTreeMap::new();
        asset_payloads.insert("asset-test".into(), asset_bytes.clone());
        specification
            .immutable_assets
            .push(ImmutableAssetReference {
                asset_id: "asset-test".into(),
                content_sha256: fullmag_session::hex_sha256(&asset_bytes),
            });
        let intent = RunIntent::new("submit-test", specification);
        let accepted =
            commit_archived_run_intent(&store, &intent, &archive, &study, &catalog, &asset_paths)
                .unwrap();
        assert_eq!(accepted.disposition, SubmitDisposition::Accepted);

        let mut batch_template = intent.specification.clone();
        batch_template.parameters = json!({});
        let batch_request = BatchExpansionRequest {
            batch_id: "batch-test".into(),
            strategy: fullmag_application::BatchExecutionStrategy::Independent,
            failure_policy: fullmag_application::BatchFailurePolicy::ContinueIndependent,
            template: batch_template,
            axes: vec![fullmag_application::BatchAxis {
                name: "field_z".into(),
                target: fullmag_application::BatchAxisTarget::ExternalFieldB {
                    step_id: "step:run".into(),
                    direction: [0.0, 0.0, 1.0],
                },
                value_kind: fullmag_application::BatchAxisValueKind::Number,
                canonical_unit: "T".into(),
                values: fullmag_application::BatchAxisValues::List {
                    values: vec![json!(-0.01), json!(0.02)],
                },
                join: fullmag_application::BatchAxisJoin::Cartesian,
            }],
            master_seed: 42,
            seed_name: "batch_seed".into(),
            max_cases: 16,
            max_parallel_cases: Some(4),
        };
        let accepted_batch = commit_archived_batch_intent(
            &store,
            &ProjectId::parse("project-test").unwrap(),
            "submit-batch-test",
            &batch_request,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            Some(test_output_storage_defaults()),
        )
        .unwrap();
        assert_eq!(accepted_batch.disposition, BatchSubmitDisposition::Accepted);
        assert_eq!(accepted_batch.case_count, 2);
        let accepted_batch_intent = store.read_batch_intent("batch-test").unwrap().unwrap();
        let resolved_output_storage =
            &accepted_batch_intent.specification["output_storage"]["settings"];
        assert_eq!(
            resolved_output_storage["output_dir"],
            json!(store.root().join("authoring-results").to_string_lossy().to_string())
        );
        assert_eq!(
            resolved_output_storage["temp_dir"],
            json!(store.root().join("authoring-tmp").to_string_lossy().to_string())
        );
        assert_eq!(resolved_output_storage["cleanup"], json!("always"));
        assert_eq!(resolved_output_storage["existing_output"], json!("error"));
        assert_eq!(
            accepted_batch_intent.specification["output_storage"]["source"],
            json!("project_authoring")
        );
        assert!(accepted_batch_intent.specification["output_storage"]
            ["workspace_defaults_sha256"]
            .is_string());
        assert!(accepted_batch_intent.specification["output_storage"]
            ["authoring_policy_sha256"]
            .is_string());
        let initial_batch_progress = batch_progress(&store, "batch-test");
        assert_eq!(initial_batch_progress.total_cases, 2);
        assert_eq!(initial_batch_progress.next_case_index, 0);
        assert_eq!(initial_batch_progress.sequence, 1);
        assert_eq!(
            initial_batch_progress.state,
            fullmag_session::FmsBatchExpansionState::Pending
        );
        std::fs::remove_file(
            store
                .root()
                .join("batches/batch-test/expansion_progress.json"),
        )
        .unwrap();
        let repaired_batch = commit_archived_batch_intent(
            &store,
            &ProjectId::parse("project-test").unwrap(),
            "submit-batch-test",
            &batch_request,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            None,
        )
        .unwrap();
        assert_eq!(repaired_batch.disposition, BatchSubmitDisposition::Replayed);
        assert_eq!(batch_progress(&store, "batch-test"), initial_batch_progress);
        drop(store);

        let reopened = SessionStore::open_existing(&root).unwrap();
        let replayed = commit_archived_run_intent(
            &reopened,
            &intent,
            &archive,
            &study,
            &catalog,
            &asset_paths,
        )
        .unwrap();
        assert_eq!(replayed.disposition, SubmitDisposition::Replayed);
        assert_eq!(replayed.run_id, accepted.run_id);
        assert_eq!(replayed.payload_fingerprint, accepted.payload_fingerprint);
        let replayed_batch = commit_archived_batch_intent(
            &reopened,
            &ProjectId::parse("project-test").unwrap(),
            "submit-batch-test",
            &batch_request,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            Some(test_output_storage_defaults()),
        )
        .unwrap();
        assert_eq!(replayed_batch.disposition, BatchSubmitDisposition::Replayed);
        assert_eq!(replayed_batch, accepted_batch);
        assert_eq!(
            batch_progress(&reopened, "batch-test"),
            initial_batch_progress
        );
        let mut conflicting_batch = batch_request.clone();
        if let fullmag_application::BatchAxisValues::List { values } =
            &mut conflicting_batch.axes[0].values
        {
            values[0] = json!(-0.02);
        }
        assert!(commit_archived_batch_intent(
            &reopened,
            &ProjectId::parse("project-test").unwrap(),
            "submit-batch-test",
            &conflicting_batch,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            Some(test_output_storage_defaults()),
        )
        .is_err());
        assert!(reopened.read_batch_intent("batch-test").unwrap().is_some());
        let accepted_batch_intent = reopened.read_batch_intent("batch-test").unwrap().unwrap();
        let accepted_manifest_bytes = reopened
            .cas()
            .get(&accepted_batch_intent.manifest_object_ref)
            .unwrap()
            .unwrap();
        let accepted_manifest: BatchExpansionManifest =
            serde_json::from_slice(&accepted_manifest_bytes).unwrap();
        let expected_child_output_storage = accepted_batch_intent.specification["output_storage"]
            ["settings"]
            .clone();
        let mut second_batch_request = batch_request.clone();
        second_batch_request.batch_id = "batch-second".into();
        commit_archived_batch_intent(
            &reopened,
            &ProjectId::parse("project-test").unwrap(),
            "submit-batch-second",
            &second_batch_request,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            Some(test_output_storage_defaults()),
        )
        .unwrap();
        assert_eq!(
            expand_pending_batch_children(&reopened, 2, NonZeroUsize::new(16).unwrap())
                .unwrap(),
            2,
            "a bounded publisher round must give one child to each pending parent"
        );
        assert_eq!(batch_progress(&reopened, "batch-test").next_case_index, 1);
        assert_eq!(batch_progress(&reopened, "batch-second").next_case_index, 1);
        assert_eq!(
            expand_pending_batch_children(
                &reopened,
                8,
                NonZeroUsize::new(16).unwrap()
            )
            .unwrap(),
            2
        );
        let expanded_progress = batch_progress(&reopened, "batch-test");
        assert_eq!(expanded_progress.next_case_index, 2);
        assert_eq!(expanded_progress.sequence, 3);
        assert_eq!(
            expanded_progress.state,
            fullmag_session::FmsBatchExpansionState::Complete
        );
        for case in &accepted_manifest.cases {
            let child = reopened
                .read_run_intent(case.specification.run_id.as_str())
                .unwrap()
                .expect("each published case has a durable child run intent");
            assert_eq!(
                child.idempotency_key,
                batch_case_idempotency_key("batch-test", &case.case_id)
            );
            let child_catalog_ref = child
                .study_catalog_object_ref
                .as_deref()
                .expect("child run pins its case-local StudyProblemCatalog");
            let child_catalog_bytes = reopened.cas().get(child_catalog_ref).unwrap().unwrap();
            let child_catalog: StudyProblemCatalog =
                serde_json::from_slice(&child_catalog_bytes).unwrap();
            for entry in child_catalog.entries() {
                assert_eq!(
                    entry.problem().problem_meta.runtime_metadata.get("output_storage"),
                    Some(&expected_child_output_storage)
                );
                assert!(!entry
                    .problem()
                    .problem_meta
                    .runtime_metadata
                    .contains_key("output_storage_source_dir"));
            }
        }
        assert_eq!(
            expand_pending_batch_children(
                &reopened,
                8,
                NonZeroUsize::new(16).unwrap()
            )
            .unwrap(),
            0,
            "restarting expansion after completion must not duplicate child runs"
        );
        let materialized = materialize_accepted_run_catalog(
            &reopened,
            accepted.run_id.as_str(),
            &intent.specification.snapshot.project_id,
        )
        .unwrap();
        assert_eq!(materialized.revision, 1);
        assert_eq!(materialized.tasks.len(), 1);
        assert_eq!(materialized.tasks[0].lifecycle, FmsTaskLifecycle::Accepted);
        assert!(matches!(
            materialized.tasks[0].readiness,
            FmsTaskReadiness::Blocked { .. }
        ));
        let materialized_again = materialize_accepted_run_catalog(
            &reopened,
            accepted.run_id.as_str(),
            &intent.specification.snapshot.project_id,
        )
        .unwrap();
        assert_eq!(materialized_again, materialized);
        let lowered = lower_study_plan_with_catalog(&study, &catalog).unwrap();
        validate_requested_execution(&intent.specification, &catalog, &lowered).unwrap();
        let mut mismatched_execution = intent.specification.clone();
        mismatched_execution.requested_execution.backend = "fem".into();
        assert!(validate_requested_execution(&mismatched_execution, &catalog, &lowered).is_err());
        mismatched_execution.requested_execution = intent.specification.requested_execution.clone();
        mismatched_execution.requested_execution.precision = "single".into();
        assert!(validate_requested_execution(&mismatched_execution, &catalog, &lowered).is_err());
        mismatched_execution.requested_execution = intent.specification.requested_execution.clone();
        mismatched_execution.requested_execution.mode = "extended".into();
        assert!(validate_requested_execution(&mismatched_execution, &catalog, &lowered).is_err());
        let conflicting_intent = RunIntent::new("submit-execution-conflict", mismatched_execution);
        let error = commit_archived_run_intent(
            &reopened,
            &conflicting_intent,
            &archive,
            &study,
            &catalog,
            &asset_paths,
        )
        .expect_err("execution conflicts must be rejected before durable publication");
        assert!(format!("{error:#}").contains("mode"));
        assert!(reopened
            .find_run_intent("submit-execution-conflict")
            .unwrap()
            .is_none());
        let persisted = reopened
            .read_run_intent(accepted.run_id.as_str())
            .unwrap()
            .unwrap();
        let object_ref = persisted.definition_object_ref.unwrap();
        assert_eq!(object_ref, intent.specification.snapshot.definition_sha256);
        assert_eq!(
            reopened.cas().get(&object_ref).unwrap().unwrap().as_slice(),
            definition.raw_definition.raw_bytes()
        );
        let study_ref = persisted.study_object_ref.unwrap();
        assert_eq!(study_ref, intent.specification.study.plan_sha256);
        assert_eq!(
            reopened.cas().get(&study_ref).unwrap().unwrap(),
            study.canonical_json_bytes().unwrap()
        );
        let catalog_ref = persisted.study_catalog_object_ref.unwrap();
        assert_eq!(catalog_ref, intent.specification.study_catalog_sha256);
        assert_eq!(
            reopened.cas().get(&catalog_ref).unwrap().unwrap(),
            fullmag_session::canonical_json_bytes(&catalog_value)
        );
        let asset_ref = persisted.asset_object_refs.get("asset-test").unwrap();
        assert_eq!(asset_ref, &fullmag_session::hex_sha256(&asset_bytes));
        assert_eq!(reopened.cas().get(asset_ref).unwrap().unwrap(), asset_bytes);

        let mut changed = intent.clone();
        changed.specification.parameters = json!({"alpha": 0.02});
        assert!(commit_validated_run_intent(
            &reopened,
            &changed,
            &definition,
            &study,
            &catalog,
            &asset_payloads
        )
        .is_err());
        let other_definition =
            ProjectEnvelope::blank(ProjectId::parse("project-test").unwrap(), "Other").unwrap();
        assert!(commit_validated_run_intent(
            &reopened,
            &intent,
            &other_definition,
            &study,
            &catalog,
            &asset_payloads
        )
        .is_err());
        let mut changed_study = study.clone();
        changed_study.revision += 1;
        assert!(commit_validated_run_intent(
            &reopened,
            &intent,
            &definition,
            &changed_study,
            &catalog,
            &asset_payloads
        )
        .is_err());
        let mut changed_asset_payloads = asset_payloads.clone();
        changed_asset_payloads.insert("asset-test".into(), b"changed asset".to_vec());
        assert!(commit_validated_run_intent(
            &reopened,
            &intent,
            &definition,
            &study,
            &catalog,
            &changed_asset_payloads,
        )
        .is_err());
        let absent_asset_paths =
            BTreeMap::from([("asset-test".into(), "project/assets/missing.bin".into())]);
        assert!(commit_archived_run_intent(
            &reopened,
            &intent,
            &archive,
            &study,
            &catalog,
            &absent_asset_paths,
        )
        .is_err());
        assert_eq!(
            reopened
                .read_run_intent(accepted.run_id.as_str())
                .unwrap()
                .unwrap()
                .specification,
            serde_json::to_value(&intent.specification).unwrap()
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn batch_progress(
        store: &SessionStore,
        batch_id: &str,
    ) -> fullmag_session::FmsBatchExpansionProgress {
        store
            .read_batch_expansion_progress(batch_id)
            .unwrap()
            .expect("accepted batch submit seeds durable expansion progress")
    }

    /// A competing writer must never be able to wedge in between the CAS blob
    /// writes and the intent publication of one Submit.  A busy result is only
    /// legitimate before the submission has published anything.
    #[test]
    fn submit_publication_is_one_writer_lease_under_competing_writer() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let definition =
            ProjectEnvelope::blank(ProjectId::parse("project-lease").unwrap(), "Lease").unwrap();
        let study = StudyPlan::from_pipeline(
            "study-lease",
            1,
            &StudyPipelineDocument {
                version: "study_pipeline.v2".into(),
                nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                    id: "step:run".into(),
                    label: "Run".into(),
                    enabled: true,
                    notes: None,
                    source: Some(StudyPipelineNodeSource::UiAuthored),
                    stage_kind: StudyPrimitiveStageKind::Run,
                    payload: [("until_seconds".into(), json!("1e-9"))]
                        .into_iter()
                        .collect(),
                })],
            },
            &StudyPlanMigrationDefaults {
                model: StudyModelReference {
                    model_id: "model:one".into(),
                    version: "v1".into(),
                },
                solver_config: StudySolverConfigReference {
                    preset_id: "solver:default".into(),
                    version: "v1".into(),
                },
                discretization: StudyDiscretizationReference {
                    recipe_id: "mesh:default".into(),
                    version: "v1".into(),
                },
                execution_profile: StudyExecutionProfileReference {
                    profile_id: "exec:auto".into(),
                    version: "v1".into(),
                },
            },
        )
        .unwrap();
        let catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                ProblemIR::bootstrap_example(),
            )],
        )
        .unwrap();
        let catalog_value = serde_json::to_value(&catalog).unwrap();
        let specification = RunSpecification::new(
            ProjectSnapshot::from_envelope(&definition).unwrap(),
            StudyReference {
                study_id: StudyId::parse("study-lease").unwrap(),
                plan_version: STUDY_PLAN_SCHEMA_VERSION_V2.into(),
                plan_sha256: study.canonical_sha256().unwrap(),
            },
            fullmag_session::canonical_json_sha256(&catalog_value),
            json!({}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(fullmag_application::RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        );
        let intent = RunIntent::new("submit-lease", specification);
        let definition_ref = intent.specification.snapshot.definition_sha256.clone();
        let mut accepted_count = 0;
        for attempt in 0..60u64 {
            let root = std::env::temp_dir().join(format!(
                "fullmag-run-intent-lease-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let store = SessionStore::open(&root).unwrap();
            let rival = SessionStore::open_existing(&root).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let rival_stop = stop.clone();
            let (rival_ready_tx, rival_ready_rx) = std::sync::mpsc::channel();
            let (rival_go_tx, rival_go_rx) = std::sync::mpsc::channel();
            let _stop_on_drop = StopOnDrop(Arc::clone(&stop));
            let hammer = std::thread::spawn(move || {
                // Sweep the rival's first acquisition across the submit so
                // that it lands in different phases of the publication.
                let offset = std::time::Instant::now()
                    + std::time::Duration::from_micros(attempt * 700);
                while std::time::Instant::now() < offset {
                    std::hint::spin_loop();
                }
                let force_initial_contention = attempt == 0;
                let mut first_acquisition = true;
                while !rival_stop.load(Ordering::Relaxed) {
                    // Spin instead of sleeping: coarse OS timers would hold the
                    // lease for whole scheduler quanta.
                    let spin = |micros: u64| {
                        let until = std::time::Instant::now()
                            + std::time::Duration::from_micros(micros);
                        while std::time::Instant::now() < until {
                            std::hint::spin_loop();
                        }
                    };
                    if let Ok(lease) = rival.write_transaction() {
                        if force_initial_contention && first_acquisition {
                            first_acquisition = false;
                            rival_ready_tx.send(()).unwrap();
                            let _ = rival_go_rx.recv_timeout(std::time::Duration::from_secs(5));
                            // Keep the native descriptor held long enough for
                            // the main thread to verify the typed conflict.
                            spin(150_000);
                            drop(lease);
                            break;
                        }
                        spin(0);
                        drop(lease);
                    }
                    spin(30000);
                }
            });
            if attempt == 0 {
                rival_ready_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                let probe = SessionStore::open_existing(&root).unwrap();
                let probe_error = match probe.write_transaction() {
                    Ok(lease) => {
                        drop(lease);
                        None
                    }
                    Err(error) => Some(error),
                };
                let native_busy = probe_error.as_ref().is_some_and(|error| {
                    error
                        .chain()
                        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                        && format!("{error:#}").contains("conflict=native descriptor")
                });
                rival_go_tx.send(()).unwrap();
                assert!(
                    native_busy,
                    "test setup must observe native StoreWriterBusy before accepted commit: {probe_error:?}"
                );
            }
            let result = commit_validated_run_intent(
                &store,
                &intent,
                &definition,
                &study,
                &catalog,
                &BTreeMap::new(),
            );
            stop.store(true, Ordering::Relaxed);
            hammer.join().unwrap();
            if attempt == 0 {
                assert!(
                    result.is_ok(),
                    "accepted publication must retry an initial writer collision: {result:?}"
                );
            }
            match result {
                Ok(receipt) => {
                    assert_eq!(receipt.disposition, SubmitDisposition::Accepted);
                    accepted_count += 1;
                }
                Err(error) => {
                    assert!(
                        error.is::<fullmag_session::StoreWriterBusy>(),
                        "unexpected error: {error:#}"
                    );
                    assert!(
                        store.cas().get(&definition_ref).unwrap().is_none(),
                        "busy submit left partial publication behind"
                    );
                    assert!(store.find_run_intent("submit-lease").unwrap().is_none());
                }
            }
            drop(store);
            let _ = std::fs::remove_dir_all(&root);
        }
        assert!(accepted_count > 0, "no submit ever won the writer lease");
    }
}

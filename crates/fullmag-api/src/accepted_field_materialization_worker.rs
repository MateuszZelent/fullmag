//! Shared worker-side accepted observation materialization.
//!
//! No evaluator or GPU context is created by a request handler. A bundle is a
//! reserved system artifact, distinct from authored Study output ports, and is
//! published under the producing task's active resource lease.

use std::collections::{BTreeMap, BTreeSet};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep};
use fullmag_session::{
    FmsArtifactCatalogEntry, FmsArtifactStatus, SessionStore,
    FMS_ACCEPTED_TERMINAL_LAYOUT_ARTIFACT_TYPE as TERMINAL_LAYOUT_ARTIFACT_TYPE,
};
use fullmag_runner::{
    AcceptedMagnetizationInput, AcceptedMaterializationBatch, AcceptedMaterializationLane,
    AcceptedMaterializationRequest, materialize_accepted_observables,
};
use crate::accepted_field_binary::{BinaryFieldRef, BinaryFieldChunk};

pub(crate) const SCHEMA: &str = "accepted_quantity_bundle.v1";
const ARTIFACT_TYPE: &str = "accepted_quantity_bundle";
pub(crate) const TERMINAL_SCALAR_ARTIFACT_TYPE: &str = "accepted_terminal_scalar_stats";
const MAX_BUNDLE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaterializationRecord {
    pub(crate) schema_version: String,
    pub(crate) source: fullmag_quantities::AcceptedStateRef,
    pub(crate) state_object_ref: String,
    pub(crate) batch: Option<AcceptedMaterializationBatch>,
    pub(crate) error: Option<String>,
    /// Values are immutable F64LE CAS chunks; batch.fields carries metadata.
    /// Empty preserves already-published inline v1 receipts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) binary_fields: BTreeMap<String, BinaryFieldRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalScalarStatsRecord {
    pub(crate) schema_version: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) step_id: String,
    pub(crate) attempt_id: String,
    pub(crate) ownership_epoch: u64,
    pub(crate) source: fullmag_quantities::AcceptedStateRef,
    pub(crate) state_object_ref: String,
    pub(crate) stats: fullmag_runner::StepStats,
}

const TERMINAL_SCALAR_STATS_SCHEMA: &str = "accepted_terminal_scalar_stats.v1";
const MAX_TERMINAL_SCALAR_STATS_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalCompletionRecord {
    pub(crate) schema_version: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) step_id: String,
    pub(crate) attempt_id: String,
    pub(crate) ownership_epoch: u64,
    pub(crate) source: fullmag_quantities::AcceptedStateRef,
    pub(crate) state_object_ref: String,
    pub(crate) clock: fullmag_quantities::ObservationClock,
    pub(crate) solver_dt_s: f64,
    pub(crate) completion: fullmag_ir::StageCompletionIR,
    pub(crate) input_fingerprint: String,
    pub(crate) resolved_input_fingerprint: Option<String>,
}

const TERMINAL_COMPLETION_SCHEMA: &str = "accepted_terminal_completion.v1";
const MAX_TERMINAL_COMPLETION_BYTES: u64 = 256 * 1024;

pub(crate) const TERMINAL_COMPLETION_ARTIFACT_TYPE: &str = "accepted_terminal_completion";
const TERMINAL_LAYOUT_SCHEMA: &str = "fullmag.accepted-terminal-magnetization-layout.v1";
const MAX_TERMINAL_LAYOUT_BYTES: u64 = 4096;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalLayoutRecord {
    schema_version: String,
    run_id: String,
    step_id: String,
    task_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    state_object_ref: String,
    pub(crate) layout_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) admitted_input_sha256: Option<String>,
}

impl TerminalLayoutRecord {
    fn artifact_id(&self) -> String {
        let digest = fullmag_session::canonical_json_sha256(&json!([
            self.run_id, self.task_id, self.attempt_id, self.ownership_epoch,
        ]));
        format!("accepted-terminal-layout-{digest}")
    }

    fn logical_path(&self) -> String {
        format!("outputs/{}/{}/accepted-terminal-layout.v1.json", self.task_id, self.attempt_id)
    }
}

fn bare_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The completed manifest pins the output. This small companion record can
/// qualify the layout without opening that output's numerical samples.
pub(crate) fn terminal_evidence_for_final_state(
    store: &SessionStore,
    artifacts: &fullmag_session::FmsArtifactCatalog,
    task: &fullmag_session::FmsTaskCatalogEntry,
    step_id: &str,
    state_object_ref: &str,
) -> Option<TerminalLayoutRecord> {
    let attempt_id = task.attempt_id.as_deref()?;
    let epoch = task.ownership_epoch?;
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
        || fullmag_session::task_id_for_study_step(&artifacts.run_id, step_id).ok()? != task.task_id
    {
        return None;
    }
    let mut entries = artifacts.entries.iter().filter(|entry| {
        entry.artifact_type == TERMINAL_LAYOUT_ARTIFACT_TYPE
            && entry.task_id == task.task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == epoch
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    let entry = entries.next()?;
    if entries.next().is_some() || entry.status != FmsArtifactStatus::Published
        || entry.required || entry.study_output.is_some()
        || entry.object_ref.as_deref() != Some(entry.content_sha256.as_str())
    {
        return None;
    }
    let bytes = store.cas().get_bounded(&entry.content_sha256, MAX_TERMINAL_LAYOUT_BYTES).ok()??;
    let record: TerminalLayoutRecord = serde_json::from_slice(&bytes).ok()?;
    if record.schema_version != TERMINAL_LAYOUT_SCHEMA
        || record.run_id != artifacts.run_id || record.step_id != step_id
        || record.task_id != task.task_id || record.attempt_id != attempt_id
        || record.ownership_epoch != epoch || record.state_object_ref != state_object_ref
        || entry.artifact_id != record.artifact_id() || entry.logical_path != record.logical_path()
        || !bare_sha256(&record.layout_sha256)
        || record.admitted_input_sha256.as_deref().is_some_and(|digest| !bare_sha256(digest))
    {
        return None;
    }
    Some(record)
}

/// Compare admitted recipes without copying the execution plan or its samples.
/// The Prepare fingerprint is checked against the immutable plan before dispatch.
fn terminal_admitted_input_sha256(step: &AcceptedWorkerStep) -> Option<String> {
    let resolved = &step.resolved_input;
    if resolved.frozen_stage_context.is_some() || !bare_sha256(&resolved.plan_fingerprint) {
        return None;
    }
    let request = &resolved.requested_execution;
    Some(fullmag_session::canonical_json_sha256(&json!({
        "schema": "fullmag.terminal-admitted-stage-input.v1",
        "plan": resolved.plan_fingerprint,
        "solver": step.problem.study,
        "until_seconds": step.until_seconds,
        "overlay": step.initial_state_overlay,
        "execution": [request.backend.as_str(), request.device.as_str(),
                      request.precision.as_str(), request.mode.as_str()],
        "resolved_inputs": resolved.inputs,
    })))
}

fn publish_terminal_layout(
    store: &SessionStore,
    step: &AcceptedWorkerStep,
    state: &fullmag_application::MagnetizationStateArtifact,
    state_object_ref: &str,
    budget: u64,
) -> Result<u64> {
    let claim = &step.claim;
    let mut record = TerminalLayoutRecord {
        schema_version: TERMINAL_LAYOUT_SCHEMA.into(),
        run_id: claim.run_id.as_str().into(),
        step_id: step.step_id.clone(),
        task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        state_object_ref: state_object_ref.into(),
        layout_sha256: state.space_fingerprint.clone(),
        admitted_input_sha256: terminal_admitted_input_sha256(step),
    };
    let artifact_id = record.artifact_id();
    let logical_path = record.logical_path();
    if let Some(catalog) = store.read_artifact_catalog(&record.run_id)? {
        let mut entries = catalog.entries.iter().filter(|entry| {
            entry.task_id == record.task_id && entry.attempt_id == record.attempt_id
                && entry.ownership_epoch == record.ownership_epoch
        });
        if let Some(entry) = entries.clone().find(|entry| entry.artifact_type == TERMINAL_LAYOUT_ARTIFACT_TYPE) {
            if entry.artifact_id != artifact_id || entry.logical_path != logical_path
                || entry.status != FmsArtifactStatus::Published || entry.required || entry.study_output.is_some()
                || entry.object_ref.as_deref() != Some(entry.content_sha256.as_str())
                || entries.filter(|entry| entry.artifact_type == TERMINAL_LAYOUT_ARTIFACT_TYPE).count() != 1
            {
                bail!("terminal magnetization layout replay differs from its immutable record");
            }
            let bytes = store.cas().get_bounded(&entry.content_sha256, MAX_TERMINAL_LAYOUT_BYTES)?
                .context("terminal magnetization layout replay object is missing")?;
            let previous: TerminalLayoutRecord = serde_json::from_slice(&bytes)?;
            // Preserve a published layout-only receipt from an earlier worker.
            if previous.admitted_input_sha256.is_none() {
                record.admitted_input_sha256 = None;
            }
            if previous != record {
                bail!("terminal magnetization layout replay differs from its immutable record");
            }
            return Ok(bytes.len() as u64);
        }
        if entries.any(|entry| entry.artifact_type == "study_output_manifest") {
            return Ok(0);
        }
    }
    let bytes = serde_json::to_vec(&record)?;
    let byte_count = bytes.len() as u64;
    if byte_count > MAX_TERMINAL_LAYOUT_BYTES {
        bail!("terminal magnetization layout record exceeds its limit");
    }
    if byte_count > budget { return Ok(0); }
    let object_ref = retry_worker_store_writer_busy(|| store.cas().put(&bytes))?;
    let lease = store.read_resource_lease(
        &record.run_id, claim.lease.resource_id.as_str(), claim.lease.lease_token.as_str(),
    )?.context("terminal magnetization layout resource lease missing")?;
    let entry = FmsArtifactCatalogEntry {
        artifact_id, logical_path, task_id: record.task_id, attempt_id: record.attempt_id,
        ownership_epoch: record.ownership_epoch, artifact_type: TERMINAL_LAYOUT_ARTIFACT_TYPE.into(),
        content_sha256: object_ref.clone(), object_ref: Some(object_ref),
        status: FmsArtifactStatus::Published, required: false, study_output: None,
    };
    retry_worker_store_writer_busy(|| {
        store.append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
    })?;
    Ok(byte_count)
}

/// Runs only inside the admitted worker, before Completing releases its lease.
/// Unsupported postprocessing is recorded without changing a completed Solve
/// into a failure. A storage/ownership failure still prevents false publication.
pub(crate) fn prepare_and_publish(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    execution: &crate::accepted_study_worker::AcceptedRunnerExecution,
) -> Result<()> {
    if execution.status != fullmag_runner::RunStatus::Completed { return Ok(()); }
    let source = execution.accepted_state_ref.as_ref();
    let is_live_study = accepted.run.specification.parameters.get("live_workspace").is_some();
    if source.is_none() && !is_live_study { return Ok(()); }
    let study_step = accepted.study.steps.iter().find(|candidate| candidate.step_id == step.step_id)
        .context("materialization study step missing")?;
    let mut states = execution.outputs.iter().filter(|output| {
        (source.is_some() || output.port_id == crate::study_execution_contract::FINAL_STATE_PORT)
            && study_step.outputs.iter().any(|port| port.port_id == output.port_id
                && port.data_kind == fullmag_authoring::StudyPortDataKind::State)
    });
    let Some(output) = states.next() else { return Ok(()); };
    if states.next().is_some() { bail!("materialization requires one exact final state"); }
    let declared_bytes = execution.outputs.iter().fold(0u64,
        |total, output| total.saturating_add(output.bytes.len() as u64));
    // Private terminal files coexist with declared outputs and CAS until the
    // attempt is retained/collected. Reserve their complete upper bound too.
    let storage_budget = step.claim.lease.budget.storage_bytes
        .saturating_sub(declared_bytes)
        .saturating_sub(step.claim.lease.budget.storage_bytes / 4) / 2;
    let budget = storage_budget.min(crate::accepted_observation_spool::MAX_MANIFEST_BYTES);
    let field_budget = step.claim.lease.budget.memory_bytes / 16;
    let legacy_budget = storage_budget.min(MAX_BUNDLE_BYTES / 2)
        .min(step.claim.lease.budget.memory_bytes / 16);
    if budget < 4096 && execution.terminal_stats.is_none() && execution.completion.is_none() {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted quantities omitted: no observation storage budget after declared outputs");
        return Ok(());
    }
    if source.is_none()
        && (output.codec_id != fullmag_application::STUDY_MAGNETIZATION_CODEC_ID
            || output.codec_version != fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION)
    {
        return Ok(());
    }
    let state_object_ref = fullmag_application::study_artifact_content_sha256(&output.bytes);
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "state", &output.codec_id, &output.codec_version, &output.bytes)?;
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("materialization requires an accepted magnetization artifact");
    };
    let Some(source) = source else {
        publish_terminal_layout(store, step, &state, &state_object_ref, budget)?;
        return Ok(());
    };
    let artifact_id = format!("accepted-quantities-{}", fullmag_session::canonical_json_sha256(&json!({
        "run": step.claim.run_id, "task": step.claim.task_id,
        "attempt": step.claim.attempt_id, "epoch": step.claim.ownership_epoch,
        "source": source, "state": state_object_ref,
    })));
    let terminal_stats = execution.terminal_stats.as_ref().and_then(|stats| {
        match build_terminal_scalar_stats(step, source, &state_object_ref, stats, &state) {
            Ok(record) => Some(record),
            Err(error) => {
                tracing::warn!(task_id = %step.claim.task_id.as_str(), error = %error,
                    "accepted terminal scalar statistics do not match the final state; scalar row omitted");
                None
            }
        }
    });
    let terminal_stats_bytes = if let Some(record) = terminal_stats.as_ref() {
        publish_terminal_scalar_stats(store, step, record, budget)?.unwrap_or(0)
    } else {
        0
    };
    let completion_bytes = if let Some(completion) = execution.completion.as_ref() {
        let record = build_terminal_completion(store, step, source, &state_object_ref, completion, &state)?;
        publish_terminal_completion(store, step, &record, budget.saturating_sub(terminal_stats_bytes))?
            .unwrap_or(0)
    } else { 0 };
    let quantity_budget = budget.saturating_sub(terminal_stats_bytes).saturating_sub(completion_bytes);
    let layout_bytes = if is_live_study
        && output.port_id == crate::study_execution_contract::FINAL_STATE_PORT
    {
        publish_terminal_layout(store, step, &state, &state_object_ref, quantity_budget)?
    } else {
        0
    };
    let quantity_budget = quantity_budget.saturating_sub(layout_bytes);
    let can_materialize_quantities = quantity_budget >= 4096;
    if !can_materialize_quantities && terminal_stats_bytes == 0 {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted quantities omitted: no observation storage budget after declared outputs");
        return Ok(());
    }
    // Receipt recovery never repeats the evaluator after its artifact committed.
    if let Some(catalog) = store.read_artifact_catalog(step.claim.run_id.as_str())? {
        if let Some(entry) = catalog.entries.iter().find(|entry| entry.artifact_id == artifact_id) {
            let record = read_record(store, entry)?;
            if record.source != *source || record.state_object_ref != state_object_ref {
                bail!("accepted materialization replay identity differs");
            }
            return Ok(());
        }
        if catalog.entries.iter().any(|entry| entry.task_id == step.claim.task_id.as_str()
            && entry.attempt_id == step.claim.attempt_id.as_str()
            && entry.ownership_epoch == step.claim.ownership_epoch.value()
            && entry.artifact_type == "study_output_manifest") {
            // Historical completion stays immutable. Never allocate a fresh
            // evaluator as a side effect of recovering an old manifest.
            return Ok(());
        }
    }
    let mut binary_fields = BTreeMap::new();
    let mut binary_entries = Vec::new();
    let evaluated = (|| -> Result<AcceptedMaterializationBatch> {
        if !can_materialize_quantities {
            bail!("accepted quantities omitted: no observation storage budget after declared outputs");
        }
        let plan = crate::accepted_study_worker::materialize_resolved_study_inputs(store, step)?;
        // FDM binds the immutable authored plan plus requested execution;
        // FEM binds its accepted preparation plan fingerprint. Neither digest
        // is calculated from the copy whose initial M was replaced from CAS.
        let accepted_plan_digest = if step.resolved_input.requested_execution.backend == "fem" {
            format!("sha256:{}", step.resolved_input.plan_fingerprint.trim_start_matches("sha256:"))
        } else {
            format!("sha256:{}", fullmag_session::canonical_json_sha256(&json!({
                "schema_version": "fullmag.accepted-state-plan.v1",
                "problem": &step.problem,
                "execution_plan": &step.execution_plan,
                "requested_execution": &step.resolved_input.requested_execution,
            })))
        };
        let lane = match (step.resolved_input.requested_execution.backend.as_str(),
            step.resolved_input.requested_execution.device.as_str()) {
            ("fdm", "cpu") => AcceptedMaterializationLane::FdmCpu,
            ("fdm", "gpu") => AcceptedMaterializationLane::FdmGpu,
            ("fem", "cpu") => AcceptedMaterializationLane::FemCpu,
            ("fem", "gpu") => AcceptedMaterializationLane::FemGpu,
            _ => bail!("accepted materialization has no exact resolved lane"),
        };
        let magnetization = AcceptedMagnetizationInput {
            values: state.values,
            layout: state.layout,
            content_sha256: state_object_ref.clone(),
            native_state_snapshot: state.native_state_snapshot,
            native_node_map: state.native_node_map,
            provenance: state.provenance,
        };
        let request = AcceptedMaterializationRequest {
            plan: &plan, problem: &step.problem, source, lane,
            accepted_plan_digest: &accepted_plan_digest,
            clock: fullmag_quantities::ObservationClock {
                accepted_step: state.step, time_seconds: state.time_s,
                dt_seconds: (state.solver_dt_s > 0.0).then_some(state.solver_dt_s),
            },
            magnetization: &magnetization,
            requested_quantity_ids: &[],
        };
        if let Some(spool) = crate::accepted_observation_spool::read_manifest(&execution.attempt_output_dir)? {
            return materialize_spool(store, step, &artifact_id, &execution.attempt_output_dir,
                &request, spool, field_budget, storage_budget.saturating_sub(budget), &mut binary_fields, &mut binary_entries);
        }
        // Legacy recovery has no field-at-a-time endpoint capture. Keep its
        // original all-in-memory guard, independently of the new stream path.
        let estimated = u64::try_from(magnetization.values.len()).unwrap_or(u64::MAX)
            .saturating_mul(32).saturating_mul(24);
        if estimated > legacy_budget { bail!("legacy quantity recovery requires a new streamed observation run for this domain"); }
        let capture_path = execution.attempt_output_dir.join(
            crate::accepted_study_worker::ACCEPTED_OBSERVABLE_CAPTURE_FILE);
        match std::fs::symlink_metadata(&capture_path) {
            Ok(_) => {
                let bytes = crate::accepted_study_worker::read_explicit_runner_artifact(
                    &execution.attempt_output_dir,
                    crate::accepted_study_worker::ACCEPTED_OBSERVABLE_CAPTURE_FILE,
                    legacy_budget,
                ).context("read original-context accepted observations")?;
                let capture: fullmag_runner::CapturedSolverObservables = serde_json::from_slice(&bytes)
                    .context("decode original-context accepted observations")?;
                // A present but mismatched capture is never replaced by a
                // fresh time-zero evaluator. Fail closed and preserve evidence.
                fullmag_runner::materialize_captured_observables(&request, capture)
                    .map_err(anyhow::Error::msg)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                materialize_accepted_observables(&request).map_err(anyhow::Error::msg)
            }
            Err(error) => Err(error).context("inspect original-context accepted observations"),
        }
    })();
    let (batch, error) = match evaluated {
        Ok(batch) => (Some(batch), None),
        Err(error) if is_store_writer_busy(&error) => return Err(error),
        Err(error) => (None, Some(format!("{error:#}").chars().take(2048).collect())),
    };
    let mut record = MaterializationRecord { schema_version: SCHEMA.into(),
        source: source.clone(), state_object_ref, batch, error, binary_fields };
    if record.batch.is_none() {
        record.binary_fields.clear();
        binary_entries.clear();
    }
    let mut bytes = serde_json::to_vec(&record)?;
    if bytes.len() as u64 > quantity_budget {
        record.batch = None;
        record.error = Some("accepted quantity bundle exceeds its serialized storage budget".into());
        record.binary_fields.clear();
        binary_entries.clear();
        bytes = serde_json::to_vec(&record)?;
    }
    if bytes.len() as u64 > quantity_budget {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted quantity receipt omitted: observation storage budget exhausted");
        return Ok(());
    }
    let object_ref = retry_worker_store_writer_busy(|| store.cas().put(&bytes))?;
    let lease = store.read_resource_lease(step.claim.run_id.as_str(),
        step.claim.lease.resource_id.as_str(), step.claim.lease.lease_token.as_str())?
        .context("materialization resource lease missing")?;
    let entry = FmsArtifactCatalogEntry {
        artifact_id, task_id: step.claim.task_id.as_str().into(),
        attempt_id: step.claim.attempt_id.as_str().into(),
        ownership_epoch: step.claim.ownership_epoch.value(),
        logical_path: format!("outputs/{}/{}/accepted-quantities.v1.json",
            step.claim.task_id.as_str(), step.claim.attempt_id.as_str()),
        artifact_type: ARTIFACT_TYPE.into(), content_sha256: object_ref.clone(),
        object_ref: Some(object_ref), status: FmsArtifactStatus::Published,
        required: false, study_output: None,
    };
    binary_entries.push(entry);
    retry_worker_store_writer_busy(|| {
        store.append_artifact_catalog_entries_for_lease(&lease, &binary_entries)
    })?;
    Ok(())
}

/// This module runs inside the worker, which waits for the shared writer
/// rather than losing a computed result (`WORKER_STORE_WRITER_WAIT`).
fn retry_worker_store_writer_busy<T>(operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_worker_store_transient(operation)
}

pub(crate) fn field_key(field: &fullmag_runner::AcceptedMaterializedField) -> String {
    format!("{}:{}", field.role, field.quantity_id)
}

fn materialize_spool(
    store: &SessionStore, step: &AcceptedWorkerStep, bundle_id: &str, root: &std::path::Path,
    request: &AcceptedMaterializationRequest<'_>, spool: crate::accepted_observation_spool::TerminalObservationSpool,
    field_budget: u64, storage_budget: u64, references: &mut BTreeMap<String, BinaryFieldRef>,
    entries: &mut Vec<FmsArtifactCatalogEntry>,
) -> Result<AcceptedMaterializationBatch> {
    let expected = fullmag_runner::accepted_observation_quantity_ids(request.plan, request.lane)
        .map_err(anyhow::Error::msg)?;
    let mut seen = BTreeSet::new();
    for field in &spool.fields {
        if !seen.insert(field.metadata.quantity_id.as_str())
            || !expected.contains(&field.metadata.quantity_id.as_str()) {
            bail!("terminal observation stream has an unknown or duplicated quantity");
        }
    }
    if expected.iter().any(|id| !seen.contains(id)) {
        bail!("terminal observation stream is incomplete for the active catalog");
    }
    let mut merged: Option<AcceptedMaterializationBatch> = None;
    let mut stored_bytes = 0_u64;
    for field in &spool.fields {
        let values = crate::accepted_observation_spool::read_field(root, field, field_budget)?;
        let id = fullmag_quantities::normalize_quantity_id(&values.quantity_id)?;
        let selected = [id];
        let selected_request = AcceptedMaterializationRequest {
            plan: request.plan, problem: request.problem, source: request.source,
            accepted_plan_digest: request.accepted_plan_digest, lane: request.lane,
            clock: request.clock, magnetization: request.magnetization,
            requested_quantity_ids: &selected,
        };
        let mut capture = spool.capture.clone();
        capture.fields = vec![values];
        // Reuse the exact-state/map/clock/provenance guards. This evaluates no
        // integrator and holds only one captured quantity at a time.
        let mut batch = fullmag_runner::materialize_captured_observables(&selected_request, capture)
            .map_err(anyhow::Error::msg)?;
        let mut metadata = Vec::new();
        for mut materialized in std::mem::take(&mut batch.fields) {
            // M was validated against the accepted state above and already
            // has its own durable state output; do not store a second copy.
            if materialized.quantity_id == "m" && materialized.role != "airbox" { continue; }
            let value_count = materialized.values.len();
            let value_bytes = (value_count as u64).checked_mul(8).context("binary field size overflow")?;
            if value_bytes > field_budget { bail!("materialized quantity exceeds its per-field budget"); }
            let values_sha256 = fullmag_runner::live_preview_values_sha256(&materialized.values);
            let chunk_bytes = materialized.values.chunks(65_536).map(|values| {
                let mut bytes = Vec::with_capacity(values.len() * 8);
                for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
                bytes
            }).collect::<Vec<_>>();
            let chunk_slices = chunk_bytes.iter().map(Vec::as_slice).collect::<Vec<_>>();
            let hashes = publish_observation_objects(store, step, bundle_id, &chunk_slices,
                storage_budget, &mut stored_bytes, entries)?;
            let chunks = hashes.into_iter().zip(materialized.values.chunks(65_536)).enumerate()
                .map(|(ordinal, (hash, values))| BinaryFieldChunk { object_ref: hash,
                    value_offset: ordinal * 65_536, value_count: values.len() })
                .collect::<Vec<_>>();
            // Preserve the original Airbox JSON digest proof without keeping
            // its large JSON tree inside the metadata record or live snapshot.
            if let Some(serde_json::Value::String(raw)) = materialized.layout.as_object_mut()
                .and_then(|object| object.remove("field_artifact_json")) {
                let hash = publish_observation_object(store, step, bundle_id, raw.as_bytes(),
                    storage_budget, &mut stored_bytes, entries)?;
                if materialized.layout.pointer("/manifest/field_artifact_sha256")
                    .and_then(Value::as_str) != Some(hash.as_str()) {
                    bail!("Airbox artifact digest differs before binary publication");
                }
                if let Some(layout) = materialized.layout.as_object_mut() {
                    layout.remove("field_artifact");
                    layout.insert("field_artifact_object_ref".into(), json!(hash));
                }
            }
            let reference = BinaryFieldRef { schema_version: "fullmag.accepted_field.f64le.v1".into(),
                value_count, values_sha256, max_read_bytes: field_budget, chunks };
            reference.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if references.insert(field_key(&materialized), reference).is_some() {
                bail!("materialized stream contains a repeated carrier");
            }
            if let Some(layout) = materialized.layout.as_object_mut() {
                let min = materialized.values.iter().copied().fold(f64::INFINITY, f64::min);
                let max = materialized.values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let mean = materialized.values.iter().map(|value| value / value_count as f64).sum::<f64>();
                layout.insert("accepted_value_summary".into(), json!({
                    "sample_count": value_count, "min": min, "max": max,
                    "mean": mean.is_finite().then_some(mean),
                }));
            }
            materialized.values.clear();
            materialized.values.shrink_to_fit();
            metadata.push(materialized);
        }
        match merged.as_mut() {
            None => { batch.fields = metadata; merged = Some(batch); }
            Some(output) => {
                if output.source != batch.source || output.clock != batch.clock
                    || output.energies != batch.energies { bail!("binary quantities have different accepted endpoints"); }
                output.fields.extend(metadata);
                output.unavailable_scopes.extend(batch.unavailable_scopes);
            }
        }
    }
    merged.context("terminal observation stream contains no fields")
}

fn publish_observation_object(
    store: &SessionStore, step: &AcceptedWorkerStep, bundle_id: &str, bytes: &[u8],
    budget: u64, used: &mut u64, entries: &mut Vec<FmsArtifactCatalogEntry>,
) -> Result<String> {
    let mut hashes = publish_observation_objects(
        store, step, bundle_id, &[bytes], budget, used, entries)?;
    hashes.pop().context("observation publication returned no digest")
}

/// Publish one field's chunks in a single CAS batch: one writer lease and one
/// barrier per directory instead of a lease and two barriers per chunk.
fn publish_observation_objects(
    store: &SessionStore, step: &AcceptedWorkerStep, bundle_id: &str, objects: &[&[u8]],
    budget: u64, used: &mut u64, entries: &mut Vec<FmsArtifactCatalogEntry>,
) -> Result<Vec<String>> {
    for bytes in objects {
        *used = used.checked_add(bytes.len() as u64).context("observation storage size overflow")?;
    }
    if *used > budget { bail!("binary observations exceed the remaining storage lease"); }
    let hashes = retry_worker_store_writer_busy(|| store.cas().put_batch(objects))?;
    for hash in &hashes {
        record_observation_entry(step, bundle_id, hash, entries);
    }
    Ok(hashes)
}

fn record_observation_entry(
    step: &AcceptedWorkerStep, bundle_id: &str, hash: &str,
    entries: &mut Vec<FmsArtifactCatalogEntry>,
) {
    let hash = hash.to_string();
    if !entries.iter().any(|entry| entry.content_sha256 == hash) {
        entries.push(FmsArtifactCatalogEntry {
            artifact_id: format!("accepted-field-{}", fullmag_session::canonical_json_sha256(
                &json!({"bundle": bundle_id, "content": hash}))),
            task_id: step.claim.task_id.as_str().into(), attempt_id: step.claim.attempt_id.as_str().into(),
            ownership_epoch: step.claim.ownership_epoch.value(),
            logical_path: format!("outputs/{}/{}/observations/{hash}.bin", step.claim.task_id.as_str(), step.claim.attempt_id.as_str()),
            artifact_type: "accepted_quantity_payload".into(), content_sha256: hash.clone(),
            object_ref: Some(hash.clone()), status: FmsArtifactStatus::Published,
            required: false, study_output: None,
        });
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
}

pub(crate) fn read_record(store: &SessionStore, entry: &FmsArtifactCatalogEntry) -> Result<MaterializationRecord> {
    if entry.artifact_type != ARTIFACT_TYPE || entry.status != FmsArtifactStatus::Published
        || entry.object_ref.as_deref() != Some(entry.content_sha256.as_str())
        || entry.study_output.is_some() {
        bail!("accepted quantity artifact binding is invalid");
    }
    let bytes = store.cas().get_bounded(&entry.content_sha256, MAX_BUNDLE_BYTES)?
        .context("accepted quantity CAS object missing")?;
    if bytes.len() as u64 > MAX_BUNDLE_BYTES
        || fullmag_application::study_artifact_content_sha256(&bytes) != entry.content_sha256 {
        bail!("accepted quantity CAS digest or size differs");
    }
    let record: MaterializationRecord = serde_json::from_slice(&bytes)?;
    if record.schema_version != SCHEMA || record.batch.is_some() == record.error.is_some() {
        bail!("accepted quantity receipt schema/outcome invalid");
    }
    record.source.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if let Some(batch) = record.batch.as_ref() {
        batch.clock.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if batch.source != record.source
            || batch.clock.accepted_step != record.source.id.accepted_step
            || batch.clock.digest().map_err(|error| anyhow::anyhow!(error.to_string()))? != record.source.id.clock_digest
            || batch.magnetization_content_sha256 != record.state_object_ref
            || batch.plan_sha256.trim_start_matches("sha256:") != record.source.id.plan_digest.trim_start_matches("sha256:") {
            bail!("accepted quantity batch does not match its source and pinned plan");
        }
        if !record.binary_fields.is_empty() {
            if record.binary_fields.len() != batch.fields.len() {
                bail!("binary field metadata is incomplete");
            }
            for field in &batch.fields {
                let reference = record.binary_fields.get(&field_key(field))
                    .context("binary quantity reference missing")?;
                reference.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if !field.values.is_empty() { bail!("binary receipt must not duplicate inline values"); }
            }
        }
    }
    Ok(record)
}

fn build_terminal_scalar_stats(
    step: &AcceptedWorkerStep,
    source: &fullmag_quantities::AcceptedStateRef,
    state_object_ref: &str,
    stats: &fullmag_runner::StepStats,
    state: &fullmag_application::MagnetizationStateArtifact,
) -> Result<TerminalScalarStatsRecord> {
    source.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    validate_scalar_row_stats(stats)?;
    let clock = fullmag_quantities::ObservationClock {
        accepted_step: stats.step,
        time_seconds: stats.time,
        dt_seconds: (stats.dt > 0.0).then_some(stats.dt),
    };
    clock.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if source.id.run_id != step.claim.run_id.as_str()
        || source.id.stage_id.as_deref() != Some(step.step_id.as_str())
        || source.generation.runtime_epoch != step.claim.ownership_epoch.value()
        || source.id.accepted_step != stats.step
        || source.id.clock_digest != clock.digest().map_err(|error| anyhow::anyhow!(error.to_string()))?
        || state.step != stats.step
        || state.time_s.to_bits() != stats.time.to_bits()
        || state.solver_dt_s.to_bits() != stats.dt.to_bits()
    {
        bail!("terminal scalar clock or state identity differs from the accepted final state");
    }
    let record = TerminalScalarStatsRecord {
        schema_version: TERMINAL_SCALAR_STATS_SCHEMA.into(),
        run_id: step.claim.run_id.as_str().into(),
        task_id: step.claim.task_id.as_str().into(),
        step_id: step.step_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().into(),
        ownership_epoch: step.claim.ownership_epoch.value(),
        source: source.clone(),
        state_object_ref: state_object_ref.to_owned(),
        stats: stats.clone(),
    };
    if serde_json::to_vec(&record)?.len() as u64 > MAX_TERMINAL_SCALAR_STATS_BYTES {
        bail!("terminal scalar record exceeds its bounded storage budget");
    }
    Ok(record)
}

fn validate_terminal_scalar_record(
    stats: &TerminalScalarStatsRecord,
    entry: &FmsArtifactCatalogEntry,
) -> Result<()> {
    stats.source.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    validate_scalar_row_stats(&stats.stats)?;
    let clock = fullmag_quantities::ObservationClock {
        accepted_step: stats.stats.step,
        time_seconds: stats.stats.time,
        dt_seconds: (stats.stats.dt > 0.0).then_some(stats.stats.dt),
    };
    clock.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if stats.schema_version != TERMINAL_SCALAR_STATS_SCHEMA
        || stats.run_id != stats.source.id.run_id
        || stats.task_id != entry.task_id
        || stats.attempt_id != entry.attempt_id
        || stats.ownership_epoch != entry.ownership_epoch
        || stats.source.generation.runtime_epoch != entry.ownership_epoch
        || stats.step_id != stats.source.id.stage_id.as_deref().unwrap_or_default()
        || stats.state_object_ref.len() != 64
        || !stats.state_object_ref.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || stats.source.id.accepted_step != stats.stats.step
        || stats.source.id.clock_digest != clock.digest().map_err(|error| anyhow::anyhow!(error.to_string()))?
        || entry.artifact_id != terminal_scalar_artifact_id(stats)
        || entry.logical_path != terminal_scalar_logical_path(stats)
        || entry.required
        || entry.study_output.is_some()
    {
        bail!("accepted terminal scalar record identity or clock differs from its artifact pin");
    }
    Ok(())
}

fn terminal_scalar_artifact_id(stats: &TerminalScalarStatsRecord) -> String {
    format!("accepted-terminal-scalar-{}", fullmag_session::canonical_json_sha256(&json!({
        "run": stats.run_id, "task": stats.task_id, "step": stats.step_id,
        "attempt": stats.attempt_id, "epoch": stats.ownership_epoch,
        "source": stats.source, "state": stats.state_object_ref,
    })))
}

fn terminal_scalar_logical_path(stats: &TerminalScalarStatsRecord) -> String {
    format!("outputs/{}/{}/accepted-terminal-scalar-stats.v1.json", stats.task_id, stats.attempt_id)
}

pub(crate) fn read_terminal_scalar_stats(
    store: &SessionStore,
    entry: &FmsArtifactCatalogEntry,
) -> Result<TerminalScalarStatsRecord> {
    if entry.artifact_type != TERMINAL_SCALAR_ARTIFACT_TYPE
        || entry.status != FmsArtifactStatus::Published
        || entry.object_ref.as_deref() != Some(entry.content_sha256.as_str())
        || entry.study_output.is_some()
    {
        bail!("accepted terminal scalar artifact binding is invalid");
    }
    let bytes = store.cas().get_bounded(&entry.content_sha256, MAX_TERMINAL_SCALAR_STATS_BYTES)?
        .context("accepted terminal scalar CAS object missing")?;
    if bytes.len() as u64 > MAX_TERMINAL_SCALAR_STATS_BYTES
        || fullmag_application::study_artifact_content_sha256(&bytes) != entry.content_sha256
    {
        bail!("accepted terminal scalar CAS digest or size differs");
    }
    let stats: TerminalScalarStatsRecord = serde_json::from_slice(&bytes)?;
    validate_terminal_scalar_record(&stats, entry)?;
    Ok(stats)
}

fn publish_terminal_scalar_stats(
    store: &SessionStore,
    step: &AcceptedWorkerStep,
    stats: &TerminalScalarStatsRecord,
    budget: u64,
) -> Result<Option<u64>> {
    let bytes = serde_json::to_vec(stats)?;
    if bytes.len() as u64 > MAX_TERMINAL_SCALAR_STATS_BYTES {
        bail!("accepted terminal scalar artifact exceeds its bounded storage limit");
    }
    let artifact_id = terminal_scalar_artifact_id(stats);
    let logical_path = terminal_scalar_logical_path(stats);
    if let Some(catalog) = store.read_artifact_catalog(step.claim.run_id.as_str())? {
        let matching = catalog.entries.iter().filter(|entry| {
            entry.artifact_type == TERMINAL_SCALAR_ARTIFACT_TYPE
                && entry.task_id == step.claim.task_id.as_str()
                && entry.attempt_id == step.claim.attempt_id.as_str()
                && entry.ownership_epoch == step.claim.ownership_epoch.value()
        }).collect::<Vec<_>>();
        if matching.len() > 1 {
            bail!("accepted terminal scalar artifact pin is ambiguous for this task attempt");
        }
        if let Some(existing_entry) = matching.first() {
            if existing_entry.artifact_id != artifact_id {
                bail!("accepted terminal scalar replay identity differs from its immutable artifact");
            }
            let existing = read_terminal_scalar_stats(store, existing_entry)?;
            if fullmag_session::canonical_json_sha256(&serde_json::to_value(&existing)?)
                != fullmag_session::canonical_json_sha256(&serde_json::to_value(stats)?)
            {
                bail!("accepted terminal scalar replay differs from its immutable artifact");
            }
            return Ok(Some(bytes.len() as u64));
        }
        if catalog.entries.iter().any(|entry| {
            entry.task_id == step.claim.task_id.as_str()
                && entry.attempt_id == step.claim.attempt_id.as_str()
                && entry.ownership_epoch == step.claim.ownership_epoch.value()
                && entry.artifact_type == "study_output_manifest"
        }) {
            tracing::warn!(task_id = %step.claim.task_id.as_str(),
                "accepted terminal scalar artifact omitted after immutable output manifest publication");
            return Ok(None);
        }
    }
    if bytes.len() as u64 > budget {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted terminal scalar artifact omitted: bounded storage budget exhausted");
        return Ok(None);
    }
    let object_ref = retry_worker_store_writer_busy(|| store.cas().put(&bytes))?;
    let lease = store.read_resource_lease(step.claim.run_id.as_str(),
        step.claim.lease.resource_id.as_str(), step.claim.lease.lease_token.as_str())?
        .context("terminal scalar publication resource lease missing")?;
    let entry = FmsArtifactCatalogEntry {
        artifact_id,
        task_id: stats.task_id.clone(),
        attempt_id: stats.attempt_id.clone(),
        ownership_epoch: stats.ownership_epoch,
        logical_path,
        artifact_type: TERMINAL_SCALAR_ARTIFACT_TYPE.into(),
        content_sha256: object_ref.clone(),
        object_ref: Some(object_ref),
        status: FmsArtifactStatus::Published,
        required: false,
        study_output: None,
    };
    retry_worker_store_writer_busy(|| {
        store.append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
    })?;
    Ok(Some(bytes.len() as u64))
}

fn build_terminal_completion(
    store: &SessionStore,
    step: &AcceptedWorkerStep,
    source: &fullmag_quantities::AcceptedStateRef,
    state_object_ref: &str,
    completion: &fullmag_ir::StageCompletionIR,
    state: &fullmag_application::MagnetizationStateArtifact,
) -> Result<TerminalCompletionRecord> {
    source.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    validate_completion(completion)?;
    let clock = fullmag_quantities::ObservationClock {
        accepted_step: state.step,
        time_seconds: state.time_s,
        dt_seconds: (state.solver_dt_s > 0.0).then_some(state.solver_dt_s),
    };
    clock.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if source.id.run_id != step.claim.run_id.as_str()
        || source.id.stage_id.as_deref() != Some(step.step_id.as_str())
        || source.generation.runtime_epoch != step.claim.ownership_epoch.value()
        || source.id.accepted_step != state.step
        || source.id.clock_digest != clock.digest().map_err(|error| anyhow::anyhow!(error.to_string()))?
        || !state.solver_dt_s.is_finite() || state.solver_dt_s < 0.0
    {
        bail!("terminal completion clock or state identity differs from the accepted final state");
    }
    let catalog = store.read_run_catalog(step.claim.run_id.as_str())?
        .context("completion publication run catalog missing")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == step.claim.task_id.as_str()
        && task.attempt_id.as_deref() == Some(step.claim.attempt_id.as_str())
        && task.ownership_epoch == Some(step.claim.ownership_epoch.value()))
        .context("completion publication task attempt missing")?;
    let record = TerminalCompletionRecord {
        schema_version: TERMINAL_COMPLETION_SCHEMA.into(),
        run_id: step.claim.run_id.as_str().into(),
        task_id: step.claim.task_id.as_str().into(),
        step_id: step.step_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().into(),
        ownership_epoch: step.claim.ownership_epoch.value(),
        source: source.clone(),
        state_object_ref: state_object_ref.to_owned(),
        clock,
        solver_dt_s: state.solver_dt_s,
        completion: completion.clone(),
        input_fingerprint: task.input_fingerprint.clone(),
        resolved_input_fingerprint: task.resolved_input_fingerprint.clone(),
    };
    if serde_json::to_vec(&record)?.len() as u64 > MAX_TERMINAL_COMPLETION_BYTES {
        bail!("terminal completion record exceeds its bounded storage budget");
    }
    Ok(record)
}

fn validate_terminal_completion_record(
    stats: &TerminalCompletionRecord,
    entry: &FmsArtifactCatalogEntry,
) -> Result<()> {
    stats.source.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    validate_completion(&stats.completion)?;
    let clock = &stats.clock;
    clock.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if stats.schema_version != TERMINAL_COMPLETION_SCHEMA
        || stats.run_id != stats.source.id.run_id
        || stats.task_id != entry.task_id
        || stats.attempt_id != entry.attempt_id
        || stats.ownership_epoch != entry.ownership_epoch
        || stats.source.generation.runtime_epoch != entry.ownership_epoch
        || stats.step_id != stats.source.id.stage_id.as_deref().unwrap_or_default()
        || stats.state_object_ref.len() != 64
        || !stats.state_object_ref.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || stats.source.id.accepted_step != clock.accepted_step
        || !stats.solver_dt_s.is_finite() || stats.solver_dt_s < 0.0
        || clock.dt_seconds != (stats.solver_dt_s > 0.0).then_some(stats.solver_dt_s)
        || stats.source.id.clock_digest != clock.digest().map_err(|error| anyhow::anyhow!(error.to_string()))?
        || stats.input_fingerprint.len() != 64
        || entry.artifact_id != terminal_completion_artifact_id(stats)
        || entry.logical_path != terminal_completion_logical_path(stats)
        || entry.required
        || entry.study_output.is_some()
    {
        bail!("accepted terminal completion record identity or clock differs from its artifact pin");
    }
    Ok(())
}

fn terminal_completion_artifact_id(stats: &TerminalCompletionRecord) -> String {
    format!("accepted-terminal-completion-{}", fullmag_session::canonical_json_sha256(&json!({
        "run": stats.run_id, "task": stats.task_id, "step": stats.step_id,
        "attempt": stats.attempt_id, "epoch": stats.ownership_epoch,
        "source": stats.source, "state": stats.state_object_ref,
        "input": stats.input_fingerprint, "resolved_input": stats.resolved_input_fingerprint,
    })))
}

fn terminal_completion_logical_path(stats: &TerminalCompletionRecord) -> String {
    format!("outputs/{}/{}/accepted-terminal-completion.v1.json", stats.task_id, stats.attempt_id)
}

pub(crate) fn read_terminal_completion(
    store: &SessionStore,
    entry: &FmsArtifactCatalogEntry,
) -> Result<TerminalCompletionRecord> {
    if entry.artifact_type != TERMINAL_COMPLETION_ARTIFACT_TYPE
        || entry.status != FmsArtifactStatus::Published
        || entry.object_ref.as_deref() != Some(entry.content_sha256.as_str())
        || entry.study_output.is_some()
    {
        bail!("accepted terminal completion artifact binding is invalid");
    }
    let bytes = store.cas().get_bounded(&entry.content_sha256, MAX_TERMINAL_COMPLETION_BYTES)?
        .context("accepted terminal completion CAS object missing")?;
    if bytes.len() as u64 > MAX_TERMINAL_COMPLETION_BYTES
        || fullmag_application::study_artifact_content_sha256(&bytes) != entry.content_sha256
    {
        bail!("accepted terminal completion CAS digest or size differs");
    }
    let stats: TerminalCompletionRecord = serde_json::from_slice(&bytes)?;
    validate_terminal_completion_record(&stats, entry)?;
    Ok(stats)
}

/// Qualify completion against the already verified final-state manifest and
/// its succeeded task. This reads only a bounded completion record.
pub(crate) fn terminal_completion_for_final_state(
    store: &SessionStore,
    artifacts: &fullmag_session::FmsArtifactCatalog,
    task: &fullmag_session::FmsTaskCatalogEntry,
    step_id: &str,
    source: &fullmag_quantities::AcceptedStateRef,
    state_object_ref: &str,
) -> Option<TerminalCompletionRecord> {
    let attempt_id = task.attempt_id.as_deref()?;
    let ownership_epoch = task.ownership_epoch?;
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
        || source.id.run_id != artifacts.run_id
        || source.id.stage_id.as_deref() != Some(step_id)
        || source.generation.runtime_epoch != ownership_epoch
    {
        return None;
    }
    let mut matches = artifacts.entries.iter().filter(|entry| {
        task.artifact_ids.contains(&entry.artifact_id)
            && entry.task_id == task.task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
            && entry.artifact_type == TERMINAL_COMPLETION_ARTIFACT_TYPE
            && entry.status == FmsArtifactStatus::Published
    });
    let entry = matches.next()?;
    if matches.next().is_some() {
        tracing::warn!(task_id = %task.task_id, "terminal completion artifact pin is ambiguous");
        return None;
    }
    let record = match read_terminal_completion(store, entry) {
        Ok(record) => record,
        Err(error) => {
            tracing::warn!(task_id = %task.task_id, error = %error, "invalid terminal completion artifact");
            return None;
        }
    };
    if &record.source != source
        || record.state_object_ref != state_object_ref
        || record.input_fingerprint != task.input_fingerprint
        || record.resolved_input_fingerprint != task.resolved_input_fingerprint
    {
        tracing::warn!(task_id = %task.task_id, "terminal completion differs from its final state or task input");
        return None;
    }
    Some(record)
}

fn publish_terminal_completion(
    store: &SessionStore,
    step: &AcceptedWorkerStep,
    stats: &TerminalCompletionRecord,
    budget: u64,
) -> Result<Option<u64>> {
    let bytes = serde_json::to_vec(stats)?;
    if bytes.len() as u64 > MAX_TERMINAL_COMPLETION_BYTES {
        bail!("accepted terminal completion artifact exceeds its bounded storage limit");
    }
    let artifact_id = terminal_completion_artifact_id(stats);
    let logical_path = terminal_completion_logical_path(stats);
    if let Some(catalog) = store.read_artifact_catalog(step.claim.run_id.as_str())? {
        let matching = catalog.entries.iter().filter(|entry| {
            entry.artifact_type == TERMINAL_COMPLETION_ARTIFACT_TYPE
                && entry.task_id == step.claim.task_id.as_str()
                && entry.attempt_id == step.claim.attempt_id.as_str()
                && entry.ownership_epoch == step.claim.ownership_epoch.value()
        }).collect::<Vec<_>>();
        if matching.len() > 1 {
            bail!("accepted terminal completion artifact pin is ambiguous for this task attempt");
        }
        if let Some(existing_entry) = matching.first() {
            if existing_entry.artifact_id != artifact_id {
                bail!("accepted terminal completion replay identity differs from its immutable artifact");
            }
            let existing = read_terminal_completion(store, existing_entry)?;
            if fullmag_session::canonical_json_sha256(&serde_json::to_value(&existing)?)
                != fullmag_session::canonical_json_sha256(&serde_json::to_value(stats)?)
            {
                bail!("accepted terminal completion replay differs from its immutable artifact");
            }
            return Ok(Some(bytes.len() as u64));
        }
        if catalog.entries.iter().any(|entry| {
            entry.task_id == step.claim.task_id.as_str()
                && entry.attempt_id == step.claim.attempt_id.as_str()
                && entry.ownership_epoch == step.claim.ownership_epoch.value()
                && entry.artifact_type == "study_output_manifest"
        }) {
            tracing::warn!(task_id = %step.claim.task_id.as_str(),
                "accepted terminal completion artifact omitted after immutable output manifest publication");
            return Ok(None);
        }
    }
    if bytes.len() as u64 > budget {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted terminal completion artifact omitted: bounded storage budget exhausted");
        return Ok(None);
    }
    let object_ref = retry_worker_store_writer_busy(|| store.cas().put(&bytes))?;
    let lease = store.read_resource_lease(step.claim.run_id.as_str(),
        step.claim.lease.resource_id.as_str(), step.claim.lease.lease_token.as_str())?
        .context("terminal completion publication resource lease missing")?;
    let entry = FmsArtifactCatalogEntry {
        artifact_id,
        task_id: stats.task_id.clone(),
        attempt_id: stats.attempt_id.clone(),
        ownership_epoch: stats.ownership_epoch,
        logical_path,
        artifact_type: TERMINAL_COMPLETION_ARTIFACT_TYPE.into(),
        content_sha256: object_ref.clone(),
        object_ref: Some(object_ref),
        status: FmsArtifactStatus::Published,
        required: false,
        study_output: None,
    };
    retry_worker_store_writer_busy(|| {
        store.append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
    })?;
    Ok(Some(bytes.len() as u64))
}

pub(crate) fn validate_scalar_row_stats(stats: &fullmag_runner::StepStats) -> Result<()> {
    if !stats.is_physical_observation() {
        bail!("terminal scalar statistics are not a physical observation");
    }
    let mut values = vec![
        stats.time, stats.dt, stats.mx, stats.my, stats.mz, stats.e_ex,
        stats.e_demag, stats.e_ext, stats.e_ani, stats.e_dmi,
        stats.e_rotated_dmi, stats.e_total, stats.max_dm_dt, stats.max_h_eff,
        stats.max_h_demag, stats.max_torque_Apm, stats.max_torque_T,
    ];
    values.extend([stats.error_estimate, stats.max_error, stats.dt_suggested, stats.pseudo_time_s]
        .into_iter().flatten());
    if values.iter().any(|value| !value.is_finite()) || stats.time < 0.0 || stats.dt < 0.0
        || stats.per_object_scalars.values().flat_map(|values| values.values()).any(|value| !value.is_finite()) {
        bail!("terminal scalar statistics contain invalid physical values");
    }
    Ok(())
}

pub(crate) struct LoadedBundle {
    pub(crate) record: MaterializationRecord,
    pub(crate) state_fingerprint: String,
    pub(crate) specification: Value,
}

pub(crate) fn load_latest_bundle(store_root: &std::path::Path, run_id: &str) -> Result<LoadedBundle> {
    let store = SessionStore::open_existing(store_root)?;
    let intent = store.read_run_intent(run_id)?.context("accepted run intent missing")?;
    intent.validate()?;
    let project_id = serde_json::from_value::<fullmag_application::RunSpecification>(intent.specification.clone())?
        .snapshot.project_id;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store,
        &fullmag_application::RunId::parse(run_id)?, &project_id)?;
    let run = store.read_run_catalog(run_id)?.context("accepted run catalog missing")?;
    let catalog = store.read_artifact_catalog(run_id)?.context("accepted artifact catalog missing")?;
    run.validate()?; catalog.validate()?;
    // Choose the latest state-producing step, never an older available bundle.
    let mut selected = None;
    for step in &accepted.lowered.steps {
        let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
        let Some(task) = run.tasks.iter().find(|task| task.task_id == task_id
            && task.lifecycle == fullmag_session::FmsTaskLifecycle::Succeeded) else { continue; };
        let entries = catalog.entries.iter().filter(|entry| entry.task_id == task.task_id
            && Some(entry.attempt_id.as_str()) == task.attempt_id.as_deref()
            && Some(entry.ownership_epoch) == task.ownership_epoch
            && entry.status == FmsArtifactStatus::Published
            && task.artifact_ids.contains(&entry.artifact_id)).collect::<Vec<_>>();
        let mut manifests = entries.iter().filter(|entry| entry.artifact_type == "study_output_manifest");
        let Some(manifest_entry) = manifests.next() else { continue; };
        if manifests.next().is_some() { bail!("accepted output manifest is ambiguous"); }
        let manifest_ref = manifest_entry.object_ref.as_deref().context("manifest CAS reference missing")?;
        if manifest_ref != manifest_entry.content_sha256 { bail!("manifest CAS digest differs"); }
        let bytes = store.cas().get_bounded(manifest_ref, crate::accepted_observation_spool::MAX_MANIFEST_BYTES)?
            .context("accepted manifest missing from CAS")?;
        if fullmag_application::study_artifact_content_sha256(&bytes) != manifest_ref {
            bail!("accepted manifest content digest differs");
        }
        let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&bytes)?;
        manifest.validate()?;
        if manifest.run_id != run_id || manifest.task_id != task_id
            || manifest.step_id != step.step_id || Some(manifest.attempt_id.as_str()) != task.attempt_id.as_deref()
            || Some(manifest.ownership_epoch) != task.ownership_epoch { bail!("manifest ownership differs"); }
        let mut states = manifest.outputs.iter().filter(|output| output.data_kind == "state");
        let Some(state_output) = states.next() else { continue; };
        if states.next().is_some() { bail!("accepted state output is ambiguous"); }
        let state_entry = entries.iter().find(|entry| entry.artifact_id == state_output.artifact_id
            && entry.object_ref.as_deref() == Some(state_output.object_ref.as_str())
            && entry.content_sha256 == state_output.content_sha256).context("accepted state catalog binding missing")?;
        let admission = store.read_task_admission(run_id, &task.task_id, &manifest.attempt_id)?
            .context("accepted state admission budget missing")?;
        admission.validate()?;
        if admission.lease.ownership_epoch != manifest.ownership_epoch
            || admission.lease.run_id != run_id || admission.lease.task_id != task.task_id {
            bail!("accepted state admission ownership differs");
        }
        let state_budget = (admission.lease.budget.memory_bytes / 4)
            .min(admission.lease.budget.storage_bytes);
        let state_bytes = store.cas().get_bounded(&state_entry.content_sha256, state_budget)?
            .context("accepted state CAS bytes missing")?;
        if fullmag_application::study_artifact_content_sha256(&state_bytes) != state_output.object_ref {
            bail!("accepted state content digest differs");
        }
        let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) =
            fullmag_application::decode_study_artifact_bytes("state", &state_output.codec_id,
                &state_output.codec_version, &state_bytes)? else { bail!("invalid state output"); };
        drop(state_bytes);
        let mut bundles = entries.iter().filter(|entry| entry.artifact_type == ARTIFACT_TYPE);
        let record = match bundles.next() {
            Some(entry) => {
                if bundles.next().is_some() { bail!("accepted quantity bundle is ambiguous"); }
                let record = read_record(&store, entry)?;
                if Some(&record.source) != manifest.accepted_state_ref.as_ref()
                    || record.state_object_ref != state_output.object_ref
                    || record.source.id.accepted_step != state.step {
                    bail!("accepted quantity bundle differs from final state manifest");
                }
                if let Some(batch) = record.batch.as_ref() {
                    for field in &batch.fields {
                        if let Some(reference) = record.binary_fields.get(&field_key(field)) {
                            if reference.max_read_bytes > admission.lease.budget.memory_bytes / 16 {
                                bail!("binary quantity read budget exceeds its producing admission");
                            }
                            let samples = if field.role == "airbox" {
                                let count = field.layout.pointer("/grid/cells").and_then(Value::as_array)
                                    .filter(|axes| axes.len() == 3)
                                    .and_then(|axes| axes.iter().try_fold(1_u64,
                                        |count, axis| count.checked_mul(axis.as_u64()?)))
                                    .context("binary Airbox grid missing")?;
                                usize::try_from(count)?
                            } else { state.values.len() };
                            if samples.checked_mul(field.n_comp) != Some(reference.value_count) {
                                bail!("binary quantity count differs from its accepted carrier");
                            }
                            let mut objects = reference.chunks.iter().map(|chunk| chunk.object_ref.as_str()).collect::<Vec<_>>();
                            if let Some(hash) = field.layout.get("field_artifact_object_ref").and_then(Value::as_str) { objects.push(hash); }
                            for hash in objects {
                                if !entries.iter().any(|entry| entry.artifact_type == "accepted_quantity_payload"
                                    && entry.content_sha256 == hash && entry.object_ref.as_deref() == Some(hash)) {
                                    bail!("binary quantity object lacks its exact task/attempt/epoch catalog binding");
                                }
                            }
                        }
                    }
                }
                Some(LoadedBundle { record, state_fingerprint: state.space_fingerprint,
                    specification: intent.specification.clone() })
            }
            None => None,
        };
        selected = Some(record);
    }
    selected.flatten().context("latest accepted state has no quantity bundle; rerun with this worker version")
}

/// Validate the runner's completion vocabulary and internal consistency only.
/// Scientific confirmations remain owned by the runner. Canonical metric names
/// follow relaxation/convergence.rs and native_fem/runtime_info.rs; the physical
/// bounds match the session time-to-tolerance projection.
pub(crate) fn validate_completion(completion: &fullmag_ir::StageCompletionIR) -> Result<()> {
    use fullmag_ir::{StageMetricKind as Metric, StageStopReason as Reason};
    if completion.status != "completed"
        || completion.metric_value.is_some_and(|value| !value.is_finite() || value < 0.0)
        || completion.threshold.is_some_and(|value| !value.is_finite() || value < 0.0)
        || serde_json::to_vec(completion)?.len() > 4096 {
        bail!("invalid or unbounded runner completion evidence");
    }
    let pair = completion.metric_value.zip(completion.threshold);
    let consistent = match (completion.reason, completion.metric, completion.metric_name.as_deref()) {
        (Some(Reason::Torque), Some(Metric::MaxTorqueApm), Some("max_torque_apm"))
        | (Some(Reason::Energy), Some(Metric::TotalEnergyPlateauRangeJ), Some("total_energy_plateau_range_J")) => {
            completion.converged && pair.is_some_and(|(value, threshold)| value <= threshold)
        }
        (Some(Reason::MaxSteps), Some(Metric::Steps), Some("steps")) => {
            !completion.converged && pair.is_some_and(|(value, threshold)|
                value >= threshold && value.fract() == 0.0 && threshold.fract() == 0.0)
        }
        (Some(Reason::MaxPseudotime | Reason::MaxPhysicalTime),
            Some(Metric::RelaxationTimeS), Some("relaxation_time_s")) => {
            !completion.converged && pair.is_some_and(|(value, threshold)| value >= threshold)
        }
        // Native FEM's representability stop is completed but not converged.
        // Ordinary numerical_stagnation has status=failed and is rejected above.
        (Some(Reason::Gradient), Some(Metric::NumericalStagnation), Some("representability_stationary")) => {
            !completion.converged && (pair.is_some()
                || (completion.metric_value.is_none() && completion.threshold.is_none()))
        }
        // The runner explicitly reports these frozen-domain outcomes without
        // a relaxation metric; retain them without inventing a torque proof.
        (None, None, Some("all_active_dofs_frozen_relaxation" | "all_active_dofs_frozen_time_advance")) => {
            completion.converged && completion.metric_value == Some(0.0) && completion.threshold.is_none()
        }
        // A completed time advance need not carry relaxation evidence.
        (None, None, None) => !completion.converged
            && completion.metric_value.is_none() && completion.threshold.is_none(),
        _ => false,
    };
    if !consistent { bail!("runner completion reason, convergence, metric or threshold are inconsistent"); }
    Ok(())
}

#[cfg(test)]
pub(crate) mod completion_tests {
    use super::*;

    #[test]
    fn saved_layout_requires_the_exact_succeeded_attempt_and_final_state() {
        use fullmag_session::{FmsArtifactCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle};
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let record = TerminalLayoutRecord {
            schema_version: TERMINAL_LAYOUT_SCHEMA.into(),
            run_id: "run-layout".into(),
            task_id: fullmag_session::task_id_for_study_step("run-layout", "relax").unwrap(),
            step_id: "relax".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 2,
            state_object_ref: "a".repeat(64),
            layout_sha256: "b".repeat(64),
            admitted_input_sha256: Some("f".repeat(64)),
        };
        let digest = store.cas().put(&serde_json::to_vec(&record).unwrap()).unwrap();
        let entry = FmsArtifactCatalogEntry {
            artifact_id: record.artifact_id(),
            logical_path: record.logical_path(),
            task_id: record.task_id.clone(),
            attempt_id: record.attempt_id.clone(),
            ownership_epoch: record.ownership_epoch,
            artifact_type: TERMINAL_LAYOUT_ARTIFACT_TYPE.into(),
            object_ref: Some(digest.clone()),
            content_sha256: digest,
            status: FmsArtifactStatus::Published,
            required: false,
            study_output: None,
        };
        let mut catalog = FmsArtifactCatalog {
            schema_version: fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: record.run_id.clone(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            entries: vec![entry.clone()],
        };
        let mut task: FmsTaskCatalogEntry = serde_json::from_value(json!({
            "task_id": record.task_id,
            "input_fingerprint": "c".repeat(64),
            "lifecycle": FmsTaskLifecycle::Succeeded,
            "attempt_id": record.attempt_id,
            "ownership_epoch": record.ownership_epoch,
            "artifact_ids": [entry.artifact_id]
        })).unwrap();
        let read = |catalog: &FmsArtifactCatalog, task: &FmsTaskCatalogEntry, digest: &str| {
            terminal_evidence_for_final_state(&store, catalog, task, &record.step_id, digest)
        };
        assert_eq!(read(&catalog, &task, &record.state_object_ref).as_ref(), Some(&record));
        assert_eq!(read(&catalog, &task, &"d".repeat(64)), None);
        task.ownership_epoch = Some(3);
        assert_eq!(read(&catalog, &task, &record.state_object_ref), None);
        task.ownership_epoch = Some(record.ownership_epoch);
        catalog.entries.push(entry.clone());
        assert_eq!(read(&catalog, &task, &record.state_object_ref), None);
        catalog.entries.clear();
        assert_eq!(read(&catalog, &task, &record.state_object_ref), None);

        let mut old_record = serde_json::to_value(&record).unwrap();
        old_record.as_object_mut().unwrap().remove("admitted_input_sha256");
        let old_digest = store.cas().put(&serde_json::to_vec(&old_record).unwrap()).unwrap();
        catalog.entries.push(FmsArtifactCatalogEntry {
            object_ref: Some(old_digest.clone()),
            content_sha256: old_digest,
            ..entry
        });
        let legacy = read(&catalog, &task, &record.state_object_ref).unwrap();
        assert_eq!(legacy.layout_sha256, record.layout_sha256);
        assert!(legacy.admitted_input_sha256.is_none());
    }

    pub(crate) fn fixture(reason: fullmag_ir::StageStopReason, converged: bool)
        -> (TerminalCompletionRecord, FmsArtifactCatalogEntry) {
        let clock = fullmag_quantities::ObservationClock {
            accepted_step: 7, time_seconds: 0.0, dt_seconds: None,
        };
        let record = TerminalCompletionRecord {
            schema_version: TERMINAL_COMPLETION_SCHEMA.into(),
            run_id: "run-completion".into(), task_id: "task".into(), step_id: "step".into(),
            attempt_id: "attempt".into(), ownership_epoch: 1,
            source: fullmag_quantities::AcceptedStateRef {
                id: fullmag_quantities::AcceptedStateId {
                    run_id: "run-completion".into(), stage_id: Some("step".into()), accepted_step: 7,
                    clock_digest: clock.digest().unwrap(),
                    state_digest: format!("sha256:{}", "b".repeat(64)),
                    domain_digest: format!("sha256:{}", "c".repeat(64)),
                    plan_digest: format!("sha256:{}", "d".repeat(64)),
                },
                generation: fullmag_quantities::AcceptedStateGeneration { runtime_epoch: 1, accepted_revision: 7 },
            },
            state_object_ref: "b".repeat(64), clock, solver_dt_s: 0.0,
            input_fingerprint: "a".repeat(64), resolved_input_fingerprint: Some("e".repeat(64)),
            completion: fullmag_ir::StageCompletionIR {
                status: "completed".into(), converged, reason: Some(reason),
                metric: Some(if reason == fullmag_ir::StageStopReason::Energy {
                    fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ
                } else if reason == fullmag_ir::StageStopReason::MaxSteps {
                    fullmag_ir::StageMetricKind::Steps
                } else { fullmag_ir::StageMetricKind::MaxTorqueApm }),
                metric_name: Some(if reason == fullmag_ir::StageStopReason::Energy {
                    "total_energy_plateau_range_J"
                } else if reason == fullmag_ir::StageStopReason::MaxSteps {
                    "steps"
                } else { "max_torque_apm" }.into()),
                metric_value: Some(if converged { 0.125 } else { 7.0 }),
                threshold: Some(if converged { 0.25 } else { 7.0 }),
            },
        };
        let entry = entry_for(&record);
        (record, entry)
    }

    pub(crate) fn entry_for(record: &TerminalCompletionRecord) -> FmsArtifactCatalogEntry {
        let digest = fullmag_application::study_artifact_content_sha256(&serde_json::to_vec(record).unwrap());
        FmsArtifactCatalogEntry {
            artifact_id: terminal_completion_artifact_id(record), task_id: record.task_id.clone(),
            attempt_id: record.attempt_id.clone(), ownership_epoch: record.ownership_epoch,
            logical_path: terminal_completion_logical_path(record),
            artifact_type: TERMINAL_COMPLETION_ARTIFACT_TYPE.into(),
            content_sha256: digest.clone(), object_ref: Some(digest),
            status: FmsArtifactStatus::Published, required: false, study_output: None,
        }
    }

    #[test]
    fn completion_validation_rejects_inconsistent_scientific_labels_without_recomputing_physics() {
        use fullmag_ir::{StageStopReason as Reason, StageMetricKind as Metric};
        let (record, _) = fixture(Reason::Torque, true);
        for change in 0..11 {
            let mut completion = record.completion.clone();
            match change {
                0 => completion.reason = Some(Reason::MaxSteps),
                1 => completion.metric = Some(Metric::Steps),
                2 => completion.metric = None,
                3 => completion.metric_name = Some("other".into()),
                4 => completion.metric_value = None,
                5 => completion.threshold = None,
                6 => completion.metric_value = Some(0.5),
                7 => completion.metric_value = Some(-0.1),
                8 => completion.threshold = Some(-0.1),
                9 => completion.metric_value = Some(f64::NAN),
                _ => completion.threshold = Some(f64::INFINITY),
            }
            assert!(validate_completion(&completion).is_err(), "inconsistent variant {change}");
        }
        let (mut budget, _) = fixture(Reason::MaxSteps, false);
        assert!(validate_completion(&budget.completion).is_ok());
        budget.completion.converged = true;
        assert!(validate_completion(&budget.completion).is_err());
        let mut no_relaxation = fullmag_ir::StageCompletionIR {
            status: "completed".into(), converged: false, reason: None, metric: None,
            metric_name: None, metric_value: None, threshold: None,
        };
        assert!(validate_completion(&no_relaxation).is_ok());
        no_relaxation.converged = true;
        assert!(validate_completion(&no_relaxation).is_err());
        let stagnation = fullmag_ir::StageCompletionIR {
            status: "failed".into(), converged: false, reason: Some(Reason::Gradient),
            metric: Some(Metric::NumericalStagnation), metric_name: Some("numerical_stagnation".into()),
            metric_value: Some(1.0), threshold: Some(0.0),
        };
        assert!(validate_completion(&stagnation).is_err());
    }

    #[test]
    fn completion_cas_roundtrip_preserves_runner_truth_and_rejects_foreign_bindings() {
        use fullmag_ir::StageStopReason::{Torque, Energy, MaxSteps};
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        for (reason, converged) in [(Torque, true), (Energy, true), (MaxSteps, false)] {
            let (record, entry) = fixture(reason, converged);
            store.cas().put(&serde_json::to_vec(&record).unwrap()).unwrap();
            assert_eq!(read_terminal_completion(&store, &entry).unwrap().completion, record.completion);
            for change in 0..5 {
                let mut foreign = record.clone();
                match change {
                    0 => foreign.attempt_id = "foreign".into(),
                    1 => foreign.ownership_epoch += 1,
                    2 => foreign.state_object_ref = "f".repeat(64),
                    3 => foreign.clock.accepted_step += 1,
                    _ => foreign.source.id.plan_digest = format!("sha256:{}", "f".repeat(64)),
                }
                assert!(validate_terminal_completion_record(&foreign, &entry).is_err());
            }
            let mut corrupt = entry.clone();
            corrupt.content_sha256 = "f".repeat(64);
            assert!(read_terminal_completion(&store, &corrupt).is_err());
        }
    }
}

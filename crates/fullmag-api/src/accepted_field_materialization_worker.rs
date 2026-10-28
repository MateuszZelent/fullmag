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
use fullmag_session::{FmsArtifactCatalogEntry, FmsArtifactStatus, SessionStore};
use fullmag_runner::{
    AcceptedMagnetizationInput, AcceptedMaterializationBatch, AcceptedMaterializationLane,
    AcceptedMaterializationRequest, materialize_accepted_observables,
};
use crate::accepted_field_binary::{BinaryFieldRef, BinaryFieldChunk};

pub(crate) const SCHEMA: &str = "accepted_quantity_bundle.v1";
const ARTIFACT_TYPE: &str = "accepted_quantity_bundle";
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

/// Runs only inside the admitted worker, before Completing releases its lease.
/// Unsupported postprocessing is recorded without changing a completed Solve
/// into a failure. A storage/ownership failure still prevents false publication.
pub(crate) fn prepare_and_publish(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    execution: &crate::accepted_study_worker::AcceptedRunnerExecution,
) -> Result<()> {
    let Some(source) = execution.accepted_state_ref.as_ref() else { return Ok(()); };
    let study_step = accepted.study.steps.iter().find(|candidate| candidate.step_id == step.step_id)
        .context("materialization study step missing")?;
    let mut states = execution.outputs.iter().filter(|output| {
        study_step.outputs.iter().any(|port| port.port_id == output.port_id
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
    if budget < 4096 {
        tracing::warn!(task_id = %step.claim.task_id.as_str(),
            "accepted quantities omitted: no observation storage budget after declared outputs");
        return Ok(());
    }
    let state_object_ref = fullmag_application::study_artifact_content_sha256(&output.bytes);
    let artifact_id = format!("accepted-quantities-{}", fullmag_session::canonical_json_sha256(&json!({
        "run": step.claim.run_id, "task": step.claim.task_id,
        "attempt": step.claim.attempt_id, "epoch": step.claim.ownership_epoch,
        "source": source, "state": state_object_ref,
    })));
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
        let decoded = fullmag_application::decode_study_artifact_bytes(
            "state", &output.codec_id, &output.codec_version, &output.bytes)?;
        let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = decoded else {
            bail!("materialization requires an accepted magnetization artifact");
        };
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
    if bytes.len() as u64 > budget {
        record.batch = None;
        record.error = Some("accepted quantity bundle exceeds its serialized storage budget".into());
        record.binary_fields.clear();
        binary_entries.clear();
        bytes = serde_json::to_vec(&record)?;
    }
    if bytes.len() as u64 > budget {
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

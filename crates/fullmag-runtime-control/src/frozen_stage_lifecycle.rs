//! Accepted stage lineage, persisted once at admission and replayed by workers.
use anyhow::{bail, Context, Result};
use fullmag_application::{
    FrozenStageContextRefV1, FrozenStageSourceManifestRef, ResolvedInput, RunId, TaskClaim,
};
use fullmag_authoring::{StudyInputSource, StudyPortDataKind, StudyStep};
use fullmag_ir::{BackendPlanIR, FdmPlanIR};
use fullmag_runner::constraints::{
    FrozenOutputLifecycleV1, FrozenSpinsActivationSet, FrozenStageContextV1,
};
use fullmag_session::SessionStore;
use std::collections::BTreeMap;

pub(crate) const MAX_CONTEXT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

pub struct FrozenStageExecutionContext {
    pub frozen: FrozenStageContextV1,
    pub source_frozen_plan: Option<fullmag_ir::ResolvedFrozenSpinsPlanIR>,
}

fn fdm_plan<'a>(study: &'a crate::AcceptedStudySnapshot, stage: &str) -> Result<&'a FdmPlanIR> {
    let execution = study
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == stage)
        .and_then(|step| step.execution_plan.as_ref())
        .context("frozen lineage has no accepted execution plan")?;
    let BackendPlanIR::Fdm(plan) = &execution.backend_plan else {
        bail!("frozen lineage requires the accepted FDM CPU realization");
    };
    Ok(plan)
}

fn bounded_object(store: &SessionStore, reference: &str, limit: u64) -> Result<Vec<u8>> {
    store
        .cas()
        .get_bounded(reference, limit)?
        .context("frozen lineage object is absent from CAS")
}

fn decode_output_lifecycle(
    artifact: fullmag_application::FrozenMagnetizationStateArtifact,
    source_plan: &FdmPlanIR,
) -> Result<FrozenOutputLifecycleV1> {
    // Application owns the field codec; runner owns the physical frozen contract.
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schema_version": "fullmag.frozen_output_lifecycle.v1",
        "frozen_spins": artifact.frozen_spins,
        "frozen_activation_set": artifact.frozen_activation_set,
    }))?;
    let lifecycle = FrozenOutputLifecycleV1::decode(&bytes)?;
    lifecycle.validate(
        source_plan.frozen_spins.as_ref(),
        fullmag_quantities::ObservationClock {
            accepted_step: artifact.state.step,
            time_seconds: artifact.state.time_s,
            dt_seconds: (artifact.state.solver_dt_s > 0.0).then_some(artifact.state.solver_dt_s),
        },
        &artifact.state.values,
    )?;
    Ok(lifecycle)
}

/// Only explicit physical state dependencies carry historical activation state.
/// A legacy M-only artifact cannot prove an empty inactive history.
fn source_lifecycle(
    store: &SessionStore,
    study: &crate::AcceptedStudySnapshot,
    step: &StudyStep,
    inputs: &BTreeMap<String, ResolvedInput>,
) -> Result<
    Option<(
        String,
        String,
        FrozenStageSourceManifestRef,
        FrozenOutputLifecycleV1,
    )>,
> {
    let mut physical = step.inputs.iter().filter(|port| {
        matches!(
            port.data_kind,
            StudyPortDataKind::State | StudyPortDataKind::InitialState
        ) && inputs.contains_key(&port.port_id)
    });
    let Some(port) = physical.next() else {
        return Ok(None);
    };
    if physical.next().is_some() {
        bail!("frozen lifecycle requires one unambiguous physical state input");
    }
    let StudyInputSource::StepOutput {
        step_id,
        port: source_port,
        case_id,
    } = &port.source
    else {
        bail!("frozen lifecycle requires a published accepted StepOutput lineage");
    };
    let pinned = inputs
        .get(&port.port_id)
        .and_then(|input| input.study_artifact.as_ref())
        .context("frozen physical input has no typed artifact binding")?;
    if pinned.codec_id != fullmag_application::STUDY_FROZEN_STATE_CODEC_ID
        || pinned.codec_version != fullmag_application::STUDY_FROZEN_STATE_CODEC_VERSION
    {
        bail!("frozen physical input has no explicit full-history codec; legacy M is insufficient");
    }
    let run_id = study.run.specification.run_id.as_str();
    let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
    let run_catalog = store
        .read_run_catalog(run_id)?
        .context("frozen source run catalog is absent")?;
    let task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("frozen source task is absent")?;
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
        bail!("frozen source task has not succeeded");
    }
    let attempt = task
        .attempt_id
        .as_deref()
        .context("frozen source attempt is absent")?;
    let epoch = task
        .ownership_epoch
        .context("frozen source epoch is absent")?;
    let catalog = store
        .read_artifact_catalog(run_id)?
        .context("frozen source artifact catalog is absent")?;
    catalog.validate()?;
    let mut manifests = catalog.entries.iter().filter(|entry| {
        entry.task_id == task_id
            && entry.attempt_id == attempt
            && entry.ownership_epoch == epoch
            && entry.artifact_type == "study_output_manifest"
            && entry.status == fullmag_session::FmsArtifactStatus::Published
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    let manifest_entry = manifests
        .next()
        .context("frozen source manifest is absent")?;
    if manifests.next().is_some() {
        bail!("frozen source manifest is ambiguous");
    }
    let reference = manifest_entry
        .object_ref
        .as_deref()
        .context("frozen source manifest has no CAS object")?;
    if reference != manifest_entry.content_sha256 {
        bail!("frozen source manifest hash differs");
    }
    let bytes = bounded_object(store, reference, MAX_MANIFEST_BYTES)?;
    let manifest = crate::study_output_history::read_manifest_projection(&bytes)?;
    if manifest.run_id != run_id
        || manifest.task_id != task_id
        || manifest.step_id != *step_id
        || manifest.attempt_id != attempt
        || manifest.ownership_epoch != epoch
    {
        bail!("frozen source manifest belongs to another claim or stage");
    }
    let mut outputs = manifest.outputs.iter().filter(|output| {
        output.port_id == *source_port
            && output.case_id == *case_id
            && output.artifact_id == pinned.artifact_id
            && output.object_ref == pinned.object_ref
            && output.codec_id == pinned.codec_id
            && output.codec_version == pinned.codec_version
            && output.data_kind == pinned.data_kind
            && output.content_sha256 == pinned.object_ref
    });
    let output = outputs
        .next()
        .context("frozen source output differs from its manifest")?;
    if outputs.next().is_some() {
        bail!("frozen source output is ambiguous");
    }
    let mut entries = catalog.entries.iter().filter(|entry| {
        entry.artifact_id == output.artifact_id
            && entry.task_id == task_id
            && entry.attempt_id == attempt
            && entry.ownership_epoch == epoch
            && entry.object_ref.as_deref() == Some(output.object_ref.as_str())
            && entry.content_sha256 == output.content_sha256
            && entry.artifact_type == output.data_kind
            && entry.status == fullmag_session::FmsArtifactStatus::Published
            && entry.study_output.as_ref().is_some_and(|identity| {
                identity.step_id == *step_id
                    && identity.port_id == *source_port
                    && identity.case_id == *case_id
            })
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    entries
        .next()
        .context("frozen source output is not owned by its published claim")?;
    if entries.next().is_some() {
        bail!("frozen source output catalog binding is ambiguous");
    }
    let raw = bounded_object(store, &output.object_ref, MAX_CONTEXT_BYTES)?;
    let decoded = fullmag_application::decode_study_artifact_bytes(
        &pinned.data_kind,
        &pinned.codec_id,
        &pinned.codec_version,
        &raw,
    )?;
    let fullmag_application::DecodedStudyArtifact::FrozenMagnetizationState(artifact) = decoded
    else {
        bail!("frozen source codec did not produce a full-history state");
    };
    let lifecycle = decode_output_lifecycle(artifact, fdm_plan(study, step_id)?)?;
    Ok(Some((
        step_id.clone(),
        case_id.clone(),
        FrozenStageSourceManifestRef {
            catalog_revision: catalog.revision,
            artifact_id: manifest_entry.artifact_id.clone(),
            object_ref: reference.into(),
            content_sha256: reference.into(),
        },
        lifecycle,
    )))
}

/// Follow authored physical state edges, not task order or unrelated resources.
/// A predecessor must export complete history before the first active constraint.
fn physical_lineage_needs_lifecycle(study: &crate::AcceptedStudySnapshot, stage: &str) -> bool {
    fn has_ancestor(
        study: &crate::AcceptedStudySnapshot,
        descendant: &str,
        ancestor: &str,
        visited: &mut std::collections::BTreeSet<String>,
    ) -> bool {
        if descendant == ancestor {
            return true;
        }
        if !visited.insert(descendant.into()) {
            return false;
        }
        study
            .study
            .steps
            .iter()
            .find(|step| step.step_id == descendant)
            .is_some_and(|step| {
                step.inputs.iter().any(|port| {
                    if !matches!(
                        port.data_kind,
                        StudyPortDataKind::State | StudyPortDataKind::InitialState
                    ) {
                        return false;
                    }
                    match &port.source {
                        StudyInputSource::StepOutput { step_id, .. } => {
                            has_ancestor(study, step_id, ancestor, visited)
                        }
                        _ => false,
                    }
                })
            })
    }
    study.lowered.steps.iter().any(|step| {
        let Some(execution) = &step.execution_plan else {
            return false;
        };
        let BackendPlanIR::Fdm(plan) = &execution.backend_plan else {
            return false;
        };
        (plan.frozen_spins.is_some()
            || plan
                .spin_transport_plans
                .iter()
                .any(|transport| transport.fdm_cpu_double_transient.is_some()))
            && has_ancestor(study, &step.step_id, stage, &mut Default::default())
    })
}

pub(crate) fn prepare_admission_binding(
    store: &SessionStore,
    study: &crate::AcceptedStudySnapshot,
    step: &StudyStep,
    inputs: &BTreeMap<String, ResolvedInput>,
) -> Result<Option<FrozenStageContextRefV1>> {
    let execution = study
        .lowered
        .steps
        .iter()
        .find(|entry| entry.step_id == step.step_id)
        .and_then(|entry| entry.execution_plan.as_ref())
        .context("accepted stage plan is absent")?;
    let BackendPlanIR::Fdm(target) = &execution.backend_plan else {
        return Ok(None);
    };
    let explicit_source = inputs.values().any(|input| {
        input.study_artifact.as_ref().is_some_and(|artifact| {
            artifact.codec_id == fullmag_application::STUDY_FROZEN_STATE_CODEC_ID
        })
    });
    if !explicit_source && !physical_lineage_needs_lifecycle(study, &step.step_id) {
        return Ok(None);
    }
    let source = source_lifecycle(store, study, step, inputs)?;
    let (previous, child, source_stage, source_manifest, case_id, source_plan) = match source {
        Some((stage, case_id, manifest, lifecycle)) => {
            let plan = fdm_plan(study, &stage)?.frozen_spins.clone();
            (
                lifecycle.frozen_activation_set,
                lifecycle.frozen_spins,
                Some(stage),
                Some(manifest),
                case_id,
                plan,
            )
        }
        None => (
            FrozenSpinsActivationSet::default(),
            None,
            None,
            None,
            "default".into(),
            None,
        ),
    };
    let changed = source_plan != target.frozen_spins;
    let context = FrozenStageContextV1::prepare_stage_entry(
        previous,
        child,
        source_stage,
        step.step_id.clone(),
        target.frozen_spins.as_ref(),
        changed,
    )?;
    let bytes = fullmag_session::canonical_json_bytes(&serde_json::to_value(&context)?);
    if bytes.len() as u64 > MAX_CONTEXT_BYTES {
        bail!("frozen stage context exceeds decode budget");
    }
    FrozenStageContextV1::decode(&bytes, target.frozen_spins.as_ref())?;
    let reference = store.cas().put(&bytes)?;
    let binding = FrozenStageContextRefV1 {
        schema_version: "frozen_stage_context_ref.v1".into(),
        run_id: study.run.specification.run_id.as_str().into(),
        stage_id: step.step_id.clone(),
        case_id,
        entry_kind: if source_manifest.is_some() {
            "continued_stage"
        } else {
            "fresh_authored_root"
        }
        .into(),
        context_object_ref: reference.clone(),
        context_sha256: reference,
        context_byte_count: bytes.len() as u64,
        source_manifest,
    };
    binding.validate()?;
    Ok(Some(binding))
}

/// Replay exact admission bytes; never allocate a new activation epoch here.
pub fn load_execution_context(
    store: &SessionStore,
    run_id: &RunId,
    target_stage: &str,
    target: &FdmPlanIR,
    claim: &TaskClaim,
    binding: &FrozenStageContextRefV1,
) -> Result<FrozenStageExecutionContext> {
    binding.validate()?;
    if binding.run_id != run_id.as_str()
        || binding.stage_id != target_stage
        || claim.run_id != *run_id
    {
        bail!("frozen stage binding belongs to another stage or run");
    }
    let admission = store
        .read_task_admission(
            run_id.as_str(),
            claim.task_id.as_str(),
            claim.attempt_id.as_str(),
        )?
        .context("frozen stage has no durable admission")?;
    let snapshot = admission
        .resolved_inputs_snapshot
        .context("frozen stage admission has no snapshot")?;
    snapshot.validate()?;
    if snapshot.frozen_stage_context != Some(serde_json::to_value(binding)?) {
        bail!("frozen stage binding differs from exact admitted history");
    }
    let bytes = bounded_object(
        store,
        &binding.context_object_ref,
        binding.context_byte_count.min(MAX_CONTEXT_BYTES),
    )?;
    if bytes.len() as u64 != binding.context_byte_count {
        bail!("frozen stage context byte count differs");
    }
    let frozen = FrozenStageContextV1::decode(&bytes, target.frozen_spins.as_ref())?;
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("frozen run intent is absent")?;
    let spec: fullmag_application::RunSpecification = serde_json::from_value(intent.specification)?;
    let study = crate::load_accepted_study_snapshot(store, run_id, &spec.snapshot.project_id)?;
    let step = study
        .study
        .steps
        .iter()
        .find(|step| step.step_id == target_stage)
        .context("frozen stage is absent")?;
    let inputs: BTreeMap<String, ResolvedInput> = serde_json::from_value(snapshot.inputs)?;
    let source = source_lifecycle(store, &study, step, &inputs)?;
    let source_frozen_plan = match source {
        Some((stage, case_id, source_ref, lifecycle)) => {
            if !binding.source_manifest.as_ref().is_some_and(|pinned| {
                pinned.catalog_revision <= source_ref.catalog_revision
                    && pinned.artifact_id == source_ref.artifact_id
                    && pinned.object_ref == source_ref.object_ref
                    && pinned.content_sha256 == source_ref.content_sha256
            }) || binding.case_id != case_id
                || frozen.source_stage_id.as_deref() != Some(stage.as_str())
                || frozen.previous_activation_set != lifecycle.frozen_activation_set
                || serde_json::to_value(&frozen.previous_frozen_child)?
                    != serde_json::to_value(&lifecycle.frozen_spins)?
            {
                bail!("frozen stage source no longer matches its admitted full history");
            }
            fdm_plan(&study, &stage)?.frozen_spins.clone()
        }
        None => {
            if binding.source_manifest.is_some() || frozen.source_stage_id.is_some() {
                bail!("frozen stage lost its declared historical source");
            }
            None
        }
    };
    Ok(FrozenStageExecutionContext {
        frozen,
        source_frozen_plan,
    })
}

/// The existing lease-owned publisher consumes the same admitted lifecycle.
pub(crate) fn validate_terminal_output(
    store: &SessionStore,
    study: &crate::AcceptedStudySnapshot,
    claim: &TaskClaim,
    stage: &str,
    artifact: fullmag_application::FrozenMagnetizationStateArtifact,
) -> Result<()> {
    let target = fdm_plan(study, stage)?;
    let lifecycle = decode_output_lifecycle(artifact, target)?;
    let admission = store
        .read_task_admission(
            claim.run_id.as_str(),
            claim.task_id.as_str(),
            claim.attempt_id.as_str(),
        )?
        .context("frozen output has no admitted history")?;
    let snapshot = admission
        .resolved_inputs_snapshot
        .context("frozen output admission has no snapshot")?;
    snapshot.validate()?;
    let binding: FrozenStageContextRefV1 = serde_json::from_value(
        snapshot
            .frozen_stage_context
            .context("frozen output admission has no full-history binding")?,
    )?;
    let context = load_execution_context(store, &claim.run_id, stage, target, claim, &binding)?;
    if lifecycle.frozen_activation_set != context.frozen.prepared_activation_set {
        bail!("terminal frozen output differs from the single admitted activation transition");
    }
    Ok(())
}

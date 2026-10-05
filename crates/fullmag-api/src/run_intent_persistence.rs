//! Durable adapter between the typed application Submit contract and the
//! session store. Callers must verify and pin the project/study snapshot before
//! invoking this boundary; publication alone does not schedule a worker.

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use fullmag_application::{
    FileProjectRepository, ProjectEnvelope, ProjectId, ProjectRepository, ProjectSource, RunId,
    RunIntent, RunSpecification, SubmitDisposition, SubmitReceipt,
};
use fullmag_authoring::StudyPlan;
use fullmag_plan::{StudyProblemCatalog, StudyStepLoweringStatus};
use fullmag_session::{
    FmsRunCatalog, FmsRunIntent, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskPreparationReceipt,
    FmsTaskReadiness, PreparationReceiptCommitDisposition, RunIntentCommitDisposition,
    SessionStore, FMS_RUN_CATALOG_SCHEMA,
};

pub(crate) const DEFAULT_ACCEPTED_RUN_BACKLOG_LIMIT: usize = 256;
const ACCEPTED_RUN_BACKLOG_LIMIT_ENV: &str = "FULLMAG_ACCEPTED_RUN_BACKLOG_LIMIT";

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

fn commit_validated_run_intent_with_optional_backlog_limit(
    store: &SessionStore,
    intent: &RunIntent,
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    asset_payloads: &BTreeMap<String, Vec<u8>>,
    backlog_limit: Option<NonZeroUsize>,
) -> Result<SubmitReceipt> {
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
    let catalog_value = serde_json::to_value(catalog)?;
    let catalog_digest = fullmag_session::canonical_json_sha256(&catalog_value);
    if intent.specification.study_catalog_sha256 != catalog_digest {
        bail!("run study catalog digest does not match immutable planner inputs");
    }
    if asset_payloads.len() != intent.specification.immutable_assets.len() {
        bail!("run asset payload count does not match immutable asset references");
    }
    for asset in &intent.specification.immutable_assets {
        let payload = asset_payloads
            .get(&asset.asset_id)
            .with_context(|| format!("missing immutable asset `{}`", asset.asset_id))?;
        if fullmag_session::hex_sha256(payload) != asset.content_sha256 {
            bail!(
                "immutable asset `{}` digest differs from run specification",
                asset.asset_id
            );
        }
    }
    // Every store mutation below (CAS blobs, intent publication, replay
    // verification) must belong to ONE writer lease.  The lease is re-entrant
    // on this thread, but separate short leases let two concurrent identical
    // submits interleave and make each other fail with `StoreWriterBusy`, so
    // that neither is accepted.  Holding one lease serializes the whole
    // publication: exactly one submit wins and the other observes either the
    // busy conflict or the committed intent as an idempotent replay.
    let _publication_lease = store.write_transaction()?;
    let definition_object_ref = store.store_blob(definition.raw_definition.raw_bytes())?;
    if definition_object_ref != intent.specification.snapshot.definition_sha256 {
        bail!("stored definition object differs from run snapshot digest");
    }
    let study_object_ref = store.store_blob(&study.canonical_json_bytes()?)?;
    if study_object_ref != intent.specification.study.plan_sha256 {
        bail!("stored study object differs from run plan digest");
    }
    let study_catalog_object_ref =
        store.store_blob(&fullmag_session::canonical_json_bytes(&catalog_value))?;
    if study_catalog_object_ref != intent.specification.study_catalog_sha256 {
        bail!("stored study catalog differs from run catalog digest");
    }
    let mut asset_object_refs = BTreeMap::new();
    for (asset_id, payload) in asset_payloads {
        asset_object_refs.insert(asset_id.clone(), store.store_blob(payload)?);
    }
    let payload_fingerprint = intent.payload_fingerprint()?;
    let specification = serde_json::to_value(&intent.specification)?;
    let mut durable = FmsRunIntent::new(
        intent.specification.run_id.as_str(),
        &intent.idempotency_key,
        specification,
    );
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
            intent.specification.run_id.clone(),
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
        payload_fingerprint,
    })
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
        match store.commit_run_catalog(&materialized) {
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
        match store.commit_task_preparation_receipt(&durable_receipt)? {
            PreparationReceiptCommitDisposition::Accepted
            | PreparationReceiptCommitDisposition::Replayed => {}
        }
    }
    Ok(catalog)
}

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
        STUDY_PLAN_SCHEMA_VERSION,
    };
    use fullmag_ir::ProblemIR;
    use fullmag_plan::lower_study_plan_with_catalog;
    use fullmag_plan::StudyProblemCatalogEntry;
    use fullmag_runtime_control::validate_requested_execution;
    use serde_json::json;

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
        let catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                ProblemIR::bootstrap_example(),
            )],
        )
        .unwrap();
        let catalog_value = serde_json::to_value(&catalog).unwrap();
        let mut specification = RunSpecification::new(
            ProjectSnapshot::from_envelope(&definition).unwrap(),
            StudyReference {
                study_id: StudyId::parse("study-main").unwrap(),
                plan_version: STUDY_PLAN_SCHEMA_VERSION.into(),
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
                plan_version: STUDY_PLAN_SCHEMA_VERSION.into(),
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
            let hammer = std::thread::spawn(move || {
                // Sweep the rival's first acquisition across the submit so
                // that it lands in different phases of the publication.
                let offset = std::time::Instant::now()
                    + std::time::Duration::from_micros(attempt * 700);
                while std::time::Instant::now() < offset {
                    std::hint::spin_loop();
                }
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
                        spin(0);
                        drop(lease);
                    }
                    spin(30000);
                }
            });
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

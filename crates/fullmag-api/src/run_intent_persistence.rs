//! Durable adapter between the typed application Submit contract and the
//! session store. Callers must verify and pin the project/study snapshot before
//! invoking this boundary; publication alone does not schedule a worker.

use std::collections::BTreeMap;
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

/// Accept only the layout exported by the managed storage resolver. Direct
/// API launches without that validated environment cannot publish new runs.
pub(crate) fn configured_submit_store_root(repo_root: &Path) -> Option<PathBuf> {
    let storage_root = PathBuf::from(std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")?);
    let runs_root = PathBuf::from(std::env::var_os("FULLMAG_RUNS_ROOT")?);
    let worktree_id = std::env::var("FULLMAG_WORKTREE_ID").ok()?;
    if !storage_root.is_absolute()
        || !runs_root.is_absolute()
        || worktree_id.is_empty()
        || !worktree_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || runs_root != storage_root.join("runs").join(&worktree_id)
        || storage_root.starts_with(repo_root)
        || repo_root.starts_with(&storage_root)
    {
        return None;
    }
    let canonical_storage = std::fs::canonicalize(&storage_root).ok()?;
    let canonical_runs = std::fs::canonicalize(&runs_root).ok()?;
    let canonical_repo = std::fs::canonicalize(repo_root).ok()?;
    if canonical_runs != canonical_storage.join("runs").join(&worktree_id)
        || canonical_storage.starts_with(&canonical_repo)
        || canonical_repo.starts_with(&canonical_storage)
    {
        return None;
    }
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(canonical_storage.join(".fullmag-storage.json")).ok()?,
    )
    .ok()?;
    if marker.get("schema").and_then(serde_json::Value::as_str) != Some("fullmag_storage_v1") {
        return None;
    }
    let declared_project = PathBuf::from(marker.get("project_root")?.as_str()?);
    let canonical_project = std::fs::canonicalize(declared_project).ok()?;
    if canonical_repo == canonical_project || !canonical_repo.starts_with(canonical_project) {
        return None;
    }
    Some(canonical_runs.join("session-store"))
}

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
    commit_validated_run_intent(
        store,
        intent,
        &opened.envelope,
        study,
        catalog,
        &asset_payloads,
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
    let disposition = store.commit_run_intent(&durable)?;
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
            Ok(FmsTaskCatalogEntry {
                task_id,
                input_fingerprint,
                lifecycle: FmsTaskLifecycle::Accepted,
                readiness: FmsTaskReadiness::Blocked {
                    reason: fullmag_runtime_control::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION
                        .into(),
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
}

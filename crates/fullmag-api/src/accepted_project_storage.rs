//! User output publication kept separate from immutable worker receipts/CAS.

use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_ir::{OutputStorageIR, ProblemIR};
use fullmag_runner::project_storage::ProjectStorageLease;
use fullmag_session::SessionStore;
use fullmag_workspace_inspect::manifest::{
    collect_outputs, write_run_manifest, RunManifest, RunSource,
};
use fullmag_workspace_inspect::read_layout;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) struct AcceptedProjectStorage {
    lease: ProjectStorageLease,
    data_root: PathBuf,
    incremental: bool,
    finalized: bool,
    requested_success: Option<bool>,
    data_publication_attempted: bool,
    publication_error: Option<String>,
    first_finalization_error: Option<String>,
    terminal_state_prepared: bool,
    terminal_manifest_prepared: bool,
    manifest: RunManifest,
    outcome: Option<(&'static str, Option<String>)>,
}

/// `fullmag-run.json` of an accepted project run, as known when its results
/// leaf is reserved. `source.path` stays empty: the accepted run knows the
/// project id and definition revision, not the `.fms` file it was opened from.
/// `requested` is the accepted request; `resolved` is the backend of the
/// accepted plan and the device of the claimed resource lease.
pub(crate) fn accepted_run_manifest(
    snapshot: &fullmag_application::ProjectSnapshot,
    requested: &fullmag_application::RequestedExecution,
    specification_fingerprint: &str,
    claim: &TaskClaim,
    resolved_backend: fullmag_ir::BackendTarget,
) -> RunManifest {
    let mut manifest = RunManifest::new(
        format!(
            "{}-{}",
            claim.run_id.as_str(),
            claim.ownership_epoch.value()
        ),
        RunSource {
            kind: "project".into(),
            path: String::new(),
            sha256: Some(snapshot.definition_sha256.clone()),
            project_id: Some(snapshot.project_id.as_str().to_string()),
            revision: Some(snapshot.definition_revision),
        },
        fullmag_build_info::version(),
        fullmag_workspace::now_rfc3339(),
    );
    manifest.requested = serde_json::to_value(requested).unwrap_or(serde_json::Value::Null);
    manifest.resolved = serde_json::json!({
        "backend": resolved_backend,
        "device": claim.lease.kind,
        "precision": requested.precision,
        "mode": requested.mode,
    });
    manifest.launched_by = Some("api".into());
    manifest.run_spec_sha256 = Some(specification_fingerprint.to_string());
    manifest
}

impl AcceptedProjectStorage {
    fn configuration(
        problem: &ProblemIR,
        store: &SessionStore,
        step_id: &str,
    ) -> Result<Option<(OutputStorageIR, PathBuf, PathBuf)>> {
        let Some(value) = problem.problem_meta.runtime_metadata.get("output_storage") else {
            // Legacy accepted runs keep their original artifact contract. New
            // UI/Python projects carry an explicit canonical storage policy.
            return Ok(None);
        };
        let mut settings: OutputStorageIR =
            serde_json::from_value(value.clone()).context("read accepted project output policy")?;
        settings
            .validate()
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
        let expected = match settings.data_format {
            fullmag_ir::OutputDataFormatIR::Zarr => fullmag_ir::AutosaveFormatIR::Zarr,
            fullmag_ir::OutputDataFormatIR::Hdf5 => fullmag_ir::AutosaveFormatIR::Hdf5,
        };
        if problem
            .study
            .sampling()
            .stage_autosave
            .as_ref()
            .is_some_and(|policy| policy.format != expected)
        {
            bail!("accepted stage format conflicts with project output_storage; no solver was launched");
        }
        fullmag_session::repository_path::validate_store_id(step_id)?;
        let source_dir = problem
            .problem_meta
            .runtime_metadata
            .get("output_storage_source_dir")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| store.root().to_path_buf());
        let requested_base = settings
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| store.root().join("project-results"));
        let base = if requested_base.is_absolute() {
            requested_base
        } else {
            source_dir.join(requested_base)
        };
        let (base, temp_parent) = fullmag_runner::project_storage::preflight_project_storage(
            &settings,
            &base,
            &source_dir,
        )
        .map_err(anyhow::Error::msg)?;
        settings.temp_dir = Some(temp_parent.to_string_lossy().into_owned());
        Ok(Some((settings, source_dir, base)))
    }

    /// Validate paths/capabilities before reserving the durable worker attempt.
    pub(crate) fn preflight(
        problem: &ProblemIR,
        store: &SessionStore,
        claim: &TaskClaim,
        step_id: &str,
    ) -> Result<()> {
        let Some((mut settings, source_dir, base)) = Self::configuration(problem, store, step_id)?
        else {
            return Ok(());
        };
        let leaf = base.join(claim.run_id.as_str()).join(format!(
            "{step_id}-attempt-{}",
            claim.ownership_epoch.value()
        ));
        settings.output_dir = Some(leaf.to_string_lossy().into_owned());
        fullmag_runner::project_storage::preflight_project_storage(&settings, &leaf, &source_dir)
            .map_err(anyhow::Error::msg)?;
        if settings.existing_output == fullmag_ir::ExistingOutputIR::Error && leaf.exists() {
            bail!(
                "accepted project result location already exists: {}",
                leaf.display()
            );
        }
        Ok(())
    }

    pub(crate) fn prepare(
        problem: &ProblemIR,
        store: &SessionStore,
        claim: &TaskClaim,
        step_id: &str,
        manifest: RunManifest,
        attempt_dir: &Path,
    ) -> Result<Option<Self>> {
        let Some((mut settings, source_dir, base)) = Self::configuration(problem, store, step_id)?
        else {
            return Ok(None);
        };
        // Each accepted run/step owns a new leaf. Reconciliation remains based
        // on the private attempt receipt, never on these user-facing copies.
        fullmag_runner::project_storage::initialize_result_container(&base, settings.data_format)
            .map_err(anyhow::Error::msg)?;
        let run_root = base.join(claim.run_id.as_str());
        fullmag_runner::project_storage::initialize_result_container(
            &run_root,
            settings.data_format,
        )
        .map_err(anyhow::Error::msg)?;
        let leaf = run_root.join(format!(
            "{step_id}-attempt-{}",
            claim.ownership_epoch.value()
        ));
        settings.output_dir = Some(leaf.to_string_lossy().into_owned());
        let run_id = format!(
            "{}-{}",
            claim.run_id.as_str(),
            claim.ownership_epoch.value()
        );
        let lease = ProjectStorageLease::prepare(&settings, &leaf, &source_dir, &run_id)
            .map_err(anyhow::Error::msg)
            .context("reserve accepted project output and scratch")?;
        // Only autosave has a sample commit protocol. Inspection bundles and
        // other workflows keep their existing finalized-publication boundary.
        let incremental = settings.data_format == fullmag_ir::OutputDataFormatIR::Zarr
            && problem.study.sampling().stage_autosave.is_some();
        let data_root = if incremental {
            lease
                .active_output_dir()
                .map_err(anyhow::Error::msg)?
                .to_path_buf()
        } else {
            let staging = lease.resolved().temp_dir.join("data");
            fs::create_dir(&staging)
                .context("create owned staging directory for numerical data")?;
            staging
        };
        let mut storage = Self {
            lease,
            data_root,
            incremental,
            finalized: false,
            requested_success: None,
            data_publication_attempted: false,
            publication_error: None,
            first_finalization_error: None,
            terminal_state_prepared: false,
            terminal_manifest_prepared: false,
            manifest,
            outcome: None,
        };
        if let Err(error) = storage.write_manifest() {
            return Err(finalize_preparation_failure(
                &mut storage,
                error,
                attempt_dir,
            ));
        }
        if incremental {
            if let Err(error) = storage.publish_incremental_descriptor(claim, step_id, attempt_dir)
            {
                return Err(finalize_preparation_failure(
                    &mut storage,
                    error,
                    attempt_dir,
                ));
            }
        }
        Ok(Some(storage))
    }

    /// Record how the run ended when it is not plain success or failure.
    pub(crate) fn note_outcome(&mut self, status: &'static str, error: Option<String>) {
        self.outcome = Some((status, error));
    }

    fn write_manifest(&self) -> Result<()> {
        let dir = self.lease.active_output_dir().map_err(anyhow::Error::msg)?;
        write_run_manifest(dir, &self.manifest).context("publish owned run manifest")
    }

    /// The descriptor is immutable. Per-array commits carry changing sample
    /// watermarks; fullmag-run.json and output-storage.json carry terminal state.
    fn publish_incremental_descriptor(
        &self,
        claim: &TaskClaim,
        step_id: &str,
        attempt_dir: &Path,
    ) -> Result<()> {
        let attempt_dir = fs::canonicalize(attempt_dir)
            .context("resolve private execution receipt identity before publication")?;
        let fingerprint =
            self.manifest.run_spec_sha256.as_deref().context(
                "incremental publication requires the accepted specification fingerprint",
            )?;
        let descriptor = serde_json::json!({
            "schema": "fullmag.accepted_project_output.v1",
            "resolved_output_storage": self.resolved(),
            "attempt_receipt_directory": attempt_dir,
            "publication": {
                "schema": "fullmag.accepted_results_publication.v1",
                "output_identity": uuid::Uuid::new_v4().to_string(),
                "accepted_run_id": claim.run_id.as_str(),
                "task_id": claim.task_id.as_str(),
                "step_id": step_id,
                "attempt_id": claim.attempt_id.as_str(),
                "ownership_epoch": claim.ownership_epoch.value(),
                "specification_fingerprint": fingerprint,
                "sample_policy": "fullmag.zarr.sample_publication.v1",
            }
        });
        self.lease
            .publish_descriptor("run.json", &descriptor)
            .map_err(anyhow::Error::msg)
    }

    pub(crate) fn data_root(&self) -> Result<&Path> {
        // Check again at the writer handoff, not just when the leaf is created.
        self.lease.active_output_dir().map_err(anyhow::Error::msg)?;
        Ok(&self.data_root)
    }

    pub(crate) fn resolved(&self) -> &fullmag_runner::project_storage::ResolvedOutputStorage {
        self.lease.resolved()
    }

    /// The runner has joined its artifact writer before returning. Keep public
    /// Zarr samples even on failure/cancellation. Legacy staged formats publish
    /// only on success; private execution receipts stay in their own store. The
    /// lease prepares its terminal receipt before the manifest callback, so a
    /// consumer accepts the publication only when both terminal documents exist.
    pub(crate) fn finish(&mut self, success: bool, attempt_dir: &Path) -> Result<()> {
        if let Some(requested) = self.requested_success {
            if requested != success {
                let previous_error = self
                    .first_finalization_error
                    .as_deref()
                    .or(self.publication_error.as_deref())
                    .or(self
                        .outcome
                        .as_ref()
                        .and_then(|(_, error)| error.as_deref()));
                if let Some(previous_error) = previous_error {
                    bail!(
                        "accepted project storage finalization outcome changed: requested {requested}, received {success}; previous finalization error: {previous_error}"
                    );
                }
                bail!(
                    "accepted project storage finalization outcome changed: requested {requested}, received {success}"
                );
            }
        } else {
            self.requested_success = Some(success);
        }
        if self.finalized {
            return self
                .publication_error
                .as_ref()
                .map_or(Ok(()), |error| Err(anyhow::anyhow!(error.clone())));
        }
        if !self.data_publication_attempted {
            self.data_publication_attempted = true;
            if success {
                if let Err(error) = self.publish_data(attempt_dir) {
                    self.publication_error = Some(error.to_string());
                }
            }
        }
        let terminal_success = success && self.publication_error.is_none();
        self.prepare_terminal_state(terminal_success);
        let finished = {
            let manifest = &mut self.manifest;
            let manifest_prepared = &mut self.terminal_manifest_prepared;
            self.lease.finish_with(terminal_success, |dir| {
                if !*manifest_prepared {
                    manifest.stages = read_layout(dir).stages;
                    manifest.outputs = collect_outputs(dir);
                    *manifest_prepared = true;
                }
                write_run_manifest(dir, manifest).map_err(|error| error.to_string())
            })
        };
        if let Err(finalization_error) = finished {
            if self.first_finalization_error.is_none() {
                self.first_finalization_error = Some(finalization_error.clone());
            }
            let finalization_error = anyhow::Error::msg(finalization_error);
            if let Some(publication_error) = self.publication_error.as_deref() {
                return Err(anyhow::anyhow!(
                    "publish accepted project numerical data: {publication_error}; finalize accepted project output and scratch: {finalization_error:#}"
                ));
            }
            return Err(finalization_error).context("finalize accepted project output and scratch");
        }
        self.finalized = true;
        if let Some(publication_error) = self.publication_error.as_deref() {
            return Err(anyhow::anyhow!(
                "publish accepted project numerical data: {publication_error}"
            ));
        }
        Ok(())
    }

    fn prepare_terminal_state(&mut self, terminal_success: bool) {
        if self.terminal_state_prepared {
            return;
        }
        let (status, error) = self.terminal_status_and_error(terminal_success);
        self.manifest.status = status.to_string();
        self.manifest.error = error;
        self.manifest.finished_at = Some(fullmag_workspace::now_rfc3339());
        self.terminal_state_prepared = true;
    }

    fn publish_data(&self, attempt_dir: &Path) -> Result<()> {
        self.lease.active_output_dir().map_err(anyhow::Error::msg)?;
        if !self.incremental {
            let descriptor = serde_json::json!({
                "schema": "fullmag.accepted_project_output.v1",
                "resolved_output_storage": self.resolved(),
                "attempt_receipt_directory": attempt_dir,
            });
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.data_root.join("run.json"))?;
            file.write_all(&serde_json::to_vec_pretty(&descriptor)?)?;
            file.sync_all()?;
        }
        // The final-state artifact is an editable/reproducible output;
        // the store still owns the authoritative accepted state/CAS.
        let final_state = attempt_dir.join("solver").join("m_final.json");
        if final_state.is_file() {
            let solver = self.data_root.join("solver");
            fs::create_dir(&solver)?;
            fullmag_runner::project_storage::copy_owned_artifact(
                attempt_dir,
                Path::new("solver/m_final.json"),
                &solver.join("m_final.json"),
            )
            .map_err(anyhow::Error::msg)?;
        }
        if self.incremental {
            Ok(())
        } else {
            self.lease
                .publish_directory(&self.data_root)
                .map_err(anyhow::Error::msg)
        }
    }

    fn terminal_status_and_error(&self, terminal_success: bool) -> (&'static str, Option<String>) {
        let status =
            self.outcome
                .as_ref()
                .map(|(status, _)| *status)
                .unwrap_or(if terminal_success {
                    "completed"
                } else {
                    "failed"
                });
        let outcome_error = self.outcome.as_ref().and_then(|(_, error)| error.clone());
        let error = match (outcome_error, self.publication_error.clone()) {
            (Some(outcome), Some(publication)) => Some(format!(
                "{outcome}; accepted project publication also failed: {publication}"
            )),
            (None, publication) => publication,
            (outcome, None) => outcome,
        };
        (status, error)
    }
}

fn finalize_preparation_failure(
    storage: &mut AcceptedProjectStorage,
    error: anyhow::Error,
    attempt_dir: &Path,
) -> anyhow::Error {
    let primary = format!("{error:#}");
    storage.note_outcome("failed", Some(primary.clone()));
    match storage.finish(false, attempt_dir) {
        Ok(()) => anyhow::anyhow!(
            "project storage preparation failed; no solver was launched: {primary}"
        ),
        Err(finalization) => anyhow::anyhow!(
            "project storage preparation failed; no solver was launched: {primary}; finalization also failed: {finalization:#}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        AttemptId, LeaseToken, OwnershipEpoch, ProjectId, ProjectSnapshot, RequestedExecution,
        ResourceBudget, ResourceKind, ResourceLease, RunId, TaskId,
    };
    use fullmag_workspace_inspect::manifest::read_run_manifest;

    fn claim(kind: ResourceKind) -> TaskClaim {
        TaskClaim {
            run_id: RunId::parse("run-test").unwrap(),
            task_id: TaskId::parse("task-test").unwrap(),
            attempt_id: AttemptId::parse("attempt-test").unwrap(),
            ownership_epoch: OwnershipEpoch::new(2).unwrap(),
            lease: ResourceLease {
                resource_id: "res-test".into(),
                kind,
                budget: ResourceBudget {
                    cpu_millis: 1000,
                    memory_bytes: 1 << 20,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1 << 20,
                },
                lease_token: LeaseToken::parse("lease-test").unwrap(),
                heartbeat_sequence: 1,
            },
        }
    }

    fn manifest() -> RunManifest {
        let snapshot = ProjectSnapshot {
            project_id: ProjectId::parse("project-0123456789abcdef").unwrap(),
            definition_revision: 7,
            definition_sha256: "ab".repeat(32),
        };
        let requested = RequestedExecution {
            backend: "auto".into(),
            device: "auto".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        };
        accepted_run_manifest(
            &snapshot,
            &requested,
            &"cd".repeat(32),
            &claim(ResourceKind::Cpu),
            fullmag_ir::BackendTarget::Fdm,
        )
    }

    fn reserve(root: &Path) -> (AcceptedProjectStorage, PathBuf) {
        let settings = OutputStorageIR::default();
        let (mut settings, temp_parent) = {
            let (_, temp_parent) = fullmag_runner::project_storage::preflight_project_storage(
                &settings,
                &root.join("results"),
                root,
            )
            .unwrap();
            (settings, temp_parent)
        };
        settings.temp_dir = Some(temp_parent.to_string_lossy().into_owned());
        let base = root.join("results");
        fullmag_runner::project_storage::initialize_result_container(&base, settings.data_format)
            .unwrap();
        let leaf = base.join("run-test").join("step-attempt-2");
        fullmag_runner::project_storage::initialize_result_container(
            leaf.parent().unwrap(),
            settings.data_format,
        )
        .unwrap();
        settings.output_dir = Some(leaf.to_string_lossy().into_owned());
        let lease = ProjectStorageLease::prepare(&settings, &leaf, root, "run-test-2").unwrap();
        let data_root = lease.active_output_dir().unwrap().to_path_buf();
        let storage = AcceptedProjectStorage {
            lease,
            data_root,
            incremental: true,
            finalized: false,
            requested_success: None,
            data_publication_attempted: false,
            publication_error: None,
            first_finalization_error: None,
            terminal_state_prepared: false,
            terminal_manifest_prepared: false,
            manifest: manifest(),
            outcome: None,
        };
        storage.write_manifest().unwrap();
        storage
            .publish_incremental_descriptor(&claim(ResourceKind::Cpu), "step", root)
            .unwrap();
        (storage, leaf)
    }

    #[test]
    fn the_manifest_links_a_project_run_by_id_and_revision() {
        let manifest = manifest();
        assert_eq!(manifest.schema, "fullmag.run_manifest.v1");
        assert_eq!(manifest.run_id, "run-test-2");
        assert_eq!(manifest.source.kind, "project");
        assert_eq!(manifest.source.path, "");
        assert_eq!(
            manifest.source.project_id.as_deref(),
            Some("project-0123456789abcdef")
        );
        assert_eq!(manifest.source.revision, Some(7));
        assert_eq!(manifest.source.sha256, Some("ab".repeat(32)));
        assert_eq!(manifest.run_spec_sha256, Some("cd".repeat(32)));
        // Requested stays what was asked; resolved is what the plan and lease say.
        assert_eq!(manifest.requested["device"], "auto");
        assert_eq!(manifest.resolved["device"], "cpu");
        assert_eq!(manifest.resolved["backend"], "fdm");
        assert_eq!(manifest.launched_by.as_deref(), Some("api"));
        assert_eq!(manifest.status, "running");
    }

    #[test]
    fn the_leaf_gets_running_then_completed_and_nothing_outside_it() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let running = read_run_manifest(&leaf).unwrap().unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.finished_at, None);

        let attempt = dir.path().join("attempt");
        fs::create_dir(&attempt).unwrap();
        storage.finish(true, &attempt).unwrap();
        let done = read_run_manifest(&leaf).unwrap().unwrap();
        assert_eq!(done.status, "completed");
        assert!(done.finished_at.is_some());
        assert!(done.outputs.iter().any(|o| o.path == "output-storage.json"));
        assert_eq!(done.source.revision, Some(7));
        // The manifest and published data live in the leaf only.
        assert!(!dir.path().join("results").join(RUN_MANIFEST_NAME).exists());
        assert!(!dir
            .path()
            .join("results")
            .join("run-test")
            .join(RUN_MANIFEST_NAME)
            .exists());
    }

    const RUN_MANIFEST_NAME: &str = fullmag_workspace_inspect::manifest::RUN_MANIFEST_FILE;

    #[test]
    fn a_failed_or_cancelled_run_is_never_left_running() {
        for (outcome, expected) in [
            (None, "failed"),
            (Some(("cancelled", None)), "cancelled"),
            (
                Some(("failed", Some("solver stopped".to_string()))),
                "failed",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (mut storage, leaf) = reserve(dir.path());
            if let Some((status, error)) = outcome.clone() {
                storage.note_outcome(status, error);
            }
            storage.finish(false, dir.path()).unwrap();
            let done = read_run_manifest(&leaf).unwrap().unwrap();
            assert_eq!(done.status, expected);
            if let Some((_, Some(error))) = outcome {
                assert_eq!(done.error.as_deref(), Some(error.as_str()));
            }
        }
    }
    #[test]
    fn public_samples_are_readable_before_finish_and_survive_cancellation() {
        use fullmag_runner::autosave_storage::{
            AutosaveSampleKind, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
            StageSampleCoordinate,
        };
        use fullmag_workspace_inspect::results::{
            read_results_catalog, read_results_sample, WorkspaceResultsSource,
        };
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let scratch = storage.resolved().temp_dir.clone();
        fs::write(scratch.join("private-receipt.json"), b"private").unwrap();
        let descriptor = fs::read(leaf.join("run.json")).unwrap();
        let binding: serde_json::Value = serde_json::from_slice(&descriptor).unwrap();
        assert_eq!(binding["publication"]["accepted_run_id"], "run-test");
        assert_eq!(binding["publication"]["attempt_id"], "attempt-test");
        assert_eq!(binding["publication"]["ownership_epoch"], 2);
        assert_eq!(
            binding["publication"]["specification_fingerprint"],
            "cd".repeat(32)
        );
        let mut writer =
            fullmag_runner::autosave_zarr::ZarrAutosaveWriter::new(storage.data_root().unwrap());
        writer
            .begin_stage(&StageManifest {
                schema_version: "fullmag.stage_autosave.stage.v1".into(),
                target: "state".into(),
                stage_id: "step".into(),
                stage_index: 0,
                layout: fullmag_ir::AutosaveLayoutIR::Separate,
                format: fullmag_ir::AutosaveFormatIR::Zarr,
                table_quantities: vec![],
                field_quantities: vec!["m".into()],
                complete: false,
                table_sample_count: 0,
                field_sample_count: 0,
                provenance: None,
            })
            .unwrap();
        for index in 0..3 {
            writer
                .append_field_sample(
                    &ContinuousIndexEntry {
                        target_sample_index: index,
                        stage_sample_index: index,
                        stage_id: "step".into(),
                        stage_index: 0,
                        sample_kind: AutosaveSampleKind::Field,
                        coordinate: StageSampleCoordinate::PhysicalTime {
                            time_s: index as f64 * 1e-12,
                        },
                        payload_ref: format!("stages/stage_0000_step/fields/m/{index}"),
                    },
                    "m",
                    &[index as f64, 0.0, 1.0],
                )
                .unwrap();
            let catalog = read_results_catalog(
                &leaf,
                None,
                100,
                Some("run-test-2"),
                WorkspaceResultsSource::WorkspaceItem,
            )
            .unwrap();
            let array = catalog
                .entries
                .iter()
                .find(|entry| entry.path.ends_with("fields/m"))
                .unwrap();
            let sample = read_results_sample(
                &leaf,
                array.array_id.as_deref().unwrap(),
                index as usize,
                &catalog.revision,
                Some("run-test-2"),
            )
            .unwrap();
            assert_eq!(sample.bytes[..8], (index as f64).to_le_bytes());
            assert_eq!(read_run_manifest(&leaf).unwrap().unwrap().status, "running");
        }
        drop(writer); // The caller joins all writers before finalization.
        storage.note_outcome("cancelled", None);
        storage.finish(false, dir.path()).unwrap();
        assert_eq!(
            read_run_manifest(&leaf).unwrap().unwrap().status,
            "cancelled"
        );
        assert_eq!(fs::read(leaf.join("run.json")).unwrap(), descriptor);
        assert!(leaf
            .join("state.zarr/stages/stage_0000_step/fields/m/2.0")
            .is_file());
        assert!(!leaf.join("private-receipt.json").exists());
        assert!(!leaf.join(".fullmag-active.lock").exists());
        assert!(storage.data_root().is_err());
        let catalog = read_results_catalog(
            &leaf,
            None,
            100,
            Some("run-test-2"),
            WorkspaceResultsSource::WorkspaceItem,
        )
        .unwrap();
        assert!(catalog
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("fields/m")));
    }

    #[test]
    fn changed_owner_blocks_writer_handoff_and_terminal_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let before = fs::read(leaf.join("fullmag-run.json")).unwrap();
        fs::write(leaf.join(".fullmag-active.lock"), b"foreign-owner").unwrap();
        assert!(storage.data_root().is_err());
        assert!(storage.finish(false, dir.path()).is_err());
        assert_eq!(fs::read(leaf.join("fullmag-run.json")).unwrap(), before);
        drop(storage);
        assert_eq!(
            fs::read(leaf.join(".fullmag-active.lock")).unwrap(),
            b"foreign-owner"
        );
    }

    #[test]
    fn descriptor_and_completed_samples_are_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let before = fs::read(leaf.join("run.json")).unwrap();
        assert!(storage
            .publish_incremental_descriptor(&claim(ResourceKind::Cpu), "step", dir.path())
            .is_err());
        assert_eq!(fs::read(leaf.join("run.json")).unwrap(), before);
        fs::write(
            storage.data_root().unwrap().join("sample.bin"),
            b"committed",
        )
        .unwrap();
        storage.finish(true, dir.path()).unwrap();
        // Repeated finalization performs no further writes or scratch cleanup.
        storage.finish(true, dir.path()).unwrap();
        assert_eq!(fs::read(leaf.join("sample.bin")).unwrap(), b"committed");
        assert_eq!(fs::read(leaf.join("run.json")).unwrap(), before);
    }

    #[test]
    fn non_incremental_outputs_keep_the_staged_publication_boundary() {
        for success in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (mut storage, leaf) = reserve(dir.path());
            // Adapt the fixture to the legacy branch; the staged descriptor is
            // deliberately absent until a successful publication.
            fs::remove_file(leaf.join("run.json")).unwrap();
            storage.incremental = false;
            storage.data_root = storage.resolved().temp_dir.join("data");
            fs::create_dir(&storage.data_root).unwrap();
            fs::write(
                storage.data_root().unwrap().join("bundle.bin"),
                b"complete bundle",
            )
            .unwrap();
            assert!(!leaf.join("bundle.bin").exists());
            storage.finish(success, dir.path()).unwrap();
            assert_eq!(leaf.join("bundle.bin").exists(), success);
            assert_eq!(leaf.join("run.json").exists(), success);
        }
    }

    #[test]
    fn terminal_manifest_retry_freezes_metadata_and_does_not_republish_solver_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let attempt = dir.path().join("attempt");
        fs::create_dir_all(attempt.join("solver")).unwrap();
        fs::write(attempt.join("solver/m_final.json"), b"first publication").unwrap();

        let mut forced_terminal = read_run_manifest(&leaf).unwrap().unwrap();
        forced_terminal.status = "completed".into();
        forced_terminal.finished_at = Some("forced-terminal".into());
        fs::write(
            leaf.join(RUN_MANIFEST_NAME),
            serde_json::to_vec_pretty(&forced_terminal).unwrap(),
        )
        .unwrap();

        assert!(storage.finish(true, &attempt).is_err());
        let prepared_status = storage.manifest.status.clone();
        let prepared_error = storage.manifest.error.clone();
        let prepared_finished_at = storage.manifest.finished_at.clone().unwrap();
        assert_eq!(
            fs::read(leaf.join("solver/m_final.json")).unwrap(),
            b"first publication"
        );

        storage.note_outcome("cancelled", Some("late outcome mutation".into()));
        fs::write(attempt.join("solver/m_final.json"), b"second publication").unwrap();
        forced_terminal.status = "running".into();
        forced_terminal.finished_at = None;
        fs::write(
            leaf.join(RUN_MANIFEST_NAME),
            serde_json::to_vec_pretty(&forced_terminal).unwrap(),
        )
        .unwrap();
        storage.finish(true, &attempt).unwrap();

        let done = read_run_manifest(&leaf).unwrap().unwrap();
        assert_eq!(done.status, prepared_status);
        assert_eq!(done.error, prepared_error);
        assert_eq!(
            done.finished_at.as_deref(),
            Some(prepared_finished_at.as_str())
        );
        assert_eq!(
            fs::read(leaf.join("solver/m_final.json")).unwrap(),
            b"first publication"
        );
        assert!(!leaf.join(".fullmag-active.lock").exists());
    }

    #[test]
    fn descriptor_failure_is_terminalized_instead_of_leaving_running_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let descriptor_error = storage
            .publish_incremental_descriptor(&claim(ResourceKind::Cpu), "step", dir.path())
            .expect_err("the immutable descriptor must not be replaced");

        let error = finalize_preparation_failure(
            &mut storage,
            anyhow::anyhow!(descriptor_error),
            dir.path(),
        );
        assert!(error
            .to_string()
            .contains("project storage preparation failed"));
        assert_eq!(read_run_manifest(&leaf).unwrap().unwrap().status, "failed");
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(leaf.join("output-storage.json")).unwrap()).unwrap();
        assert_eq!(receipt["state"], "failed");
        assert!(!leaf.join(".fullmag-active.lock").exists());
    }

    #[test]
    fn receipt_failure_before_callback_freezes_completed_outcome_across_retry() {
        let dir = tempfile::tempdir().unwrap();
        let (mut storage, leaf) = reserve(dir.path());
        let receipt_path = leaf.join("output-storage.json");
        fs::remove_file(&receipt_path).unwrap();
        fs::create_dir(&receipt_path).unwrap();

        assert!(storage.finish(true, dir.path()).is_err());
        assert_eq!(read_run_manifest(&leaf).unwrap().unwrap().status, "running");
        let prepared_status = storage.manifest.status.clone();
        let prepared_error = storage.manifest.error.clone();
        let prepared_finished_at = storage.manifest.finished_at.clone().unwrap();

        storage.note_outcome("cancelled", Some("late outcome mutation".into()));
        fs::remove_dir(&receipt_path).unwrap();
        storage.finish(true, dir.path()).unwrap();

        let done = read_run_manifest(&leaf).unwrap().unwrap();
        assert_eq!(done.status, prepared_status);
        assert_eq!(done.error, prepared_error);
        assert_eq!(
            done.finished_at.as_deref(),
            Some(prepared_finished_at.as_str())
        );
    }
}

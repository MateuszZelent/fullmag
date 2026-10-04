//! User output publication kept separate from immutable worker receipts/CAS.

use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_ir::{OutputStorageIR, ProblemIR};
use fullmag_runner::project_storage::ProjectStorageLease;
use fullmag_session::SessionStore;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) struct AcceptedProjectStorage {
    lease: ProjectStorageLease,
    data_root: PathBuf,
    finalized: bool,
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
        let data_root = lease.resolved().temp_dir.join("data");
        fs::create_dir(&data_root).context("create owned staging directory for numerical data")?;
        Ok(Some(Self {
            lease,
            data_root,
            finalized: false,
        }))
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub(crate) fn resolved(&self) -> &fullmag_runner::project_storage::ResolvedOutputStorage {
        self.lease.resolved()
    }

    /// The runner has joined its artifact writer before returning. Publish
    /// finalized data and retain immutable attempt receipts in their store.
    pub(crate) fn finish(&mut self, success: bool, attempt_dir: &Path) -> Result<()> {
        if self.finalized {
            return Ok(());
        }
        let publication = if success {
            (|| {
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
                self.lease
                    .publish_directory(&self.data_root)
                    .map_err(anyhow::Error::msg)
            })()
        } else {
            Ok(())
        };
        self.lease
            .finish(success && publication.is_ok())
            .map_err(anyhow::Error::msg)
            .context("finalize accepted project temporary storage")?;
        self.finalized = true;
        publication.context("publish accepted project numerical data")
    }
}

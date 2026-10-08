//! Inspection-only stage: never registers a legacy field basis for LLG or FFT.
use super::{
    current_stage_magnetization_vectors, relative_artifact_ref, synthetic_interrupt_requested,
    write_synthetic_stage_record, SyntheticStageOutcome, SYNTHETIC_ANTENNA_CANCELLED,
};
use anyhow::{bail, Context, Result};
use fullmag_ir::{
    BackendPlanIR, RequestedTransportExecutionIR, ResolvedAntennaExternalLeadCurrentInputIR,
};
use fullmag_runner::{AntennaExternalLeadSolutionManifest, AntennaFieldStageStatus};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub(super) const STAGE_OUTPUT_NAME: &str = "antenna_external_lead_stage_output.v1.json";
mod carrier;
pub(super) use carrier::plan_carrier;

pub(super) fn is_carrier(plan: &fullmag_ir::ExecutionPlanIR) -> bool {
    plan.provenance
        .notes
        .iter()
        .any(|note| note == "antenna_external_lead_inspection_carrier_only:no_llg_execution")
}

fn read_record(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1 << 20 {
        bail!("external-lead stage record is not a bounded regular file");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((1 << 20) + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1 << 20 {
        bail!("external-lead stage record exceeds size limit");
    }
    Ok(bytes)
}

fn write_record(dir: &Path, payload: &Value, interrupt: Option<&AtomicBool>) -> Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(STAGE_OUTPUT_NAME);
    let bytes = serde_json::to_vec_pretty(payload)?;
    if bytes.len() > 1 << 20 {
        bail!("external-lead stage record exceeds size limit");
    }
    if synthetic_interrupt_requested(interrupt) {
        bail!("{SYNTHETIC_ANTENNA_CANCELLED}");
    }
    if path.exists() {
        if read_record(&path)? == bytes {
            return Ok(());
        }
        bail!("external-lead stage record already exists with different content");
    }
    let temporary = dir.join(format!(
        ".{STAGE_OUTPUT_NAME}.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let mut temporary_created = false;
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        temporary_created = true;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if synthetic_interrupt_requested(interrupt) {
            bail!("{SYNTHETIC_ANTENNA_CANCELLED}");
        }
        // No overwrite even if a concurrent writer committed another record.
        fs::hard_link(&temporary, &path).context("publishing external-lead stage record")?;
        Ok(())
    })();
    if temporary_created {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn execute(
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    artifact_dir: &Path,
    stage_dir: &Path,
    backend_plan: &BackendPlanIR,
    continuation: Option<&[[f64; 3]]>,
    interrupt: Option<&AtomicBool>,
    mut observer: Option<&mut dyn FnMut(AntennaFieldStageStatus, Option<String>)>,
) -> Result<SyntheticStageOutcome> {
    let publication = (|| -> Result<_> {
        if synthetic_interrupt_requested(interrupt) {
            bail!("{SYNTHETIC_ANTENNA_CANCELLED}");
        }
        if let Some(observer) = observer.as_deref_mut() {
            observer(AntennaFieldStageStatus::SolvingCurrent, Some(
                "One current-driven V/RT0/H solve; inspection only; native cancellation is checked after return".into(),
            ));
        }
        let artifact = fullmag_runner::execute_antenna_external_lead_inspection(
            input,
            requested_execution,
            output_id,
            interrupt,
        )?;
        let manifest: AntennaExternalLeadSolutionManifest =
            serde_json::from_slice(&artifact.manifest_bytes)?;
        let published = fullmag_runner::publish_antenna_external_lead_solution_atomically(
            artifact_dir,
            &artifact,
            interrupt,
        )?;
        let manifest_ref = relative_artifact_ref(artifact_dir, &published.manifest_path)?;
        Ok((published, manifest, manifest_ref))
    })();
    let (published, manifest, manifest_ref) = match publication {
        Ok(result) => result,
        Err(error) => {
            let status = if synthetic_interrupt_requested(interrupt) {
                "cancelled"
            } else {
                "failed"
            };
            write_record(
                stage_dir,
                &json!({
                    "schema_version": "antenna_external_lead_stage_output.v1",
                    "stage_kind": "antenna_field_solve",
                    "resolved_action": "external_lead_inspection",
                    "stage_id": input.stage.id,
                    "port_mode_id": input.port.id,
                    "output_id": output_id,
                    "status": status,
                    "qualification": "NOT VERIFIED",
                    "field_scope": input.field_scope,
                    "outputs": [],
                    "diagnostic": error.to_string(),
                }),
                None,
            )
            .context("recording failed/cancelled external-lead inspection")?;
            return Err(error);
        }
    };
    let payload = json!({
        "schema_version": "antenna_external_lead_stage_output.v1",
        "stage_kind": "antenna_field_solve",
        "resolved_action": "external_lead_inspection",
        "stage_id": input.stage.id,
        "port_mode_id": input.port.id,
        "output_id": output_id,
        "status": "inspection_only",
        "qualification": manifest.qualification,
        "field_scope": manifest.field_scope,
        "outputs": [{
            "kind": "antenna_external_lead_inspection",
            "inspection_ref": published.reference,
            "manifest_ref": manifest_ref,
            "payload_units": {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"},
            "reused_existing": published.reused_existing,
        }],
    });
    if let Err(error) = write_record(stage_dir, &payload, interrupt) {
        if synthetic_interrupt_requested(interrupt) {
            write_record(
                stage_dir,
                &json!({
                    "schema_version": "antenna_external_lead_stage_output.v1",
                    "stage_kind": "antenna_field_solve",
                    "resolved_action": "external_lead_inspection",
                    "stage_id": input.stage.id,
                    "port_mode_id": input.port.id,
                    "output_id": output_id,
                    "status": "cancelled",
                    "qualification": "NOT VERIFIED",
                    "field_scope": input.field_scope,
                    "outputs": [],
                    "diagnostic": error.to_string(),
                }),
                None,
            )?;
        }
        return Err(error);
    }
    write_synthetic_stage_record(stage_dir, payload)?;
    Ok(SyntheticStageOutcome {
        magnetization: current_stage_magnetization_vectors(continuation, backend_plan),
        message: format!(
            "Computed antenna inspection '{}' for port '{}'; NOT VERIFIED, no LLG/FFT qualification.",
            output_id, input.port.id,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StageDir(std::path::PathBuf);
    impl StageDir {
        fn new() -> Self {
            let root =
                std::path::PathBuf::from(std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT").expect(
                    "stage publication tests require resolved FULLMAG_PROJECT_STORAGE_ROOT",
                ));
            assert!(root.is_absolute());
            let root = fs::canonicalize(root).unwrap();
            let path = root.join("tmp").join(format!(
                "antenna-inspection-stage-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for StageDir {
        fn drop(&mut self) {
            for name in [STAGE_OUTPUT_NAME, "foreign.txt"] {
                let _ = fs::remove_file(self.0.join(name));
            }
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn inspection_stage_record_reuses_exact_bytes_and_refuses_overwrite() {
        let dir = StageDir::new();
        let payload = json!({"schema_version": "antenna_external_lead_stage_output.v1", "status": "inspection_only", "outputs": []});
        write_record(&dir.0, &payload, None).unwrap();
        let before = read_record(&dir.0.join(STAGE_OUTPUT_NAME)).unwrap();
        write_record(&dir.0, &payload, None).unwrap();
        assert!(write_record(&dir.0, &json!({"status": "ready"}), None).is_err());
        assert_eq!(before, read_record(&dir.0.join(STAGE_OUTPUT_NAME)).unwrap());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn inspection_stage_record_cancel_preserves_foreign_files_without_partial_output() {
        let dir = StageDir::new();
        fs::write(dir.0.join("foreign.txt"), b"foreign").unwrap();
        let flag = AtomicBool::new(true);
        let error =
            write_record(&dir.0, &json!({"status": "inspection_only"}), Some(&flag)).unwrap_err();
        assert!(error.to_string().contains(SYNTHETIC_ANTENNA_CANCELLED));
        assert!(!dir.0.join(STAGE_OUTPUT_NAME).exists());
        assert_eq!(fs::read(dir.0.join("foreign.txt")).unwrap(), b"foreign");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn inspection_stage_record_is_not_accepted_as_a_legacy_ready_catalog() {
        let dir = StageDir::new();
        let payload = json!({
            "schema_version": "antenna_external_lead_stage_output.v1",
            "stage_id": "inspection", "port_mode_id": "port",
            "stage_kind": "antenna_field_solve", "status": "inspection_only", "outputs": [],
        });
        write_record(&dir.0, &payload, None).unwrap();
        assert!(super::super::read_ready_antenna_stage_outputs(
            &dir.0.join(STAGE_OUTPUT_NAME),
            &dir.0,
            "inspection",
            "port",
        )
        .is_err());
        assert!(!dir.0.join("stage_output_catalog.v1.json").exists());
    }
}

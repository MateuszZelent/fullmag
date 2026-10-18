//! One closed-loop solve and one complete immutable publication; never LLG qualification.
use super::{current_stage_magnetization_vectors, publish_antenna_artifacts_atomically,
    relative_artifact_ref, synthetic_interrupt_requested,
    SyntheticStageOutcome, SYNTHETIC_ANTENNA_CANCELLED};
use anyhow::{bail, Context, Result};
use fullmag_ir::{BackendPlanIR, RequestedTransportExecutionIR, ResolvedAntennaClosedLoopCurrentInputIR};
use fullmag_runner::AntennaFieldStageStatus;
use serde_json::{json, Value};
use std::{fs, io::{Read, Write}, path::Path, sync::atomic::AtomicBool};

pub(super) const STAGE_OUTPUT_NAME: &str = "antenna_closed_loop_stage_output.v2.json";
const RECORD_LIMIT: u64 = 1 << 20;

fn write_record(dir: &Path, payload: &Value, interrupt: Option<&AtomicBool>) -> Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(STAGE_OUTPUT_NAME);
    let bytes = serde_json::to_vec_pretty(payload)?;
    if bytes.len() as u64 > RECORD_LIMIT { bail!("closed-loop stage record exceeds size limit"); }
    if synthetic_interrupt_requested(interrupt) { bail!("{SYNTHETIC_ANTENNA_CANCELLED}"); }
    if path.exists() {
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > RECORD_LIMIT {
            bail!("closed-loop stage record is not a bounded regular file");
        }
        let mut previous = Vec::new();
        fs::File::open(&path)?.take(RECORD_LIMIT + 1).read_to_end(&mut previous)?;
        if previous == bytes { return Ok(()); }
        bail!("closed-loop stage record already exists with different content");
    }
    let temporary = dir.join(format!(".{STAGE_OUTPUT_NAME}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if synthetic_interrupt_requested(interrupt) { bail!("{SYNTHETIC_ANTENNA_CANCELLED}"); }
        fs::hard_link(&temporary, &path).context("publishing closed-loop stage record")?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub(super) fn execute(
    input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    artifact_dir: &Path,
    stage_dir: &Path,
    backend_plan: &BackendPlanIR,
    continuation: Option<&[[f64; 3]]>,
    interrupt: Option<&AtomicBool>,
    mut observer: Option<&mut dyn FnMut(AntennaFieldStageStatus, Option<String>)>,
) -> Result<SyntheticStageOutcome> {
    let publication = (|| -> Result<Value> {
        if synthetic_interrupt_requested(interrupt) { bail!("{SYNTHETIC_ANTENNA_CANCELLED}"); }
        if let Some(observer) = observer.as_deref_mut() {
            observer(AntennaFieldStageStatus::SolvingCurrent, Some(
                "Solving the full closed conductor; V, conservative RT0 J and H share one accepted owner".into()));
        }
        let artifacts = fullmag_runner::execute_antenna_closed_loop_inspection(
            input, requested_execution, output_id, interrupt)?;
        let manifest_path = format!("antenna/field_solutions/{output_id}/manifest.v2.json");
        let manifest = artifacts.iter().find(|artifact| artifact.relative_path == manifest_path)
            .context("closed-loop result has no manifest")?;
        let metadata: Value = serde_json::from_slice(&manifest.bytes)?;
        if metadata["schema_version"] != "antenna_field_solution.v2"
            || metadata["status"] != "inspection_only"
            || metadata["stage_id"] != input.stage.id
            || metadata["port_mode_id"] != input.port.id
            || metadata["solution_id"] != output_id {
            bail!("closed-loop stage/result owner mismatch");
        }
        publish_antenna_artifacts_atomically(artifact_dir, output_id, "field_solutions",
            &["manifest.v2.json"], &artifacts, interrupt, None)?;
        let manifest_ref = relative_artifact_ref(artifact_dir, &artifact_dir.join(&manifest_path))?;
        let payload = json!({
            "schema_version": "antenna_closed_loop_stage_output.v2",
            "stage_kind": "antenna_field_solve", "resolved_action": "closed_loop_inspection",
            "stage_id": input.stage.id, "port_mode_id": input.port.id, "output_id": output_id,
            "source_object_id": input.source.object_id, "status": "inspection_only",
            "qualification": "NOT VERIFIED", "field_scope": input.field_scope,
            "outputs": [{"kind": "antenna_closed_loop_inspection", "manifest_ref": manifest_ref,
                "content_digest": metadata["content_digest"], "source": metadata["source"],
                "payload_units": {"V_electric": "V", "J_charge": "A/m^2", "H_ant": "A/m",
                    "H_ant_per_a": "1/m", "positions": "m"}}],
        });
        // The record link is the terminal commit point. Cancellation checked before
        // that point records no handoff; a later request cannot undo a committed result.
        write_record(stage_dir, &payload, interrupt)?;
        Ok(payload)
    })();
    match publication {
        Ok(_) => {},
        Err(error) => {
            write_record(stage_dir, &json!({
                "schema_version": "antenna_closed_loop_stage_output.v2",
                "stage_kind": "antenna_field_solve", "resolved_action": "closed_loop_inspection",
                "stage_id": input.stage.id, "port_mode_id": input.port.id, "output_id": output_id,
                "status": if synthetic_interrupt_requested(interrupt) {"cancelled"} else {"failed"},
                "qualification": "NOT VERIFIED", "field_scope": input.field_scope,
                "outputs": [], "diagnostic": format!("{error}; a committed complete bundle, if present, is retained at antenna/field_solutions/{output_id}/manifest.v2.json without a stage handoff"),
            }), None).context("recording failed/cancelled closed-loop solve")?;
            return Err(error);
        }
    }
    Ok(SyntheticStageOutcome {
        magnetization: current_stage_magnetization_vectors(continuation, backend_plan),
        message: format!("Computed full closed-loop inspection '{output_id}' for port '{}'; NOT VERIFIED for LLG/FFT.", input.port.id),
    })
}

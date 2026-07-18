use fullmag_ir::{OutputIR, RegionalFieldDriveIR, TimeStageContextIR};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::types::{AuxiliaryArtifact, ExecutionProvenance, RunError};

#[derive(Debug, Serialize)]
struct RegionalFieldDriveManifest<'a> {
    schema_version: &'static str,
    active_stage_id: &'a Option<String>,
    stage_start_time_s: f64,
    stage_end_time_s: f64,
    drive_revision_sha256: String,
    drive_count: usize,
    drives: &'a [RegionalFieldDriveIR],
    event_count: usize,
    event_times_s: Vec<f64>,
    fsal_invalidation_count: usize,
    fsal_invalidation_times_s: Vec<f64>,
    execution_engine: &'a str,
    precision: &'a str,
    requested_outputs: Vec<String>,
}

pub(crate) fn regional_field_drive_artifact(
    drives: &[RegionalFieldDriveIR],
    time_stage: &TimeStageContextIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    provenance: &ExecutionProvenance,
) -> Result<Option<AuxiliaryArtifact>, RunError> {
    if drives.is_empty() {
        return Ok(None);
    }
    let stage_end_time_s = time_stage.start_time_s + until_seconds;
    let schedule = crate::time_events::build_resolved_stage_event_schedule(
        drives,
        time_stage.start_time_s,
        stage_end_time_s,
        outputs,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    );
    let fsal_invalidation_times_s = crate::time_events::resolved_stage_drive_discontinuities(
        drives,
        time_stage.start_time_s,
        stage_end_time_s,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    );
    let encoded_drives = serde_json::to_vec(drives).map_err(|error| RunError {
        message: format!("failed to serialize regional field-drive revision: {error}"),
    })?;
    let manifest = RegionalFieldDriveManifest {
        schema_version: "regional_field_drive.v1",
        active_stage_id: &time_stage.active_stage_id,
        stage_start_time_s: time_stage.start_time_s,
        stage_end_time_s,
        drive_revision_sha256: format!("{:x}", Sha256::digest(encoded_drives)),
        drive_count: drives.len(),
        drives,
        event_count: schedule.times_s.len(),
        event_times_s: schedule.times_s,
        fsal_invalidation_count: fsal_invalidation_times_s.len(),
        fsal_invalidation_times_s,
        execution_engine: &provenance.execution_engine,
        precision: &provenance.precision,
        requested_outputs: outputs.iter().map(output_name).collect(),
    };
    let mut bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| RunError {
        message: format!("failed to serialize regional_field_drive.v1: {error}"),
    })?;
    bytes.push(b'\n');
    Ok(Some(AuxiliaryArtifact {
        relative_path: "regional_field_drive.v1.json".into(),
        bytes,
    }))
}

fn output_name(output: &OutputIR) -> String {
    match output {
        OutputIR::Scalar { name, .. }
        | OutputIR::ScalarAuto { name, .. }
        | OutputIR::ScalarResolvedAuto { name, .. }
        | OutputIR::Field { name, .. }
        | OutputIR::FieldAuto { name, .. }
        | OutputIR::FieldResolvedAuto { name, .. }
        | OutputIR::DispersionCurve { name } => name.clone(),
        OutputIR::Snapshot {
            field, component, ..
        } => format!("{field}:{component}"),
        OutputIR::EigenSpectrum { quantity } => quantity.clone(),
        OutputIR::EigenMode { field, .. } => field.clone(),
        OutputIR::FrequencyResponseOutput { .. } => "frequency_response".into(),
        OutputIR::EigenDiagnostics { .. } => "eigen_diagnostics".into(),
        OutputIR::SaveQuantity { quantity_id, .. } => quantity_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        DriveActivationIR, FieldDriveKindIR, FieldSpatialProfileIR, FieldTargetIR,
        FieldTimeOriginIR, TimeDependenceIR,
    };

    #[test]
    fn manifest_carries_revision_stage_events_and_provenance() {
        let drive = RegionalFieldDriveIR {
            id: "pulse".into(),
            name: "Pulse".into(),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::Pulse {
                t_on: 1e-12,
                t_off: 2e-12,
            },
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: DriveActivationIR::AllTimeEvolution {},
            migration: None,
        };
        let artifact = regional_field_drive_artifact(
            &[drive],
            &TimeStageContextIR {
                active_stage_id: Some("run".into()),
                start_time_s: 10e-12,
            },
            3e-12,
            &[],
            &ExecutionProvenance {
                execution_engine: "native_fem_cpu".into(),
                precision: "double".into(),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(value["schema_version"], "regional_field_drive.v1");
        assert_eq!(value["active_stage_id"], "run");
        assert_eq!(value["event_count"], 4);
        assert_eq!(value["execution_engine"], "native_fem_cpu");
    }
}

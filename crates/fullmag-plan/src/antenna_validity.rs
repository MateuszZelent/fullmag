use fullmag_ir::{
    AntennaWaveformBandwidthIR, ProblemIR, SolvedAntennaDriveIR,
    ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION,
};

pub use fullmag_ir::classify_antenna_waveform_bandwidth;

/// Add stable, human-readable bandwidth provenance for every solved antenna
/// drive.  The note is recomputed from the authored waveform on every plan;
/// changing a waveform therefore cannot leave a stale validity diagnostic.
pub fn antenna_waveform_bandwidth_notes(problem: &ProblemIR) -> Vec<String> {
    problem
        .solved_antenna_drives
        .iter()
        .map(antenna_waveform_bandwidth_note)
        .collect()
}

fn antenna_waveform_bandwidth_note(drive: &SolvedAntennaDriveIR) -> String {
    match fullmag_ir::classify_antenna_waveform_bandwidth(&drive.waveform) {
        AntennaWaveformBandwidthIR::Known {
            f_max_hz, source, ..
        } => format!(
            "{ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION} drive_id={} status=known f_max_hz={f_max_hz:.17e} source={}",
            drive.id,
            source.as_str()
        ),
        AntennaWaveformBandwidthIR::Unknown { reason, .. } => format!(
            "{ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION} drive_id={} status=unknown reason={reason}",
            drive.id
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AntennaWaveformBandwidthSourceIR, DriveActivationIR, FieldTimeOriginIR, TimeDependenceIR,
    };

    fn drive(id: &str, waveform: TimeDependenceIR) -> SolvedAntennaDriveIR {
        SolvedAntennaDriveIR {
            id: id.to_string(),
            name: id.to_string(),
            projection_ref: "projection".to_string(),
            port_mode_id: "port".to_string(),
            peak_current_a: 1.0,
            waveform,
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: DriveActivationIR::AllTimeEvolution {},
        }
    }

    #[test]
    fn notes_are_versioned_and_refresh_from_authored_waveform() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.solved_antenna_drives.push(drive(
            "rf",
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 4.5e9,
                phase_rad: 0.0,
                offset: 0.0,
            },
        ));
        let notes = antenna_waveform_bandwidth_notes(&problem);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains(ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION));
        assert!(notes[0].contains("f_max_hz=4.50000000000000000e9"));
        assert!(notes[0].contains("source=sinusoidal"));

        problem.solved_antenna_drives[0].waveform = TimeDependenceIR::PiecewiseLinear {
            points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
        };
        let updated = antenna_waveform_bandwidth_notes(&problem);
        assert!(updated[0].contains("status=unknown"));
        assert!(updated[0].contains("validity_bandwidth_unknown"));
    }

    #[test]
    fn classifier_reexport_preserves_source_contract() {
        let result = classify_antenna_waveform_bandwidth(&TimeDependenceIR::SincPulse {
            cutoff_hz: 8.0e9,
            t0: 0.0,
            amplitude: 1.0,
        });
        assert!(matches!(
            result,
            AntennaWaveformBandwidthIR::Known {
                source: AntennaWaveformBandwidthSourceIR::SincCutoff,
                ..
            }
        ));
    }
}

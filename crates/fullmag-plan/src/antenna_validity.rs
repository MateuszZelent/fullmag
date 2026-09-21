use fullmag_ir::{
    AntennaWaveformBandwidthIR, GeometryEntryIR, ProblemIR, SolvedAntennaDriveIR,
    ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION,
};

pub use fullmag_ir::classify_antenna_waveform_bandwidth;

const ANTENNA_VALIDITY_SCHEMA_VERSION: &str = "antenna_validity.v1";
const SPEED_OF_LIGHT_M_PER_S: f64 = 299_792_458.0;
const MU0_H_PER_M: f64 = 4.0 * std::f64::consts::PI * 1.0e-7;
const VALIDITY_WARNING_THRESHOLD: f64 = 0.1;

#[derive(Debug, Clone, Copy)]
struct ConductorMetrics {
    length_m: f64,
    thickness_m: f64,
    conductivity_s_per_m: f64,
}

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

/// Compute the Tier-1 separable-field validity diagnostics defined by 0950.
/// Geometry is resolved through the authored solve stage rather than inferred
/// from a drive name, and unknown bandwidth/geometry remains explicitly
/// unknown.
pub fn antenna_validity_notes(problem: &ProblemIR) -> Vec<String> {
    problem
        .solved_antenna_drives
        .iter()
        .map(|drive| {
            antenna_validity_note(
                drive,
                conductor_metrics_for_drive(problem, drive),
            )
        })
        .collect()
}

fn conductor_metrics_for_drive(
    problem: &ProblemIR,
    drive: &SolvedAntennaDriveIR,
) -> Option<ConductorMetrics> {
    let projection = problem
        .antenna_target_projections
        .iter()
        .find(|projection| projection.id == drive.projection_ref)?;
    let stage = problem
        .antenna_field_solve_stages
        .iter()
        .find(|stage| stage.id == projection.solution.stage_id)?;
    let geometry = problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == stage.source_object_id.as_str())?;
    match geometry {
        GeometryEntryIR::MicrostripAntenna {
            length_m,
            thickness_m,
            conductivity_s_per_m,
            ..
        }
        | GeometryEntryIR::CpwAntenna {
            length_m,
            thickness_m,
            conductivity_s_per_m,
            ..
        } => Some(ConductorMetrics {
            length_m: *length_m,
            thickness_m: *thickness_m,
            conductivity_s_per_m: *conductivity_s_per_m,
        }),
        _ => None,
    }
}

fn antenna_validity_note(
    drive: &SolvedAntennaDriveIR,
    metrics: Option<ConductorMetrics>,
) -> String {
    let bandwidth = fullmag_ir::classify_antenna_waveform_bandwidth(&drive.waveform);
    let AntennaWaveformBandwidthIR::Known {
        f_max_hz,
        source,
        ..
    } = bandwidth
    else {
        return format!(
            "{ANTENNA_VALIDITY_SCHEMA_VERSION} drive_id={} status=unknown reason=validity_bandwidth_unknown",
            drive.id
        );
    };

    let Some(metrics) = metrics else {
        return format!(
            "{ANTENNA_VALIDITY_SCHEMA_VERSION} drive_id={} status=unknown reason=antenna_geometry_unknown f_max_hz={f_max_hz:.17e} source={}",
            drive.id,
            source.as_str()
        );
    };
    if !metrics.length_m.is_finite()
        || metrics.length_m <= 0.0
        || !metrics.thickness_m.is_finite()
        || metrics.thickness_m <= 0.0
        || !metrics.conductivity_s_per_m.is_finite()
        || metrics.conductivity_s_per_m <= 0.0
    {
        return format!(
            "{ANTENNA_VALIDITY_SCHEMA_VERSION} drive_id={} status=unknown reason=antenna_geometry_invalid f_max_hz={f_max_hz:.17e} source={}",
            drive.id,
            source.as_str()
        );
    }

    let eta_wave = metrics.length_m * f_max_hz / SPEED_OF_LIGHT_M_PER_S;
    let eta_skin = if f_max_hz == 0.0 {
        0.0
    } else {
        let skin_depth_m =
            (2.0 / (2.0 * std::f64::consts::PI * f_max_hz * MU0_H_PER_M
                * metrics.conductivity_s_per_m))
                .sqrt();
        metrics.thickness_m / skin_depth_m
    };
    let status = if eta_wave >= VALIDITY_WARNING_THRESHOLD || eta_skin >= VALIDITY_WARNING_THRESHOLD
    {
        "warning"
    } else {
        "ok"
    };
    let warning = if status == "warning" {
        " warning=separable_field_basis_validity_warning"
    } else {
        ""
    };
    format!(
        "{ANTENNA_VALIDITY_SCHEMA_VERSION} drive_id={} status={status} f_max_hz={f_max_hz:.17e} source={} length_m={:.17e} thickness_m={:.17e} conductivity_s_per_m={:.17e} eta_wave={:.17e} eta_skin={:.17e}{warning}",
        drive.id,
        source.as_str(),
        metrics.length_m,
        metrics.thickness_m,
        metrics.conductivity_s_per_m,
        eta_wave,
        eta_skin,
    )
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

    #[test]
    fn validity_note_uses_physical_ratios_and_warning_threshold() {
        let drive = drive(
            "rf",
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 10.0e9,
                phase_rad: 0.0,
                offset: 0.0,
            },
        );
        let note = antenna_validity_note(
            &drive,
            Some(ConductorMetrics {
                length_m: 0.01,
                thickness_m: 2.0e-6,
                conductivity_s_per_m: 5.8e7,
            }),
        );
        assert!(note.contains("antenna_validity.v1 drive_id=rf status=warning"));
        assert!(note.contains("eta_wave="));
        assert!(note.contains("eta_skin="));
        assert!(note.contains("separable_field_basis_validity_warning"));
    }

    #[test]
    fn unknown_bandwidth_remains_unknown_without_duration_heuristic() {
        let drive = drive(
            "pulse",
            TimeDependenceIR::Pulse {
                t_on: 0.0,
                t_off: 1.0e-9,
            },
        );
        let note = antenna_validity_note(&drive, None);
        assert!(note.contains("status=unknown"));
        assert!(note.contains("validity_bandwidth_unknown"));
        assert!(!note.contains("f_max_hz="));
    }
}

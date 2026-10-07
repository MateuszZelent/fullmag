use fullmag_ir::{
    AntennaWaveformBandwidthIR, GeometryEntryIR, ProblemIR, SolvedAntennaDriveIR, StudyKindIR,
    ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION,
};

pub use fullmag_ir::classify_antenna_waveform_bandwidth;

const ANTENNA_VALIDITY_SCHEMA_VERSION: &str = "antenna_validity.v1";
const ANTENNA_WAVEFORM_BANDWIDTH_AGGREGATE_SCHEMA_VERSION: &str =
    "antenna_waveform_bandwidth_aggregate.v1";
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

/// Publish one conservative band for the shared antenna-field source used by
/// all potentially active solved drives. When the active stage is known, use
/// the same activation rule as materialization; otherwise explicit `StageIds`
/// remain potentially active in an authored, unresolved `ProblemIR`.
pub fn antenna_waveform_bandwidth_aggregate_note(problem: &ProblemIR) -> String {
    let study_kind = problem.study.kind();
    let candidates = problem
        .solved_antenna_drives
        .iter()
        .filter(|drive| drive_may_be_active(drive, problem))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return format!(
            "{ANTENNA_WAVEFORM_BANDWIDTH_AGGREGATE_SCHEMA_VERSION} study_kind={} status=none shared_field_quantity=H_ant_basis",
            study_kind_name(study_kind)
        );
    }

    let mut known = Vec::with_capacity(candidates.len());
    let mut unknown = Vec::new();
    let mut port_mode_ids = candidates
        .iter()
        .map(|drive| drive.port_mode_id.as_str())
        .collect::<Vec<_>>();
    port_mode_ids.sort_unstable();
    port_mode_ids.dedup();
    for drive in &candidates {
        match fullmag_ir::classify_antenna_waveform_bandwidth_with_declaration(
            &drive.waveform,
            drive.bandwidth_declaration.as_ref(),
        ) {
            AntennaWaveformBandwidthIR::Known { f_max_hz, .. } => {
                known.push((drive.id.as_str(), f_max_hz));
            }
            AntennaWaveformBandwidthIR::Unknown { .. } => unknown.push(drive.id.as_str()),
        }
    }
    let drive_ids = candidates
        .iter()
        .map(|drive| drive.id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let port_mode_ids = port_mode_ids.join(",");
    if !unknown.is_empty() {
        return format!(
            "{ANTENNA_WAVEFORM_BANDWIDTH_AGGREGATE_SCHEMA_VERSION} study_kind={} status=unknown reason=active_drive_bandwidth_unknown active_drive_ids={drive_ids} unknown_drive_ids={} port_mode_ids={port_mode_ids} shared_field_quantity=H_ant_basis",
            study_kind_name(study_kind),
            unknown.join(",")
        );
    }

    let f_max_hz = known
        .iter()
        .map(|(_, f_max_hz)| *f_max_hz)
        .fold(0.0_f64, f64::max);
    format!(
        "{ANTENNA_WAVEFORM_BANDWIDTH_AGGREGATE_SCHEMA_VERSION} study_kind={} status=known active_drive_ids={drive_ids} port_mode_ids={port_mode_ids} f_max_hz={f_max_hz:.17e} aggregation=maximum_active_drive_band shared_field_quantity=H_ant_basis",
        study_kind_name(study_kind)
    )
}

fn drive_may_be_active(drive: &SolvedAntennaDriveIR, problem: &ProblemIR) -> bool {
    if crate::util::active_stage_id(problem).is_some() {
        return crate::util::drive_activation_is_active(&drive.activation, problem);
    }
    match &drive.activation {
        fullmag_ir::DriveActivationIR::AllTimeEvolution {} => {
            matches!(problem.study.kind(), StudyKindIR::TimeEvolution)
        }
        fullmag_ir::DriveActivationIR::StageIds { stage_ids } => !stage_ids.is_empty(),
    }
}

fn study_kind_name(study_kind: StudyKindIR) -> &'static str {
    match study_kind {
        StudyKindIR::Unknown => "unknown",
        StudyKindIR::TimeEvolution => "time_evolution",
        StudyKindIR::Relaxation => "relaxation",
        StudyKindIR::Hysteresis => "hysteresis",
        StudyKindIR::Eigenmodes => "eigenmodes",
        StudyKindIR::FrequencyResponse => "frequency_response",
    }
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
        .find(|stage| stage.id == projection.solution.stage_id())?;
    let geometry_name = crate::antenna_field_solve::geometry_name_for_object(
        problem,
        &stage.source_object_id,
    ).ok()?;
    let geometry = problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == geometry_name)?;
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
    let bandwidth = fullmag_ir::classify_antenna_waveform_bandwidth_with_declaration(
        &drive.waveform,
        drive.bandwidth_declaration.as_ref(),
    );
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
    if !eta_wave.is_finite() || !eta_skin.is_finite() {
        return format!(
            "{ANTENNA_VALIDITY_SCHEMA_VERSION} drive_id={} status=unknown reason=validity_numeric_overflow f_max_hz={f_max_hz:.17e} source={} length_m={:.17e} thickness_m={:.17e} conductivity_s_per_m={:.17e}",
            drive.id,
            source.as_str(),
            metrics.length_m,
            metrics.thickness_m,
            metrics.conductivity_s_per_m,
        );
    }
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
    match fullmag_ir::classify_antenna_waveform_bandwidth_with_declaration(
        &drive.waveform,
        drive.bandwidth_declaration.as_ref(),
    ) {
        AntennaWaveformBandwidthIR::Known {
            f_max_hz, source, ..
        } => {
            let declaration_schema = if matches!(
                source,
                fullmag_ir::AntennaWaveformBandwidthSourceIR::Declared
            ) {
                format!(
                    " declaration_schema={}",
                    fullmag_ir::ANTENNA_WAVEFORM_BANDWIDTH_DECLARATION_SCHEMA_VERSION
                )
            } else {
                String::new()
            };
            format!(
                "{ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION} drive_id={} status=known f_max_hz={f_max_hz:.17e} source={}{}",
                drive.id,
                source.as_str(),
                declaration_schema
            )
        }
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
        AntennaFieldModelIR, AntennaFieldSolveStageIR, AntennaOerstedRealizationIR,
        AntennaSolutionRefIR, AntennaStageOutputRefIR, AntennaTargetProjectionRefIR,
        AntennaWaveformBandwidthSourceIR, DriveActivationIR, FieldTargetIR, FieldTimeOriginIR,
        TimeDependenceIR,
    };

    fn drive(id: &str, waveform: TimeDependenceIR) -> SolvedAntennaDriveIR {
        SolvedAntennaDriveIR {
            id: id.to_string(),
            name: id.to_string(),
            projection_ref: "projection".to_string(),
            port_mode_id: "port".to_string(),
            peak_current_a: 1.0,
            waveform,
            bandwidth_declaration: None,
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
    fn aggregate_note_uses_maximum_known_band_for_potentially_active_ports() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.solved_antenna_drives.push(drive(
            "rf_a",
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 2.0e9,
                phase_rad: 0.0,
                offset: 0.0,
            },
        ));
        let mut second = drive("rf_b", TimeDependenceIR::Constant);
        second.port_mode_id = "port_b".to_string();
        problem.solved_antenna_drives.push(second);
        let note = antenna_waveform_bandwidth_aggregate_note(&problem);
        assert!(note.contains("status=known"));
        assert!(note.contains("f_max_hz=2.00000000000000000e9"));
        assert!(note.contains("aggregation=maximum_active_drive_band"));
        assert!(note.contains("port_mode_ids=port,port_b"));
    }

    #[test]
    fn aggregate_note_is_unknown_when_one_active_port_has_no_band() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.solved_antenna_drives.push(drive(
            "rf_a",
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 2.0e9,
                phase_rad: 0.0,
                offset: 0.0,
            },
        ));
        problem.solved_antenna_drives.push(drive(
            "rf_b",
            TimeDependenceIR::PiecewiseLinear {
                points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
            },
        ));
        let note = antenna_waveform_bandwidth_aggregate_note(&problem);
        assert!(note.contains("status=unknown"));
        assert!(note.contains("active_drive_bandwidth_unknown"));
        assert!(note.contains("unknown_drive_ids=rf_b"));
    }

    #[test]
    fn aggregate_uses_resolved_stage_activation_when_stage_is_known() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut run_drive = drive("run_rf", TimeDependenceIR::Constant);
        run_drive.activation = DriveActivationIR::StageIds {
            stage_ids: vec!["run".to_string()],
        };
        let mut later_drive = drive(
            "later_rf",
            TimeDependenceIR::PiecewiseLinear {
                points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
            },
        );
        later_drive.activation = DriveActivationIR::StageIds {
            stage_ids: vec!["later".to_string()],
        };
        problem.solved_antenna_drives = vec![run_drive, later_drive];

        assert!(antenna_waveform_bandwidth_aggregate_note(&problem).contains("status=unknown"));
        problem.problem_meta.runtime_metadata.insert(
            "active_stage_id".to_string(),
            serde_json::json!("run"),
        );
        let note = antenna_waveform_bandwidth_aggregate_note(&problem);
        assert!(note.contains("status=known active_drive_ids=run_rf"));
        assert!(!note.contains("later_rf"));
        assert!(note.contains("f_max_hz=0.00000000000000000e0"));

        problem.problem_meta.runtime_metadata.insert(
            "active_stage_id".to_string(),
            serde_json::json!("relax"),
        );
        assert!(antenna_waveform_bandwidth_aggregate_note(&problem).contains("status=none"));
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
    fn validity_resolves_stable_object_id_through_its_geometry_binding() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::MicrostripAntenna {
            name: "layout_geometry".into(),
            length_m: 1.0e-5,
            thickness_m: 1.0e-7,
            conductivity_s_per_m: 5.8e7,
            transform: fullmag_ir::AntennaRigidTransformIR {
                rotation_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                translation_m: [0.0; 3],
            },
            stations: Vec::new(),
            return_width_m: 1.0e-6,
            return_offset_m: 2.0e-6,
            conductors: Vec::new(),
            terminal_faces: std::collections::BTreeMap::new(),
        };
        problem.regions[0].geometry = "layout_geometry".into();
        problem.magnets[0].name = "display_name".into();
        problem.magnets[0].object_id = Some("stable_object_id".into());
        problem.geometry.entries.push(GeometryEntryIR::Box {
            name: "stable_object_id".into(),
            size: [1.0, 1.0, 1.0],
        });
        assert_eq!(
            crate::antenna_field_solve::geometry_name_for_object(
                &problem,
                "stable_object_id",
            ).unwrap(),
            "layout_geometry",
        );
        problem.antenna_field_solve_stages.push(AntennaFieldSolveStageIR {
            id: "solve".into(),
            source_object_id: "stable_object_id".into(),
            current_transport_id: "current".into(),
            port_mode_ids: vec!["port".into()],
            conservative_current_view_ref: Some("view".into()),
            model: AntennaFieldModelIR::QuasistaticConductionBiotSavart3d,
            oersted_realization: AntennaOerstedRealizationIR::DirectTetraQuadrature,
            conductor_mesh_policy: "default".into(),
            field_sampling_domain: FieldTargetIR::Global {},
            target_refs: Vec::new(),
            solver_policy: "default".into(),
            outputs: Vec::new(),
        });
        problem.antenna_target_projections.push(AntennaTargetProjectionRefIR {
            id: "projection".into(),
            solution: AntennaSolutionRefIR::StageOutput(AntennaStageOutputRefIR::StageOutput {
                stage_id: "solve".into(),
                output_id: "basis".into(),
            }),
            target: FieldTargetIR::Global {},
            output_id: "projected".into(),
        });
        let drive = drive("rf", TimeDependenceIR::Constant);
        let metrics = conductor_metrics_for_drive(&problem, &drive)
            .expect("validity must resolve object id to authored geometry");
        assert_eq!(metrics.length_m, 1.0e-5);
        assert_eq!(metrics.thickness_m, 1.0e-7);
        assert_eq!(metrics.conductivity_s_per_m, 5.8e7);
    }

    #[test]
    fn validity_note_does_not_publish_infinite_ratios() {
        let drive = drive(
            "rf",
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 1.0e300,
                phase_rad: 0.0,
                offset: 0.0,
            },
        );
        let note = antenna_validity_note(
            &drive,
            Some(ConductorMetrics {
                length_m: 1.0e100,
                thickness_m: 1.0e100,
                conductivity_s_per_m: 1.0e100,
            }),
        );
        assert!(note.contains("status=unknown reason=validity_numeric_overflow"));
        assert!(!note.contains("eta_wave="));
        assert!(!note.contains("eta_skin="));
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

    #[test]
    fn declared_piecewise_band_refreshes_validity_diagnostic() {
        let mut drive = drive(
            "rf",
            TimeDependenceIR::PiecewiseLinear {
                points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
            },
        );
        drive.bandwidth_declaration = Some(fullmag_ir::AntennaWaveformBandwidthDeclarationIR {
            f_max_hz: 4.0e9,
        });
        let note = antenna_waveform_bandwidth_note(&drive);
        assert!(note.contains("status=known"));
        assert!(note.contains("source=declared"));
        assert!(note.contains("f_max_hz=4.00000000000000000e9"));
    }
}

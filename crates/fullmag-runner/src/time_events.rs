use fullmag_ir::{
    FieldTimeOriginIR, OutputIR, RegionalFieldDriveIR, ResolvedSolvedAntennaDriveBasisIR,
    TimeDependenceIR, TimeStageContextIR,
};

pub(crate) fn resolved_field_drive_is_active(
    drive: &RegionalFieldDriveIR,
    time_stage: &TimeStageContextIR,
) -> bool {
    drive.enabled
        && drive
            .activation
            .is_active_for(time_stage.study_kind, time_stage.active_stage_id.as_deref())
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StageTimeWindow {
    pub stage_id: String,
    pub start_s: f64,
    pub end_s: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TimeEventSchedule {
    pub times_s: Vec<f64>,
}

fn waveform_event_offsets(waveform: &TimeDependenceIR) -> Vec<f64> {
    match waveform {
        TimeDependenceIR::Pulse { t_on, t_off } => vec![*t_on, *t_off],
        TimeDependenceIR::PiecewiseLinear { points } => {
            points.iter().map(|point| point[0]).collect()
        }
        TimeDependenceIR::Constant
        | TimeDependenceIR::Sinusoidal { .. }
        | TimeDependenceIR::SincPulse { .. } => Vec::new(),
    }
}

#[cfg(test)]
fn drive_active_in_stage(drive: &RegionalFieldDriveIR, stage_id: &str) -> bool {
    drive
        .activation
        .is_active_for(fullmag_ir::StudyKindIR::TimeEvolution, Some(stage_id))
}

#[cfg(test)]
pub(crate) fn build_time_event_schedule(
    drives: &[RegionalFieldDriveIR],
    stages: &[StageTimeWindow],
    output_times_s: &[f64],
    tolerance_s: f64,
) -> TimeEventSchedule {
    let mut times = output_times_s.to_vec();
    for stage in stages {
        if drives
            .iter()
            .any(|drive| drive.enabled && drive_active_in_stage(drive, &stage.stage_id))
        {
            times.push(stage.start_s);
            times.push(stage.end_s);
        }
    }
    for drive in drives.iter().filter(|drive| drive.enabled) {
        let offsets = waveform_event_offsets(&drive.waveform);
        match drive.time_origin {
            FieldTimeOriginIR::Absolute => times.extend(offsets),
            FieldTimeOriginIR::StageLocal => {
                for stage in stages
                    .iter()
                    .filter(|stage| drive_active_in_stage(drive, &stage.stage_id))
                {
                    for offset in &offsets {
                        let time = stage.start_s + offset;
                        if time >= stage.start_s - tolerance_s && time <= stage.end_s + tolerance_s
                        {
                            times.push(time.clamp(stage.start_s, stage.end_s));
                        }
                    }
                }
            }
        }
    }
    times.retain(|time| time.is_finite());
    times.sort_by(f64::total_cmp);
    let mut deduplicated: Vec<f64> = Vec::with_capacity(times.len());
    for time in times {
        if deduplicated
            .last()
            .is_none_or(|previous| (time - *previous).abs() > tolerance_s)
        {
            deduplicated.push(time);
        }
    }
    TimeEventSchedule {
        times_s: deduplicated,
    }
}

/// Builds the executable schedule for one already-resolved stage. The planner
/// has removed drives inactive in this stage, so activation is intentionally
/// not re-evaluated here.
pub(crate) fn build_resolved_stage_event_schedule_with_origin(
    drives: &[RegionalFieldDriveIR],
    solved_bases: &[ResolvedSolvedAntennaDriveBasisIR],
    stage_start_s: f64,
    waveform_origin_s: f64,
    stage_end_s: f64,
    outputs: &[OutputIR],
    tolerance_s: f64,
) -> TimeEventSchedule {
    let mut times = vec![stage_start_s, stage_end_s];
    for (waveform, time_origin) in drives
        .iter()
        .filter(|drive| drive.enabled)
        .map(|drive| (&drive.waveform, drive.time_origin))
        .chain(
            solved_bases
                .iter()
                .map(|basis| (&basis.drive.waveform, basis.drive.time_origin)),
        )
    {
        for offset in waveform_event_offsets(waveform) {
            let time = match time_origin {
                FieldTimeOriginIR::StageLocal => waveform_origin_s + offset,
                FieldTimeOriginIR::Absolute => offset,
            };
            if time >= stage_start_s - tolerance_s && time <= stage_end_s + tolerance_s {
                times.push(time.clamp(stage_start_s, stage_end_s));
            }
        }
    }
    let finite_stage_span = stage_end_s - stage_start_s;
    if finite_stage_span.is_finite() && finite_stage_span >= 0.0 {
        for every_s in outputs.iter().filter_map(|output| match output {
            OutputIR::Scalar { every_seconds, .. }
            | OutputIR::ScalarResolvedAuto { every_seconds, .. }
            | OutputIR::Field { every_seconds, .. }
            | OutputIR::FieldResolvedAuto { every_seconds, .. }
            | OutputIR::Snapshot { every_seconds, .. } => Some(*every_seconds),
            _ => None,
        }) {
            if every_s.is_finite() && every_s > 0.0 {
                let count = (finite_stage_span / every_s).floor() as u64;
                for index in 0..=count {
                    times.push(stage_start_s + index as f64 * every_s);
                }
            }
        }
    }
    times.retain(|time| time.is_finite());
    times.sort_by(f64::total_cmp);
    times.dedup_by(|right, left| (*right - *left).abs() <= tolerance_s);
    TimeEventSchedule { times_s: times }
}

/// Direct energy minimizers advance in accepted minimization steps, not in
/// physical time. Building sub-picosecond output events across their synthetic
/// `until_seconds` horizon can therefore allocate an unbounded vector that the
/// minimizer never consumes.
#[cfg(any(feature = "fem-gpu", test))]
pub(crate) fn build_native_fem_stage_event_schedule(
    drives: &[RegionalFieldDriveIR],
    solved_bases: &[ResolvedSolvedAntennaDriveBasisIR],
    stage_start_s: f64,
    stage_end_s: f64,
    outputs: &[OutputIR],
    tolerance_s: f64,
    physical_time_events_required: bool,
) -> Option<TimeEventSchedule> {
    physical_time_events_required.then(|| {
        build_resolved_stage_event_schedule_with_origin(
            drives,
            solved_bases,
            stage_start_s,
            stage_start_s,
            stage_end_s,
            outputs,
            tolerance_s,
        )
    })
}

pub(crate) fn resolved_stage_drive_discontinuities_with_origin(
    drives: &[RegionalFieldDriveIR],
    solved_bases: &[ResolvedSolvedAntennaDriveBasisIR],
    stage_start_s: f64,
    waveform_origin_s: f64,
    stage_end_s: f64,
    tolerance_s: f64,
) -> Vec<f64> {
    let mut times = drives
        .iter()
        .filter(|drive| drive.enabled)
        .map(|drive| (&drive.waveform, drive.time_origin))
        .chain(
            solved_bases
                .iter()
                .map(|basis| (&basis.drive.waveform, basis.drive.time_origin)),
        )
        .flat_map(|(waveform, time_origin)| {
            waveform_event_offsets(waveform)
                .into_iter()
                .map(|offset| match time_origin {
                    FieldTimeOriginIR::StageLocal => waveform_origin_s + offset,
                    FieldTimeOriginIR::Absolute => offset,
                })
                .collect::<Vec<_>>()
        })
        .filter(|time| *time > stage_start_s + tolerance_s && *time < stage_end_s - tolerance_s)
        .collect::<Vec<_>>();
    times.sort_by(f64::total_cmp);
    times.dedup_by(|right, left| (*right - *left).abs() <= tolerance_s);
    times
}

pub(crate) fn cap_timestep_to_next_event(
    current_time_s: f64,
    proposed_dt_s: f64,
    event_times_s: &[f64],
    tolerance_s: f64,
) -> f64 {
    let proposed_end = current_time_s + proposed_dt_s;
    event_times_s
        .iter()
        .copied()
        .find(|event| *event > current_time_s + tolerance_s && *event < proposed_end - tolerance_s)
        .map_or(proposed_dt_s, |event| event - current_time_s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        DriveActivationIR, FieldDriveKindIR, FieldSpatialProfileIR, FieldTargetIR,
        FieldTimeOriginIR, RegionalFieldDriveIR, StudyKindIR, TimeDependenceIR,
    };

    fn pulse(origin: FieldTimeOriginIR, activation: DriveActivationIR) -> RegionalFieldDriveIR {
        RegionalFieldDriveIR {
            id: "pulse".into(),
            name: "Pulse".into(),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::Pulse {
                t_on: 1.0,
                t_off: 2.0,
            },
            time_origin: origin,
            activation,
            migration: None,
        }
    }

    #[test]
    fn resolved_analysis_drive_activation_respects_study_and_stage() {
        let drive = pulse(
            FieldTimeOriginIR::Absolute,
            DriveActivationIR::AllTimeEvolution {},
        );
        let mut stage = TimeStageContextIR {
            active_stage_id: Some("run".into()),
            start_time_s: 0.0,
            waveform_origin_time_s: None,
            study_kind: StudyKindIR::Relaxation,
        };
        assert!(!resolved_field_drive_is_active(&drive, &stage));
        stage.study_kind = StudyKindIR::TimeEvolution;
        assert!(resolved_field_drive_is_active(&drive, &stage));

        let mut explicit = pulse(
            FieldTimeOriginIR::Absolute,
            DriveActivationIR::StageIds {
                stage_ids: vec!["relax".into()],
            },
        );
        explicit.waveform = TimeDependenceIR::Constant;
        stage.study_kind = StudyKindIR::Relaxation;
        assert!(!resolved_field_drive_is_active(&explicit, &stage));
        stage.active_stage_id = Some("relax".into());
        assert!(resolved_field_drive_is_active(&explicit, &stage));
        explicit.enabled = false;
        assert!(!resolved_field_drive_is_active(&explicit, &stage));
    }

    #[test]
    fn stage_local_events_are_shifted_and_activation_filtered() {
        let drives = vec![pulse(
            FieldTimeOriginIR::StageLocal,
            DriveActivationIR::StageIds {
                stage_ids: vec!["run-b".into()],
            },
        )];
        let stages = vec![
            StageTimeWindow {
                stage_id: "run-a".into(),
                start_s: 0.0,
                end_s: 5.0,
            },
            StageTimeWindow {
                stage_id: "run-b".into(),
                start_s: 10.0,
                end_s: 15.0,
            },
        ];
        let schedule = build_time_event_schedule(&drives, &stages, &[], 1e-12);
        assert_eq!(schedule.times_s, vec![10.0, 11.0, 12.0, 15.0]);
    }

    #[test]
    fn events_and_output_times_are_sorted_and_deduplicated() {
        let drives = vec![pulse(
            FieldTimeOriginIR::Absolute,
            DriveActivationIR::AllTimeEvolution {},
        )];
        let stages = vec![StageTimeWindow {
            stage_id: "run".into(),
            start_s: 0.0,
            end_s: 3.0,
        }];
        let schedule = build_time_event_schedule(&drives, &stages, &[1.0 + 1e-14, 2.5], 1e-12);
        assert_eq!(schedule.times_s, vec![0.0, 1.0, 2.0, 2.5, 3.0]);
    }

    #[test]
    fn cap_step_lands_exactly_on_next_event() {
        let capped = cap_timestep_to_next_event(0.8, 0.5, &[1.0, 2.0], 1e-12);
        assert_eq!(0.8 + capped, 1.0);
        assert_eq!(
            cap_timestep_to_next_event(1.0, 0.5, &[1.0, 2.0], 1e-12),
            0.5
        );
    }

    #[test]
    fn resolved_stage_schedule_contains_waveform_and_exact_output_events() {
        let drives = vec![pulse(
            FieldTimeOriginIR::StageLocal,
            DriveActivationIR::StageIds {
                stage_ids: vec!["run".into()],
            },
        )];
        let outputs = vec![OutputIR::Scalar {
            name: "mx".into(),
            every_seconds: 0.75,
        }];
        let schedule = build_resolved_stage_event_schedule_with_origin(
            &drives,
            &[],
            10.0,
            10.0,
            13.0,
            &outputs,
            1e-12,
        );
        assert_eq!(
            schedule.times_s,
            vec![10.0, 10.75, 11.0, 11.5, 12.0, 12.25, 13.0]
        );
    }

    #[test]
    fn resumed_segment_keeps_original_stage_local_waveform_events() {
        let drives = vec![pulse(
            FieldTimeOriginIR::StageLocal,
            DriveActivationIR::AllTimeEvolution {},
        )];
        let schedule = build_resolved_stage_event_schedule_with_origin(
            &drives,
            &[],
            10.5,
            10.0,
            13.0,
            &[],
            1e-12,
        );
        assert_eq!(schedule.times_s, vec![10.5, 11.0, 12.0, 13.0]);
    }

    #[test]
    fn solved_antenna_pulse_contributes_resume_events() {
        let basis = ResolvedSolvedAntennaDriveBasisIR {
            drive: fullmag_ir::SolvedAntennaDriveIR {
                id: "antenna-drive".into(),
                name: "Antenna drive".into(),
                projection_ref: "projection".into(),
                port_mode_id: "port".into(),
                peak_current_a: 1.0,
                waveform: TimeDependenceIR::Pulse {
                    t_on: 1.0,
                    t_off: 2.0,
                },
                bandwidth_declaration: None,
                time_origin: FieldTimeOriginIR::StageLocal,
                activation: DriveActivationIR::AllTimeEvolution {},
            },
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            field_xyz_apm_per_a: vec![[1.0, 0.0, 0.0]],
            projection_signature: "verified".into(),
        };
        let schedule = build_resolved_stage_event_schedule_with_origin(
            &[],
            &[basis],
            10.5,
            10.0,
            13.0,
            &[],
            1e-12,
        );
        assert_eq!(schedule.times_s, vec![10.5, 11.0, 12.0, 13.0]);
    }

    #[test]
    fn auto_sampling_resolved_5ghz_clock_lands_on_ticks_and_stage_boundary() {
        let sample_period_s = 1.0 / 13.0e9;
        let outputs = vec![OutputIR::Field {
            name: "m".into(),
            every_seconds: sample_period_s,
        }];

        let schedule = build_resolved_stage_event_schedule_with_origin(
            &[],
            &[],
            0.0,
            0.0,
            4.0 * sample_period_s,
            &outputs,
            1e-24,
        );

        assert_eq!(
            schedule.times_s,
            vec![
                0.0,
                sample_period_s,
                2.0 * sample_period_s,
                3.0 * sample_period_s,
                4.0 * sample_period_s,
            ]
        );
    }

    #[test]
    fn direct_minimizer_skips_physical_time_event_materialization() {
        let outputs = vec![OutputIR::Scalar {
            name: "mx".into(),
            every_seconds: 0.5e-12,
        }];
        let schedule = build_native_fem_stage_event_schedule(
            &[],
            &[],
            0.0,
            1.0,
            &outputs,
            crate::schedules::OUTPUT_TIME_TOLERANCE,
            false,
        );
        assert!(schedule.is_none());
    }

    #[test]
    fn unbounded_llg_relaxation_does_not_materialize_infinite_periodic_outputs() {
        let outputs = vec![OutputIR::Scalar {
            name: "mx".into(),
            every_seconds: 1.0e-14,
        }];

        let schedule = build_native_fem_stage_event_schedule(
            &[],
            &[],
            0.0,
            f64::INFINITY,
            &outputs,
            crate::schedules::OUTPUT_TIME_TOLERANCE,
            true,
        )
        .expect("LLG relaxation keeps a finite event schedule");

        assert_eq!(schedule.times_s, vec![0.0]);
    }

    #[test]
    fn discontinuity_schedule_excludes_stage_boundaries_and_is_exact() {
        let drives = vec![pulse(
            FieldTimeOriginIR::StageLocal,
            DriveActivationIR::AllTimeEvolution {},
        )];
        assert_eq!(
            resolved_stage_drive_discontinuities_with_origin(&drives, &[], 10.0, 10.0, 13.0, 1e-12,),
            vec![11.0, 12.0]
        );
    }
}

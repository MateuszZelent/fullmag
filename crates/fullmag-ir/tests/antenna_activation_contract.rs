use fullmag_ir::{DriveActivationIR, StudyKindIR};

#[test]
fn all_time_evolution_is_scoped_to_time_evolution_studies() {
    let activation = DriveActivationIR::AllTimeEvolution {};

    assert!(activation.is_active_for(StudyKindIR::TimeEvolution, Some("run")));
    assert!(!activation.is_active_for(StudyKindIR::Relaxation, Some("relax")));
    assert!(!activation.is_active_for(StudyKindIR::Hysteresis, Some("branch")));
    assert!(!activation.is_active_for(StudyKindIR::Unknown, None));
}

#[test]
fn stage_ids_are_scoped_to_the_resolved_active_stage() {
    let activation = DriveActivationIR::StageIds {
        stage_ids: vec!["antenna_run".to_string()],
    };

    assert!(activation.is_active_for(
        StudyKindIR::TimeEvolution,
        Some("antenna_run"),
    ));
    assert!(activation.is_active_for(
        StudyKindIR::Relaxation,
        Some("antenna_run"),
    ));
    assert!(!activation.is_active_for(
        StudyKindIR::TimeEvolution,
        Some("other"),
    ));
}

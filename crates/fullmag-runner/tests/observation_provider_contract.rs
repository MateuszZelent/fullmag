use fullmag_runner::{
    observation_provider_policy, ObservationLane, ObservationProviderPolicy,
};

#[test]
fn post_stage_observation_provider_policy_is_explicit_for_all_visualization_lanes() {
    let cases = [
        (
            ObservationLane::FdmRegular,
            ObservationProviderPolicy::RetainedRuntime,
        ),
        (
            ObservationLane::FdmMultilayer,
            ObservationProviderPolicy::DeterministicReconstruction,
        ),
        (
            ObservationLane::FemMagneticOnly,
            ObservationProviderPolicy::RetainedRuntime,
        ),
        (
            ObservationLane::FemSharedAir,
            ObservationProviderPolicy::ImmutableTerminalSnapshot,
        ),
    ];

    for quantity_id in ["m", "H_eff", "eden_total", "e_total"] {
        for (lane, expected) in cases {
            assert_eq!(observation_provider_policy(lane, quantity_id), expected);
        }
    }
}

#[test]
fn unknown_quantity_is_explicitly_unavailable_after_stage_in_every_lane() {
    for lane in [
        ObservationLane::FdmRegular,
        ObservationLane::FdmMultilayer,
        ObservationLane::FemMagneticOnly,
        ObservationLane::FemSharedAir,
    ] {
        assert_eq!(
            observation_provider_policy(lane, "not-a-canonical-quantity"),
            ObservationProviderPolicy::UnavailableAfterStage,
        );
    }
}

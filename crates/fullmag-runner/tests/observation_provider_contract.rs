use fullmag_runner::{
    observation_provider_policy, ObservationLane, ObservationProviderPolicy,
    ObservationProviderResolver,
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

#[test]
fn bootstrap_fdm_plan_resolver_smoke_selects_runtime_and_terminal_materializer() {
    let problem = fullmag_ir::ProblemIR::bootstrap_example();
    let plan = fullmag_plan::plan(&problem).expect("bootstrap problem should plan");
    let resolver = ObservationProviderResolver::from_backend_plan(&plan.backend_plan);

    assert!(resolver.retains_idle_runtime());
    assert!(!resolver.uses_deterministic_reconstruction());
    let terminal_quantities = resolver.terminal_snapshot_quantity_ids();
    assert!(terminal_quantities.contains(&"m"));
    assert!(terminal_quantities.contains(&"H_eff"));
    assert_eq!(
        resolver.policy("not-a-canonical-quantity"),
        ObservationProviderPolicy::UnavailableAfterStage
    );
}

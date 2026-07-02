use super::*;

#[test]
fn final_magnetization_only_outputs_read_state_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(1, 1, 2).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        .expect("state should build");
    state.time_seconds = 4e-12;
    let mut steps = vec![StepStats {
        step: 7,
        time: state.time_seconds,
        dt: 1e-14,
        ..StepStats::default()
    }];
    let field_schedules = vec![OutputSchedule {
        name: "m.y".to_string(),
        every_seconds: 1e-12,
        next_time: 5e-12,
        last_sampled_time: None,
    }];
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_final_outputs(
        &problem,
        &state,
        7,
        1e-14,
        false,
        None,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("final magnetization-only output should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "final magnetization-only snapshots should use state values when no scalar row is due"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 1);
    assert_eq!(field_snapshots[0].name, "m.y");
    assert_eq!(
        field_snapshots[0].values,
        vec![[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
    );
}

#[test]
fn final_outputs_do_not_duplicate_current_time_scalar_row_or_reobserve_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(1, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0]])
        .expect("state should build");
    state.time_seconds = 5e-12;
    let mut steps = vec![StepStats {
        step: 9,
        time: state.time_seconds,
        dt: 1e-14,
        e_total: 42.0,
        ..StepStats::default()
    }];
    let field_schedules = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_final_outputs(
        &problem,
        &state,
        9,
        1e-14,
        true,
        None,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("final output pass should not duplicate an existing final scalar row");

    assert_eq!(
        observe_state_call_count(),
        0,
        "final outputs should not reobserve when a scalar row already exists at the current time"
    );
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].e_total, 42.0);
}

#[test]
fn standalone_cpu_reference_step_keeps_supported_segment_on_persistent_soa_state() {
    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(11, 16),
        enable_demag: true,
        ..make_test_plan()
    };
    let (problem, mut state) = build_snapshot_problem_and_state(&plan).expect("problem");
    let mut state_soa = if problem.soa_fast_path_supported() {
        Some(state.to_soa())
    } else {
        None
    };
    assert!(state_soa.is_some());

    let mut fft_workspace = problem.create_workspace();
    let mut integrator_bufs = problem.create_integrator_buffers();
    let report = step_reference_fdm_problem(
        &problem,
        &mut state,
        &mut state_soa,
        1e-14,
        &mut fft_workspace,
        &mut integrator_bufs,
    )
    .expect("step should execute");

    assert!(state_soa.is_some());
    assert!(report.total_energy_joules.is_finite());
    assert_eq!(state.time_seconds, report.time_seconds);
}

#[test]
fn cpu_fft_backend_selection_defaults_and_auto_resolve_to_rustfft_for_demag() {
    let default_backend =
        resolve_cpu_fft_backend_for_demag(true, None).expect("default backend should resolve");
    let auto_backend = resolve_cpu_fft_backend_for_demag(true, Some(" auto "))
        .expect("auto backend should resolve");
    let rustfft_backend = resolve_cpu_fft_backend_for_demag(true, Some("RustFFT"))
        .expect("rustfft backend should resolve");

    assert_eq!(
        default_backend.map(|backend| backend.as_str()),
        Some("rustfft")
    );
    assert_eq!(
        auto_backend.map(|backend| backend.as_str()),
        Some("rustfft")
    );
    assert_eq!(
        rustfft_backend.map(|backend| backend.as_str()),
        Some("rustfft")
    );
}

#[test]
fn cpu_fft_backend_selection_rejects_unimplemented_backend_for_demag() {
    let err = resolve_cpu_fft_backend_for_demag(true, Some("fftw"))
        .expect_err("fftw is not implemented in this build");

    assert!(err.message.contains("FULLMAG_CPU_FFT_BACKEND"));
    assert!(err.message.contains("fftw"));
    assert!(err
        .message
        .contains("supported CPU FDM FFT backends: rustfft"));
}

#[test]
fn cpu_fft_backend_selection_is_none_when_demag_is_disabled() {
    let backend = resolve_cpu_fft_backend_for_demag(false, Some("fftw"))
        .expect("demag-disabled plans should not resolve an FFT backend");

    assert!(backend.is_none());
}

#[test]
fn generalized_oersted_field_reaches_cpu_reference_observables() {
    let plan = FdmPlanIR {
        enable_exchange: false,
        external_field: Some([2.0, -1.0, 0.5]),
        oersted_field_xyz: Some(vec![
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [-0.5, -0.5, -0.5],
            [0.25, 0.0, 0.0],
            [0.0, 0.25, 0.0],
            [0.0, 0.0, 0.25],
            [0.25, 0.25, 0.0],
            [0.0, 0.25, 0.25],
            [0.25, 0.0, 0.25],
            [0.1, 0.2, 0.3],
            [0.0, 0.0, 0.0],
        ]),
        oersted_realization: Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint),
        ..make_test_plan()
    };

    let (problem, state) = build_snapshot_problem_and_state(&plan).expect("snapshot problem");
    let observables = observe_state(&problem, &state).expect("observables");

    assert_eq!(observables.external_field[0], [2.0, -1.0, 0.5]);
    assert_eq!(observables.oersted_field[0], [0.0, 0.0, 1.0]);
    assert_eq!(observables.oersted_field[1], [0.0, 1.0, 0.0]);
    assert_eq!(
        select_state_observable_field(&observables, "H_OE", true).unwrap(),
        observables.oersted_field
    );
    for component in 0..3 {
        assert!(
            (observables.effective_field[0][component]
                - (observables.exchange_field[0][component]
                    + observables.demag_field[0][component]
                    + observables.external_field[0][component]
                    + observables.oersted_field[0][component]))
                .abs()
                < 1e-12
        );
    }
}

#[test]
fn slonczewski_does_not_enable_zhang_li_builder() {
    let mut plan = make_test_plan();
    plan.current_density = Some([5.0e10, 0.0, 0.0]);
    plan.stt_degree = Some(0.6);
    plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
    plan.stt_lambda = Some(1.5);
    plan.stt_epsilon_prime = Some(0.0);

    assert!(build_zl_stt(&plan).is_none());
    assert!(build_slon_stt(&plan, plan.cell_size[2]).is_some());
}

#[test]
fn slonczewski_bottom_flips_torque_direction() {
    let mut plan_top = make_test_plan();
    plan_top.current_density = Some([0.0, 0.0, 8.0e10]);
    plan_top.stt_degree = Some(0.55);
    plan_top.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
    plan_top.stt_lambda = Some(1.4);
    plan_top.stt_epsilon_prime = Some(0.0);
    plan_top.stt_fixed_layer_position = Some("top".to_string());

    let mut plan_bottom = plan_top.clone();
    plan_bottom.stt_fixed_layer_position = Some("bottom".to_string());

    let top = build_slon_stt(&plan_top, plan_top.cell_size[2])
        .expect("top Slonczewski config should build");
    let bottom = build_slon_stt(&plan_bottom, plan_bottom.cell_size[2])
        .expect("bottom Slonczewski config should build");

    assert_eq!(top.current_sign, 1.0);
    assert_eq!(bottom.current_sign, -1.0);
}

#[test]
fn helper_max_vector_norm_handles_empty_input() {
    assert_eq!(crate::derived_fields::max_vector_norm(&[]), 0.0);
}

#[test]
fn active_mask_keeps_inactive_cells_zero_and_excludes_them_from_fields() {
    let active_mask = vec![
        true, true, false, false, true, true, false, false, true, true, false, false, true, true,
        false, false,
    ];
    let plan = FdmPlanIR {
        active_mask: Some(active_mask.clone()),
        initial_magnetization: vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
        ],
        enable_demag: true,
        external_field: Some([1e5, 0.0, 0.0]),
        ..make_test_plan()
    };

    let outputs = [
        OutputIR::Field {
            name: "m".to_string(),
            every_seconds: 1e-13,
        },
        OutputIR::Field {
            name: "H_demag".to_string(),
            every_seconds: 1e-13,
        },
        OutputIR::Field {
            name: "H_ext".to_string(),
            every_seconds: 1e-13,
        },
    ];

    let executed = execute_reference_fdm(&plan, 2e-13, &outputs, None, None)
        .expect("masked run should succeed");

    let is_zero = |vector: [f64; 3]| vector.iter().all(|value| value.abs() <= 1e-12);

    for (index, is_active) in active_mask.iter().enumerate() {
        if !is_active {
            assert!(
                is_zero(executed.result.final_magnetization[index]),
                "inactive cell {index} should stay zero in final magnetization"
            );
        }
    }

    for snapshot in &executed.field_snapshots {
        if snapshot.name == "H_demag" || snapshot.name == "H_ext" || snapshot.name == "m" {
            for (index, is_active) in active_mask.iter().enumerate() {
                if !is_active {
                    assert!(
                        is_zero(snapshot.values[index]),
                        "inactive cell {index} should stay zero in snapshot '{}'",
                        snapshot.name
                    );
                }
            }
        }
    }
}

#[test]
fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state() {
    let plan = FdmPlanIR {
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(1000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("relaxation run should succeed");

    assert!(executed.result.steps.len() <= 2);
    let final_time = executed.result.steps.last().expect("final stats").time;
    assert!(
        final_time < 1e-9,
        "relaxation should stop early, got final_time={final_time}"
    );
}

#[test]
fn llg_overdamped_relaxation_uses_pure_damping_rhs() {
    let plan = make_relaxation_precession_test_plan();
    let executed =
        execute_reference_fdm(&plan, 1e-12, &[], None, None).expect("relaxation should succeed");
    let final_m = executed.result.final_magnetization[0];

    assert!(
        final_m[1].abs() <= 1e-10,
        "pure-damping relaxation should not precess into y, got {:?}",
        final_m
    );
    assert!(
        final_m[2] > 0.0,
        "pure-damping relaxation should move toward +z field, got {:?}",
        final_m
    );
}

#[test]
fn bb_relaxation_stops_on_uniform_state() {
    let plan = FdmPlanIR {
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(1000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("BB relaxation should succeed");
    assert_eq!(executed.result.status, RunStatus::Completed);
    assert!(!executed.result.steps.is_empty());
}

#[test]
fn direct_minimization_provenance_names_cpu_minimizer_realization() {
    let plan = FdmPlanIR {
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(1000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("BB relaxation should succeed");

    assert_eq!(
        executed.provenance.requested_energy_minimizer.as_deref(),
        Some("projected_gradient_bb")
    );
    assert_eq!(
        executed.provenance.resolved_energy_minimizer.as_deref(),
        Some("projected_gradient_bb")
    );
    assert_eq!(
        executed.provenance.energy_minimizer_realization.as_deref(),
        Some("cpu_soa_tangent_gradient")
    );
    assert!(executed.provenance.resolved_integrator.is_none());
}

#[test]
fn ncg_relaxation_stops_on_uniform_state() {
    let plan = FdmPlanIR {
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::NonlinearCg,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(1000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("NCG relaxation should succeed");
    assert_eq!(executed.result.status, RunStatus::Completed);
    assert!(!executed.result.steps.is_empty());
}

#[test]
fn bb_relaxation_decreases_energy_on_random_initial() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
    let plan = FdmPlanIR {
        initial_magnetization: random_m0,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(5000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("BB relaxation should succeed");
    assert!(
        executed.result.steps.len() >= 2,
        "should have initial + final stats"
    );
    let first_energy = executed.result.steps.first().unwrap().e_ex;
    let last_energy = executed.result.steps.last().unwrap().e_ex;
    assert!(
        last_energy <= first_energy + 1e-25,
        "BB should decrease exchange energy: {} -> {}",
        first_energy,
        last_energy
    );
}

#[test]
fn ncg_relaxation_decreases_energy_on_random_initial() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
    let plan = FdmPlanIR {
        initial_magnetization: random_m0,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::NonlinearCg,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(5000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-9, &[], None, None).expect("NCG relaxation should succeed");
    assert!(
        executed.result.steps.len() >= 2,
        "should have initial + final stats"
    );
    let first_energy = executed.result.steps.first().unwrap().e_ex;
    let last_energy = executed.result.steps.last().unwrap().e_ex;
    assert!(
        last_energy <= first_energy + 1e-25,
        "NCG should decrease exchange energy: {} -> {}",
        first_energy,
        last_energy
    );
}

#[test]
fn all_algorithms_converge_to_similar_equilibrium() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
    let base = FdmPlanIR {
        initial_magnetization: random_m0,
        fixed_timestep: Some(5e-14), // larger dt for faster LLG convergence
        ..make_test_plan()
    };

    let mut energies = Vec::new();
    for algorithm in [
        RelaxationAlgorithmIR::LlgOverdamped,
        RelaxationAlgorithmIR::ProjectedGradientBb,
        RelaxationAlgorithmIR::NonlinearCg,
    ] {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-4),
                    energy_tolerance_j: None,
                    max_steps: Some(2000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            }),
            ..base.clone()
        };
        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect(&format!("{:?} relaxation should succeed", algorithm));
        let final_energy = executed.result.steps.last().unwrap().e_total;
        energies.push((algorithm, final_energy));
    }

    // All algorithms should converge to similar energy (within 20% relative or 1e-25 absolute)
    let (_, ref_energy) = energies[0];
    for (algorithm, energy) in &energies[1..] {
        let delta = (energy - ref_energy).abs();
        let relative = if ref_energy.abs() > 1e-25 {
            delta / ref_energy.abs()
        } else {
            delta
        };
        assert!(
            relative < 0.2 || delta < 1e-25,
            "{:?} final energy {} differs from LLG reference {} by {:.1}%",
            algorithm,
            energy,
            ref_energy,
            relative * 100.0
        );
    }
}

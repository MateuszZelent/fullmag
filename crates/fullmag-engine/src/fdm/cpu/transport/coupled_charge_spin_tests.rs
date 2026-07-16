use super::*;
use crate::fdm::shared::types::{CellSize, GridShape};

fn norm3(value: [f64; 3]) -> f64 {
    value
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

fn material(count: usize) -> CoupledChargeSpinMaterialFields {
    CoupledChargeSpinMaterialFields {
        reciprocal: vec![
            ReciprocalConstitutiveMaterial {
                sigma_s_per_m: 4.0,
                sigma_spin_s_per_m: 3.0,
                sigma_parallel_s_per_m: 5.0,
                sigma_perpendicular_s_per_m: 2.0,
                sigma_ahe_s_per_m: 0.7,
                polarization: 0.5,
                spin_hall_angle: 0.2,
            };
            count
        ],
        magnetization: vec![[0.0, 0.0, 1.0]; count],
        reactions: vec![
            SpinReactionLengths {
                spin_flip_m: Some(2.0),
                exchange_m: None,
                dephasing_m: None
            };
            count
        ],
    }
}

fn bar(nx: usize) -> CoupledChargeSpinProblem {
    CoupledChargeSpinProblem::new(
        GridShape { nx, ny: 1, nz: 1 },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        material(nx),
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpinSink,
                x_max: SpinBoundaryCondition::SpinSink,
                ..Default::default()
            },
        },
    )
    .unwrap()
}

#[test]
fn m2_manufactured_amr_bar_converges_to_anisotropic_linear_solution() {
    let solution = bar(8)
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    for (cell, value) in solution.potential_volts.iter().enumerate() {
        let expected = 1.0 - (cell as f64 + 0.5) / 8.0;
        assert!(
            (value - expected).abs() < 2.0e-8,
            "cell {cell}: {value} != {expected}"
        );
    }
    assert!(solution.telemetry.scaled_charge_residual <= 1.0e-9);
    assert!(solution.telemetry.scaled_spin_residual <= 1.0e-9);
}

#[test]
fn m2_uses_block_preconditioning_and_requires_a_converged_picard_update() {
    let solution = bar(8)
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();

    assert!(
        solution.telemetry.picard_iterations >= 2,
        "a cold state must not be accepted before its first nonlinear update is checked"
    );
    assert!(
        solution.telemetry.preconditioner_applications > 0,
        "the advertised block preconditioner must be applied by GMRES"
    );
    assert_eq!(
        solution.telemetry.preconditioner,
        "charge_scalar_spin_3x3_block_jacobi_v1"
    );
}

#[test]
fn m2_dirichlet_boundary_uses_one_reciprocal_charge_spin_response() {
    let mut fields = material(1);
    fields.magnetization[0] = [1.0, 0.0, 0.0];
    fields.reactions[0] = SpinReactionLengths {
        spin_flip_m: None,
        exchange_m: None,
        dephasing_m: None,
    };
    let model = fields.reciprocal[0];
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 1,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        fields,
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 0.0, 0.0]),
                x_max: SpinBoundaryCondition::SpecifiedPotential([0.0, 0.0, 0.0]),
                ..Default::default()
            },
        },
    )
    .unwrap();

    let expected = model
        .evaluate(
            [1.0, 0.0, 0.0],
            [[0.5, 0.0, 0.0], [0.0; 3], [0.0; 3]],
            [1.0, 0.0, 0.0],
        )
        .unwrap();
    for positive in [false, true] {
        let (charge, spin) =
            problem.boundary_flux_for_test(0, positive, 0, &[0.5], &[[0.5, 0.0, 0.0]]);
        assert!((charge - expected.charge_current_density_a_per_m2[0]).abs() < 1.0e-12);
        for component in 0..3 {
            assert!(
                (spin[component] - expected.spin_current_density_a_per_m2[0][component]).abs()
                    < 1.0e-12
            );
        }
    }
}

#[test]
fn m2_transport_torque_is_dimensionally_converted_and_gated_by_outer_lte() {
    let mut fields = material(1);
    fields.magnetization[0] = [0.0, 0.0, 1.0];
    fields.reactions[0] = SpinReactionLengths {
        spin_flip_m: None,
        exchange_m: Some(1.0),
        dephasing_m: Some(1.5),
    };
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 1,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        fields,
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 0.0, 0.0]),
                x_max: SpinBoundaryCondition::SpecifiedPotential([0.0, 0.0, 0.0]),
                ..Default::default()
            },
        },
    )
    .unwrap()
    .with_torque_targets(SpinTorqueTargets {
        target_cells: vec![true],
        saturation_magnetization_a_per_m: vec![8.0e5],
        gamma_e_rad_per_s_t: 1.760_859_630_23e11,
    })
    .unwrap();

    let baseline = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    assert!(baseline.transport_gilbert_torque_per_s[0]
        .iter()
        .any(|component| component.abs() > 0.0));

    let strict_budget = CoupledTransportOuterErrorBudget {
        dt_s: 1.0e-12,
        embedded_lte_m: 1.0e-30,
        eta_transport: 0.1,
        previous_transport_torque_per_s: vec![[0.0; 3]],
    };
    let error = problem
        .solve_with_outer_error_budget(
            CoupledChargeSpinSolverConfig::default(),
            None,
            &strict_budget,
        )
        .unwrap_err();
    assert!(error.to_string().contains("outer LTE"));

    let converged_budget = CoupledTransportOuterErrorBudget {
        previous_transport_torque_per_s: baseline.transport_gilbert_torque_per_s.clone(),
        embedded_lte_m: 1.0e-12,
        ..strict_budget
    };
    let accepted = problem
        .solve_with_outer_error_budget(
            CoupledChargeSpinSolverConfig::default(),
            None,
            &converged_budget,
        )
        .unwrap();
    assert_eq!(accepted.telemetry.transport_outer_error_ratio, Some(0.0));
}

#[test]
fn m2_acceptance_includes_independent_charge_and_spin_balance_gates() {
    let config = CoupledChargeSpinSolverConfig::default();
    let solution = bar(8).solve(config, None).unwrap();

    assert!(solution.telemetry.charge_balance_relative <= config.relative_tolerance);
    assert!(solution.telemetry.spin_balance_relative <= 10.0 * config.relative_tolerance);
    assert!(solution.telemetry.convergence_reason.contains("balance"));
}

#[test]
fn m2_phe_and_ahe_manufactured_current_has_full_3d_components() {
    let mut fields = material(1);
    let s = 0.5_f64.sqrt();
    fields.magnetization[0] = [s, s, 0.0];
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 1,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        fields,
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpinSink,
                x_max: SpinBoundaryCondition::SpinSink,
                ..Default::default()
            },
        },
    )
    .unwrap();
    let solution = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    let j = solution.cell_charge_current_density_a_per_m2[0];
    let expected = [3.5, 1.5, -0.7 * s];
    for component in 0..3 {
        assert!(
            (j[component] - expected[component]).abs() < 1.0e-12,
            "manufactured AMR/PHE/AHE component {component}: {j:?} != {expected:?}"
        );
    }
}

#[test]
fn m2_she_ishe_pair_is_reciprocal_and_nondissipative() {
    let model = material(1).reciprocal[0];
    let e = [0.3, -0.7, 0.2];
    let g = [[0.1, 0.5, -0.4], [-0.2, 0.6, 0.9], [0.8, -0.3, 0.7]];
    let response = model.evaluate(e, g, [0.0, 0.0, 1.0]).unwrap();
    let mut without_hall = model;
    without_hall.spin_hall_angle = 0.0;
    let base = without_hall.evaluate(e, g, [0.0, 0.0, 1.0]).unwrap();
    let hall_power: f64 = (0..3)
        .map(|i| {
            (response.charge_current_density_a_per_m2[i] - base.charge_current_density_a_per_m2[i])
                * e[i]
        })
        .sum::<f64>()
        + (0..3)
            .flat_map(|i| {
                (0..3).map(move |a| {
                    (response.spin_current_density_a_per_m2[i][a]
                        - base.spin_current_density_a_per_m2[i][a])
                        * g[i][a]
                })
            })
            .sum::<f64>();
    assert!(hall_power.abs() < 1.0e-12);
}

#[test]
fn m2_warm_start_requires_exact_revisions_and_failure_is_transactional() {
    let problem = bar(4).with_revisions(12, 34);
    let solution = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    let warm = CoupledChargeSpinWarmStart::from_solution(12, 34, &solution);
    let reused = problem
        .solve(CoupledChargeSpinSolverConfig::default(), Some(&warm))
        .unwrap();
    assert!(reused.telemetry.warm_start_used);
    let stale = CoupledChargeSpinWarmStart {
        state_revision: 11,
        ..warm.clone()
    };
    let cold = problem
        .solve(CoupledChargeSpinSolverConfig::default(), Some(&stale))
        .unwrap();
    assert!(!cold.telemetry.warm_start_used);

    let mut impossible = CoupledChargeSpinSolverConfig::default();
    impossible.max_linear_iterations = 1;
    impossible.relative_tolerance = 1.0e-30;
    let before = warm.clone();
    assert!(problem.solve(impossible, Some(&stale)).is_err());
    assert_eq!(warm, before, "rejected solve mutated committed warm state");
}

#[test]
fn m2_rejects_periodic_spin_until_coupled_periodic_charge_drop_is_implemented() {
    let mut boundaries = CoupledChargeSpinBoundaryConditions::default();
    boundaries.charge.x_min = Some(1.0);
    boundaries.charge.x_max = Some(0.0);
    boundaries.spin.x_min = SpinBoundaryCondition::PeriodicSpin;
    boundaries.spin.x_max = SpinBoundaryCondition::PeriodicSpin;
    let result = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 2,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        material(2),
        None,
        boundaries,
    );
    assert!(result.unwrap_err().to_string().contains("periodic"));
}

#[test]
fn m2_mixing_interface_reports_backflow_absorption_and_sml_separately() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let interface = OrientedSpinInterface {
        face,
        from_cell: 0,
        to_cell: 1,
        law: SpinInterfaceLaw::MixingConductance {
            g_up_s_per_m2: 3.0,
            g_down_s_per_m2: 1.0,
            g_r_s_per_m2: 2.0,
            g_i_s_per_m2: 0.25,
            g_sml_s_per_m2: 0.5,
            magnetization: [0.0, 0.0, 1.0],
        },
    };
    let problem = bar(2).with_interfaces(vec![0, 1], vec![interface]).unwrap();
    let solution = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    let observation = solution.interface_observations[0];
    assert!(observation.incoming_longitudinal_a_per_m2[2].abs() > 0.0);
    assert!(observation.backflow_longitudinal_a_per_m2[2].is_finite());
    assert!(observation
        .absorbed_transverse_a_per_m2
        .iter()
        .all(|v| v.is_finite()));
    assert!(observation
        .spin_memory_loss_a_per_m2
        .iter()
        .all(|v| v.is_finite()));
    for component in 0..3 {
        let reconstructed = observation.to_side_transmitted_a_per_m2[component]
            + observation.absorbed_transverse_a_per_m2[component]
            + observation.spin_memory_loss_a_per_m2[component];
        assert!(
            (observation.from_side_outgoing_a_per_m2[component] - reconstructed).abs() < 1.0e-10
        );
    }
}

#[test]
fn m2_mixing_interface_closes_nonzero_absorption_and_sml_with_torque_target() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 2,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        material(2),
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 0.0, 0.0]),
                x_max: SpinBoundaryCondition::SpecifiedPotential([0.0, 0.0, 0.0]),
                ..Default::default()
            },
        },
    )
    .unwrap()
    .with_interfaces(
        vec![0, 1],
        vec![OrientedSpinInterface {
            face,
            from_cell: 0,
            to_cell: 1,
            law: SpinInterfaceLaw::MixingConductance {
                g_up_s_per_m2: 3.0,
                g_down_s_per_m2: 1.0,
                g_r_s_per_m2: 2.0,
                g_i_s_per_m2: 0.25,
                g_sml_s_per_m2: 0.5,
                magnetization: [0.0, 0.0, 1.0],
            },
        }],
    )
    .unwrap()
    .with_torque_targets(SpinTorqueTargets {
        target_cells: vec![false, true],
        saturation_magnetization_a_per_m: vec![0.0, 8.0e5],
        gamma_e_rad_per_s_t: 1.760_859_630_23e11,
    })
    .unwrap();

    let solution = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    let observation = solution.interface_observations[0];
    assert!(norm3(observation.absorbed_transverse_a_per_m2) > 0.0);
    assert!(norm3(observation.spin_memory_loss_a_per_m2) > 0.0);
    assert!(norm3(solution.transport_gilbert_torque_per_s[1]) > 0.0);
    assert!(solution.telemetry.spin_balance_relative <= 1.0e-9);
}

#[test]
fn m2_cross_region_face_without_explicit_interface_fails_closed() {
    let problem = bar(2).with_interfaces(vec![0, 1], vec![]).unwrap();
    let error = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap_err();
    assert!(error.to_string().contains("explicit oriented interface"));
}

#[test]
fn m2_material_jump_without_a_distinct_region_and_interface_fails_closed() {
    let mut fields = material(2);
    fields.reciprocal[1].sigma_parallel_s_per_m = 7.0;
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 2,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        fields,
        None,
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(0.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpinSink,
                x_max: SpinBoundaryCondition::SpinSink,
                ..Default::default()
            },
        },
    )
    .unwrap();
    let error = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap_err();
    assert!(error.to_string().contains("material jump"));
}

#[test]
fn m2_rejects_unqualified_transparent_tensor_interface() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let result = bar(2).with_interfaces(
        vec![0, 1],
        vec![OrientedSpinInterface {
            face,
            from_cell: 0,
            to_cell: 1,
            law: SpinInterfaceLaw::Transparent,
        }],
    );
    assert!(result.unwrap_err().to_string().contains("unsupported"));
}

#[test]
fn m2_amr_convergence_map_is_mesh_independent_for_linear_manufactured_state() {
    let mut errors = Vec::new();
    for nx in [4, 8, 16] {
        let solution = bar(nx)
            .solve(CoupledChargeSpinSolverConfig::default(), None)
            .unwrap();
        let error = solution
            .potential_volts
            .iter()
            .enumerate()
            .map(|(cell, value)| {
                let exact = 1.0 - (cell as f64 + 0.5) / nx as f64;
                (value - exact).powi(2)
            })
            .sum::<f64>()
            .sqrt();
        errors.push(error);
    }
    assert!(errors.iter().all(|error| *error < 1.0e-8), "{errors:?}");
}

#[test]
fn m2_picard_convergence_map_covers_reciprocal_and_hall_strengths() {
    for (polarization, spin_hall_angle, sigma_ahe) in [
        (0.0, 0.0, 0.0),
        (0.3, 0.1, 0.2),
        (-0.6, -0.25, -0.5),
        (0.75, 0.4, 0.8),
    ] {
        let mut fields = material(6);
        for material in &mut fields.reciprocal {
            material.polarization = polarization;
            material.spin_hall_angle = spin_hall_angle;
            material.sigma_ahe_s_per_m = sigma_ahe;
        }
        let problem = CoupledChargeSpinProblem::new(
            GridShape {
                nx: 6,
                ny: 1,
                nz: 1,
            },
            CellSize {
                dx: 1.0,
                dy: 1.0,
                dz: 1.0,
            },
            fields,
            None,
            CoupledChargeSpinBoundaryConditions {
                charge: ChargeBoundaryConditions {
                    x_min: Some(1.0),
                    x_max: Some(0.0),
                    ..Default::default()
                },
                spin: SpinBoundaryConditions {
                    x_min: SpinBoundaryCondition::SpinSink,
                    x_max: SpinBoundaryCondition::SpinSink,
                    ..Default::default()
                },
            },
        )
        .unwrap();
        let solution = problem
            .solve(CoupledChargeSpinSolverConfig::default(), None)
            .unwrap();
        assert!(solution.telemetry.picard_iterations >= 2);
        assert!(solution.telemetry.scaled_charge_residual <= 1.0e-10);
        assert!(solution.telemetry.scaled_spin_residual <= 1.0e-10);
    }
}

#[test]
fn m2_inactive_cells_do_not_require_physical_material_or_publish_current() {
    let mut fields = material(2);
    fields.reciprocal[1] = ReciprocalConstitutiveMaterial {
        sigma_s_per_m: 0.0,
        sigma_spin_s_per_m: 0.0,
        sigma_parallel_s_per_m: 0.0,
        sigma_perpendicular_s_per_m: 0.0,
        sigma_ahe_s_per_m: 0.0,
        polarization: 0.0,
        spin_hall_angle: 0.0,
    };
    let problem = CoupledChargeSpinProblem::new(
        GridShape {
            nx: 2,
            ny: 1,
            nz: 1,
        },
        CellSize {
            dx: 1.0,
            dy: 1.0,
            dz: 1.0,
        },
        fields,
        Some(vec![true, false]),
        CoupledChargeSpinBoundaryConditions {
            charge: ChargeBoundaryConditions {
                x_min: Some(1.0),
                ..Default::default()
            },
            spin: SpinBoundaryConditions {
                x_min: SpinBoundaryCondition::SpinSink,
                ..Default::default()
            },
        },
    )
    .unwrap();
    let solution = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap();
    assert_eq!(solution.cell_charge_current_density_a_per_m2[1], [0.0; 3]);
    assert_eq!(
        solution.cell_spin_current_density_a_per_m2[1],
        [[0.0; 3]; 3]
    );
}

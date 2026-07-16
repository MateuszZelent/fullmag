use super::*;
use crate::fdm::shared::types::{CellSize, GridShape};

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
    assert!(j[0] > 0.0);
    assert!(j[1].abs() > 1.0e-6, "PHE component missing: {j:?}");
    assert!(j[2].abs() > 1.0e-6, "AHE component missing: {j:?}");
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
fn m2_cross_region_face_without_explicit_interface_fails_closed() {
    let problem = bar(2).with_interfaces(vec![0, 1], vec![]).unwrap();
    let error = problem
        .solve(CoupledChargeSpinSolverConfig::default(), None)
        .unwrap_err();
    assert!(error.to_string().contains("explicit oriented interface"));
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

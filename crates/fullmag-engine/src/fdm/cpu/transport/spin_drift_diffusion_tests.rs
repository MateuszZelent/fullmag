use super::{
    ChargeBoundaryConditions, InternalSpinContact, OrientedSpinInterface, SpinBoundaryCondition,
    SpinBoundaryConditions, SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceLaw,
    SpinMaterialFields, SpinReactionLengths, SpinSolverConfig, SpinTorqueTargets,
    StructuredChargeProblem, StructuredSpinFace,
};
use crate::fdm::shared::types::{CellSize, GridShape};

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected:.16e}, got {actual:.16e} (tol {tolerance:.3e})"
    );
}

fn simple_problem(
    grid: GridShape,
    potential: Vec<f64>,
    conductivity: Vec<f64>,
    active: Option<Vec<bool>>,
    materials: SpinMaterialFields,
    boundary: SpinBoundaryConditions,
) -> SpinDriftDiffusionProblem {
    try_simple_problem(grid, potential, conductivity, active, materials, boundary).unwrap()
}

fn try_simple_problem(
    grid: GridShape,
    potential: Vec<f64>,
    conductivity: Vec<f64>,
    active: Option<Vec<bool>>,
    materials: SpinMaterialFields,
    boundary: SpinBoundaryConditions,
) -> crate::fdm::shared::types::Result<SpinDriftDiffusionProblem> {
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        conductivity,
        None,
        ChargeBoundaryConditions::default(),
    )?;
    SpinDriftDiffusionProblem::new(charge, potential, materials, active, boundary)
}

fn diffusion_problem(nx: usize, length: f64, lambda: f64) -> SpinDriftDiffusionProblem {
    let grid = GridShape::new(nx, 1, 1).unwrap();
    let dx = length / nx as f64;
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(dx, 1.0, 1.0).unwrap(),
        vec![1.0; nx],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0; nx],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![4.0; nx],
            polarization: vec![0.0; nx],
            spin_hall_angle: vec![0.0; nx],
            magnetization: vec![[0.0, 0.0, 1.0]; nx],
            reactions: vec![
                SpinReactionLengths {
                    spin_flip_m: Some(lambda),
                    exchange_m: None,
                    dephasing_m: None,
                };
                nx
            ],
        },
        None,
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 0.0, 0.0]),
            x_max: SpinBoundaryCondition::SpecifiedPotential([0.0, 0.0, 0.0]),
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn spin_1d_diffusion_v1_matches_sinh_profile_and_second_order_convergence() {
    let length = 5.0;
    let lambda = 1.3;
    let mut errors = Vec::new();
    for nx in [20, 40, 80] {
        let problem = diffusion_problem(nx, length, lambda);
        let solution = problem.solve(SpinSolverConfig::default()).unwrap();
        let dx = length / nx as f64;
        let denominator = (length / lambda).sinh();
        let error = solution
            .spin_potential_volts
            .iter()
            .enumerate()
            .map(|(cell, value)| {
                let x = (cell as f64 + 0.5) * dx;
                let exact = ((length - x) / lambda).sinh() / denominator;
                (value[0] - exact).powi(2)
            })
            .sum::<f64>()
            .sqrt()
            / (nx as f64).sqrt();
        errors.push(error);
        assert!(solution.relative_residual < 1.0e-10);
    }
    assert!(errors[0] / errors[1] > 3.7, "errors: {errors:?}");
    assert!(errors[1] / errors[2] > 3.7, "errors: {errors:?}");
}

#[test]
fn spin_relaxation_modes_v1_have_correct_signs_and_torque_partition() {
    let grid = GridShape::new(1, 1, 1).unwrap();
    let sigma_s = 12.0;
    let lambda_sf = 2.0;
    let lambda_j = 3.0;
    let lambda_phi = 4.0;
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let problem = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![sigma_s],
            polarization: vec![0.0],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths {
                spin_flip_m: Some(lambda_sf),
                exchange_m: Some(lambda_j),
                dephasing_m: Some(lambda_phi),
            }],
        },
        None,
        SpinBoundaryConditions::default(),
    )
    .unwrap()
    .with_torque_targets(super::SpinTorqueTargets {
        target_cells: vec![true],
        saturation_magnetization_a_per_m: vec![8.0e5],
        gamma_e_rad_per_s_t: 1.760_859_630_23e11,
    })
    .unwrap();

    let mu = [[2.0, -3.0, 5.0]];
    let channels = problem.reaction_channels(&mu).unwrap();
    let a_sf = sigma_s / (2.0 * lambda_sf * lambda_sf);
    let a_j = sigma_s / (2.0 * lambda_j * lambda_j);
    let a_phi = sigma_s / (2.0 * lambda_phi * lambda_phi);
    for component in 0..3 {
        assert_close(
            channels.spin_flip[0][component],
            a_sf * mu[0][component],
            1.0e-14,
        );
    }
    assert_eq!(channels.exchange[0], [a_j * mu[0][1], -a_j * mu[0][0], 0.0]);
    assert_eq!(
        channels.dephasing[0],
        [a_phi * mu[0][0], a_phi * mu[0][1], 0.0]
    );
    for component in 0..3 {
        assert_close(
            channels.magnetic_torque_sink[0][component],
            channels.exchange[0][component] + channels.dephasing[0][component],
            1.0e-14,
        );
    }
    assert_eq!(channels.magnetic_torque_sink[0][2], 0.0);
}

#[test]
fn restarted_gmres_solves_nonsymmetric_exchange_reaction_block() {
    let grid = GridShape::new(1, 1, 1).unwrap();
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let problem = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![2.0],
            polarization: vec![0.0],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths {
                spin_flip_m: Some(1.7),
                exchange_m: Some(0.8),
                dephasing_m: Some(1.2),
            }],
        },
        None,
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, -2.0, 0.5]),
            x_max: SpinBoundaryCondition::SpecifiedPotential([1.0, -2.0, 0.5]),
            ..Default::default()
        },
    )
    .unwrap()
    .with_torque_targets(super::SpinTorqueTargets {
        target_cells: vec![true],
        saturation_magnetization_a_per_m: vec![8.0e5],
        gamma_e_rad_per_s_t: 1.760_859_630_23e11,
    })
    .unwrap();
    let solution = problem.solve(SpinSolverConfig {
        restart: 2,
        ..Default::default()
    });
    let solution = solution.unwrap();
    assert!(solution.iterations >= 2);
    assert!(solution.relative_residual < 1.0e-10);
    assert!(solution.balance.max_abs_residual_a_per_m3 < 1.0e-10);
}

fn she_problem(nz: usize, theta: f64, magnetization: [f64; 3]) -> SpinDriftDiffusionProblem {
    let nx = 3;
    let length_x = 3.0;
    let thickness = 4.0;
    let grid = GridShape::new(nx, 1, nz).unwrap();
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(length_x / nx as f64, 1.0, thickness / nz as f64).unwrap(),
        vec![5.0; grid.cell_count()],
        None,
        ChargeBoundaryConditions {
            x_min: Some(1.5),
            x_max: Some(-1.5),
            ..Default::default()
        },
    )
    .unwrap();
    let potential = (0..grid.cell_count())
        .map(|cell| {
            let x = cell % nx;
            1.5 - (x as f64 + 0.5)
        })
        .collect();
    SpinDriftDiffusionProblem::new(
        charge,
        potential,
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![4.0; grid.cell_count()],
            polarization: vec![0.0; grid.cell_count()],
            spin_hall_angle: vec![theta; grid.cell_count()],
            magnetization: vec![magnetization; grid.cell_count()],
            reactions: vec![
                SpinReactionLengths {
                    spin_flip_m: Some(1.1),
                    exchange_m: None,
                    dephasing_m: None,
                };
                grid.cell_count()
            ],
        },
        None,
        SpinBoundaryConditions::default(),
    )
    .unwrap()
}

#[test]
fn she_1d_film_v1_has_positive_y_accumulation_gradient_and_expected_profile() {
    let nz = 48;
    let theta = 0.2;
    let problem = she_problem(nz, theta, [0.0, 0.0, 1.0]);
    let solution = problem.solve(SpinSolverConfig::default()).unwrap();
    let grid = problem.grid();
    let thickness = 4.0;
    let lambda = 1.1;
    let sigma = 5.0;
    let sigma_s = 4.0;
    let electric_x = 1.0;
    let amplitude =
        2.0 * theta * sigma * electric_x * lambda / (sigma_s * (0.5 * thickness / lambda).cosh());
    for z in 0..nz {
        let cell = grid.index(1, 0, z);
        let coordinate = (z as f64 + 0.5) * thickness / nz as f64 - 0.5 * thickness;
        let exact = amplitude * (coordinate / lambda).sinh();
        assert_close(solution.spin_potential_volts[cell][1], exact, 2.0e-4);
        assert_close(solution.spin_potential_volts[cell][0], 0.0, 2.0e-11);
        assert_close(solution.spin_potential_volts[cell][2], 0.0, 2.0e-11);
    }
    assert!(solution.spin_potential_volts[grid.index(1, 0, nz - 1)][1] > 0.0);
    assert!(solution.spin_potential_volts[grid.index(1, 0, 0)][1] < 0.0);
}

#[test]
fn theta_sh_zero_v1_removes_direct_she_exactly() {
    let problem = she_problem(12, 0.0, [0.0, 0.0, 1.0]);
    let solution = problem.solve(SpinSolverConfig::default()).unwrap();
    assert!(solution
        .spin_potential_volts
        .iter()
        .flatten()
        .all(|component| *component == 0.0));
    assert!(solution
        .spin_current_density
        .x
        .iter()
        .chain(&solution.spin_current_density.y)
        .chain(&solution.spin_current_density.z)
        .flatten()
        .all(|component| *component == 0.0));
}

#[test]
fn one_transparent_face_flux_is_shared_with_opposite_cell_balance_signs() {
    let problem = diffusion_problem(2, 2.0, 1.0);
    let mu = [[0.0, 0.0, 0.0], [1.0, -2.0, 3.0]];
    let mut flux = problem.face_fluxes(&mu).unwrap();
    assert_eq!(flux.x[1], [-2.0, 4.0, -6.0]);
    flux.x[0] = [0.0; 3];
    flux.x[2] = [0.0; 3];
    let divergence = problem.conservative_divergence(&flux).unwrap();
    for component in 0..3 {
        assert_close(divergence[0][component], flux.x[1][component], 1.0e-14);
        assert_close(divergence[1][component], -flux.x[1][component], 1.0e-14);
    }
}

#[test]
fn polarized_flux_reverses_with_magnetization_but_she_does_not() {
    let grid = GridShape::new(2, 1, 1).unwrap();
    let make = |m: [f64; 3]| {
        let charge = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            vec![2.0; 2],
            None,
            ChargeBoundaryConditions {
                x_min: Some(1.0),
                x_max: Some(-1.0),
                ..Default::default()
            },
        )
        .unwrap();
        SpinDriftDiffusionProblem::new(
            charge,
            vec![0.5, -0.5],
            SpinMaterialFields {
                spin_conductivity_s_per_m: vec![1.0; 2],
                polarization: vec![0.4; 2],
                spin_hall_angle: vec![0.0; 2],
                magnetization: vec![m; 2],
                reactions: vec![SpinReactionLengths::default(); 2],
            },
            None,
            SpinBoundaryConditions::default(),
        )
        .unwrap()
    };
    let plus = make([0.0, 1.0, 0.0]).face_fluxes(&[[0.0; 3]; 2]).unwrap();
    let minus = make([0.0, -1.0, 0.0]).face_fluxes(&[[0.0; 3]; 2]).unwrap();
    assert_eq!(plus.x[1], [0.0, -minus.x[1][1], 0.0]);

    let she_plus = she_problem(8, 0.2, [0.0, 0.0, 1.0])
        .solve(SpinSolverConfig::default())
        .unwrap();
    let she_minus = she_problem(8, 0.2, [0.0, 0.0, -1.0])
        .solve(SpinSolverConfig::default())
        .unwrap();
    assert_eq!(
        she_plus.spin_potential_volts,
        she_minus.spin_potential_volts
    );
}

#[test]
fn active_mask_makes_transport_boundary_spin_insulating() {
    let grid = GridShape::new(3, 1, 1).unwrap();
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0; 3],
        Some(vec![true, false, true]),
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let problem = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0; 3],
        SpinMaterialFields::nonmagnetic_isotropic(3, 2.0, 1.0),
        Some(vec![true, false, true]),
        SpinBoundaryConditions::default(),
    )
    .unwrap();
    let flux = problem
        .face_fluxes(&[[1.0, 0.0, 0.0], [100.0; 3], [-2.0, 0.0, 0.0]])
        .unwrap();
    assert_eq!(flux.x[1], [0.0; 3]);
    assert_eq!(flux.x[2], [0.0; 3]);
}

#[test]
fn independently_recomputed_residual_and_global_balance_close() {
    let problem = diffusion_problem(32, 4.0, 1.2);
    let solution = problem.solve(SpinSolverConfig::default()).unwrap();
    let residual = problem
        .steady_residual(&solution.spin_potential_volts)
        .unwrap();
    let residual_norm = residual.iter().flatten().map(|x| x * x).sum::<f64>().sqrt();
    assert_close(residual_norm, solution.residual_l2, 1.0e-13);
    assert!(solution.relative_residual < 1.0e-10);
    for component in solution.balance.closure_a {
        assert!(component.abs() < 1.0e-9, "balance {component:.6e}");
    }
    assert!(solution.balance.spin_flip_sink_a[0] > 0.0);
    assert_eq!(solution.balance.magnetic_torque_sink_a, [0.0; 3]);
    assert_eq!(
        problem
            .balance_diagnostics(&solution.spin_potential_volts)
            .unwrap(),
        solution.balance
    );
}

#[test]
fn validation_rejects_nonfinite_coefficients_bad_lengths_and_unanchored_nullspace() {
    let grid = GridShape::new(1, 1, 1).unwrap();
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let bad = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![1.0],
            polarization: vec![f64::NAN],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths {
                spin_flip_m: Some(0.0),
                ..Default::default()
            }],
        },
        None,
        SpinBoundaryConditions::default(),
    )
    .unwrap_err();
    assert!(bad.to_string().contains("polarization"));

    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let bad_length = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![1.0],
            polarization: vec![0.0],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths {
                spin_flip_m: Some(0.0),
                ..Default::default()
            }],
        },
        None,
        SpinBoundaryConditions::default(),
    )
    .unwrap_err();
    assert!(bad_length.to_string().contains("spin_flip_m"));

    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let unanchored = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![1.0],
            polarization: vec![0.0],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths::default()],
        },
        None,
        SpinBoundaryConditions::default(),
    )
    .unwrap();
    assert!(unanchored
        .solve(SpinSolverConfig::default())
        .unwrap_err()
        .to_string()
        .contains("nullspace"));

    let problem = diffusion_problem(2, 2.0, 1.0);
    let mut config = SpinSolverConfig::default();
    config.restart = 0;
    assert!(problem
        .solve(config)
        .unwrap_err()
        .to_string()
        .contains("restart"));
}

#[test]
fn every_disconnected_spin_component_requires_its_own_coercive_anchor() {
    let grid = GridShape::new(3, 1, 1).unwrap();
    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0; 3],
        Some(vec![true, false, true]),
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let problem = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0; 3],
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![1.0; 3],
            polarization: vec![0.0; 3],
            spin_hall_angle: vec![0.0; 3],
            magnetization: vec![[0.0, 0.0, 1.0]; 3],
            reactions: vec![
                SpinReactionLengths {
                    spin_flip_m: Some(1.0),
                    ..Default::default()
                },
                SpinReactionLengths::default(),
                SpinReactionLengths::default(),
            ],
        },
        Some(vec![true, false, true]),
        SpinBoundaryConditions::default(),
    )
    .unwrap();
    let error = problem.solve(SpinSolverConfig::default()).unwrap_err();
    assert!(error.to_string().contains("every disconnected"));
}

#[test]
fn specified_spin_flux_is_outward_normal_on_min_and_max_faces_of_every_axis() {
    let grid = GridShape::new(1, 1, 1).unwrap();
    let q = [1.0, -2.0, 3.0];
    let problem = simple_problem(
        grid,
        vec![0.0],
        vec![1.0],
        None,
        SpinMaterialFields::nonmagnetic_isotropic(1, 1.0, 1.0),
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedFlux(q),
            x_max: SpinBoundaryCondition::SpecifiedFlux(q),
            y_min: SpinBoundaryCondition::SpecifiedFlux(q),
            y_max: SpinBoundaryCondition::SpecifiedFlux(q),
            z_min: SpinBoundaryCondition::SpecifiedFlux(q),
            z_max: SpinBoundaryCondition::SpecifiedFlux(q),
        },
    );
    let flux = problem.face_fluxes(&[[0.0; 3]]).unwrap();
    assert_eq!(flux.x, vec![[-1.0, 2.0, -3.0], q]);
    assert_eq!(flux.y, vec![[-1.0, 2.0, -3.0], q]);
    assert_eq!(flux.z, vec![[-1.0, 2.0, -3.0], q]);
}

#[test]
fn upwind_v1_and_central_reference_v1_are_distinct_and_reverse_with_current() {
    let build = |potential: Vec<f64>| {
        simple_problem(
            GridShape::new(2, 1, 1).unwrap(),
            potential,
            vec![2.0; 2],
            None,
            SpinMaterialFields {
                spin_conductivity_s_per_m: vec![2.0; 2],
                polarization: vec![0.5; 2],
                spin_hall_angle: vec![0.0; 2],
                magnetization: vec![[0.0, 1.0, 0.0], [0.0, -1.0, 0.0]],
                reactions: vec![SpinReactionLengths::default(); 2],
            },
            SpinBoundaryConditions::default(),
        )
    };
    let forward = build(vec![0.5, -0.5]);
    let reverse = build(vec![-0.5, 0.5]);
    let mu = [[0.0; 3]; 2];
    let forward_upwind = forward.face_fluxes(&mu).unwrap().x[1];
    let reverse_upwind = reverse.face_fluxes(&mu).unwrap().x[1];
    let forward_central = forward
        .clone()
        .with_flux_operator(SpinFluxOperator::FvSpinCentralReferenceV1)
        .face_fluxes(&mu)
        .unwrap()
        .x[1];
    assert!(forward_upwind[1] > 0.0);
    assert!(reverse_upwind[1] > 0.0);
    assert_eq!(forward_central, [0.0; 3]);
}

#[test]
fn validation_rejects_out_of_range_polarization_and_nonpositive_reduced_spin_conductivity() {
    let make = |sigma_s: f64, p: f64| {
        try_simple_problem(
            GridShape::new(1, 1, 1).unwrap(),
            vec![0.0],
            vec![2.0],
            None,
            SpinMaterialFields {
                spin_conductivity_s_per_m: vec![sigma_s],
                polarization: vec![p],
                spin_hall_angle: vec![0.0],
                magnetization: vec![[0.0, 0.0, 1.0]],
                reactions: vec![SpinReactionLengths::default()],
            },
            SpinBoundaryConditions::default(),
        )
    };
    let out_of_range = make(4.0, 1.1).unwrap_err();
    assert!(out_of_range.to_string().contains("[-1, 1]"));
    let nonpositive = make(0.5, 0.5).unwrap_err();
    assert!(nonpositive.to_string().contains("sigma_s - polarization"));
}

#[test]
fn charge_gradient_reconstruction_uses_full_conducting_mask_not_spin_mask() {
    let grid = GridShape::new(3, 1, 1).unwrap();
    let problem = simple_problem(
        grid,
        vec![1.0, 0.0, -1.0],
        vec![2.0; 3],
        Some(vec![false, true, false]),
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![1.0; 3],
            polarization: vec![0.0; 3],
            spin_hall_angle: vec![0.25; 3],
            magnetization: vec![[0.0, 0.0, 1.0]; 3],
            reactions: vec![SpinReactionLengths::default(); 3],
        },
        SpinBoundaryConditions {
            z_min: SpinBoundaryCondition::SpinSink,
            z_max: SpinBoundaryCondition::SpinSink,
            ..Default::default()
        },
    );
    let flux = problem.face_fluxes(&[[0.0; 3]; 3]).unwrap();
    let middle_z_min = 1;
    assert_close(flux.z[middle_z_min][1], 0.5, 1.0e-14);
}

#[test]
fn periodic_spin_pairs_are_conservative_and_one_sided_periodic_is_rejected() {
    let grid = GridShape::new(3, 1, 1).unwrap();
    let periodic = simple_problem(
        grid,
        vec![0.0; 3],
        vec![1.0; 3],
        None,
        SpinMaterialFields::nonmagnetic_isotropic(3, 2.0, 1.0),
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::PeriodicSpin,
            x_max: SpinBoundaryCondition::PeriodicSpin,
            ..Default::default()
        },
    );
    let flux = periodic
        .face_fluxes(&[[1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [4.0, 0.0, 0.0]])
        .unwrap();
    assert_eq!(flux.x[0], flux.x[3]);

    let charge = StructuredChargeProblem::new(
        grid,
        CellSize::new(1.0, 1.0, 1.0).unwrap(),
        vec![1.0; 3],
        None,
        ChargeBoundaryConditions::default(),
    )
    .unwrap();
    let error = SpinDriftDiffusionProblem::new(
        charge,
        vec![0.0; 3],
        SpinMaterialFields::nonmagnetic_isotropic(3, 1.0, 1.0),
        None,
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::PeriodicSpin,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("both x-axis"));
}

#[test]
fn internal_structured_contact_executes_outward_flux_on_each_selected_side() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let problem = simple_problem(
        GridShape::new(2, 1, 1).unwrap(),
        vec![0.0; 2],
        vec![1.0; 2],
        None,
        SpinMaterialFields::nonmagnetic_isotropic(2, 1.0, 1.0),
        SpinBoundaryConditions::default(),
    )
    .with_internal_contacts(vec![InternalSpinContact {
        face,
        negative_cell_condition: Some(SpinBoundaryCondition::SpecifiedFlux([1.0, 0.0, 0.0])),
        positive_cell_condition: Some(SpinBoundaryCondition::SpecifiedFlux([2.0, 0.0, 0.0])),
    }])
    .unwrap();
    let flux = problem.face_fluxes(&[[0.0; 3]; 2]).unwrap();
    assert_eq!(flux.x[1], [1.0, 0.0, 0.0]);
    let divergence = problem.conservative_divergence(&flux).unwrap();
    assert_eq!(divergence[0], [1.0, 0.0, 0.0]);
    assert_eq!(divergence[1], [2.0, 0.0, 0.0]);
}

#[test]
fn mixing_flux_balance_v1_resolves_longitudinal_absorbed_and_sml_channels() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let problem = simple_problem(
        GridShape::new(2, 1, 1).unwrap(),
        vec![1.0, 0.0],
        vec![1.0; 2],
        None,
        SpinMaterialFields::nonmagnetic_isotropic(2, 1.0, 1.0),
        SpinBoundaryConditions::default(),
    )
    .with_interfaces(
        vec![1, 2],
        vec![OrientedSpinInterface {
            face,
            from_cell: 0,
            to_cell: 1,
            law: SpinInterfaceLaw::MixingConductance {
                g_up_s_per_m2: 4.0,
                g_down_s_per_m2: 2.0,
                g_r_s_per_m2: 3.0,
                g_i_s_per_m2: 5.0,
                g_sml_s_per_m2: 7.0,
                magnetization: [0.0, 0.0, 1.0],
            },
        }],
    )
    .unwrap();
    let flux = problem.face_fluxes(&[[1.0, 2.0, 3.0], [0.0; 3]]).unwrap();
    let observation = flux.interface_observations[0];
    assert_eq!(observation.incoming_longitudinal_a_per_m2, [0.0, 0.0, 2.0]);
    assert_eq!(observation.backflow_longitudinal_a_per_m2, [0.0, 0.0, 9.0]);
    assert_eq!(observation.absorbed_transverse_a_per_m2, [13.0, 1.0, 0.0]);
    assert_eq!(observation.spin_memory_loss_a_per_m2, [7.0, 14.0, 21.0]);
    assert_eq!(observation.from_side_outgoing_a_per_m2, [20.0, 15.0, 32.0]);
    assert_eq!(observation.to_side_transmitted_a_per_m2, [0.0, 0.0, 11.0]);

    let missing = simple_problem(
        GridShape::new(2, 1, 1).unwrap(),
        vec![0.0; 2],
        vec![1.0; 2],
        None,
        SpinMaterialFields::nonmagnetic_isotropic(2, 1.0, 1.0),
        SpinBoundaryConditions::default(),
    )
    .with_interfaces(vec![1, 2], vec![])
    .unwrap();
    assert!(missing
        .face_fluxes(&[[0.0; 3]; 2])
        .unwrap_err()
        .to_string()
        .contains("explicit"));
}

#[test]
fn transport_gilbert_torque_has_canonical_negative_sign_and_units() {
    let problem = simple_problem(
        GridShape::new(1, 1, 1).unwrap(),
        vec![0.0],
        vec![1.0],
        None,
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![2.0],
            polarization: vec![0.0],
            spin_hall_angle: vec![0.0],
            magnetization: vec![[0.0, 0.0, 1.0]],
            reactions: vec![SpinReactionLengths {
                spin_flip_m: Some(1.0),
                exchange_m: Some(2.0),
                dephasing_m: Some(3.0),
            }],
        },
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 2.0, 0.0]),
            x_max: SpinBoundaryCondition::SpecifiedPotential([1.0, 2.0, 0.0]),
            ..Default::default()
        },
    )
    .with_torque_targets(SpinTorqueTargets {
        target_cells: vec![true],
        saturation_magnetization_a_per_m: vec![8.0e5],
        gamma_e_rad_per_s_t: 1.760_859_630_23e11,
    })
    .unwrap();
    let solution = problem.solve(SpinSolverConfig::default()).unwrap();
    let factor = -1.760_859_630_23e11 / 8.0e5 * (1.054_571_817e-34 / (2.0 * 1.602_176_634e-19));
    for component in 0..3 {
        assert_close(
            solution.transport_gilbert_torque_per_s[0][component],
            factor * solution.reaction_channels.magnetic_torque_sink[0][component],
            1.0e-18,
        );
    }
    assert_eq!(solution.telemetry.operator_version, "fv_spin_upwind_v1");
    assert_eq!(
        solution.telemetry.convergence_reason,
        "converged_true_residual_and_balance"
    );
    assert!(solution.telemetry.relative_balance_closure <= 10.0e-10);
}

#[test]
fn absorbed_mixing_flux_is_the_interface_gilbert_torque_source() {
    let face = StructuredSpinFace {
        axis: 0,
        negative_cell: 0,
        positive_cell: 1,
    };
    let problem = simple_problem(
        GridShape::new(2, 1, 1).unwrap(),
        vec![0.0; 2],
        vec![1.0; 2],
        None,
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![2.0; 2],
            polarization: vec![0.0; 2],
            spin_hall_angle: vec![0.0; 2],
            magnetization: vec![[0.0, 0.0, 1.0]; 2],
            reactions: vec![SpinReactionLengths::default(); 2],
        },
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedPotential([1.0, 2.0, 0.0]),
            x_max: SpinBoundaryCondition::SpinSink,
            ..Default::default()
        },
    )
    .with_interfaces(
        vec![1, 2],
        vec![OrientedSpinInterface {
            face,
            from_cell: 0,
            to_cell: 1,
            law: SpinInterfaceLaw::MixingConductance {
                g_up_s_per_m2: 0.0,
                g_down_s_per_m2: 0.0,
                g_r_s_per_m2: 3.0,
                g_i_s_per_m2: 0.0,
                g_sml_s_per_m2: 0.0,
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
    let solution = problem.solve(SpinSolverConfig::default()).unwrap();
    let absorbed =
        solution.spin_current_density.interface_observations[0].absorbed_transverse_a_per_m2;
    let factor = -1.760_859_630_23e11 / 8.0e5 * (1.054_571_817e-34 / (2.0 * 1.602_176_634e-19));
    assert_eq!(solution.transport_gilbert_torque_per_s[0], [0.0; 3]);
    for component in 0..3 {
        assert_close(
            solution.transport_gilbert_torque_per_s[1][component],
            factor * absorbed[component],
            1.0e-18,
        );
    }
    assert!(solution.telemetry.relative_balance_closure <= 10.0e-10);
}

#![cfg(feature = "fdm-native-cpu")]

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use fullmag_ir::*;

fn region(region_id: &str) -> RegionRefIR {
    RegionRefIR {
        object_id: "strip".into(),
        region_id: Some(region_id.into()),
    }
}

fn public_transport_problem(transparent: bool, native: bool) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu"}),
    );
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.backend_policy.execution_precision = ExecutionPrecision::Double;
    problem
        .backend_policy
        .discretization_hints
        .as_mut()
        .expect("bootstrap discretization hints")
        .fdm
        .as_mut()
        .expect("bootstrap FDM hints")
        .cell = [100.0e-9, 20.0e-9, 6.0e-9];
    problem.object_regions = vec![
        ObjectRegionIR {
            region_id: "normal".into(),
            owner_object: "strip".into(),
            name: "Normal metal".into(),
            shape: RegionShapeIR::Box {
                size: [100.0e-9, 20.0e-9, 6.0e-9],
                center: [-50.0e-9, 0.0, 0.0],
            },
            frame: RegionFrameIR::default(),
            enabled: true,
            priority: 0,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            realization_policy: RegionRealizationPolicyIR::default(),
            material_transition: None,
        },
        ObjectRegionIR {
            region_id: "ferromagnet".into(),
            owner_object: "strip".into(),
            name: "Ferromagnet".into(),
            shape: RegionShapeIR::Box {
                size: [100.0e-9, 20.0e-9, 6.0e-9],
                center: [50.0e-9, 0.0, 0.0],
            },
            frame: RegionFrameIR::default(),
            enabled: true,
            priority: 0,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            realization_policy: RegionRealizationPolicyIR::default(),
            material_transition: None,
        },
    ];
    let charge_surfaces = [
        ("x_min", [-1.0, 0.0, 0.0]),
        ("x_max", [1.0, 0.0, 0.0]),
        ("y_min", [0.0, -1.0, 0.0]),
        ("y_max", [0.0, 1.0, 0.0]),
        ("z_min", [0.0, 0.0, -1.0]),
        ("z_max", [0.0, 0.0, 1.0]),
    ];
    problem.current_modules = vec![CurrentModuleIR::CurrentTransport {
        name: "charge".into(),
        model: CurrentTransportModelIR::OhmicPoisson,
        current_density: None,
        solve_region: None,
        conductivity_s_per_m: None,
        coupling: TransportCouplingIR::OneWay,
        time_envelope: None,
        definition: Some(ChargeTransportDefinitionIR {
            domain: vec![region("normal"), region("ferromagnet")],
            materials: ["normal", "ferromagnet"]
                .into_iter()
                .map(|region_id| ChargeTransportMaterialAssignmentIR {
                    region: region(region_id),
                    material: ChargeTransportMaterialIR {
                        sigma_spm: 4.0e6,
                        sigma_parallel_spm: None,
                        sigma_perpendicular_spm: None,
                        sigma_ahe_spm: None,
                    },
                })
                .collect(),
            boundaries: charge_surfaces
                .into_iter()
                .map(|(surface_id, orientation)| {
                    let surfaces = vec![SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: surface_id.into(),
                        orientation,
                    }];
                    if matches!(surface_id, "x_min" | "x_max") {
                        ChargeBoundaryIR::VoltageElectrode {
                            id: surface_id.into(),
                            surfaces,
                            potential_v: if surface_id == "x_max" { 2.0e-3 } else { 0.0 },
                        }
                    } else {
                        ChargeBoundaryIR::Insulating {
                            id: surface_id.into(),
                            surfaces,
                        }
                    }
                })
                .collect(),
            gauge: ChargePotentialGaugeIR::DirichletReference,
            solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-12,
                    absolute_tolerance: 1.0e-14,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fv_charge_harmonic_v1".into(),
            },
            conservative_current_view: None,
            structured_current_closure: None,
        }),
    }];
    problem.spin_transport_modules = vec![SpinTransportModuleIR {
        schema_version: "spin_transport.v1".into(),
        id: "spin".into(),
        current_source_id: "charge".into(),
        mode: SpinTransportModeIR::Steady,
        domain: vec![region("normal"), region("ferromagnet")],
        materials: ["normal", "ferromagnet"]
            .into_iter()
            .map(|region_id| SpinTransportMaterialAssignmentIR {
                region: region(region_id),
                material: SpinTransportMaterialIR {
                    sigma_s_spm: 5.0e6,
                    polarization_p: 0.4,
                    theta_sh: 0.1,
                    lambda_sf_m: 5.0e-9,
                    lambda_j_m: if region_id == "ferromagnet" {
                        ReactionLengthIR::Enabled(40.0e-9)
                    } else {
                        ReactionLengthIR::Disabled(DisabledReactionIR::Disabled)
                    },
                    lambda_phi_m: if region_id == "ferromagnet" {
                        ReactionLengthIR::Enabled(50.0e-9)
                    } else {
                        ReactionLengthIR::Disabled(DisabledReactionIR::Disabled)
                    },
                    spin_capacitance_as_per_v_m3: None,
                    capacitance_formula_version: None,
                    density_of_states_per_spin_j_inv_m3: None,
                },
            })
            .collect(),
        interfaces: vec![if transparent {
            SpinInterfaceIR::Transparent {
                id: "mix".into(),
                side_a: region("normal"),
                side_b: region("ferromagnet"),
                normal_a_to_b: [1.0, 0.0, 0.0],
            }
        } else {
            SpinInterfaceIR::MixingConductance {
                id: "mix".into(),
                normal_to_ferromagnet: [1.0, 0.0, 0.0],
                normal_side: region("normal"),
                ferromagnet_side: region("ferromagnet"),
                g_up_spm2: 7.0e14,
                g_down_spm2: 3.0e14,
                g_r_spm2: 2.0e14,
                g_i_spm2: -1.0e14,
                g_sml_spm2: 0.0,
                spin_memory_loss: None,
                absorption: "full".into(),
                formula_version: "magnetoelectronic.fullmag.v2".into(),
            }
        }],
        boundaries: [
            ("x_min", [-1.0, 0.0, 0.0]),
            ("x_max", [1.0, 0.0, 0.0]),
            ("y_min", [0.0, -1.0, 0.0]),
            ("y_max", [0.0, 1.0, 0.0]),
            ("z_min", [0.0, 0.0, -1.0]),
            ("z_max", [0.0, 0.0, 1.0]),
        ]
        .into_iter()
        .map(|(surface_id, orientation)| {
            let surfaces = vec![SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: surface_id.into(),
                orientation,
            }];
            if surface_id == "x_min" {
                SpinBoundaryIR::SpecifiedSpinPotential {
                    id: "spin_drive".into(),
                    surfaces,
                    spin_potential_v: [1.0e-3, 2.0e-3, 3.0e-3],
                }
            } else {
                SpinBoundaryIR::SpinInsulating {
                    id: format!("spin_{surface_id}"),
                    surfaces,
                }
            }
        })
        .collect(),
        solver: SpinSolverPolicyIR {
            engine: if native { "native_m1_v1" } else { "gmres" }.into(),
            linear: LinearTransportSolverPolicyIR {
                relative_tolerance: 1.0e-10,
                absolute_tolerance: 1.0e-14,
                max_iterations: 1000,
            },
            physical_residual_version: "transport_balance_integrated_l2.v1".into(),
            operator_version: "fv_spin_upwind_v1".into(),
            default_external_boundary: "spin_insulating".into(),
            reciprocal_nonlinear: None,
        },
        requested_execution: RequestedTransportExecutionIR {
            discretization: BackendTarget::Fdm,
            device: ExecutionDevice::Cpu,
            precision: ExecutionPrecision::Double,
            execution_mode: ExecutionMode::Strict,
        },
        constitutive_version: "transport_constitutive.one_way.fullmag.v1".into(),
    }];
    problem.spin_torque_modules = vec![SpinTorqueModuleIR::DriftDiffusionSpinTorque {
        schema_version: "drift_diffusion_spin_torque.v1".into(),
        id: "transport_torque".into(),
        solve_id: "spin".into(),
        target: region("ferromagnet"),
        formula_version: "transport_torque_angular_momentum.fullmag.v1".into(),
    }];
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 1,
        "modules": [
            {"id":"charge","kind":"current_transport","applies_to":[{"kind":"object","object_id":"strip"}],"solve_domain":[{"object_id":"strip"}],"depends_on":[],"activation":"active","authored_state":"authored","capability":"semantic_only","source_path":"/current_modules/0","family_payload":{}},
            {"id":"spin","kind":"spin_transport","applies_to":[{"kind":"object","object_id":"strip"}],"solve_domain":[{"object_id":"strip"}],"depends_on":["charge"],"activation":"active","authored_state":"authored","capability":"reference_executable","source_path":"/spin_transport_modules/0","family_payload":{}},
            {"id":"mix","kind":"spin_interface","applies_to":[{"kind":"object","object_id":"strip"}],"solve_domain":[{"object_id":"strip"}],"depends_on":["spin"],"activation":"active","authored_state":"authored","capability":"semantic_only","source_path":"/spin_transport_modules/0/interfaces/0","family_payload":{}},
            {"id":"transport_torque","kind":"spin_torque","applies_to":[{"kind":"object","object_id":"strip"}],"solve_domain":[{"object_id":"strip"}],"depends_on":["spin"],"activation":"active","authored_state":"authored","capability":"semantic_only","source_path":"/spin_torque_modules/0","family_payload":{}}
        ],
        "edges": []
    }));
    problem
}

fn public_closed_loop_oersted_problem() -> ProblemIR {
    let mut problem = public_transport_problem(true, true);
    problem.problem_meta.name = "fdm_closed_loop_oersted".into();
    problem.geometry.entries = vec![GeometryEntryIR::Difference {
        name: "strip".into(),
        base: Box::new(GeometryEntryIR::Box {
            name: "loop_outer".into(),
            size: [3.0e-9, 3.0e-9, 1.0e-9],
        }),
        tool: Box::new(GeometryEntryIR::Box {
            name: "loop_hole".into(),
            size: [1.0e-9, 1.0e-9, 1.0e-9],
        }),
    }];
    problem.object_regions = vec![ObjectRegionIR {
        region_id: "source_arm".into(),
        owner_object: "strip".into(),
        name: "Source arm".into(),
        shape: RegionShapeIR::Box {
            size: [1.0e-9, 3.0e-9, 1.0e-9],
            center: [-1.0e-9, 0.0, 0.0],
        },
        frame: RegionFrameIR::default(),
        enabled: true,
        priority: 1,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: RegionRealizationPolicyIR::default(),
        material_transition: None,
    }];
    problem
        .backend_policy
        .discretization_hints
        .as_mut()
        .expect("bootstrap discretization hints")
        .fdm
        .as_mut()
        .expect("bootstrap FDM hints")
        .cell = [1.0e-9; 3];
    let whole_loop = RegionRefIR {
        object_id: "strip".into(),
        region_id: None,
    };
    let source_arm = RegionRefIR {
        object_id: "strip".into(),
        region_id: Some("source_arm".into()),
    };
    let CurrentModuleIR::CurrentTransport {
        definition: Some(definition),
        ..
    } = &mut problem.current_modules[0]
    else {
        panic!("charge definition fixture")
    };
    definition.domain = vec![whole_loop.clone()];
    definition.materials = vec![ChargeTransportMaterialAssignmentIR {
        region: whole_loop.clone(),
        material: ChargeTransportMaterialIR {
            sigma_spm: 4.0e6,
            sigma_parallel_spm: None,
            sigma_perpendicular_spm: None,
            sigma_ahe_spm: None,
        },
    }];
    for boundary in &mut definition.boundaries {
        let id = boundary.id().to_string();
        let surfaces = boundary.surfaces().to_vec();
        *boundary = ChargeBoundaryIR::Insulating { id, surfaces };
    }
    definition.gauge = ChargePotentialGaugeIR::ZeroMean;
    definition.solver.linear.absolute_tolerance = 1.0e-6;
    definition.solver.operator_version = "fv_charge_harmonic_source_cut_v1".into();
    definition.structured_current_closure = Some(StructuredCurrentClosureIR::ClosedGeometry {
        schema_version: "structured_current_closure.v1".into(),
        closure_id: "loop-closure".into(),
        source_cuts: vec![StructuredCurrentSourceCutIR {
            source_cut_id: "source-cut".into(),
            circuit_id: "loop-circuit".into(),
            region: source_arm,
            plane: StructuredCutPlaneIR {
                axis: StructuredCutAxisIR::Y,
                offset_m: -0.5e-9,
                normal: StructuredCutNormalIR::PositiveAxis,
            },
            drive: StructuredCurrentDriveIR::ImpressedPotentialJump(
                ImpressedPotentialJumpIR {
                    schema_version: "impressed_potential_jump.v1".into(),
                    drive_id: "loop-drive".into(),
                    potential_jump_v: 1.0e-3,
                },
            ),
        }],
    });
    problem.spin_transport_modules[0].domain = vec![whole_loop.clone()];
    problem.spin_transport_modules[0].materials = vec![SpinTransportMaterialAssignmentIR {
        region: whole_loop.clone(),
        material: problem.spin_transport_modules[0].materials[0]
            .material
            .clone(),
    }];
    problem.spin_transport_modules[0].interfaces = vec![SpinInterfaceIR::Transparent {
        id: "source-arm-plus-x".into(),
        side_a: RegionRefIR {
            object_id: "strip".into(),
            region_id: Some("source_arm".into()),
        },
        side_b: whole_loop.clone(),
        normal_a_to_b: [1.0, 0.0, 0.0],
    }];
    problem.spin_transport_modules[0].boundaries.clear();
    problem.spin_torque_modules = vec![SpinTorqueModuleIR::DriftDiffusionSpinTorque {
        schema_version: "drift_diffusion_spin_torque.v1".into(),
        id: "transport_torque".into(),
        solve_id: "spin".into(),
        target: whole_loop,
        formula_version: "transport_torque_angular_momentum.fullmag.v1".into(),
    }];
    problem.energy_terms = vec![
        EnergyTermIR::Exchange,
        EnergyTermIR::OerstedField {
            id: Some("oersted".into()),
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "charge".into(),
        },
    ];
    problem.physics_graph = None;
    problem
}

fn output_dir(label: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "fullmag-native-m1-{label}-{}-{suffix}",
        std::process::id()
    ))
}

fn assert_json_close(
    label: &str,
    actual: &serde_json::Value,
    expected: &serde_json::Value,
    abs: f64,
    rel: f64,
) {
    match (actual, expected) {
        (serde_json::Value::Number(actual), serde_json::Value::Number(expected)) => {
            let actual = actual.as_f64().expect("actual f64");
            let expected = expected.as_f64().expect("expected f64");
            let tolerance = abs + rel * actual.abs().max(expected.abs());
            assert!(
                (actual - expected).abs() <= tolerance,
                "{label}: {actual} != {expected}, tol={tolerance}"
            );
        }
        (serde_json::Value::Array(actual), serde_json::Value::Array(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{label} length");
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                assert_json_close(&format!("{label}[{index}]"), actual, expected, abs, rel);
            }
        }
        (serde_json::Value::Object(actual), serde_json::Value::Object(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{label} object field count");
            for (key, expected) in expected {
                assert_json_close(
                    &format!("{label}.{key}"),
                    actual
                        .get(key)
                        .unwrap_or_else(|| panic!("{label} missing {key}")),
                    expected,
                    abs,
                    rel,
                );
            }
        }
        _ => assert_eq!(actual, expected, "{label}"),
    }
}

fn vector_field_values(label: &str, value: &serde_json::Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{label} must be an array"))
        .iter()
        .enumerate()
        .flat_map(|(cell, vector)| {
            vector
                .as_array()
                .unwrap_or_else(|| panic!("{label}[{cell}] must be a vector"))
                .iter()
                .enumerate()
                .map(move |(component, value)| {
                    value
                        .as_f64()
                        .unwrap_or_else(|| panic!("{label}[{cell}][{component}] must be numeric"))
                })
        })
        .collect()
}

#[test]
fn public_closed_loop_source_cut_publishes_nonzero_oersted_artifact() {
    let problem = public_closed_loop_oersted_problem();
    let plan = fullmag_plan::plan(&problem).expect("closed-loop ProblemIR must plan");
    let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        panic!("closed-loop fixture must resolve FDM")
    };
    let descriptor = fdm.spin_transport_plans[0]
        .fdm_cpu_double
        .as_ref()
        .expect("native FDM descriptor");
    let closure = descriptor
        .structured_current_closure
        .as_ref()
        .expect("resolved structured closure");
    assert_eq!(closure.source_cuts.len(), 1);
    assert_eq!(closure.source_cuts[0].faces.len(), 1);

    let directory = output_dir("closed-loop-oersted");
    let result = fullmag_runner::run_planned_problem(&problem, &plan, 1.0e-13, &directory)
        .expect("public planned runner must execute the closed loop");
    assert_eq!(result.status, fullmag_runner::RunStatus::Completed);
    let artifact: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join("transport/spin_transport_accepted.json"))
            .expect("persistent accepted transport artifact"),
    )
    .expect("accepted transport JSON");
    let module = &artifact["evaluation"]["modules"][0];
    assert_eq!(
        module["charge_operator_version"],
        "fv_charge_harmonic_source_cut_v1"
    );
    let current = vector_field_values("closed-loop current", &module["current_density_apm2"]);
    assert!(current.iter().any(|value| value.abs() > 0.0));
    let field = vector_field_values("closed-loop Oersted", &module["oersted_field_apm"]);
    assert!(field.iter().all(|value| value.is_finite()));
    assert!(field.iter().any(|value| value.abs() > 0.0));
    let provenance = &module["oersted_closure_provenance"];
    assert_eq!(provenance["closure_kind"], "closed_geometry");
    assert_eq!(
        provenance["certificate_version"],
        "global_closed_current_certificate.v1"
    );
    assert_eq!(
        provenance["operator_version"],
        "fdm_oersted_cell_integrated_open.v1"
    );
    for digest in [
        "geometry_digest",
        "conductor_mask_digest",
        "target_mask_digest",
        "face_current_digest",
        "certificate_digest",
        "envelope_digest",
        "trusted_snapshot_digest",
    ] {
        assert!(
            provenance[digest]
                .as_str()
                .is_some_and(|value| value.starts_with("sha256:")),
            "missing canonical {digest}"
        );
    }
    assert_eq!(provenance["source_cuts"].as_array().unwrap().len(), 1);
    assert_eq!(
        provenance["source_cuts"][0]["drive_kind"],
        "impressed_potential_jump.v1"
    );
    assert_eq!(
        provenance["source_cuts"][0]["ordered_internal_face_ids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    fs::remove_dir_all(directory).expect("remove closed-loop fixture");
}

#[test]
fn public_native_m1_v1_transparent_and_mixing_artifacts_match_reference_and_provenance() {
    for (label, transparent) in [("transparent", true), ("mixing", false)] {
        let native_problem = public_transport_problem(transparent, true);
        let native_plan = fullmag_plan::plan(&native_problem).expect("native ProblemIR must plan");
        let BackendPlanIR::Fdm(fdm) = &native_plan.backend_plan else {
            panic!("native M1 fixture must resolve FDM");
        };
        let descriptor = fdm.spin_transport_plans[0]
            .fdm_cpu_double
            .as_ref()
            .expect("native descriptor");
        assert_eq!(
            descriptor.realization,
            FdmCpuTransportRealizationIR::NativeM1V1
        );
        let expected_interfaces =
            serde_json::to_value(&descriptor.interfaces).expect("serialize expected interfaces");
        let expected_torque_target_cells = serde_json::to_value(&descriptor.torque_target_cells)
            .expect("serialize expected torque target");
        let expected_charge_domain = serde_json::to_value(ResolvedFemTransportDomainIR {
            regions: Vec::new(),
            element_mask: descriptor.charge_active_cells.clone(),
        })
        .expect("serialize expected charge domain");
        let expected_spin_domain = serde_json::to_value(ResolvedFemTransportDomainIR {
            regions: Vec::new(),
            element_mask: descriptor.spin_active_cells.clone(),
        })
        .expect("serialize expected spin domain");

        let reference_problem = public_transport_problem(transparent, false);
        let reference_plan =
            fullmag_plan::plan(&reference_problem).expect("reference ProblemIR must plan");
        let native_dir = output_dir(&format!("{label}-native"));
        let reference_dir = output_dir(&format!("{label}-reference"));
        for (problem, plan, directory) in [
            (&native_problem, &native_plan, &native_dir),
            (&reference_problem, &reference_plan, &reference_dir),
        ] {
            let result = fullmag_runner::run_planned_problem(problem, plan, 1.0e-13, directory)
                .expect("public planned runner must execute unchanged plan");
            assert_eq!(result.status, fullmag_runner::RunStatus::Completed);
        }
        let read = |directory: &std::path::Path| {
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(directory.join("transport/spin_transport_accepted.json"))
                    .expect("persistent accepted transport artifact"),
            )
            .expect("accepted artifact JSON")
        };
        let native_artifact = read(&native_dir);
        let reference_artifact = read(&reference_dir);
        let native = &native_artifact["evaluation"]["modules"][0];
        let reference = &reference_artifact["evaluation"]["modules"][0];
        for (field, abs, rel) in [
            ("potential_volts", 1.0e-13, 1.0e-10),
            ("current_density_apm2", 1.0e-5, 1.0e-10),
            ("charge_face_current", 1.0e-5, 1.0e-10),
            ("charge_interface_observations", 1.0e-5, 1.0e-9),
            ("spin_potential_volts", 1.0e-13, 2.0e-8),
            ("spin_current_tensor_apm2", 1.0e-5, 2.0e-8),
            ("spin_face_current", 1.0e-5, 2.0e-8),
            ("spin_reaction_channels", 1.0e-1, 2.0e-8),
            ("interface_fluxes", 1.0e-5, 2.0e-8),
            ("transport_torque_per_s", 1.0e-3, 2.0e-8),
        ] {
            assert_json_close(
                &format!("{label}.{field}"),
                &native[field],
                &reference[field],
                abs,
                rel,
            );
        }
        let native_torque = vector_field_values(
            &format!("{label}.transport_torque_per_s"),
            &native["transport_torque_per_s"],
        );
        let reference_torque = vector_field_values(
            &format!("{label}.transport_torque_per_s"),
            &reference["transport_torque_per_s"],
        );
        assert_eq!(native_torque.len(), reference_torque.len());
        assert!(
            native_torque.iter().any(|value| value.abs() > 1.0e-12),
            "{label} native transport torque must be nonzero"
        );
        assert!(
            reference_torque.iter().any(|value| value.abs() > 1.0e-12),
            "{label} reference transport torque must be nonzero"
        );
        let torque_correlation = native_torque
            .iter()
            .zip(&reference_torque)
            .map(|(native, reference)| native * reference)
            .sum::<f64>();
        assert!(
            torque_correlation > 0.0,
            "{label} native and reference transport torque must have the same orientation"
        );
        assert_eq!(native["runtime_owner"], "fdm_cpu_native_transport_m1_v1");
        assert_eq!(native["transport_realization"], "native_m1_v1");
        assert_eq!(native["fallback_used"], false);
        assert_eq!(
            native["constitutive_version"],
            "transport_constitutive.one_way.fullmag.v1"
        );
        assert_eq!(native["charge_operator_version"], "fv_charge_harmonic_v1");
        assert_eq!(native["spin_operator_version"], "fv_spin_upwind_v1");
        assert_eq!(
            native["torque_formula_version"],
            "transport_torque_angular_momentum.fullmag.v1"
        );

        let metadata: serde_json::Value = serde_json::from_slice(
            &fs::read(native_dir.join("metadata.json")).expect("durable metadata"),
        )
        .expect("metadata JSON");
        assert_eq!(
            metadata["execution_provenance"]["lossy_fallback_used"],
            false
        );
        assert_eq!(
            metadata["execution_provenance"]["resolved_fallback"],
            serde_json::Value::Null
        );
        assert_eq!(
            metadata["execution_provenance"]["executed_physics_module_ids"],
            serde_json::json!(["charge", "mix", "spin", "transport_torque"])
        );
        let transport = &metadata["execution_provenance"]["transport_modules"][0];
        let expected_transport = serde_json::json!({
            "module_id": "spin",
            "current_source_id": "charge",
            "requested_discretization": "fdm",
            "requested_device": "cpu",
            "requested_precision": "double",
            "requested_execution_mode": "strict",
            "resolved_discretization": "fdm",
            "resolved_device": "cpu",
            "resolved_precision": "double",
            "resolved_execution_mode": "strict",
            "runtime_family": "fullmag_fdm_cpu_native_transport",
            "runtime_id": "fdm_cpu_native_transport_m1_v1",
            "engine_id": "native_m1_v1",
            "charge_solver_engine": "cg",
            "spin_solver_engine": "native_m1_v1",
            "constitutive_version": "transport_constitutive.one_way.fullmag.v1",
            "operator_version": "fv_spin_upwind_v1",
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "charge_operator_version": "fv_charge_harmonic_v1",
            "spin_operator_version": "fv_spin_upwind_v1",
            "interface_formula_versions": if transparent {
                serde_json::json!([null])
            } else {
                serde_json::json!(["magnetoelectronic.fullmag.v2"])
            },
            "torque_formula_version": "transport_torque_angular_momentum.fullmag.v1",
            "interface_realization": if transparent {
                "transparent"
            } else {
                "magnetoelectronic.fullmag.v2"
            },
            "stage_coupling": "one_way_stage_refresh",
            "capability_status": "semantic_only",
            "implementation_state": "executable",
            "validation_state": "unvalidated",
            "validation_scope": "opt_in_fdm_cpu_double_native_m1_v1_contract_only",
            "charge_domain": expected_charge_domain,
            "spin_domain": expected_spin_domain,
            "charge_insulating_boundaries": [],
            "spin_insulating_boundaries": [],
            "interfaces": [],
            "fdm_interfaces": expected_interfaces,
            "fdm_torque_target_cells": expected_torque_target_cells,
        });
        assert_eq!(
            transport, &expected_transport,
            "{label} exact transport provenance"
        );

        fs::remove_dir_all(native_dir).expect("remove native fixture");
        fs::remove_dir_all(reference_dir).expect("remove reference fixture");
    }
}

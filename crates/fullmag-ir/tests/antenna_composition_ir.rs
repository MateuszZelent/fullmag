use fullmag_ir::{
    AntennaPortBranchV2IR, AntennaPortModeIR, ChargeBoundaryIR, ChargePotentialGaugeIR,
    ChargeSolverPolicyIR, ChargeTransportDefinitionIR, CurrentModuleIR, CurrentTransportModelIR,
    LinearTransportSolverPolicyIR, PhysicsObjectIR, PhysicsObjectTypeIR, ProblemIRV04,
    SurfaceRefIR, TransportCouplingIR,
};

fn problem_with_charge_transport() -> ProblemIRV04 {
    let mut problem = ProblemIRV04::bootstrap_example();
    let geometry_id = problem.geometry.entries[0].name().to_string();
    problem.objects.push(PhysicsObjectIR::new(
        "antenna_1",
        "Antenna 1",
        PhysicsObjectTypeIR::Antenna,
        geometry_id,
    ));
    let surface = |surface_id: &str| SurfaceRefIR {
        object_id: "antenna_1".to_string(),
        surface_id: surface_id.to_string(),
        orientation: [1.0, 0.0, 0.0],
    };
    problem
        .current_modules
        .push(CurrentModuleIR::CurrentTransport {
            name: "antenna_current".to_string(),
            model: CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: TransportCouplingIR::OneWay,
            time_envelope: None,
            definition: Some(ChargeTransportDefinitionIR {
                domain: Vec::new(),
                materials: Vec::new(),
                boundaries: vec![
                    ChargeBoundaryIR::VoltageElectrode {
                        id: "signal_in".to_string(),
                        surfaces: vec![surface("signal_in_face")],
                        potential_v: 1.0,
                    },
                    ChargeBoundaryIR::VoltageElectrode {
                        id: "signal_out".to_string(),
                        surfaces: vec![surface("signal_out_face")],
                        potential_v: 0.0,
                    },
                    ChargeBoundaryIR::VoltageElectrode {
                        id: "return_in".to_string(),
                        surfaces: vec![surface("return_in_face")],
                        potential_v: 0.0,
                    },
                    ChargeBoundaryIR::VoltageElectrode {
                        id: "return_out".to_string(),
                        surfaces: vec![surface("return_out_face")],
                        potential_v: 0.0,
                    },
                ],
                gauge: ChargePotentialGaugeIR::DirichletReference,
                solver: ChargeSolverPolicyIR {
                    engine: "fem_cpu".to_string(),
                    linear: LinearTransportSolverPolicyIR {
                        relative_tolerance: 1.0e-10,
                        absolute_tolerance: 1.0e-12,
                        max_iterations: 500,
                    },
                    physical_residual_version: "charge_balance_integrated_l2.v1".to_string(),
                    operator_version: "fem_charge_conforming_h1_p1.transparent.v1".to_string(),
                },
                conservative_current_view: None,
                conservative_current_source: None,
                structured_current_closure: None,
            }),
        });
    problem
}

#[test]
fn balanced_port_mode_is_composition_only_and_round_trips() {
    let mut problem = problem_with_charge_transport();
    problem.antenna_port_modes.push(AntennaPortModeIR {
        schema_version: "antenna_port_mode.v2".to_string(),
        id: "common_mode".to_string(),
        source_object_id: "antenna_1".to_string(),
        current_transport_id: "antenna_current".to_string(),
        branches: vec![
            AntennaPortBranchV2IR {
                id: "signal".to_string(),
                inlet_terminal_ref: "signal_in".to_string(),
                outlet_terminal_ref: "signal_out".to_string(),
                signed_weight: 1.0,
            },
            AntennaPortBranchV2IR {
                id: "return".to_string(),
                inlet_terminal_ref: "return_in".to_string(),
                outlet_terminal_ref: "return_out".to_string(),
                signed_weight: -1.0,
            },
        ],
        normalization_current_a: 1.0,
    });

    assert!(problem.validate().is_ok());
    let value = serde_json::to_value(&problem).unwrap();
    let port = &value["antenna_port_modes"][0];
    assert!(port.get("geometry").is_none());
    assert!(port.get("conductivity").is_none());
    let round_trip: ProblemIRV04 = serde_json::from_value(value).unwrap();
    assert_eq!(round_trip.antenna_port_modes, problem.antenna_port_modes);
}

#[test]
fn port_mode_rejects_unbalanced_or_missing_terminal_references() {
    let mut problem = problem_with_charge_transport();
    problem.antenna_port_modes.push(AntennaPortModeIR {
        schema_version: "antenna_port_mode.v2".to_string(),
        id: "invalid".to_string(),
        source_object_id: "antenna_1".to_string(),
        current_transport_id: "antenna_current".to_string(),
        branches: vec![
            AntennaPortBranchV2IR {
                id: "signal".to_string(),
                inlet_terminal_ref: "signal_in".to_string(),
                outlet_terminal_ref: "signal_out".to_string(),
                signed_weight: 1.0,
            },
            AntennaPortBranchV2IR {
                id: "missing_return".to_string(),
                inlet_terminal_ref: "missing_return_in".to_string(),
                outlet_terminal_ref: "missing_return_out".to_string(),
                signed_weight: -0.5,
            },
        ],
        normalization_current_a: 1.0,
    });

    let errors = problem.validate().unwrap_err();
    assert!(errors.iter().any(|error| error.contains("summing to zero")));
    assert!(errors
        .iter()
        .any(|error| error.contains("missing_return") && error.contains("does not exist")));
}

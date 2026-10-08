use fullmag_ir::{
    AntennaConductorPartIR, AntennaRigidTransformIR, AntennaTerminalFaceSelectorsIR,
    CpwWidthStationIR, GeometryEntryIR, ProblemIR,
};
use std::collections::BTreeMap;

fn identity_transform() -> AntennaRigidTransformIR {
    AntennaRigidTransformIR {
        rotation_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        translation_m: [0.0, 0.0, 0.0],
    }
}

fn cpw_geometry(name: &str) -> GeometryEntryIR {
    let conductors = vec![
        AntennaConductorPartIR {
            id: "signal".to_string(),
            kind: "signal".to_string(),
        },
        AntennaConductorPartIR {
            id: "ground_left".to_string(),
            kind: "ground_left".to_string(),
        },
        AntennaConductorPartIR {
            id: "ground_right".to_string(),
            kind: "ground_right".to_string(),
        },
    ];
    let terminal_faces = conductors
        .iter()
        .map(|part| {
            (
                part.id.clone(),
                AntennaTerminalFaceSelectorsIR {
                    inlet: "local_u_min".to_string(),
                    outlet: "local_u_max".to_string(),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    GeometryEntryIR::CpwAntenna {
        name: name.to_string(),
        length_m: 10.0e-6,
        thickness_m: 100.0e-9,
        conductivity_s_per_m: 58.0e6,
        transform: identity_transform(),
        stations: vec![
            CpwWidthStationIR {
                s: 0.0,
                signal_width_m: 1.0e-6,
                left_gap_m: 0.5e-6,
                right_gap_m: 0.5e-6,
                left_ground_width_m: 3.0e-6,
                right_ground_width_m: 3.0e-6,
            },
            CpwWidthStationIR {
                s: 1.0,
                signal_width_m: 0.3e-6,
                left_gap_m: 0.2e-6,
                right_gap_m: 0.25e-6,
                left_ground_width_m: 3.0e-6,
                right_ground_width_m: 3.0e-6,
            },
        ],
        conductors,
        terminal_faces,
    }
}

#[test]
fn cpw_layout_geometry_round_trips_with_typed_stations() {
    let geometry = cpw_geometry("cpw");
    let value = serde_json::to_value(&geometry).expect("serialize CPW geometry");
    assert_eq!(value["kind"], "cpw");
    assert_eq!(value["stations"][1]["right_gap_m"], 0.25e-6);
    let decoded: GeometryEntryIR = serde_json::from_value(value).expect("decode CPW geometry");
    assert_eq!(decoded, geometry);
}

#[test]
fn problem_validation_rejects_non_monotonic_antenna_stations() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.geometry.entries[0] = cpw_geometry("strip");
    if let GeometryEntryIR::CpwAntenna { stations, .. } = &mut problem.geometry.entries[0] {
        stations[1].s = 0.0;
    }
    let errors = problem
        .validate()
        .expect_err("invalid station order must fail");
    assert!(errors
        .iter()
        .any(|error| error.contains("positions must be strictly increasing")));
}

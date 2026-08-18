use fullmag_ir::{EnergyTermIR, ProblemIR};

#[test]
fn static_field_map_is_a_typed_zeeman_ir_term() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.energy_terms = vec![
        EnergyTermIR::Exchange,
        EnergyTermIR::StaticFieldMap {
            id: "frozen_transport_equivalent".to_string(),
            field_b_t: vec![[0.0, 1.0e-3, 0.0], [-2.0e-3, 0.0, 3.0e-3]],
        },
    ];

    let encoded = serde_json::to_value(&problem).expect("static field map serializes");
    let decoded: ProblemIR =
        serde_json::from_value(encoded).expect("static field map deserializes");
    assert!(decoded.validate().is_ok());
    assert_eq!(decoded.energy_terms, problem.energy_terms);
}

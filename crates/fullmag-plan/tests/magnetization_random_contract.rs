use fullmag_plan::generate_random_unit_vectors;

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn norm(value: [f64; 3]) -> f64 {
    dot(value, value).sqrt()
}

#[test]
fn seed_zero_is_finite_normalized_and_non_degenerate() {
    let first = generate_random_unit_vectors(0, 4);
    let second = generate_random_unit_vectors(0, 4);

    assert_eq!(first, second);
    assert!(first.iter().all(|value| {
        value.iter().all(|component| component.is_finite()) && (norm(*value) - 1.0).abs() < 1.0e-12
    }));
    assert!(dot(first[0], first[1]).abs() < 0.999);
}

use fullmag_engine::Vector3;

pub(super) fn vector_norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

pub(super) fn frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue) / (2.0 * std::f64::consts::PI)
}

pub(super) fn angular_frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    // gyromagnetic_ratio is μ₀γ (≈ 2.211e5 m/(A·s)), eigenvalue is H_eff in A/m.
    // ω = μ₀γ · H_eff — no additional μ₀ factor needed.
    gyromagnetic_ratio * eigenvalue.max(0.0)
}

pub(super) fn angular_frequency_from_raw_eigenvalue(
    gyromagnetic_ratio: f64,
    eigenvalue: f64,
) -> f64 {
    gyromagnetic_ratio * eigenvalue
}

pub(super) fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn norm(a: Vector3) -> f64 {
    dot(a, a).sqrt()
}

pub(super) fn normalize_vector(a: Vector3) -> Vector3 {
    let magnitude = norm(a);
    if magnitude <= 1e-30 {
        [1.0, 0.0, 0.0]
    } else {
        scale_vector(a, 1.0 / magnitude)
    }
}

pub(super) fn scale_vector(a: Vector3, factor: f64) -> Vector3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

pub(super) fn add_vector(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

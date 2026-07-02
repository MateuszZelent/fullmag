pub(super) fn unpack_flat_f64(flat: &[f64]) -> Vec<[f64; 3]> {
    flat.chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

pub(super) fn unpack_flat_f32(flat: &[f32]) -> Vec<[f32; 3]> {
    flat.chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

pub(super) fn flatten_vectors_f64(vectors: &[[f64; 3]]) -> Vec<f64> {
    vectors
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

pub(super) fn flatten_vectors_f32(vectors: &[[f32; 3]]) -> Vec<f32> {
    vectors
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

pub(super) fn max_rhs_norm_from_field(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
    damping: f64,
    gyromagnetic_ratio: f64,
    precession_enabled: bool,
) -> f64 {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .map(|(m, h)| {
            norm(llg_rhs_from_field(
                *m,
                *h,
                damping,
                gyromagnetic_ratio,
                precession_enabled,
            ))
        })
        .fold(0.0, f64::max)
}

fn llg_rhs_from_field(
    magnetization: [f64; 3],
    field: [f64; 3],
    damping: f64,
    gyromagnetic_ratio: f64,
    precession_enabled: bool,
) -> [f64; 3] {
    let gamma_bar = gyromagnetic_ratio / (1.0 + damping * damping);
    let precession = cross(magnetization, field);
    let damping_term = cross(magnetization, precession);
    let precession_term = if precession_enabled {
        precession
    } else {
        [0.0, 0.0, 0.0]
    };
    scale(
        add(precession_term, scale(damping_term, damping)),
        -gamma_bar,
    )
}

fn add(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] + rhs[0], lhs[1] + rhs[1], lhs[2] + rhs[2]]
}

fn scale(vector: [f64; 3], factor: f64) -> [f64; 3] {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn norm(vector: [f64; 3]) -> f64 {
    (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt()
}

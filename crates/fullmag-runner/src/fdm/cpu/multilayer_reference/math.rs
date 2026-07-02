//! CPU reference multilayer vector and LLG math helpers.

pub(super) fn llg_rhs_from_field(
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

pub(super) fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(super) fn scale(v: [f64; 3], factor: f64) -> [f64; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

pub(super) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

pub(super) fn max_norm(values: &[[f64; 3]]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

pub(super) fn normalized(v: [f64; 3]) -> Result<[f64; 3], String> {
    let length = norm(v);
    if length <= 1e-30 {
        if v == [0.0, 0.0, 0.0] {
            return Ok(v);
        }
        return Err("magnetization vector collapsed to zero during multilayer step".to_string());
    }
    Ok([v[0] / length, v[1] / length, v[2] / length])
}

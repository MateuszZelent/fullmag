use super::*;

pub(super) fn field_energy_from_full(
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    ms: f64,
    cell_volume: f64,
) -> f64 {
    let mut sum = 0.0;
    for index in 0..magnetization.len() {
        if active_mask.is_some_and(|mask| !mask[index]) {
            continue;
        }
        sum += -0.5 * MU0 * ms * dot(magnetization[index], field[index]) * cell_volume;
    }
    sum
}

pub(super) fn max_norm_from_full(values: &[[f64; 3]], active_mask: Option<&[bool]>) -> f64 {
    values
        .iter()
        .enumerate()
        .filter(|(index, _)| active_mask.is_none_or(|mask| mask[*index]))
        .map(|(_, value)| norm(*value))
        .fold(0.0, f64::max)
}

pub(super) fn max_rhs_norm_from_full(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    damping: f64,
    gyromagnetic_ratio: f64,
    precession_enabled: bool,
) -> f64 {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .enumerate()
        .filter(|(index, _)| active_mask.is_none_or(|mask| mask[*index]))
        .map(|(_, (m, h))| {
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

pub(super) fn current_time(states: &[ExchangeLlgState]) -> f64 {
    states
        .first()
        .map(|state| state.time_seconds)
        .unwrap_or(0.0)
}

pub(super) fn current_time_single(states: &[LayerStateSingle]) -> f64 {
    states
        .first()
        .map(|state| state.time_seconds)
        .unwrap_or(0.0)
}

pub(super) fn average_damping(contexts: &[LayerContext]) -> f64 {
    if contexts.is_empty() {
        return 0.0;
    }
    contexts
        .iter()
        .map(|context| context.problem.material.damping)
        .sum::<f64>()
        / contexts.len() as f64
}

pub(super) fn flatten_layers(layers: &[Vec<[f64; 3]>]) -> Vec<[f64; 3]> {
    layers
        .iter()
        .flat_map(|layer| layer.iter().copied())
        .collect()
}

pub(super) fn flatten_layers_single(states: &[LayerStateSingle]) -> Vec<[f64; 3]> {
    states
        .iter()
        .flat_map(|state| to_f64_vectors(&state.magnetization))
        .collect()
}

pub(super) fn precision_name(value: ExecutionPrecision) -> &'static str {
    match value {
        ExecutionPrecision::Single => "single",
        ExecutionPrecision::Double => "double",
    }
}

pub(super) fn zero_outside_active(values: &mut [[f64; 3]], active_mask: Option<&[bool]>) {
    let Some(mask) = active_mask else {
        return;
    };
    for (value, active) in values.iter_mut().zip(mask.iter()) {
        if !active {
            *value = [0.0, 0.0, 0.0];
        }
    }
}

pub(super) fn zero_vectors(count: usize) -> Vec<[f64; 3]> {
    vec![[0.0, 0.0, 0.0]; count]
}

pub(super) fn zero_outside_active_f32(values: &mut [[f32; 3]], active_mask: Option<&[bool]>) {
    let Some(mask) = active_mask else {
        return;
    };
    for (value, active) in values.iter_mut().zip(mask.iter()) {
        if !active {
            *value = [0.0, 0.0, 0.0];
        }
    }
}

pub(super) fn zero_vectors_f32(count: usize) -> Vec<[f32; 3]> {
    vec![[0.0, 0.0, 0.0]; count]
}

pub(super) fn llg_rhs_for_layer(
    context: &LayerContext,
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| {
            llg_rhs_from_field(
                *m,
                *h,
                context.problem.material.damping,
                context.problem.dynamics.gyromagnetic_ratio,
                context.problem.dynamics.precession_enabled,
            )
        })
        .collect()
}

pub(super) fn llg_rhs_for_layer_f32(
    context: &LayerContext,
    magnetization: &[[f32; 3]],
    field: &[[f32; 3]],
) -> Vec<[f32; 3]> {
    let damping = context.problem.material.damping as f32;
    let gyromagnetic_ratio = context.problem.dynamics.gyromagnetic_ratio as f32;
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| {
            llg_rhs_from_field_f32(
                *m,
                *h,
                damping,
                gyromagnetic_ratio,
                context.problem.dynamics.precession_enabled,
            )
        })
        .collect()
}

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

pub(super) fn llg_rhs_from_field_f32(
    magnetization: [f32; 3],
    field: [f32; 3],
    damping: f32,
    gyromagnetic_ratio: f32,
    precession_enabled: bool,
) -> [f32; 3] {
    let gamma_bar = gyromagnetic_ratio / (1.0 + damping * damping);
    let precession = cross_f32(magnetization, field);
    let damping_term = cross_f32(magnetization, precession);
    let precession_term = if precession_enabled {
        precession
    } else {
        [0.0, 0.0, 0.0]
    };
    scale_f32(
        add_f32(precession_term, scale_f32(damping_term, damping)),
        -gamma_bar,
    )
}

pub(super) fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(super) fn add_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(super) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(super) fn sub_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(super) fn scale(v: [f64; 3], factor: f64) -> [f64; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

pub(super) fn scale_f32(v: [f32; 3], factor: f32) -> [f32; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

pub(super) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn cross_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn dot_f32(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

pub(super) fn norm_f32(v: [f32; 3]) -> f32 {
    dot_f32(v, v).sqrt()
}

pub(super) fn max_norm(values: &[[f64; 3]]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

pub(super) fn max_norm_f32(values: &[[f32; 3]]) -> f64 {
    values
        .iter()
        .map(|value| norm_f32(*value) as f64)
        .fold(0.0, f64::max)
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

pub(super) fn normalized_f32(v: [f32; 3]) -> Result<[f32; 3], String> {
    let length = norm_f32(v);
    if length <= 1e-20 {
        if v == [0.0, 0.0, 0.0] {
            return Ok(v);
        }
        return Err("magnetization vector collapsed to zero during multilayer step".to_string());
    }
    Ok([v[0] / length, v[1] / length, v[2] / length])
}

pub(super) fn to_f32_vectors(values: &[[f64; 3]]) -> Vec<[f32; 3]> {
    values
        .iter()
        .map(|value| [value[0] as f32, value[1] as f32, value[2] as f32])
        .collect()
}

pub(super) fn to_f64_vectors(values: &[[f32; 3]]) -> Vec<[f64; 3]> {
    values
        .iter()
        .map(|value| [value[0] as f64, value[1] as f64, value[2] as f64])
        .collect()
}

pub(super) fn observe_context_f32(
    context: &LayerContext,
    magnetization: &[[f32; 3]],
) -> Result<EffectiveFieldObservables, RunError> {
    let state = context
        .problem
        .new_state(to_f64_vectors(magnetization))
        .map_err(|error| RunError {
            message: format!(
                "temporary single-precision observables state for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
    context.problem.observe(&state).map_err(|error| RunError {
        message: format!(
            "single-precision local observables for magnet '{}': {}",
            context.magnet_name, error
        ),
    })
}

pub(super) fn field_energy_from_vectors_f32(
    magnetization: &[[f32; 3]],
    field: &[[f32; 3]],
    prefactor: f64,
) -> f64 {
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| prefactor * dot_f32(*m, *h) as f64)
        .sum()
}

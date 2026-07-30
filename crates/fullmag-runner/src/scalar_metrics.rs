use crate::schedules::{is_due, OutputSchedule};
use crate::types::StepStats;
use std::collections::HashMap;

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
const ENERGY_KEYS: [&str; 6] = ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"];

pub(crate) fn average_magnetization_components(values: &[[f64; 3]]) -> [f64; 3] {
    let mut sum = [0.0; 3];
    let mut count = 0usize;

    for value in values {
        if value[0].abs() <= 1e-18 && value[1].abs() <= 1e-18 && value[2].abs() <= 1e-18 {
            continue;
        }
        sum[0] += value[0];
        sum[1] += value[1];
        sum[2] += value[2];
        count += 1;
    }

    if count == 0 {
        return [0.0, 0.0, 0.0];
    }

    let inv = 1.0 / count as f64;
    [sum[0] * inv, sum[1] * inv, sum[2] * inv]
}

pub(crate) fn weighted_average_magnetization_components(
    values: &[[f64; 3]],
    weights: &[f64],
) -> [f64; 3] {
    let mut sum = [0.0; 3];
    let mut weight_sum = 0.0;

    for (value, weight) in values.iter().zip(weights.iter().copied()) {
        if !weight.is_finite()
            || weight <= 0.0
            || value.iter().any(|component| !component.is_finite())
        {
            continue;
        }
        sum[0] += weight * value[0];
        sum[1] += weight * value[1];
        sum[2] += weight * value[2];
        weight_sum += weight;
    }

    if weight_sum <= 0.0 {
        return [0.0, 0.0, 0.0];
    }

    let inverse_weight = 1.0 / weight_sum;
    [
        sum[0] * inverse_weight,
        sum[1] * inverse_weight,
        sum[2] * inverse_weight,
    ]
}

pub(crate) fn apply_average_m_to_step_stats(stats: &mut StepStats, magnetization: &[[f64; 3]]) {
    let [mx, my, mz] = average_magnetization_components(magnetization);
    stats.mx = mx;
    stats.my = my;
    stats.mz = mz;
}

pub(crate) fn apply_weighted_average_m_to_step_stats(
    stats: &mut StepStats,
    magnetization: &[[f64; 3]],
    weights: &[f64],
) {
    let [mx, my, mz] = if weights
        .iter()
        .take(magnetization.len())
        .any(|weight| weight.is_finite() && *weight > 0.0)
    {
        weighted_average_magnetization_components(magnetization, weights)
    } else {
        average_magnetization_components(magnetization)
    };
    stats.mx = mx;
    stats.my = my;
    stats.mz = mz;
}

pub(crate) fn scalar_snapshot_from_step(stats: &StepStats) -> HashMap<String, f64> {
    let mut scalars = HashMap::new();
    scalars.insert("e_ex".to_string(), stats.e_ex);
    scalars.insert("e_demag".to_string(), stats.e_demag);
    scalars.insert("e_ext".to_string(), stats.e_ext);
    scalars.insert("e_ani".to_string(), stats.e_ani);
    scalars.insert("e_dmi".to_string(), stats.e_dmi);
    scalars.insert("e_total".to_string(), stats.e_total);
    scalars.insert("mx".to_string(), stats.mx);
    scalars.insert("my".to_string(), stats.my);
    scalars.insert("mz".to_string(), stats.mz);
    scalars.insert("max_dm_dt".to_string(), stats.max_dm_dt);
    scalars.insert("max_h_eff".to_string(), stats.max_h_eff);
    scalars.insert("max_h_demag".to_string(), stats.max_h_demag);
    scalars.insert("max_torque_Apm".to_string(), stats.max_torque_Apm);
    scalars.insert("max_torque_T".to_string(), stats.max_torque_T);
    if let Some(pseudo_time_s) = stats.pseudo_time_s {
        scalars.insert("pseudo_time_s".to_string(), pseudo_time_s);
    }
    scalars
}

pub(crate) fn single_object_scalars(
    object_id: &str,
    stats: &StepStats,
) -> HashMap<String, HashMap<String, f64>> {
    let mut out = HashMap::new();
    out.insert(object_id.to_string(), scalar_snapshot_from_step(stats));
    out
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) fn weighted_object_scalars(
    stats: &StepStats,
    weights: &[(String, f64)],
) -> HashMap<String, HashMap<String, f64>> {
    let normalized = normalized_weights(weights);
    if normalized.is_empty() {
        return HashMap::new();
    }

    let global = scalar_snapshot_from_step(stats);
    let mut out: HashMap<String, HashMap<String, f64>> = HashMap::new();

    for (name, frac) in &normalized {
        let mut values = global.clone();
        for key in ENERGY_KEYS {
            if let Some(value) = values.get_mut(key) {
                *value *= *frac;
            }
        }
        out.insert(name.clone(), values);
    }

    // Enforce Σ(per-object term) ~= global term for energy terms.
    let Some((first_name, _)) = normalized.first() else {
        return out;
    };
    for key in ENERGY_KEYS {
        let target = global.get(key).copied().unwrap_or(0.0);
        let current_sum = out
            .values()
            .map(|values| values.get(key).copied().unwrap_or(0.0))
            .sum::<f64>();
        let correction = target - current_sum;
        if correction.abs() > 0.0 {
            if let Some(first_values) = out.get_mut(first_name) {
                let entry = first_values.entry(key.to_string()).or_insert(0.0);
                *entry += correction;
            }
        }
    }

    out
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) fn set_object_average_m(
    per_object: &mut HashMap<String, HashMap<String, f64>>,
    object_id: &str,
    magnetization: &[[f64; 3]],
    start: usize,
    count: usize,
) {
    if count == 0 || start >= magnetization.len() {
        return;
    }
    let end = start.saturating_add(count).min(magnetization.len());
    if end <= start {
        return;
    }
    let [mx, my, mz] = average_magnetization_components(&magnetization[start..end]);
    let entry = per_object.entry(object_id.to_string()).or_default();
    entry.insert("mx".to_string(), mx);
    entry.insert("my".to_string(), my);
    entry.insert("mz".to_string(), mz);
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
fn normalized_weights(weights: &[(String, f64)]) -> Vec<(String, f64)> {
    let mut filtered = Vec::new();
    for (name, weight) in weights {
        if !name.is_empty() && weight.is_finite() && *weight > 0.0 {
            filtered.push((name.clone(), *weight));
        }
    }
    let sum = filtered.iter().map(|(_, weight)| *weight).sum::<f64>();
    if sum <= 0.0 {
        return Vec::new();
    }
    filtered
        .into_iter()
        .map(|(name, weight)| (name, weight / sum))
        .collect()
}

pub(crate) fn scalar_row_due(schedules: &[OutputSchedule], current_time: f64) -> bool {
    schedules
        .iter()
        .any(|schedule| is_due(current_time, schedule.next_time))
}

pub(crate) fn scalar_outputs_request_average_m(schedules: &[OutputSchedule]) -> bool {
    schedules
        .iter()
        .any(|schedule| matches!(schedule.name.as_str(), "mx" | "my" | "mz"))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_weighted_average_m_to_step_stats, weighted_average_magnetization_components,
    };
    use crate::types::StepStats;

    #[test]
    fn weighted_average_magnetization_uses_fem_volume_weights() {
        let values = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let weights = [1.0, 2.0, 7.0];

        let actual = weighted_average_magnetization_components(&values, &weights);
        for (actual, expected) in actual.into_iter().zip([0.1, 0.2, 0.7]) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }

    #[test]
    fn weighted_average_magnetization_keeps_zero_magnetization_with_positive_weight() {
        let values = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let weights = [3.0, 1.0];

        assert_eq!(
            weighted_average_magnetization_components(&values, &weights),
            [0.25, 0.0, 0.0]
        );
    }

    #[test]
    fn weighted_step_stats_fall_back_to_uniform_average_without_mesh_volumes() {
        let mut stats = StepStats::default();
        apply_weighted_average_m_to_step_stats(
            &mut stats,
            &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            &[],
        );

        assert_eq!([stats.mx, stats.my, stats.mz], [0.5, 0.5, 0.0]);
    }
}

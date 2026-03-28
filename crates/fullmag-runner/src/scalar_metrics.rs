use crate::schedules::{is_due, OutputSchedule};
use crate::types::StepStats;

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

pub(crate) fn apply_average_m_to_step_stats(stats: &mut StepStats, magnetization: &[[f64; 3]]) {
    let [mx, my, mz] = average_magnetization_components(magnetization);
    stats.mx = mx;
    stats.my = my;
    stats.mz = mz;
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

use std::f64::consts::PI;

use fullmag_ir::TimeDependenceIR;

pub(crate) fn evaluate_time_dependence(waveform: &TimeDependenceIR, t: f64) -> f64 {
    match waveform {
        TimeDependenceIR::Constant => 1.0,
        TimeDependenceIR::Sinusoidal {
            frequency_hz,
            phase_rad,
            offset,
        } => (2.0 * PI * frequency_hz * t + phase_rad).sin() + offset,
        TimeDependenceIR::Pulse { t_on, t_off } => {
            if t >= *t_on && t < *t_off {
                1.0
            } else {
                0.0
            }
        }
        TimeDependenceIR::PiecewiseLinear { points } => evaluate_piecewise_linear(points, t),
        TimeDependenceIR::SincPulse {
            cutoff_hz,
            t0,
            amplitude,
        } => amplitude * normalized_sinc(2.0 * cutoff_hz * (t - t0)),
    }
}

pub(crate) fn evaluate_optional_time_dependence(
    waveform: Option<&TimeDependenceIR>,
    t: f64,
) -> f64 {
    waveform.map_or(1.0, |waveform| evaluate_time_dependence(waveform, t))
}

fn normalized_sinc(value: f64) -> f64 {
    let x = PI * value;
    if x.abs() <= 1e-4 {
        let x2 = x * x;
        1.0 - x2 / 6.0 + x2 * x2 / 120.0
    } else {
        x.sin() / x
    }
}

fn evaluate_piecewise_linear(points: &[[f64; 2]], t: f64) -> f64 {
    let Some(first) = points.first() else {
        return 0.0;
    };
    if t <= first[0] {
        return first[1];
    }
    let last = points.last().expect("non-empty points");
    if t >= last[0] {
        return last[1];
    }
    let upper = points.partition_point(|point| point[0] < t);
    let [t0, v0] = points[upper - 1];
    let [t1, v1] = points[upper];
    v0 + (t - t0) / (t1 - t0) * (v1 - v0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::TimeDependenceIR;

    #[test]
    fn sinc_is_stable_at_center_and_known_zeros() {
        let waveform = TimeDependenceIR::SincPulse {
            cutoff_hz: 10.0,
            t0: 2.0,
            amplitude: 3.0,
        };
        assert_eq!(evaluate_time_dependence(&waveform, 2.0), 3.0);
        assert!(evaluate_time_dependence(&waveform, 2.05).abs() < 1e-12);
    }

    #[test]
    fn pulse_is_left_closed_and_right_open() {
        let waveform = TimeDependenceIR::Pulse {
            t_on: 1.0,
            t_off: 2.0,
        };
        assert_eq!(evaluate_time_dependence(&waveform, 1.0), 1.0);
        assert_eq!(evaluate_time_dependence(&waveform, 2.0), 0.0);
    }

    #[test]
    fn piecewise_linear_clamps_outside_and_interpolates_inside() {
        let waveform = TimeDependenceIR::PiecewiseLinear {
            points: vec![[1.0, 2.0], [3.0, 6.0]],
        };
        assert_eq!(evaluate_time_dependence(&waveform, 0.0), 2.0);
        assert_eq!(evaluate_time_dependence(&waveform, 2.0), 4.0);
        assert_eq!(evaluate_time_dependence(&waveform, 4.0), 6.0);
    }
}

use std::f64::consts::PI;

use fullmag_ir::TimeEnvelopeIR;

/// Evaluate the canonical dimensionless source multiplier at an exact stage
/// time.  Artifact-backed tabulated envelopes deliberately fail closed until
/// the runtime artifact resolver is available; no implicit interpolation or
/// zero fallback is allowed.
pub(crate) fn evaluate_time_envelope(
    envelope: &TimeEnvelopeIR,
    time_s: f64,
) -> Result<f64, String> {
    if !time_s.is_finite() {
        return Err("time envelope evaluation time is non-finite".into());
    }
    let value = match envelope {
        TimeEnvelopeIR::Constant { value } => *value,
        TimeEnvelopeIR::Sinusoidal {
            amplitude,
            frequency_hz,
            phase_rad,
            offset,
        } => offset + amplitude * (2.0 * PI * frequency_hz * time_s + phase_rad).sin(),
        TimeEnvelopeIR::Pulse {
            amplitude,
            t_on_s,
            t_off_s,
        } => {
            if time_s >= *t_on_s && time_s < *t_off_s {
                *amplitude
            } else {
                0.0
            }
        }
        TimeEnvelopeIR::PiecewiseLinear { points } => {
            let Some(first) = points.first() else {
                return Ok(0.0);
            };
            if time_s <= first.time_s {
                first.value
            } else {
                let last = points.last().expect("non-empty points");
                if time_s >= last.time_s {
                    last.value
                } else {
                    let upper = points
                        .partition_point(|point| point.time_s <= time_s)
                        .min(points.len() - 1);
                    let lower = upper - 1;
                    let fraction = (time_s - points[lower].time_s)
                        / (points[upper].time_s - points[lower].time_s);
                    points[lower].value + fraction * (points[upper].value - points[lower].value)
                }
            }
        }
        TimeEnvelopeIR::Sinc {
            amplitude,
            center_s,
            bandwidth_hz,
            offset,
        } => {
            let x = bandwidth_hz * (time_s - center_s);
            let sinc = if x.abs() <= 1.0e-12 {
                1.0
            } else {
                let pi_x = PI * x;
                pi_x.sin() / pi_x
            };
            offset + amplitude * sinc
        }
        TimeEnvelopeIR::Tabulated { artifact_ref, .. } => {
            return Err(format!(
                "tabulated time envelope requires materialized artifact '{artifact_ref}'"
            ));
        }
    };
    if value.is_finite() {
        Ok(value)
    } else {
        Err("time envelope evaluated to a non-finite value".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::TimeEnvelopePointIR;

    #[test]
    fn evaluates_all_runtime_variants() {
        assert_eq!(
            evaluate_time_envelope(&TimeEnvelopeIR::Constant { value: 2.0 }, 1.0),
            Ok(2.0)
        );
        let sinusoidal = TimeEnvelopeIR::Sinusoidal {
            amplitude: 0.5,
            frequency_hz: 1.0,
            phase_rad: 0.0,
            offset: 1.0,
        };
        assert!((evaluate_time_envelope(&sinusoidal, 0.25).unwrap() - 1.5).abs() < 1.0e-12);
        let pulse = TimeEnvelopeIR::Pulse {
            amplitude: 3.0,
            t_on_s: 1.0,
            t_off_s: 2.0,
        };
        assert_eq!(evaluate_time_envelope(&pulse, 1.0), Ok(3.0));
        assert_eq!(evaluate_time_envelope(&pulse, 2.0), Ok(0.0));
        let piecewise = TimeEnvelopeIR::PiecewiseLinear {
            points: vec![
                TimeEnvelopePointIR {
                    time_s: 0.0,
                    value: 1.0,
                },
                TimeEnvelopePointIR {
                    time_s: 2.0,
                    value: 3.0,
                },
            ],
        };
        assert_eq!(evaluate_time_envelope(&piecewise, 1.0), Ok(2.0));
        let sinc = TimeEnvelopeIR::Sinc {
            amplitude: 2.0,
            center_s: 0.0,
            bandwidth_hz: 1.0,
            offset: 0.5,
        };
        assert_eq!(evaluate_time_envelope(&sinc, 0.0), Ok(2.5));
    }

    #[test]
    fn tabulated_requires_artifact_resolution() {
        let error = evaluate_time_envelope(
            &TimeEnvelopeIR::Tabulated {
                artifact_ref: "artifact://current".into(),
                interpolation: Default::default(),
                extrapolation: Default::default(),
                bandwidth_hz: None,
            },
            0.0,
        )
        .expect_err("tabulated envelope must fail closed");
        assert!(error.contains("artifact://current"));
    }
}

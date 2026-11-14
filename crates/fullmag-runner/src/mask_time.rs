//! Host checks of mask-term time programs on every lane (ADR 0081, physics
//! note 0922 sections 8.2 and 8.3).

use fullmag_ir::{FieldTimeOriginIR, ResolvedMaskFieldTermBasisIR, TimeStageContextIR};

use crate::types::RunError;

/// Uniform samples of each time program over the stage horizon.
pub(crate) const MASK_TIME_HORIZON_SAMPLES: usize = 4097;

/// Argument of a mask term's time function `elapsed_s` after the stage start:
/// the stage-local clock restarts at the waveform origin of the stage, the
/// absolute clock is the simulation time (as `canonical_fdm_waveform_time`).
pub(crate) fn mask_term_local_time(
    time_stage: &TimeStageContextIR,
    origin: FieldTimeOriginIR,
    elapsed_s: f64,
) -> f64 {
    match origin {
        FieldTimeOriginIR::StageLocal => {
            elapsed_s + (time_stage.start_time_s - time_stage.waveform_origin_time_s())
        }
        FieldTimeOriginIR::Absolute => time_stage.start_time_s + elapsed_s,
    }
}

/// Every mask term's time program is finite on `[0, duration_s]` of the stage
/// (4097 uniform samples; a constant program or an unbounded duration is
/// checked at the stage start only). Lanes that evaluate the programs per field
/// build also check each value; this catches the common case before stepping.
pub(crate) fn check_mask_time_programs(
    bases: &[ResolvedMaskFieldTermBasisIR],
    time_stage: &TimeStageContextIR,
    duration_s: f64,
) -> Result<(), RunError> {
    for basis in bases {
        let samples = if basis.time_dependent && duration_s.is_finite() && duration_s > 0.0 {
            MASK_TIME_HORIZON_SAMPLES
        } else {
            1
        };
        for sample in 0..samples {
            let elapsed_s = if samples == 1 {
                0.0
            } else {
                duration_s * sample as f64 / (samples - 1) as f64
            };
            let local_time_s = mask_term_local_time(time_stage, basis.time_origin, elapsed_s);
            let value = fullmag_expr::eval_time_program(&basis.time_program, local_time_s);
            if !value.is_finite() {
                return Err(RunError {
                    message: format!(
                        "mask_expression_non_finite: mask drive '{}' term {} gives {value} at {elapsed_s:e} s into the stage (time function argument {local_time_s:e} s)",
                        basis.drive_id, basis.term_index
                    ),
                });
            }
        }
    }
    Ok(())
}

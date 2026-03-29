//! Output scheduling: decides when scalar/field outputs are due.

use fullmag_ir::OutputIR;

use crate::types::RunError;

pub(crate) const OUTPUT_TIME_TOLERANCE: f64 = 1e-18;

#[derive(Debug, Clone)]
pub(crate) struct OutputSchedule {
    pub name: String,
    pub every_seconds: f64,
    pub next_time: f64,
    pub last_sampled_time: Option<f64>,
}

pub(crate) fn collect_scalar_schedules(
    outputs: &[OutputIR],
) -> Result<Vec<OutputSchedule>, RunError> {
    let mut schedules = Vec::new();
    for output in outputs {
        if let OutputIR::Scalar {
            name,
            every_seconds,
        } = output
        {
            if !matches!(
                name.as_str(),
                "E_ex"
                    | "E_demag"
                    | "E_ext"
                    | "E_total"
                    | "time"
                    | "step"
                    | "solver_dt"
                    | "mx"
                    | "my"
                    | "mz"
                    | "max_dm_dt"
                    | "max_h_eff"
            ) {
                return Err(RunError {
                    message: format!("scalar output '{}' is not executable in Phase 1", name),
                });
            }
            schedules.push(OutputSchedule {
                name: name.clone(),
                every_seconds: *every_seconds,
                next_time: 0.0,
                last_sampled_time: None,
            });
        }
    }
    Ok(schedules)
}

pub(crate) fn collect_field_schedules(
    outputs: &[OutputIR],
) -> Result<Vec<OutputSchedule>, RunError> {
    let mut schedules = Vec::new();
    for output in outputs {
        match output {
            OutputIR::Field {
                name,
                every_seconds,
            } => {
                if !matches!(name.as_str(), "m" | "H_ex" | "H_demag" | "H_ext" | "H_eff") {
                    return Err(RunError {
                        message: format!("field output '{}' is not executable in Phase 1", name),
                    });
                }
                schedules.push(OutputSchedule {
                    name: name.clone(),
                    every_seconds: *every_seconds,
                    next_time: 0.0,
                    last_sampled_time: None,
                });
            }
            OutputIR::Snapshot {
                field,
                component,
                every_seconds,
                ..
            } => {
                if !matches!(field.as_str(), "m" | "H_ex" | "H_demag" | "H_ext" | "H_eff") {
                    return Err(RunError {
                        message: format!("snapshot field '{}' is not executable in Phase 1", field),
                    });
                }
                // For component-specific snapshots, qualify the name (e.g. "m.z").
                // For "3D", use the raw field name — identical to SaveField behaviour.
                let schedule_name = if component == "3D" {
                    field.clone()
                } else {
                    format!("{}.{}", field, component)
                };
                schedules.push(OutputSchedule {
                    name: schedule_name,
                    every_seconds: *every_seconds,
                    next_time: 0.0,
                    last_sampled_time: None,
                });
            }
            _ => {} // Scalar — handled by collect_scalar_schedules
        }
    }
    Ok(schedules)
}

pub(crate) fn is_due(current_time: f64, next_time: f64) -> bool {
    current_time + OUTPUT_TIME_TOLERANCE >= next_time
}

pub(crate) fn same_time(lhs: f64, rhs: f64) -> bool {
    (lhs - rhs).abs() <= OUTPUT_TIME_TOLERANCE
}

pub(crate) fn advance_due_schedules(schedules: &mut [OutputSchedule], current_time: f64) {
    for schedule in schedules {
        let mut advanced = false;
        while is_due(current_time, schedule.next_time) {
            schedule.next_time += schedule.every_seconds;
            advanced = true;
        }
        if advanced {
            schedule.last_sampled_time = Some(current_time);
        }
    }
}

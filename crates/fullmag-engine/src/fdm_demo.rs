//! Reference demo for exchange-only LLG simulation.

use crate::{
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters,
    Result, StepReport, Vector3,
};
use crate::EngineError;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReferenceDemoReport {
    pub steps: usize,
    pub dt: f64,
    pub initial_exchange_energy_joules: f64,
    pub final_exchange_energy_joules: f64,
    pub final_time_seconds: f64,
    pub final_center_magnetization: Vector3,
    pub max_effective_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
}

#[allow(deprecated)]
pub fn run_reference_exchange_demo(steps: usize, dt: f64) -> Result<ReferenceDemoReport> {
    if dt <= 0.0 {
        return Err(EngineError::new("dt must be positive"));
    }
    let grid = GridShape::new(3, 1, 1)?;
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(2e-9, 2e-9, 2e-9)?,
        MaterialParameters::new(800e3, 13e-12, 0.2)?,
        LlgConfig::default(),
        EffectiveFieldTerms {
            exchange: true,
            demag: false,
            external_field: None,
            per_node_field: None,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem.new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])?;
    let initial_exchange_energy_joules = problem.exchange_energy(&state)?;
    let mut last_report = StepReport {
        time_seconds: 0.0,
        dt_used: dt,
        step_rejected: false,
        suggested_next_dt: None,
        exchange_energy_joules: initial_exchange_energy_joules,
        demag_energy_joules: 0.0,
        external_energy_joules: 0.0,
        total_energy_joules: initial_exchange_energy_joules,
        max_effective_field_amplitude: 0.0,
        max_demag_field_amplitude: 0.0,
        max_rhs_amplitude: 0.0,
        max_torque_Apm: 0.0,
    };

    for _ in 0..steps {
        last_report = problem.step(&mut state, dt)?;
    }

    Ok(ReferenceDemoReport {
        steps,
        dt,
        initial_exchange_energy_joules,
        final_exchange_energy_joules: last_report.exchange_energy_joules,
        final_time_seconds: last_report.time_seconds,
        final_center_magnetization: state.magnetization()[grid.index(1, 0, 0)],
        max_effective_field_amplitude: last_report.max_effective_field_amplitude,
        max_rhs_amplitude: last_report.max_rhs_amplitude,
    })
}

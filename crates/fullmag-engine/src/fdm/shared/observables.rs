//! Shared FDM observables and step-report contracts.

use crate::Vector3;

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(non_snake_case)]
pub struct StepReport {
    pub time_seconds: f64,
    pub dt_used: f64,
    pub step_rejected: bool,
    pub suggested_next_dt: Option<f64>,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    /// Maximum total dynamic RHS norm in 1/s, including direct torques.
    pub max_rhs_amplitude: f64,
    /// Exact field-equilibrium residual max |m x H_eff| in A/m.
    pub max_torque_Apm: f64,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(non_snake_case)]
pub struct EffectiveFieldObservables {
    pub magnetization: Vec<Vector3>,
    pub exchange_field: Vec<Vector3>,
    pub demag_field: Vec<Vector3>,
    pub external_field: Vec<Vector3>,
    pub effective_field: Vec<Vector3>,
    pub dmi_field: Vec<Vector3>,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    /// Maximum total dynamic RHS norm in 1/s, including direct torques.
    pub max_rhs_amplitude: f64,
    /// Exact field-equilibrium residual max |m x H_eff| in A/m.
    pub max_torque_Apm: f64,
}

/// Lightweight observables from a single RHS evaluation.
#[derive(Debug, Clone, PartialEq)]
#[allow(non_snake_case)]
pub struct RhsEvaluation {
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    /// Maximum total dynamic RHS norm in 1/s, including direct torques.
    pub max_rhs_amplitude: f64,
    /// Exact field-equilibrium residual max |m x H_eff| in A/m.
    pub max_torque_Apm: f64,
}

#[cfg(test)]
mod tests {
    use super::RhsEvaluation;

    #[test]
    fn exact_zero_torque_remains_distinct_from_nonzero_rhs_norm() {
        let report = RhsEvaluation {
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 13.0,
            max_torque_Apm: 0.0,
        }
        .into_step_report(1.0, 0.1, false);

        assert_eq!(report.max_torque_Apm, 0.0);
        assert_eq!(report.max_rhs_amplitude, 13.0);
    }
}

impl RhsEvaluation {
    /// Convert to a `StepReport`.
    pub fn into_step_report(
        self,
        time_seconds: f64,
        dt_used: f64,
        step_rejected: bool,
    ) -> StepReport {
        StepReport {
            time_seconds,
            dt_used,
            step_rejected,
            suggested_next_dt: None,
            exchange_energy_joules: self.exchange_energy_joules,
            demag_energy_joules: self.demag_energy_joules,
            external_energy_joules: self.external_energy_joules,
            anisotropy_energy_joules: self.anisotropy_energy_joules,
            dmi_energy_joules: self.dmi_energy_joules,
            total_energy_joules: self.total_energy_joules,
            max_effective_field_amplitude: self.max_effective_field_amplitude,
            max_demag_field_amplitude: self.max_demag_field_amplitude,
            max_rhs_amplitude: self.max_rhs_amplitude,
            max_torque_Apm: self.max_torque_Apm,
        }
    }
}

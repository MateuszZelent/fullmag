//! Separated step data: solver diagnostics vs physical scalar observations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Solver-internal telemetry for one integration step.
///
/// This is _not_ physics — it is implementation and performance metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StepDiagnostics {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub wall_time_ns: u64,
    pub exchange_wall_time_ns: u64,
    #[serde(default)]
    pub demag_wall_time_ns: u64,
    #[serde(default)]
    pub demag_assemble_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solve_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solver_setup_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solver_apply_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solver_setup_reused: bool,
    #[serde(default)]
    pub demag_recover_wall_time_ns: u64,
    #[serde(default)]
    pub demag_energy_wall_time_ns: u64,
    #[serde(default)]
    pub rhs_wall_time_ns: u64,
    #[serde(default)]
    pub extra_energy_wall_time_ns: u64,
    #[serde(default)]
    pub snapshot_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_preconditioner_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_state_copy_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_state_upload_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_retraction_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_gradient_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_metric_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_line_search_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_update_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_preconditioner_cache_hits: u32,
    #[serde(default)]
    pub relaxation_preconditioner_cache_misses: u32,
    #[serde(default)]
    pub finalization_wall_time_ns: u64,
    #[serde(default)]
    pub finalization_field_copy_wall_time_ns: u64,
    #[serde(default)]
    pub finalization_field_copy_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_estimate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default)]
    pub rhs_evals: u32,
    #[serde(default)]
    pub demag_solves: u32,
    #[serde(default)]
    pub fsal_reused: bool,
    /// Number of PCG iterations in the last Poisson demag solve.
    #[serde(default)]
    pub poisson_iterations: u32,
    /// Final residual norm of the last Poisson demag solve.
    #[serde(default)]
    pub poisson_final_residual: f64,
    /// Whether demag field was freshly solved (true) or frozen (false) this step.
    #[serde(default)]
    pub demag_refreshed: bool,
}

/// Per-step physical scalar observations.
///
/// Each entry corresponds to a `GlobalScalar` quantity from the catalog.
/// The field names match the `scalar_metric_key` values in `QuantitySpec`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(non_snake_case)]
pub struct GlobalQuantityRow {
    pub step: u64,
    pub time: f64,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    #[serde(default)]
    pub e_drive: f64,
    pub e_ani: f64,
    pub e_dmi: f64,
    pub e_el: f64,
    pub e_kin_el: f64,
    pub e_total: f64,
    pub elastic_residual_norm: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    #[serde(default)]
    pub max_torque_Apm: f64,
    #[serde(default)]
    pub max_torque_T: f64,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

impl GlobalQuantityRow {
    /// Look up a scalar value by its `scalar_metric_key`.
    pub fn scalar_value(&self, metric_key: &str) -> Option<f64> {
        match metric_key {
            "e_ex" => Some(self.e_ex),
            "e_demag" => Some(self.e_demag),
            "e_ext" => Some(self.e_ext),
            "e_drive" => Some(self.e_drive),
            "e_ani" => Some(self.e_ani),
            "e_dmi" => Some(self.e_dmi),
            "e_el" => Some(self.e_el),
            "e_kin_el" => Some(self.e_kin_el),
            "e_total" => Some(self.e_total),
            "elastic_residual_norm" => Some(self.elastic_residual_norm),
            "mx" => Some(self.mx),
            "my" => Some(self.my),
            "mz" => Some(self.mz),
            "max_dm_dt" => Some(self.max_dm_dt),
            "max_h_eff" => Some(self.max_h_eff),
            "max_h_demag" => Some(self.max_h_demag),
            "max_torque_Apm" => Some(self.max_torque_Apm),
            "max_torque_T" => Some(self.max_torque_T),
            _ => None,
        }
    }
}

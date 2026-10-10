//! Separated step data: solver diagnostics vs physical scalar observations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Semantic classification for a step record.
///
/// Rust-created rows default to physical observations for compatibility with
/// current producers. Deserialization of records that predate this field uses
/// `legacy_unclassified` instead, so stored numeric placeholders are not
/// silently qualified as measurements.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepDataKind {
    #[default]
    PhysicalObservation,
    SolverProgress,
    LegacyUnclassified,
}

impl StepDataKind {
    pub const fn is_physical_observation(self) -> bool {
        matches!(self, Self::PhysicalObservation)
    }

    pub const fn is_solver_progress(self) -> bool {
        matches!(self, Self::SolverProgress)
    }

    /// Serde fallback for records written before a semantic kind was present.
    pub const fn legacy_unclassified() -> Self {
        Self::LegacyUnclassified
    }

    /// Validate that the optional progress channel agrees with this record kind.
    pub fn validate_solver_progress(
        self,
        solver_progress: Option<&SolverProgress>,
    ) -> Result<(), &'static str> {
        match (self, solver_progress) {
            (Self::PhysicalObservation, None) | (Self::LegacyUnclassified, None) => Ok(()),
            (Self::SolverProgress, Some(_)) => Ok(()),
            (Self::PhysicalObservation, Some(_)) => {
                Err("physical observations cannot carry solver progress")
            }
            (Self::SolverProgress, None) => {
                Err("solver progress records require a typed progress payload")
            }
            (Self::LegacyUnclassified, Some(_)) => {
                Err("legacy unclassified records cannot carry typed solver progress")
            }
        }
    }
}

/// Typed solver progress channel. Its metrics are diagnostics and are not
/// physical scalar observations or per-object scene data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SolverProgress {
    FemEigen { metrics: HashMap<String, f64> },
}

/// Public CPU explicit-RK accepted-endpoint cache decision and cost receipt.
///
/// The receipt is optional because non-RK steps and device-resident lanes do
/// not publish the CPU endpoint-cache realization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EndpointCacheTelemetry {
    pub final_refresh_reason: String,
    pub cache_state_valid: bool,
    pub cache_time_valid: bool,
    pub cache_dynamic_sources_valid: bool,
    pub cache_transport_valid: bool,
    pub cache_projection_valid: bool,
    pub final_rhs_evaluations: u64,
    pub extra_poisson_solves: u64,
    pub endpoint_cache_hits: u64,
    pub endpoint_refreshes: u64,
    pub accepted_step_wall_time_ns: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemStateRepresentation {
    LocalNodeAos,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMaterialFieldLocation {
    Scalar,
    NodalP1,
    ElementDg0,
}

/// Executed native FEM state/material representation and cumulative conversion
/// traffic for one backend handle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemRepresentationReceipt {
    pub schema_version: u32,
    pub state_space: FemStateRepresentation,
    pub ms_location: FemMaterialFieldLocation,
    pub a_location: FemMaterialFieldLocation,
    pub local_node_count: u64,
    pub true_node_count: u64,
    pub periodic_map_revision: u64,
    pub representation_copy_count: u64,
    pub gather_scatter_bytes: u64,
    pub invalid_space_assertion_count: u64,
    pub hot_loop_representation_copy_count: u64,
    pub hot_loop_gather_scatter_bytes: u64,
}

/// Solver-internal telemetry for one integration step.
///
/// This is _not_ physics — it is implementation and performance metadata.
#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StepDiagnostics {
    /// Semantic record kind. Missing values in historical JSON are unclassified.
    #[serde(default = "StepDataKind::legacy_unclassified")]
    pub kind: StepDataKind,
    /// Solver-specific progress payload, present only for solver progress records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver_progress: Option<SolverProgress>,
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub wall_time_ns: u64,
    #[serde(default)]
    pub backend_create_wall_time_ns: u64,
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
    pub max_error: Option<f64>,
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
    #[serde(default)]
    pub max_torque_all_Apm: f64,
    #[serde(default)]
    pub frozen_reference_max_drift: f64,
    #[serde(default)]
    pub active_dof_count: u64,
    #[serde(default)]
    pub frozen_dof_count: u64,
    #[serde(default)]
    pub free_dof_count: u64,
    /// Optional native CPU RK accepted-endpoint cache receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_cache_telemetry: Option<EndpointCacheTelemetry>,
    /// Optional native FEM representation receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_representation_receipt: Option<FemRepresentationReceipt>,
}

impl StepDiagnostics {
    /// Validate the relationship between this record's kind and progress payload.
    pub fn validate_record_kind(&self) -> Result<(), &'static str> {
        self.kind
            .validate_solver_progress(self.solver_progress.as_ref())
    }
}

/// Per-step physical scalar observations.
///
/// Each entry corresponds to a `GlobalScalar` quantity from the catalog.
/// The field names match the `scalar_metric_key` values in `QuantitySpec`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(non_snake_case)]
pub struct GlobalQuantityRow {
    /// Semantic record kind. Missing values in historical JSON are unclassified.
    #[serde(default = "StepDataKind::legacy_unclassified")]
    pub kind: StepDataKind,
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
    #[serde(default, alias = "E_rotated_dmi")]
    pub e_rotated_dmi: f64,
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
        if !self.kind.is_physical_observation() {
            return None;
        }
        match metric_key {
            "e_ex" => Some(self.e_ex),
            "e_demag" => Some(self.e_demag),
            "e_ext" => Some(self.e_ext),
            "e_drive" => Some(self.e_drive),
            "e_ani" => Some(self.e_ani),
            "e_dmi" => Some(self.e_dmi),
            "e_rotated_dmi" => Some(self.e_rotated_dmi),
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

#[cfg(test)]
mod modal_quantity_availability_tests {
    use super::{GlobalQuantityRow, SolverProgress, StepDataKind};
    use std::collections::HashMap;

    #[test]
    fn physical_quantity_admission_uses_kind_not_object_id() {
        let mut row = GlobalQuantityRow {
            e_total: 4.25,
            ..GlobalQuantityRow::default()
        };
        row.per_object_scalars.insert(
            "fem_eigen_progress".into(),
            HashMap::from([("percent".into(), 75.0)]),
        );
        assert_eq!(row.scalar_value("e_total"), Some(4.25));

        row.kind = StepDataKind::SolverProgress;
        assert_eq!(row.scalar_value("e_total"), None);
        row.kind = StepDataKind::LegacyUnclassified;
        assert_eq!(row.scalar_value("e_total"), None);
    }

    #[test]
    fn legacy_rows_preserve_raw_values_without_qualifying_quantities() {
        let mut value =
            serde_json::to_value(GlobalQuantityRow::default()).expect("default row serializes");
        value.as_object_mut().expect("row object").remove("kind");
        value["e_total"] = serde_json::json!(2.5);
        value["per_object_scalars"] = serde_json::json!({
            "fem_eigen_progress": {"percent": 25.0}
        });
        let row: GlobalQuantityRow = serde_json::from_value(value).expect("legacy row parses");

        assert_eq!(row.kind, StepDataKind::LegacyUnclassified);
        assert_eq!(row.e_total, 2.5);
        assert_eq!(
            row.per_object_scalars["fem_eigen_progress"]["percent"],
            25.0
        );
        assert_eq!(row.scalar_value("e_total"), None);
    }

    #[test]
    fn unknown_kinds_and_progress_payloads_fail_closed() {
        let mut unknown =
            serde_json::to_value(GlobalQuantityRow::default()).expect("default row serializes");
        unknown["kind"] = serde_json::json!("future_kind");
        assert!(serde_json::from_value::<GlobalQuantityRow>(unknown).is_err());
        assert!(
            serde_json::from_value::<super::StepDataKind>(serde_json::json!("future_kind"))
                .is_err()
        );

        let mut diagnostics = super::StepDiagnostics::default();
        diagnostics.kind = StepDataKind::PhysicalObservation;
        diagnostics.solver_progress = Some(SolverProgress::FemEigen {
            metrics: HashMap::new(),
        });
        assert!(diagnostics.validate_record_kind().is_err());
    }

    #[test]
    fn null_kinds_and_unknown_solver_progress_variants_are_rejected() {
        let mut null_kind =
            serde_json::to_value(GlobalQuantityRow::default()).expect("default row serializes");
        null_kind["kind"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<GlobalQuantityRow>(null_kind).is_err());

        let unknown_progress = serde_json::json!({
            "kind": "future_progress",
            "metrics": {}
        });
        assert!(serde_json::from_value::<super::SolverProgress>(unknown_progress).is_err());
    }
}

use crate::types::{RunError, TransportExecutionProvenance};
use fullmag_ir::ResolvedSpinTransportPlanIR;

pub(super) fn transport_provenance(
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<TransportExecutionProvenance, RunError> {
    let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
        message: format!(
            "FEM spin transport '{}' lacks provenance descriptor",
            resolved.module_id
        ),
    })?;
    Ok(TransportExecutionProvenance {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        requested_discretization: format!("{:?}", resolved.requested_execution.discretization)
            .to_ascii_lowercase(),
        requested_device: format!("{:?}", resolved.requested_execution.device).to_ascii_lowercase(),
        requested_precision: format!("{:?}", resolved.requested_execution.precision)
            .to_ascii_lowercase(),
        requested_execution_mode: format!("{:?}", resolved.requested_execution.execution_mode)
            .to_ascii_lowercase(),
        resolved_discretization: "fem".into(),
        resolved_device: "cpu".into(),
        resolved_precision: "double".into(),
        resolved_execution_mode: "strict".into(),
        runtime_family: "fullmag_fem".into(),
        runtime_id: "fullmag_fem_managed".into(),
        engine_id: "fem_cpu_native".into(),
        charge_solver_engine: descriptor.resolved_charge_engine.clone(),
        spin_solver_engine: descriptor.resolved_spin_engine.clone(),
        constitutive_version: resolved.constitutive_version.clone(),
        operator_version: resolved.operator_version.clone(),
        physical_residual_version: resolved.physical_residual_version.clone(),
        interface_realization: descriptor.interface_realization.clone(),
        stage_coupling: descriptor.stage_coupling.clone(),
        capability_status: descriptor.capability_status.clone(),
        implementation_state: descriptor.implementation_state.clone(),
        validation_state: descriptor.validation_state.clone(),
        validation_scope: descriptor.validation_scope.clone(),
        inserted_default_boundaries: resolved.inserted_default_boundaries.clone(),
        charge_domain: descriptor.charge_domain.clone(),
        spin_domain: descriptor.spin_domain.clone(),
        charge_insulating_boundaries: descriptor.charge_insulating_boundaries.clone(),
        spin_insulating_boundaries: descriptor.spin_insulating_boundaries.clone(),
        interfaces: descriptor.interfaces.clone(),
        torque_target: descriptor.torque_target.clone(),
        fallback: None,
        degradation: None,
        oersted_source_kind: None,
        oersted_source_current_sha256: None,
        oersted_mesh_source_sha256: None,
        oersted_field_sha256: None,
        conservative_current_view_identity_digest: None,
        conservative_current_balance_certificate_digest: None,
    })
}

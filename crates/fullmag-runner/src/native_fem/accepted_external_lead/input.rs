//! Borrowed adapter only: caller must re-materialize and compare the owned input first.
use super::{
    AcceptedExternalLeadRequest, ExternalLeadBoundary, ExternalLeadBranch,
    ExternalLeadQuadraturePolicy,
};
use crate::native_fem::accepted_terminal_charge::{
    require, AcceptedChargeInterface, AcceptedChargeTerminal, AcceptedTerminalChargeRequest,
};
use crate::types::RunError;
use fullmag_ir::antenna_current_source::{
    AntennaCurrentBoundaryRoleIR, ResolvedAntennaExternalLeadCurrentInputIR,
};
use fullmag_ir::ConservativeCurrentSourceIR;

// Fixed defaults of fem_accepted_terminal_charge_source.v1, not authoring inference.
const ABSOLUTE_JUMP_TOLERANCE_V: f64 = 1.0e-12;
const RELATIVE_JUMP_TOLERANCE: f64 = 1.0e-12;

pub(crate) fn with_materialized_external_lead_request<T>(
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    consume: impl FnOnce(&AcceptedExternalLeadRequest<'_>) -> Result<T, RunError>,
) -> Result<T, RunError> {
    require(
        input.schema_version
            == fullmag_ir::antenna_current_source::ANTENNA_EXTERNAL_LEAD_CURRENT_INPUT_SCHEMA
            && input.field_scope == "external_electrode_truncation"
            && input.direct_field_policy.policy_version
                == fullmag_ir::antenna_current_source::ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION
            && input.direct_field_policy.relative_scale_floor_apm == 0.0,
        "unsupported materialized external lead input schema/scope/policy",
    )?;
    let source = input
        .authored_definition
        .conservative_current_source
        .as_ref()
        .ok_or_else(|| RunError {
            message: "materialized external lead input has no authored source".into(),
        })?;
    let ConservativeCurrentSourceIR::ExternalLeadCurrent { revision, .. } = source;
    let terminals = input
        .outer_terminals
        .iter()
        .map(|terminal| AcceptedChargeTerminal {
            id: terminal.id.clone(),
            boundary_face_vertex_ids: terminal.boundary_face_vertex_ids.clone(),
            requested_outward_current_a: terminal.requested_outward_current_a,
        })
        .collect::<Vec<_>>();
    let interfaces = input
        .interfaces
        .iter()
        .map(|pair| AcceptedChargeInterface {
            id: pair.id.clone(),
            first_face_vertex_ids: pair.device_face_vertex_ids,
            second_face_vertex_ids: pair.lead_face_vertex_ids,
            vertex_pairs: pair.vertex_pairs,
        })
        .collect::<Vec<_>>();
    let boundaries = input
        .boundary_roles
        .iter()
        .map(|face| ExternalLeadBoundary {
            vertex_ids: face.vertex_ids,
            role: match face.role {
                AntennaCurrentBoundaryRoleIR::Insulating => 1,
                AntennaCurrentBoundaryRoleIR::OuterElectrode => 2,
                AntennaCurrentBoundaryRoleIR::DeviceLeadInterface => 3,
            },
            circuit_id: face.circuit_id.clone(),
        })
        .collect::<Vec<_>>();
    // Observations are passive signed certificates, never boundary conditions.
    let branches = input
        .observations
        .iter()
        .map(|observation| ExternalLeadBranch {
            id: observation.id.clone(),
            interface_pair_ids: observation.interface_pair_ids.clone(),
            requested_device_outward_current_a: observation.requested_device_outward_current_a,
        })
        .collect::<Vec<_>>();
    let policy = &input.direct_field_policy;
    let request = AcceptedExternalLeadRequest {
        charge: AcceptedTerminalChargeRequest {
            mesh: &input.combined_mesh,
            execution_lane: fullmag_fem_sys::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
            stable_vertex_version: "stable_mesh_vertex_u64.v1",
            stable_vertex_ids: &input.combined_stable_vertex_ids,
            conductivity_spm_per_element: &input.conductivity_spm_per_element,
            terminals: &terminals,
            interfaces: &interfaces,
            absolute_jump_tolerance_v: ABSOLUTE_JUMP_TOLERANCE_V,
            relative_jump_tolerance: RELATIVE_JUMP_TOLERANCE,
            algebraic_relative_tolerance: input.solver.linear.relative_tolerance,
            maximum_iterations: input.solver.linear.max_iterations,
        },
        closure_revision: revision,
        device_vertex_ids: &input.device_stable_vertex_ids,
        lead_vertex_ids: &input.lead_stable_vertex_ids,
        boundary_faces: &boundaries,
        branches: &branches,
        targets_m: &input.field_sampling.positions_xyz_m,
        quadrature: ExternalLeadQuadraturePolicy {
            base_quadrature_order: policy.base_quadrature_order,
            maximum_subdivision_depth: policy.maximum_subdivision_depth,
            absolute_tolerance_apm: policy.absolute_tolerance_apm,
            relative_tolerance: policy.relative_tolerance,
            maximum_source_target_pairs: policy.maximum_source_target_pairs,
        },
    };
    super::preflight(&request)?;
    consume(&request)
}

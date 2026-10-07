//! Materialized input only; neither an execution plan nor an accepted field.
use crate::{
    AntennaFieldSamplingPlanIR, AntennaFieldSolveStageIR, AntennaPortModeIR, ChargeSolverPolicyIR,
    ChargeTransportDefinitionIR, CurrentSourceDriveIR, CurrentSourceInterfacePairIR,
    FemObjectSegmentIR, MeshIR,
};
use serde::{Deserialize, Serialize};

pub const ANTENNA_EXTERNAL_LEAD_CURRENT_INPUT_SCHEMA: &str =
    "antenna_external_lead_current_input.v1";
pub const ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION: &str =
    "external_lead_direct_defaults.unqualified.v3";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaCurrentBoundaryRoleIR {
    Insulating,
    OuterElectrode,
    DeviceLeadInterface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaCurrentBoundaryInputIR {
    pub vertex_ids: [u64; 3],
    pub role: AntennaCurrentBoundaryRoleIR,
    pub circuit_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaOuterTerminalCurrentInputIR {
    pub id: String,
    pub boundary_face_vertex_ids: Vec<[u64; 3]>,
    pub requested_outward_current_a: f64,
    pub electrical_component_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaCurrentObservationEndpointIR {
    Inlet,
    Outlet,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaCurrentObservationInputIR {
    pub id: String,
    pub object_id: String,
    pub port_branch_id: String,
    pub endpoint: AntennaCurrentObservationEndpointIR,
    pub interface_pair_ids: Vec<String>,
    pub requested_device_outward_current_a: f64,
    pub electrical_component_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaDirectFieldInputPolicyIR {
    pub policy_version: String,
    pub base_quadrature_order: i32,
    pub maximum_subdivision_depth: i32,
    pub absolute_tolerance_apm: f64,
    pub relative_tolerance: f64,
    pub maximum_source_target_pairs: u64,
    pub source_target_pairs: u64,
    pub relative_scale_floor_apm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaCurrentInputPinsIR {
    pub schema_version: String,
    pub authored_source_sha256: String,
    pub device_mesh_ownership_sha256: String,
    pub selected_control_sha256: String,
    pub combined_mesh_material_sha256: String,
    pub solver_sampling_sha256: String,
    pub materialized_input_sha256: String,
}

/// Owned planning input. No accepted-output pins or legacy boundary references.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAntennaExternalLeadCurrentInputIR {
    pub schema_version: String,
    pub field_scope: String,
    pub stage: AntennaFieldSolveStageIR,
    pub port: AntennaPortModeIR,
    pub authored_definition: ChargeTransportDefinitionIR,
    pub original_device_mesh: MeshIR,
    pub device_object_segments: Vec<FemObjectSegmentIR>,
    pub selected_drive: CurrentSourceDriveIR,
    pub combined_mesh: MeshIR,
    pub combined_stable_vertex_ids: Vec<u64>,
    pub device_stable_vertex_ids: Vec<u64>,
    pub lead_stable_vertex_ids: Vec<u64>,
    pub conductivity_spm_per_element: Vec<f64>,
    pub device_element_count: u32,
    pub combined_runtime_ordinal_policy: String,
    pub interfaces: Vec<CurrentSourceInterfacePairIR>,
    pub outer_terminals: Vec<AntennaOuterTerminalCurrentInputIR>,
    pub boundary_roles: Vec<AntennaCurrentBoundaryInputIR>,
    pub observations: Vec<AntennaCurrentObservationInputIR>,
    pub electrical_component_ids_per_vertex: Vec<u64>,
    pub solver: ChargeSolverPolicyIR,
    pub direct_field_policy: AntennaDirectFieldInputPolicyIR,
    pub field_sampling: AntennaFieldSamplingPlanIR,
    pub pins: AntennaCurrentInputPinsIR,
}

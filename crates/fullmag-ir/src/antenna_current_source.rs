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

/// Execution-only input for one coincident closed conductor; never an accepted field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparedAntennaClosedLoopMaterialPartIR {
    pub part_id: String,
    pub element_ordinals: Vec<u64>,
    pub material_assignment_index: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparedAntennaClosedLoopObservationFaceIR {
    pub face_vertex_ids: [u64; 3],
    pub part_cell_ordinal: u64,
    pub bridge_cell_ordinal: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparedAntennaClosedLoopObservationIR {
    pub id: String,
    pub part_id: String,
    pub selector: String,
    pub faces: Vec<PreparedAntennaClosedLoopObservationFaceIR>,
    pub normal_convention: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparedAntennaClosedLoopSourceIR {
    pub schema_version: String,
    pub revision: String,
    pub object_id: String,
    pub geometry_id: String,
    pub mesh_digest: String,
    pub authored_input_digest: String,
    pub materials_digest: String,
    pub stable_vertex_ids: Vec<u64>,
    #[serde(deserialize_with = "deserialize_prepared_closed_geometry")]
    pub closure: crate::ConservativeCurrentClosureIR,
    pub material_parts: Vec<PreparedAntennaClosedLoopMaterialPartIR>,
    pub terminal_observations: Vec<PreparedAntennaClosedLoopObservationIR>,
}
fn deserialize_prepared_closed_geometry<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<crate::ConservativeCurrentClosureIR, D::Error> {
    use serde::de::Error;
    let value = serde_json::Value::deserialize(deserializer)?;
    let closed = |value: &serde_json::Value, allowed: &[&str]| -> Result<(), D::Error> {
        if value.as_object().ok_or_else(|| D::Error::custom("prepared closure requires an object"))?.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(D::Error::custom("unknown prepared closure member"));
        }
        Ok(())
    };
    closed(&value, &["kind", "operator_version", "revision", "digest", "source_cuts"])?;
    if let Some(cuts) = value.get("source_cuts").and_then(serde_json::Value::as_array) {
        for cut in cuts {
            closed(cut, &["id", "translation_m", "potential_drop_v", "face_pairs"])?;
            if let Some(pairs) = cut.get("face_pairs").and_then(serde_json::Value::as_array) {
                for pair in pairs { closed(pair, &["minus_face_vertex_ids", "plus_face_vertex_ids"])?; }
            }
        }
    }
    serde_json::from_value(value).map_err(D::Error::custom)
}
impl PreparedAntennaClosedLoopSourceIR {
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        let mut errors = Vec::new();
        let text = |s: &str| !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0');
        let digest = |s: &str| s.strip_prefix("sha256:").is_some_and(|s| s.len()==64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        if self.schema_version != "conservative_current_source.v2" || !text(&self.object_id) || !text(&self.geometry_id)
            || ![&self.revision, &self.mesh_digest, &self.authored_input_digest, &self.materials_digest].iter().all(|s| digest(s))
            || self.revision != self.authored_input_digest {
            errors.push(format!("{path} requires exact prepared v2 owner and canonical input digests"));
        }
        const LIMIT: usize = 1 << 20;
        if self.stable_vertex_ids.is_empty() || self.stable_vertex_ids.len()>4*LIMIT
            || self.stable_vertex_ids.iter().any(|id| *id==0)
            || self.stable_vertex_ids.iter().copied().collect::<std::collections::BTreeSet<_>>().len()!=self.stable_vertex_ids.len()
            || self.material_parts.len()!=4 || self.terminal_observations.len()!=4
            || self.material_parts.iter().any(|part| !text(&part.part_id) || part.element_ordinals.is_empty() || part.element_ordinals.len()>LIMIT
                || part.element_ordinals.windows(2).any(|pair| pair[0]>=pair[1]))
            || self.terminal_observations.iter().any(|obs| !text(&obs.id) || !text(&obs.part_id) || !matches!(obs.selector.as_str(), "local_u_min"|"local_u_max")
                || obs.normal_convention!="outward_from_part" || obs.faces.is_empty() || obs.faces.len()>4*LIMIT) {
            errors.push(format!("{path} requires bounded unique carrier, four ordered material parts and four internal observations"));
        }
        match &self.closure {
            crate::ConservativeCurrentClosureIR::ClosedGeometry {operator_version, revision, digest, source_cuts} if operator_version=="fem_closed_current_geometry.v2"
                && revision==&self.revision && digest==&self.authored_input_digest && source_cuts.len()==1
                && text(&source_cuts[0].id) && source_cuts[0].translation_m==[0.0;3]
                && source_cuts[0].potential_drop_v.is_finite() && source_cuts[0].potential_drop_v!=0.0
                && !source_cuts[0].face_pairs.is_empty() && source_cuts[0].face_pairs.len()<=4*LIMIT => {},
            _ => errors.push(format!("{path}.closure requires exactly one nonzero coincident cut with the same v2 input identity")),
        }
        errors
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAntennaClosedLoopCurrentInputIR {
    pub schema_version: String,
    pub field_scope: String,
    pub stage: AntennaFieldSolveStageIR,
    pub port: AntennaPortModeIR,
    pub authored_definition: ChargeTransportDefinitionIR,
    pub source_mesh: MeshIR,
    pub source_object_segments: Vec<FemObjectSegmentIR>,
    pub source: PreparedAntennaClosedLoopSourceIR,
    pub authored_input_preimage: serde_json::Value,
    pub conductivity_spm_per_element: Vec<f64>,
    pub boundary_roles: Vec<crate::ConservativeCurrentBoundaryFaceIR>,
    pub solver: ChargeSolverPolicyIR,
    pub direct_field_policy: AntennaDirectFieldInputPolicyIR,
    pub field_sampling: AntennaFieldSamplingPlanIR,
    pub algebraic_relative_tolerance: f64,
    pub physical_relative_gate: f64,
    pub physical_absolute_gate_a: f64,
}

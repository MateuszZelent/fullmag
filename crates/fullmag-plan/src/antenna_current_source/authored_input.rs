//! Shared canonical source identity for original transport and retained-current inspection.
use super::{fail, require};
use crate::PlanError;
use fullmag_ir::{AntennaFieldSolveStageIR, AntennaPortModeIR, ChargeTransportDefinitionIR,
    ChargePotentialGaugeIR, ConservativeCurrentSourceIR, CurrentModuleIR, ProblemIR};
use serde_json::Value;

pub(super) fn exact_ids(value:&mut Value, field:Option<&str>) {
    match value {
        Value::Object(map)=>for (key,value) in map {exact_ids(value,Some(key));},
        Value::Array(values)=>for value in values {exact_ids(value,field);},
        Value::Number(number) if matches!(field,Some("stable_vertex_ids"|"face_vertex_ids"|"minus_face_vertex_ids"|"plus_face_vertex_ids"|"element_ordinals"|"part_cell_ordinal"|"bridge_cell_ordinal")) => {*value=Value::String(number.to_string());},
        _=>{},
    }
}

/// Rebuild the existing v2 source preimage without mesh generation or a transport solve.
/// The original materializer separately verifies geometry/topology and physical source coverage.
pub fn antenna_closed_loop_authored_input_preimage(
    problem: &ProblemIR, definition: &ChargeTransportDefinitionIR,
    stage: &AntennaFieldSolveStageIR, port: &AntennaPortModeIR,
) -> Result<Value, PlanError> {
    let Some(ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(source)) = &definition.conservative_current_source
        else { return Err(fail("source identity requires the complete prepared closed-loop source")); };
    let geometry = problem.geometry.entries.iter().find(|geometry| geometry.name() == source.geometry_id)
        .ok_or_else(|| fail("prepared source geometry owner is missing"))?;
    let solver = &definition.solver;
    let mut mapping = serde_json::to_value(&source.material_parts).map_err(|cause| fail(cause.to_string()))?;
    exact_ids(&mut mapping, None);
    let receipts=problem.problem_meta.runtime_metadata.get("antenna_coincident_preparations").and_then(Value::as_array).ok_or_else(||fail("prepared source authored intent receipt is missing"))?;
    let matches=receipts.iter().filter(|receipt|receipt.get("current_transport_id").and_then(Value::as_str)==Some(stage.current_transport_id.as_str())
        && receipt.get("object_id").and_then(Value::as_str)==Some(source.object_id.as_str()) && receipt.get("geometry_id").and_then(Value::as_str)==Some(source.geometry_id.as_str())).collect::<Vec<_>>();
    require(matches.len()==1,"prepared source authored receipt is missing or ambiguous")?;
    let authored=matches[0].pointer("/preparation/authored_intent").ok_or_else(||fail("prepared source lost its authored closure"))?;
    let mut closure=serde_json::to_value(&source.closure).map_err(|cause|fail(cause.to_string()))?;
    let object=closure.as_object_mut().ok_or_else(||fail("prepared closure shape"))?;object.remove("revision");object.remove("digest");exact_ids(&mut closure,None);
    let mut stable=serde_json::json!(source.stable_vertex_ids);exact_ids(&mut stable,Some("stable_vertex_ids"));
    let mut observations=serde_json::to_value(&source.terminal_observations).map_err(|cause|fail(cause.to_string()))?;exact_ids(&mut observations,None);
    let mesh_workflow=matches[0].pointer("/preparation/prepared_mesh_workflow").filter(|value|value.is_object()).ok_or_else(||fail("prepared source mesh policy intent missing"))?;
    let recipes=matches[0].pointer("/preparation/prepared_per_object_recipes").filter(|value|value.is_object()).ok_or_else(||fail("prepared source per-object mesh recipes missing"))?;
    // Python FEM.to_ir retains the authored optional mesh as null; restore
    // that canonical shape rather than hashing a Rust serialization omission.
    let mut backend_policy=serde_json::to_value(&problem.backend_policy).map_err(|cause|fail(cause.to_string()))?;
    if let Some(fem)=backend_policy.pointer_mut("/discretization_hints/fem").and_then(Value::as_object_mut) {
        fem.entry("mesh".to_string()).or_insert(Value::Null);
    }
    let selection=problem.problem_meta.runtime_metadata.get("runtime_selection").ok_or_else(||fail("prepared source requested execution identity missing"))?;
    let authored_input_preimage=serde_json::json!({"schema":"antenna_coincident_prepared_input.v2","object_id":source.object_id,"geometry":geometry,
        "authored_closure":authored,"mesh_digest":source.mesh_digest,"stable_vertex_ids":stable,"closure":closure,"materials_digest":source.materials_digest,
        "material_parts":mapping,"terminal_observations":observations,"port":port,"gauge":definition.gauge,"solver":solver,
        "requested_execution":selection,"backend_policy":backend_policy,"validation_profile":problem.validation_profile,"mesh_workflow":mesh_workflow,"per_object_recipes":recipes});
    Ok(authored_input_preimage)
}

/// Compare the actual source physics, not names or the new sampling/field policy.
/// Frozen conductivity must come from the fully verified parent, never a caller-authored digest.
pub fn validate_retained_current_authored_source(
    problem: &ProblemIR, stage: &AntennaFieldSolveStageIR,
    verified_preimage: &Value, verified_conductivity_spm: &[f64],
) -> Result<(), PlanError> {
    problem.validate().map_err(|reasons| PlanError { reasons })?;
    require(verified_preimage.get("schema").and_then(Value::as_str) == Some("antenna_coincident_prepared_input.v2")
        && !verified_conductivity_spm.is_empty()
        && verified_conductivity_spm.iter().all(|value| value.is_finite() && *value > 0.0),
        "retained source requires the verified original preimage and positive finite conductivities")?;
    let module = problem.current_modules.iter().find(|module| matches!(module,
        CurrentModuleIR::CurrentTransport { name, .. } if name == &stage.current_transport_id))
        .ok_or_else(|| fail("retained source current module is absent"))?;
    let CurrentModuleIR::CurrentTransport { definition: Some(definition), .. } = module
        else { return Err(fail("retained source current definition is absent")); };
    let Some(ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(source)) = &definition.conservative_current_source
        else { return Err(fail("retained source requires the complete original prepared closure")); };
    let geometry_id = fullmag_ir::geometry_name_for_physics_object_v03(problem, &source.object_id)
        .map_err(|reasons| PlanError { reasons })?;
    require(geometry_id == source.geometry_id,
        "retained source geometry is no longer owned by its original physical object")?;
    require(stage.port_mode_ids.len() == 1, "retained source requires exactly one port")?;
    let port = problem.antenna_port_modes.iter().find(|port| port.id == stage.port_mode_ids[0])
        .ok_or_else(|| fail("retained source port is absent"))?;
    require(stage.source_object_id == source.object_id && port.source_object_id == source.object_id
        && port.current_transport_id == stage.current_transport_id
        && definition.domain.len() == 1 && definition.domain[0].object_id == source.object_id
        && definition.domain[0].region_id.is_none() && definition.boundaries.is_empty()
        && definition.gauge == ChargePotentialGaugeIR::ZeroMean
        && definition.external_lead_preparation.is_none() && definition.structured_current_closure.is_none()
        && definition.conservative_current_view.is_none(),
        "retained source object/domain/gauge or alternate boundary/source differs")?;
    let mut mapping = serde_json::to_value(&source.material_parts).map_err(|cause| fail(cause.to_string()))?;
    exact_ids(&mut mapping, None);
    let tagged = |value: &Value| fullmag_ir::transport_identity::tagged_json_digest(value)
        .map_err(|cause| fail(cause.to_string()));
    let materials = tagged(&serde_json::json!({"schema":"antenna_coincident_material_binding.v2",
        "assignments":definition.materials,"material_parts":mapping,
        "resolved_conductivity_spm_per_element":verified_conductivity_spm}))?;
    require(materials == source.materials_digest,
        "retained source material assignments or conductivity changed; fresh transport is required")?;
    let current = antenna_closed_loop_authored_input_preimage(problem, definition, stage, port)?;
    let current_digest = tagged(&current)?;
    require(current_digest == source.authored_input_digest && current_digest == tagged(verified_preimage)?,
        "retained source geometry/closure/port/transport intent changed; fresh transport is required")
}

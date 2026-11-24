//! Compare current source intent with authenticated history, without altering ProblemIR or sampling.
use super::{authored_input::exact_ids, fail, require};
use crate::PlanError;
use fullmag_ir::{AntennaFieldSolveStageIR, ChargePotentialGaugeIR, ConservativeCurrentSourceIR,
    CurrentModuleIR, ProblemIR};
use serde_json::Value;

/// The preimage and conductivities must come from the opaque verified original source.
/// Asset bytes, frozen topology and receipt pins are independently authenticated by runtime.
pub fn validate_retained_preparation_authored_source(
    problem: &ProblemIR, stage: &AntennaFieldSolveStageIR,
    verified_preimage: &Value, verified_conductivity_spm: &[f64],
) -> Result<(), PlanError> {
    problem.validate().map_err(|reasons| PlanError { reasons })?;
    let module = problem.current_modules.iter().find(|module| matches!(module,
        CurrentModuleIR::CurrentTransport { name, .. } if name == &stage.current_transport_id))
        .ok_or_else(|| fail("retained preparation current module is absent"))?;
    let CurrentModuleIR::CurrentTransport { definition: Some(definition), .. } = module
        else { return Err(fail("retained preparation current definition is absent")); };
    let Some(ConservativeCurrentSourceIR::RetainedPreparationAsset(source)) = &definition.conservative_current_source
        else { return Err(fail("retained preparation requires its explicit source-asset kind")); };
    let historical = &source.historical_prepared_source;
    let reference = stage.retained_source_preparation.as_ref()
        .ok_or_else(|| fail("retained preparation stage asset is absent"))?;
    let geometry_id = fullmag_ir::geometry_name_for_physics_object_v03(problem, &source.object_id)
        .map_err(|reasons| PlanError { reasons })?;
    require(geometry_id == source.geometry_id && source.object_id == historical.object_id
        && source.geometry_id == historical.geometry_id && reference == &source.preparation_asset
        && stage.source_object_id == source.object_id && stage.port_mode_ids.len() == 1
        && stage.retained_current_source.is_some(), "retained preparation owner/asset/port binding differs")?;
    let port = problem.antenna_port_modes.iter().find(|port| port.id == stage.port_mode_ids[0])
        .ok_or_else(|| fail("retained preparation port is absent"))?;
    require(port.source_object_id == source.object_id && port.current_transport_id == stage.current_transport_id
        && definition.domain.len() == 1 && definition.domain[0].object_id == source.object_id
        && definition.domain[0].region_id.is_none() && definition.boundaries.is_empty()
        && definition.gauge == ChargePotentialGaugeIR::ZeroMean && definition.external_lead_preparation.is_none()
        && definition.structured_current_closure.is_none() && definition.conservative_current_view.is_none(),
        "retained preparation domain/gauge or alternate source differs")?;
    let tagged = |value: &Value| fullmag_ir::transport_identity::tagged_json_digest(value)
        .map_err(|cause| fail(cause.to_string()));
    require(verified_preimage["schema"] == "antenna_coincident_prepared_input.v2"
        && tagged(verified_preimage)? == historical.authored_input_digest
        && !verified_conductivity_spm.is_empty()
        && verified_conductivity_spm.iter().all(|value| value.is_finite() && *value > 0.0),
        "retained preparation requires the exact verified original preimage and positive conductivities")?;
    let geometry = problem.geometry.entries.iter().find(|geometry| geometry.name() == source.geometry_id)
        .ok_or_else(|| fail("retained preparation current geometry is absent"))?;
    let mut mapping = serde_json::to_value(&historical.material_parts).map_err(|cause| fail(cause.to_string()))?;
    exact_ids(&mut mapping, None);
    require(tagged(&serde_json::json!({"schema":"antenna_coincident_material_binding.v2",
        "assignments":definition.materials, "material_parts":mapping,
        "resolved_conductivity_spm_per_element":verified_conductivity_spm}))? == historical.materials_digest,
        "retained preparation material assignments or verified conductivity changed")?;
    let mut backend = serde_json::to_value(&problem.backend_policy).map_err(|cause| fail(cause.to_string()))?;
    if let Some(fem) = backend.pointer_mut("/discretization_hints/fem").and_then(Value::as_object_mut) {
        fem.entry("mesh".to_owned()).or_insert(Value::Null);
    }
    let mut actual_closure = serde_json::to_value(&source.authored_closure).map_err(|cause| fail(cause.to_string()))?;
    exact_ids(&mut actual_closure, None);
    let mut stable = serde_json::json!(historical.stable_vertex_ids); exact_ids(&mut stable, Some("stable_vertex_ids"));
    let mut observations = serde_json::to_value(&historical.terminal_observations).map_err(|cause| fail(cause.to_string()))?;
    exact_ids(&mut observations, None);
    let mut closure = serde_json::to_value(&historical.closure).map_err(|cause| fail(cause.to_string()))?;
    let object = closure.as_object_mut().ok_or_else(|| fail("historical closure shape"))?;
    object.remove("revision"); object.remove("digest"); exact_ids(&mut closure, None);
    let selection = problem.problem_meta.runtime_metadata.get("runtime_selection")
        .ok_or_else(|| fail("retained preparation requested execution is absent"))?;
    let current = serde_json::json!({"schema":"antenna_coincident_prepared_input.v2",
        "object_id":source.object_id,"geometry":geometry,"authored_closure":actual_closure,
        "mesh_digest":historical.mesh_digest,"stable_vertex_ids":stable,"closure":closure,
        "materials_digest":historical.materials_digest,"material_parts":mapping,
        "terminal_observations":observations,"port":port,"gauge":definition.gauge,"solver":definition.solver,
        "requested_execution":selection,"backend_policy":backend,"validation_profile":problem.validation_profile});
    // These are source intent only. Global observation workflow is deliberately not part of this comparison.
    for (key, value) in current.as_object().ok_or_else(|| fail("source comparison shape"))? {
        require(verified_preimage.get(key) == Some(value),
            &format!("retained preparation current source field '{key}' changed; fresh transport is required"))?;
    }
    // PerObjectMeshRecipe is authored only on magnets, which the existing static H-only carrier forbids.
    // Auxiliary source mesh overrides are represented by the per-geometry workflow below.
    require(problem.magnets.is_empty(), "retained preparation cannot introduce a magnetic per-object source recipe")?;
    let recipes = verified_preimage.get("per_object_recipes").and_then(Value::as_object)
        .ok_or_else(|| fail("original per-object recipe metadata is missing"))?;
    require(!recipes.contains_key(&source.geometry_id),
        "retained preparation cannot silently drop an original magnetic source recipe")?;
    // An empty inherit record is emitted even without an authored edit: it selects the frozen policy.
    // Inherit carrying local override fields is contradictory and must not hide an explicit change.
    if let Some(entries) = problem.problem_meta.runtime_metadata.get("mesh_workflow")
        .and_then(|workflow| workflow.get("per_geometry")).and_then(Value::as_array) {
        require(entries.iter().filter(|entry| entry["geometry"].as_str() == Some(source.geometry_id.as_str())).count() <= 1,
            "retained preparation local source policy is ambiguous")?;
        for entry in entries.iter().filter(|entry| entry["geometry"].as_str() == Some(source.geometry_id.as_str())) {
            if entry["mode"] == "inherit" {
                require(entry.as_object().is_some_and(|object| object.len() == 2
                    && object.contains_key("geometry") && object.contains_key("mode")),
                    "retained preparation inherit record contains an explicit local source override")?;
                continue;
            }
            require(entry["mode"] == "custom", "retained preparation source mesh mode is unsupported")?;
            let historical_entries = verified_preimage.pointer("/mesh_workflow/per_geometry").and_then(Value::as_array)
                .ok_or_else(|| fail("original local source mesh policy is missing"))?;
            require(historical_entries.iter().filter(|old| old["geometry"] == entry["geometry"]).count() == 1
                && historical_entries.iter().any(|old| old == entry),
                "retained preparation explicit local mesh policy changed")?;
        }
    }
    // The source carrier is explicit inline input, never a newly loaded or generated mesh.
    let assets = problem.geometry_assets.as_ref().ok_or_else(|| fail("frozen source mesh assets are absent"))?;
    let matches = assets.fem_mesh_assets.iter().filter(|asset| asset.geometry_name == source.geometry_id).collect::<Vec<_>>();
    require(matches.len() == 1 && matches[0].mesh_source.is_none(), "retained preparation requires one frozen inline mesh")?;
    let mesh = matches[0].mesh.as_ref().ok_or_else(|| fail("frozen inline source mesh is absent"))?;
    require(mesh.mixed_topology_fingerprint_v3().map_err(fail)? == historical.mesh_digest
        && mesh.nodes.len() == historical.stable_vertex_ids.len()
        && mesh.cells.global_ordinals.iter().copied().eq(0..mesh.cell_count() as u64),
        "retained preparation actual source mesh or ordered carrier changed")?;
    Ok(())
}

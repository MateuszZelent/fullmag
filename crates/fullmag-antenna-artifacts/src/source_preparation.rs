//! Bounded input-only source preparation. Shape and pins never authorize a historical current.
use crate::{artifact_json::UnambiguousJson, ArtifactError};
use crate::retained_current::{ParentCurrentDigests, ParentInspectionOwner};
use fullmag_ir::{AntennaSourcePreparationReceiptPinsIR, FemObjectSegmentIR, MeshIR,
    PreparedAntennaClosedLoopSourceIR};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA: &str = "antenna_source_preparation_asset.v1";
pub const MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSourcePreparationAssetDocument {
    pub schema_version: String,
    pub parent_owner: ParentInspectionOwner,
    pub source_pins: ParentCurrentDigests,
    pub source_mesh: MeshIR,
    pub source_object_segments: Vec<FemObjectSegmentIR>,
    pub prepared_source: PreparedAntennaClosedLoopSourceIR,
    pub authored_input_preimage: Value,
    pub source_preparation: AntennaSourcePreparationReceiptPinsIR,
}
fn failure(message: impl Into<String>) -> ArtifactError {
    ArtifactError { message: format!("antenna source preparation: {}", message.into()) }
}
fn require(ok: bool, message: &str) -> Result<(), ArtifactError> {
    if ok { Ok(()) } else { Err(failure(message)) }
}
fn closed(value: &Value, allowed: &[&str]) -> Result<(), ArtifactError> {
    let object = value.as_object().ok_or_else(|| failure("required JSON object is missing"))?;
    require(object.keys().all(|key| allowed.contains(&key.as_str())), "unknown input-only field")
}
fn known_fields(actual: &Value, canonical: &Value) -> Result<(), ArtifactError> {
    match (actual, canonical) {
        (Value::Object(actual), Value::Object(canonical)) => {
            for (key, value) in actual {
                let expected = canonical.get(key).ok_or_else(|| failure(format!("unknown field {key}")))?;
                known_fields(value, expected)?;
            }
        },
        (Value::Array(actual), Value::Array(canonical)) => {
            require(actual.len() == canonical.len(), "typed array size differs")?;
            for (actual, expected) in actual.iter().zip(canonical) { known_fields(actual, expected)?; }
        },
        _ => {},
    }
    Ok(())
}
fn typed_fields<T: serde::de::DeserializeOwned + Serialize>(value: &Value, restore_fem_mesh: bool) -> Result<(), ArtifactError> {
    let typed: T = serde_json::from_value(value.clone()).map_err(|error| failure(error.to_string()))?;
    let mut canonical = serde_json::to_value(typed).map_err(|error| failure(error.to_string()))?;
    if restore_fem_mesh {
        if let Some(fem) = canonical.pointer_mut("/discretization_hints/fem").and_then(Value::as_object_mut) {
            // The unchanged original v2 preimage explicitly retained this authored optional field.
            fem.entry("mesh".to_owned()).or_insert(Value::Null);
        }
    }
    known_fields(value, &canonical)
}
fn source_part_markers(geometry: &fullmag_ir::GeometryEntryIR) -> Result<std::collections::BTreeMap<&str, u32>, ArtifactError> {
    let (conductors, inlet, outlet) = match geometry {
        fullmag_ir::GeometryEntryIR::MicrostripAntenna { conductors, r#loop: Some(connection), .. }
            if connection.enabled && conductors.len() == 2 && conductors[0].kind == "signal" && conductors[1].kind == "return" =>
            (conductors, connection.inlet_connection_part_id.as_str(), connection.outlet_connection_part_id.as_str()),
        fullmag_ir::GeometryEntryIR::CpwAntenna { conductors, r#loop: Some(connection), .. }
            if connection.enabled && conductors.len() == 3 && conductors[0].kind == "signal"
                && conductors[1].kind == "ground_left" && conductors[2].kind == "ground_right" =>
            (conductors, connection.inlet_connection_part_id.as_str(), connection.outlet_connection_part_id.as_str()),
        _ => return Err(failure("source part markers require the original complete microstrip or GSG loop geometry")),
    };
    let mut markers = std::collections::BTreeMap::new();
    for (index, part_id) in conductors.iter().map(|part| part.id.as_str()).chain([inlet, outlet]).enumerate() {
        require(!part_id.trim().is_empty() && markers.insert(part_id, (index + 1) as u32).is_none(),
            "source geometry material part IDs are missing or duplicated")?;
    }
    Ok(markers)
}
fn exact_ids(value: &mut Value, field: Option<&str>) {
    match value {
        Value::Object(map) => for (key, value) in map { exact_ids(value, Some(key)); },
        Value::Array(values) => for value in values { exact_ids(value, field); },
        Value::Number(number) if matches!(field, Some("stable_vertex_ids" | "face_vertex_ids" | "minus_face_vertex_ids" | "plus_face_vertex_ids" | "element_ordinals" | "part_cell_ordinal" | "bridge_cell_ordinal")) =>
            *value = Value::String(number.to_string()),
        _ => {},
    }
}
fn bounded(value: &impl Serialize) -> Result<(), ArtifactError> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len()).filter(|size| *size <= MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES)
                .ok_or_else(|| std::io::Error::other("source preparation asset exceeds 8 MiB"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    serde_json::to_writer(Counter(0), value).map_err(|error| failure(error.to_string()))
}
impl AntennaSourcePreparationAssetDocument {
    pub fn decode(bytes: &[u8]) -> Result<Self, ArtifactError> {
        require(!bytes.is_empty() && bytes.len() <= MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES,
            "input byte budget")?;
        let raw = serde_json::from_slice::<UnambiguousJson>(bytes).map_err(|error| failure(error.to_string()))?.0;
        let document: Self = serde_json::from_value(raw.clone()).map_err(|error| failure(error.to_string()))?;
        // MeshIR supports older transports with permissive nested structs. This new document does not.
        known_fields(&raw["source_mesh"], &serde_json::to_value(&document.source_mesh).map_err(|error| failure(error.to_string()))?)?;
        known_fields(&raw["source_object_segments"], &serde_json::to_value(&document.source_object_segments).map_err(|error| failure(error.to_string()))?)?;
        let input = &raw["authored_input_preimage"];
        closed(input, &["schema", "object_id", "geometry", "authored_closure", "mesh_digest", "stable_vertex_ids",
            "closure", "materials_digest", "material_parts", "terminal_observations", "port", "gauge", "solver",
            "requested_execution", "backend_policy", "validation_profile", "mesh_workflow", "per_object_recipes"])?;
        document.validate()?;
        Ok(document)
    }

    /// Measure compact JSON before allocating final bytes or allowing an exporter to create its output.
    pub fn encode(&self) -> Result<Vec<u8>, ArtifactError> {
        bounded(self)?;
        self.validate()?;
        serde_json::to_vec(self).map_err(|error| failure(error.to_string()))
    }

    /// Internal consistency only. The runtime must compare all fields with its independently read parent.
    pub fn validate(&self) -> Result<(), ArtifactError> {
        bounded(self)?;
        require(self.schema_version == ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA, "unsupported schema")?;
        self.parent_owner.validate_metadata()?;
        self.source_pins.validate_metadata()?;
        require(self.source_preparation.validation_errors("source_preparation").is_empty(), "invalid historical receipt pins")?;
        require(self.prepared_source.validation_errors("prepared_source").is_empty(), "invalid historical prepared source")?;
        require(self.source_preparation.run_id == self.parent_owner.run_id
            && self.source_preparation.task_id == self.parent_owner.task_id
            && self.source_preparation.step_id == self.parent_owner.study_step_id,
            "receipt and parent owner differ")?;
        fullmag_ir::validate_mesh_for_execution(&self.source_mesh).map_err(|errors| failure(errors.join("; ")))?;
        self.source_mesh.cells.require_tet4().map_err(failure)?;
        require(!self.source_mesh.cells.is_empty() && self.source_mesh.periodic_node_pairs.is_empty()
            && self.source_mesh.periodic_boundary_pairs.is_empty()
            && self.source_mesh.nodes.len() == self.prepared_source.stable_vertex_ids.len()
            && self.source_mesh.cells.global_ordinals.iter().copied().eq(0..self.source_mesh.cell_count() as u64)
            && self.source_mesh.mixed_topology_fingerprint_v3().map_err(failure)? == self.prepared_source.mesh_digest,
            "source mesh, stable carrier or canonical digest differs")?;
        require(self.source_object_segments.len() == 1, "source must have exactly one complete owner segment")?;
        let segment = &self.source_object_segments[0];
        require(segment.object_id == self.prepared_source.object_id
            && segment.geometry_id.as_ref() == Some(&self.prepared_source.geometry_id)
            && segment.node_start == 0 && segment.node_count as usize == self.source_mesh.nodes.len()
            && segment.element_start == 0 && segment.element_count as usize == self.source_mesh.cell_count()
            && segment.boundary_face_start == 0 && segment.boundary_face_count as usize == self.source_mesh.facet_count(),
            "source owner segment does not cover its exact mesh")?;
        let source_geometry: fullmag_ir::GeometryEntryIR = serde_json::from_value(self.authored_input_preimage["geometry"].clone())
            .map_err(|error| failure(error.to_string()))?;
        require(source_geometry.name() == self.prepared_source.geometry_id, "source geometry owner differs")?;
        // Material records are sorted by part_id, while markers follow authored geometry order.
        let part_markers = source_part_markers(&source_geometry)?;
        let mut seen_parts = std::collections::BTreeSet::new();
        let mut owners = vec![false; self.source_mesh.cell_count()];
        for part in &self.prepared_source.material_parts {
            let marker = part_markers.get(part.part_id.as_str()).ok_or_else(|| failure("material part is absent from source geometry"))?;
            require(seen_parts.insert(part.part_id.as_str()), "material part ID is duplicated")?;
            for ordinal in &part.element_ordinals {
                let ordinal = usize::try_from(*ordinal).map_err(|_| failure("material ordinal overflow"))?;
                require(ordinal < owners.len(), "material ordinal outside source")?;
                require(!std::mem::replace(&mut owners[ordinal], true)
                    && self.source_mesh.element_markers.get(ordinal) == Some(marker),
                    "material parts overlap or disagree with actual markers")?;
            }
        }
        require(seen_parts.len() == part_markers.len() && owners.iter().all(|covered| *covered),
            "material parts do not cover the source and every geometry part")?;
        let input = &self.authored_input_preimage;
        let fields = ["schema", "object_id", "geometry", "authored_closure", "mesh_digest", "stable_vertex_ids",
            "closure", "materials_digest", "material_parts", "terminal_observations", "port", "gauge", "solver",
            "requested_execution", "backend_policy", "validation_profile", "mesh_workflow", "per_object_recipes"];
        closed(input, &fields)?;
        require(input.as_object().is_some_and(|object| object.len() == fields.len()), "historical input fields are incomplete")?;
        typed_fields::<fullmag_ir::GeometryEntryIR>(&input["geometry"], false)?;
        typed_fields::<fullmag_ir::StructuredCurrentClosureIR>(&input["authored_closure"], false)?;
        typed_fields::<fullmag_ir::AntennaPortModeIR>(&input["port"], false)?;
        typed_fields::<fullmag_ir::ChargeSolverPolicyIR>(&input["solver"], false)?;
        typed_fields::<fullmag_ir::BackendPolicyIR>(&input["backend_policy"], true)?;
        typed_fields::<fullmag_ir::ValidationProfileIR>(&input["validation_profile"], false)?;
        // Historical workflow, recipes and runtime-selection metadata retain their original JSON vocabulary.
        // Runtime authenticates their exact bytes/values against the independently verified parent.
        require(input["mesh_workflow"].is_object() && input["per_object_recipes"].is_object()
            && input["requested_execution"].is_object(), "historical metadata objects are missing")?;
        require(input["schema"] == "antenna_coincident_prepared_input.v2"
            && input["object_id"].as_str() == Some(self.prepared_source.object_id.as_str())
            && input["mesh_digest"].as_str() == Some(self.prepared_source.mesh_digest.as_str())
            && input["materials_digest"].as_str() == Some(self.prepared_source.materials_digest.as_str())
            && fullmag_ir::transport_identity::tagged_json_digest(input).map_err(failure)? == self.prepared_source.authored_input_digest,
            "historical authored preimage differs from original prepared source")?;
        let mut stable = serde_json::json!(self.prepared_source.stable_vertex_ids); exact_ids(&mut stable, Some("stable_vertex_ids"));
        let mut parts = serde_json::to_value(&self.prepared_source.material_parts).map_err(|error| failure(error.to_string()))?;
        exact_ids(&mut parts, None);
        let mut observations = serde_json::to_value(&self.prepared_source.terminal_observations).map_err(|error| failure(error.to_string()))?;
        exact_ids(&mut observations, None);
        let mut closure = serde_json::to_value(&self.prepared_source.closure).map_err(|error| failure(error.to_string()))?;
        let closure_object = closure.as_object_mut().ok_or_else(|| failure("prepared closure shape"))?;
        closure_object.remove("revision"); closure_object.remove("digest"); exact_ids(&mut closure, None);
        require(input["stable_vertex_ids"] == stable && input["material_parts"] == parts
            && input["terminal_observations"] == observations && input["closure"] == closure,
            "historical input carrier/material/terminal/closure differs")?;
        // Round-trip rejects non-finite programmatic values that JSON would silently serialize as null.
        let roundtrip: Self = serde_json::from_value(serde_json::to_value(self).map_err(|error| failure(error.to_string()))?)
            .map_err(|error| failure(error.to_string()))?;
        require(roundtrip == *self, "input contains non-finite or non-roundtrippable values")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retained_current::{CasObjectRef, PARENT_CODEC_ID, PARENT_CODEC_VERSION, PARENT_MANIFEST_SCHEMA};
    use sha2::{Digest, Sha256};
    pub(super) fn fixture() -> AntennaSourcePreparationAssetDocument { fixture_for(false) }
    fn fixture_for(gsg: bool) -> AntennaSourcePreparationAssetDocument {
        // Input shape fixture only: no durable parent, admitted current or numerical qualification.
        let ir: Value = serde_json::from_str::<Value>(include_str!("../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap()["ir"].clone();
        let mut mesh: MeshIR = serde_json::from_value(ir["geometry_assets"]["fem_mesh_assets"][0]["mesh"].clone()).unwrap();
        let cell_count = mesh.cell_count();
        let conductor_ids = if gsg { vec!["signal", "ground_left", "ground_right"] } else { vec!["signal", "return"] };
        let part_ids = conductor_ids.iter().copied().chain(["inlet", "outlet"]).collect::<Vec<_>>();
        for (index, marker) in mesh.element_markers.iter_mut().enumerate() { *marker = (index % part_ids.len() + 1) as u32; }
        let stable = (1..=mesh.nodes.len() as u64).collect::<Vec<_>>();
        let mut parts = part_ids.iter().enumerate().map(|(index, id)|
            serde_json::json!({"part_id":id,"element_ordinals":(index..cell_count).step_by(part_ids.len()).map(|n|n as u64).collect::<Vec<_>>(),"material_assignment_index":0})).collect::<Vec<_>>();
        parts.sort_by(|a, b| a["part_id"].as_str().unwrap().cmp(b["part_id"].as_str().unwrap()));
        let observations = conductor_ids.iter().flat_map(|part| ["min", "max"].map(move |end|
            serde_json::json!({"id":format!("{part}-{end}"),"part_id":part,"selector":format!("local_u_{end}"),
                "faces":[{"face_vertex_ids":[1,2,3],"part_cell_ordinal":0,"bridge_cell_ordinal":1}],"normal_convention":"outward_from_part"}))).collect::<Vec<_>>();
        let hash = |c: char| c.to_string().repeat(64);
        let pin = |c| format!("sha256:{}", hash(c));
        let mut prepared: PreparedAntennaClosedLoopSourceIR = serde_json::from_value(serde_json::json!({
            "schema_version":"conservative_current_source.v2","revision":pin('a'),"object_id":"antenna","geometry_id":"antenna",
            "mesh_digest":mesh.mixed_topology_fingerprint_v3().unwrap(),"authored_input_digest":pin('a'),"materials_digest":pin('b'),
            "stable_vertex_ids":stable,"material_parts":parts,"terminal_observations":observations,
            "closure":{"kind":"closed_geometry","operator_version":"fem_closed_current_geometry.v2","revision":pin('a'),"digest":pin('a'),
                "source_cuts":[{"id":"cut","translation_m":[0.,0.,0.],"potential_drop_v":1.,
                    "face_pairs":[{"minus_face_vertex_ids":[1,2,3],"plus_face_vertex_ids":[4,5,6]}]}]}
        })).unwrap();
        let mut closure = serde_json::to_value(&prepared.closure).unwrap();
        closure.as_object_mut().unwrap().remove("revision"); closure.as_object_mut().unwrap().remove("digest"); exact_ids(&mut closure,None);
        let mut parts = serde_json::to_value(&prepared.material_parts).unwrap(); exact_ids(&mut parts,None);
        let mut observations = serde_json::to_value(&prepared.terminal_observations).unwrap(); exact_ids(&mut observations,None);
        let mut stable = serde_json::json!(prepared.stable_vertex_ids); exact_ids(&mut stable,Some("stable_vertex_ids"));
        let mut geometry = serde_json::json!({"name":"antenna","kind":if gsg {"cpw"} else {"microstrip"},
            "length_m":2.,"thickness_m":0.1,"conductivity_s_per_m":4.,
            "transform":{"rotation_matrix":[[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]],"translation_m":[0.,0.,0.]},
            "conductors":conductor_ids.iter().map(|part| serde_json::json!({"id":part,"kind":part})).collect::<Vec<_>>(),"terminal_faces":{}});
        geometry["stations"] = if gsg {serde_json::json!([{"s":0.,"signal_width_m":0.2,"left_gap_m":0.1,"right_gap_m":0.1,"left_ground_width_m":0.3,"right_ground_width_m":0.3},
            {"s":1.,"signal_width_m":0.2,"left_gap_m":0.1,"right_gap_m":0.1,"left_ground_width_m":0.3,"right_ground_width_m":0.3}])}
            else {serde_json::json!([{"s":0.,"signal_width_m":0.2},{"s":1.,"signal_width_m":0.2}])};
        geometry["loop"] = if gsg {serde_json::json!({"enabled":true,"inlet_connection_length_m":0.1,"inlet_crossbar_length_m":1.,"inlet_connection_part_id":"inlet",
            "inlet_connection_conductivity_s_per_m":4.,"outlet_connection_length_m":0.1,"outlet_crossbar_length_m":1.,"outlet_connection_part_id":"outlet","outlet_connection_conductivity_s_per_m":4.})}
            else {serde_json::json!({"enabled":true,"inlet_connection_length_m":0.1,"inlet_connection_width_m":1.,"inlet_connection_offset_v_m":0.,"inlet_connection_part_id":"inlet",
            "inlet_connection_conductivity_s_per_m":4.,"outlet_connection_length_m":0.1,"outlet_connection_width_m":1.,"outlet_connection_offset_v_m":0.,"outlet_connection_part_id":"outlet","outlet_connection_conductivity_s_per_m":4.})};
        if !gsg {geometry["return_width_m"] = 1.0.into(); geometry["return_offset_m"] = 0.3.into();}
        let input = serde_json::json!({"schema":"antenna_coincident_prepared_input.v2","object_id":"antenna",
            "geometry":geometry,"authored_closure":{"kind":"closed_geometry","schema_version":"structured_current_closure.v2",
                "closure_id":"loop","source_cuts":[{"source_cut_id":"cut","circuit_id":"loop","region":{"object_id":"antenna","region_id":"inlet"},
                "plane":{"coordinate_frame":"object","axis":"x","offset_m":0.,"normal":"positive_axis"},
                "drive":{"kind":"impressed_potential_jump","schema_version":"impressed_potential_jump.v1","drive_id":"drive","potential_jump_V":1.}}]},
            "mesh_digest":prepared.mesh_digest,
            "stable_vertex_ids":stable,"closure":closure,"materials_digest":prepared.materials_digest,
            "material_parts":parts,"terminal_observations":observations,"port":ir["antenna_port_modes"][0],"gauge":"zero_mean","solver":ir["current_modules"][0]["solver"],
            "requested_execution":ir["problem_meta"]["runtime_metadata"]["runtime_selection"],"backend_policy":ir["backend_policy"],
            "validation_profile":ir["validation_profile"],"mesh_workflow":{},"per_object_recipes":{}});
        let digest = fullmag_ir::transport_identity::tagged_json_digest(&input).unwrap();
        prepared.revision = digest.clone(); prepared.authored_input_digest = digest.clone();
        let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry { revision, digest: cut_digest, .. } = &mut prepared.closure else {unreachable!()};
        *revision = digest.clone(); *cut_digest = digest;
        let task = format!("task-{:x}", Sha256::digest(b"run-source\0source-step"));
        let count = |n| u32::try_from(n).unwrap();
        AntennaSourcePreparationAssetDocument {
            schema_version:ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA.into(),
            parent_owner:ParentInspectionOwner {project_id:"project-source".into(),run_id:"run-source".into(),study_step_id:"source-step".into(),
                native_stage_id:"native-source".into(),task_id:task.clone(),attempt_id:"attempt-source".into(),ownership_epoch:"1".into(),artifact_id:"artifact-source".into(),
                package:CasObjectRef{object_ref:hash('c'),byte_count:4096},package_codec_id:PARENT_CODEC_ID.into(),package_codec_version:PARENT_CODEC_VERSION.into(),
                manifest_schema:PARENT_MANIFEST_SCHEMA.into(),output_manifest_artifact_id:"output-source".into(),output_manifest:CasObjectRef{object_ref:hash('d'),byte_count:512}},
            source_pins:ParentCurrentDigests {prepared_execution_digest:pin('1'),accepted_charge_field_digest:pin('2'),accepted_source_state_digest:pin('3'),
                view_identity_digest:pin('4'),current_balance_certificate_digest:pin('5')},
            source_object_segments:vec![FemObjectSegmentIR{object_id:"antenna".into(),geometry_id:Some("antenna".into()),node_start:0,node_count:count(mesh.nodes.len()),
                element_start:0,element_count:count(mesh.cell_count()),boundary_face_start:0,boundary_face_count:count(mesh.facet_count())}],
            source_mesh:mesh,prepared_source:prepared,authored_input_preimage:input,
            source_preparation:AntennaSourcePreparationReceiptPinsIR {receipt_schema_version:"task_preparation_receipt.v1".into(),run_id:"run-source".into(),step_id:"source-step".into(),
                preparation_id:format!("prep-{task}"),task_id:task,input_fingerprint:hash('6'),plan_fingerprint:pin('7'),payload_sha256:hash('8'),receipt_sha256:hash('9')},
        }
    }
    #[test]
    fn sorted_material_records_follow_geometry_markers_for_microstrip_and_gsg() {
        for gsg in [false, true] {
            let document = fixture_for(gsg);
            let geometry: fullmag_ir::GeometryEntryIR = serde_json::from_value(document.authored_input_preimage["geometry"].clone()).unwrap();
            let markers = source_part_markers(&geometry).unwrap();
            assert_eq!(markers.len(), if gsg {5} else {4});
            assert!(document.prepared_source.material_parts.windows(2).all(|parts| parts[0].part_id < parts[1].part_id));
            assert!(document.prepared_source.material_parts.iter().enumerate().any(|(index, part)| markers[part.part_id.as_str()] != (index+1) as u32));
            let bytes = document.encode().unwrap();
            assert_eq!(AntennaSourcePreparationAssetDocument::decode(&bytes).unwrap(), document);
        }
    }
    #[test]
    fn marker_mapping_rejects_swapped_cells_despite_complete_nonoverlapping_coverage() {
        for gsg in [false, true] {
            let mut document = fixture_for(gsg);
            document.validate().unwrap();
            let (first, rest) = document.prepared_source.material_parts.split_at_mut(1);
            std::mem::swap(&mut first[0].element_ordinals, &mut rest[0].element_ordinals);
            let error = document.validate().unwrap_err();
            assert!(error.message.contains("actual markers"), "{gsg}: {error}");
        }
    }
    #[test]
    fn marker_mapping_rejects_unknown_or_duplicate_geometry_part_ids() {
        for gsg in [false, true] {
            let mut document = fixture_for(gsg);
            document.prepared_source.material_parts[0].part_id = "foreign-part".into();
            assert!(document.validate().unwrap_err().message.contains("absent from source geometry"));
            let mut duplicate = fixture_for(gsg);
            duplicate.prepared_source.material_parts[1].part_id = duplicate.prepared_source.material_parts[0].part_id.clone();
            assert!(duplicate.validate().unwrap_err().message.contains("duplicated"));
        }
    }
    #[test]
    fn input_only_document_roundtrips_without_result_arrays() {
        let document = fixture(); let bytes = document.encode().unwrap();
        assert_eq!(AntennaSourcePreparationAssetDocument::decode(&bytes).unwrap(), document);
        let wire: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(wire.as_object().unwrap().len(),8);
        for forbidden in ["potential", "j_raw", "h_raw", "claims", "journal", "payloads"] { assert!(wire.get(forbidden).is_none()); }
    }
    #[test]
    fn rejects_result_injection_unknown_nested_fields_and_duplicate_keys() {
        let bytes = fixture().encode().unwrap(); let wire: Value = serde_json::from_slice(&bytes).unwrap();
        for case in ["result", "mesh", "segment", "receipt", "schema", "incomplete", "input"] {
            let mut wrong = wire.clone();
            match case {
                "result" => wrong["j_raw"] = serde_json::json!([1,2,3]),
                "mesh" => wrong["source_mesh"]["cells"]["h_raw"] = serde_json::json!([]),
                "segment" => wrong["source_object_segments"][0]["claim"] = serde_json::json!({}),
                "receipt" => wrong["source_preparation"]["receipt_sha256"] = "A".repeat(64).into(),
                "schema" => wrong["schema_version"] = "antenna_field_solution.v2".into(),
                "incomplete" => {wrong["source_mesh"]["nodes"].as_array_mut().unwrap().pop();},
                "input" => {wrong["authored_input_preimage"].as_object_mut().unwrap().remove("solver");},
                _ => unreachable!(),
            }
            assert!(AntennaSourcePreparationAssetDocument::decode(&serde_json::to_vec(&wrong).unwrap()).is_err(), "{case}");
        }
        let duplicate = format!("{{\"schema_version\":\"{}\",{}", ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA, std::str::from_utf8(&bytes).unwrap().trim_start_matches('{'));
        assert!(AntennaSourcePreparationAssetDocument::decode(duplicate.as_bytes()).is_err());
        assert!(AntennaSourcePreparationAssetDocument::decode(&vec![b' '; MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES+1]).is_err());
    }
}

#[cfg(test)]
mod typed_preimage_tests {
    use super::*;
    #[test]
    fn rehashed_unknown_nested_preimage_is_not_an_accepted_input_document() {
        let mut document = super::tests::fixture();
        document.validate().unwrap();
        document.authored_input_preimage["solver"]["unexpected"] = true.into();
        let digest = fullmag_ir::transport_identity::tagged_json_digest(&document.authored_input_preimage).unwrap();
        document.prepared_source.revision = digest.clone(); document.prepared_source.authored_input_digest = digest.clone();
        let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {revision,digest:closure_digest,..} = &mut document.prepared_source.closure else {panic!()};
        *revision = digest.clone(); *closure_digest = digest;
        assert!(document.validate().is_err());
        assert!(AntennaSourcePreparationAssetDocument::decode(&serde_json::to_vec(&document).unwrap()).is_err());
    }

    #[test]
    fn typed_projection_refuses_unknown_fields_even_when_legacy_serde_ignores_them() {
        let solver = serde_json::json!({"engine":"cg","linear":{"relative_tolerance":1e-12,"absolute_tolerance":0.,"max_iterations":100},
            "physical_residual_version":"charge_balance_integrated_l2.v1","operator_version":"fem_charge_conforming_h1_p1.transparent.v1"});
        typed_fields::<fullmag_ir::ChargeSolverPolicyIR>(&solver,false).unwrap();
        let mut unknown = solver.clone(); unknown["unexpected"] = true.into();
        assert!(typed_fields::<fullmag_ir::ChargeSolverPolicyIR>(&unknown,false).is_err());
        let mut nested = solver; nested["linear"]["unexpected"] = true.into();
        assert!(typed_fields::<fullmag_ir::ChargeSolverPolicyIR>(&nested,false).is_err());
    }
}

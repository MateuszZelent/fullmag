//! Raw typed wire representation for a 2D waveguide cross-section mesh.
//!
//! Deserialization enforces only the wire shape. It does not validate geometry,
//! topology, region mapping, boundary invariants, or provider readiness.

use serde::{Deserialize, Serialize};

/// The only schema token currently defined for a raw cross-section mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum WaveguideCrossSectionMeshSchemaIR {
    V1,
}

impl TryFrom<String> for WaveguideCrossSectionMeshSchemaIR {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "fullmag.waveguide-cross-section-mesh.v1" => Ok(Self::V1),
            _ => Err("unsupported waveguide cross-section mesh schema"),
        }
    }
}

impl From<WaveguideCrossSectionMeshSchemaIR> for String {
    fn from(value: WaveguideCrossSectionMeshSchemaIR) -> Self {
        match value {
            WaveguideCrossSectionMeshSchemaIR::V1 => {
                "fullmag.waveguide-cross-section-mesh.v1".to_string()
            }
        }
    }
}

/// Raw cross-section mesh payload. Successful deserialization is not a mesh
/// validity certificate and does not authorize solver/provider admission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideCrossSectionMeshIR {
    pub schema: WaveguideCrossSectionMeshSchemaIR,
    pub nodes_uv_m: Vec<[f64; 2]>,
    pub triangles: Vec<WaveguideCrossSectionTriangleIR>,
    pub edges: Vec<WaveguideCrossSectionEdgeIR>,
    pub regions: Vec<WaveguideCrossSectionRegionIR>,
    pub boundary_components: Vec<WaveguideCrossSectionBoundaryComponentIR>,
}

/// Raw P1 triangle connectivity. Node and region references are not resolved here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideCrossSectionTriangleIR {
    pub nodes: [u64; 3],
    pub region_id: String,
}

/// A canonical node pair and the triangle-side incidences that refer to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideCrossSectionEdgeIR {
    pub nodes: [u64; 2],
    pub incidences: Vec<WaveguideCrossSectionHalfEdgeIR>,
}

/// A raw directed triangle side identified by triangle and local side indices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideCrossSectionHalfEdgeIR {
    pub triangle_index: u64,
    pub local_edge_index: WaveguideLocalEdgeIndex,
}

/// Checked local side index serialized as the wire integer 0, 1, or 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct WaveguideLocalEdgeIndex(u8);

impl WaveguideLocalEdgeIndex {
    /// Return the wire side index after construction has checked its range.
    pub const fn as_u8(self) -> u8 {
        self.0
    }
}

impl TryFrom<u8> for WaveguideLocalEdgeIndex {
    type Error = &'static str;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value <= 2 {
            Ok(Self(value))
        } else {
            Err("local edge index must be 0, 1, or 2")
        }
    }
}

impl From<WaveguideLocalEdgeIndex> for u8 {
    fn from(value: WaveguideLocalEdgeIndex) -> Self {
        value.0
    }
}

/// Region references carried by the raw mesh descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WaveguideCrossSectionRegionIR {
    Magnetic {
        region_id: String,
        object_id: String,
        material_id: String,
    },
    Air {
        region_id: String,
        object_id: String,
    },
}

/// The declared role of an ordered region contour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum WaveguideCrossSectionLoopKindIR {
    Outer,
    Hole,
}

impl TryFrom<String> for WaveguideCrossSectionLoopKindIR {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "outer" => Ok(Self::Outer),
            "hole" => Ok(Self::Hole),
            _ => Err("unsupported waveguide cross-section loop kind"),
        }
    }
}

impl From<WaveguideCrossSectionLoopKindIR> for String {
    fn from(value: WaveguideCrossSectionLoopKindIR) -> Self {
        match value {
            WaveguideCrossSectionLoopKindIR::Outer => "outer".to_string(),
            WaveguideCrossSectionLoopKindIR::Hole => "hole".to_string(),
        }
    }
}

/// Raw ordered contour data. Closure and orientation are not checked here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideCrossSectionBoundaryComponentIR {
    pub boundary_component_id: String,
    pub region_id: String,
    pub loop_kind: WaveguideCrossSectionLoopKindIR,
    pub half_edges: Vec<WaveguideCrossSectionHalfEdgeIR>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map, Value};

    const FIXTURE: &str = include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");

    fn fixture_value() -> Value {
        serde_json::from_str(FIXTURE).expect("shared mesh fixture must be valid JSON")
    }

    fn reject(value: Value, description: &str) {
        assert!(
            serde_json::from_value::<WaveguideCrossSectionMeshIR>(value).is_err(),
            "{description} must be rejected"
        );
    }

    fn object_at_pointer<'a>(root: &'a mut Value, pointer: &str) -> &'a mut Map<String, Value> {
        let value = if pointer.is_empty() {
            root
        } else {
            root.pointer_mut(pointer).expect("fixture object pointer")
        };
        value
            .as_object_mut()
            .expect("fixture path must name an object")
    }

    fn assert_object_rejects_missing_null_and_unknown(path: &str, fields: &[&str]) {
        for field in fields {
            let mut missing = fixture_value();
            assert!(
                object_at_pointer(&mut missing, path)
                    .remove(*field)
                    .is_some(),
                "fixture must contain {path}.{field}"
            );
            reject(missing, &format!("{path}.{field} missing"));

            let mut null = fixture_value();
            object_at_pointer(&mut null, path).insert((*field).to_string(), Value::Null);
            reject(null, &format!("{path}.{field} null"));
        }

        let mut unknown = fixture_value();
        object_at_pointer(&mut unknown, path).insert("unexpected_field".to_string(), Value::Null);
        reject(unknown, &format!("{path} unknown field"));
    }

    #[test]
    fn shared_fixture_deserializes_and_round_trips_through_serde() {
        let mesh: WaveguideCrossSectionMeshIR =
            serde_json::from_str(FIXTURE).expect("fixture must deserialize");
        assert_eq!(mesh.schema, WaveguideCrossSectionMeshSchemaIR::V1);
        assert_eq!(serde_json::to_value(&mesh).unwrap(), fixture_value());
    }

    #[test]
    fn every_object_requires_fields_and_rejects_unknown_fields() {
        assert_object_rejects_missing_null_and_unknown(
            "",
            &[
                "schema",
                "nodes_uv_m",
                "triangles",
                "edges",
                "regions",
                "boundary_components",
            ],
        );
        assert_object_rejects_missing_null_and_unknown("/triangles/0", &["nodes", "region_id"]);
        assert_object_rejects_missing_null_and_unknown("/edges/0", &["nodes", "incidences"]);
        assert_object_rejects_missing_null_and_unknown(
            "/edges/0/incidences/0",
            &["triangle_index", "local_edge_index"],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/regions/0",
            &["kind", "region_id", "object_id", "material_id"],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/regions/1",
            &["kind", "region_id", "object_id"],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/boundary_components/0",
            &[
                "boundary_component_id",
                "region_id",
                "loop_kind",
                "half_edges",
            ],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/boundary_components/1",
            &[
                "boundary_component_id",
                "region_id",
                "loop_kind",
                "half_edges",
            ],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/boundary_components/2",
            &[
                "boundary_component_id",
                "region_id",
                "loop_kind",
                "half_edges",
            ],
        );
        assert_object_rejects_missing_null_and_unknown(
            "/boundary_components/0/half_edges/0",
            &["triangle_index", "local_edge_index"],
        );
    }

    #[test]
    fn schema_and_region_kind_accept_only_declared_tokens() {
        let mut unknown_schema = fixture_value();
        unknown_schema["schema"] = json!("fullmag.waveguide-cross-section-mesh.v2");
        reject(unknown_schema, "unknown schema");

        let mut unknown_kind = fixture_value();
        unknown_kind["regions"][0]["kind"] = json!("plasma");
        reject(unknown_kind, "unknown region kind");

        let mut air_with_material = fixture_value();
        air_with_material["regions"][1]["material_id"] = json!("material-air");
        reject(air_with_material, "air material_id");
    }

    #[test]
    fn unit_enum_wire_tokens_require_strings_and_declared_values() {
        for invalid in [
            json!({"fullmag.waveguide-cross-section-mesh.v1": null}),
            json!(true),
            json!(1),
            json!([]),
        ] {
            assert!(
                serde_json::from_value::<WaveguideCrossSectionMeshSchemaIR>(invalid).is_err(),
                "schema token must be a string"
            );
        }

        for invalid in [json!({"outer": null}), json!(true), json!(1), json!([])] {
            assert!(
                serde_json::from_value::<WaveguideCrossSectionLoopKindIR>(invalid).is_err(),
                "loop kind must be a string"
            );
        }

        let mut unknown_loop_kind = fixture_value();
        unknown_loop_kind["boundary_components"][0]["loop_kind"] = json!("internal");
        reject(unknown_loop_kind, "unknown loop kind");
    }

    #[test]
    fn fixed_arrays_reject_lengths_other_than_the_wire_shape() {
        for (pointer, replacement) in [
            ("/nodes_uv_m/0", json!([0.0, 0.0, 0.0])),
            ("/triangles/0/nodes", json!([0, 1])),
            ("/triangles/0/nodes", json!([0, 1, 2, 3])),
            ("/edges/0/nodes", json!([0, 1, 2])),
            ("/edges/0/nodes", json!([0])),
        ] {
            let mut value = fixture_value();
            *value.pointer_mut(pointer).expect("fixture array pointer") = replacement;
            reject(value, &format!("invalid array at {pointer}"));
        }
    }

    #[test]
    fn local_edge_index_round_trips_only_wire_values_zero_through_two() {
        for value in 0_u8..=2 {
            let encoded = value.to_string();
            let parsed: WaveguideLocalEdgeIndex =
                serde_json::from_str(&encoded).expect("declared local edge index");
            assert_eq!(parsed.as_u8(), value);
            assert_eq!(serde_json::to_string(&parsed).unwrap(), encoded);
        }
        assert!(WaveguideLocalEdgeIndex::try_from(3).is_err());

        for invalid in ["3", "-1", "1.5", "null"] {
            assert!(
                serde_json::from_str::<WaveguideLocalEdgeIndex>(invalid).is_err(),
                "{invalid} must not deserialize as a local edge index"
            );
        }
    }
}

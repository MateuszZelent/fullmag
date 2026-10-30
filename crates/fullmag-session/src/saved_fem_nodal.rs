//! File contracts for saved FEM nodal geometry and per-array bindings.
//!
//! These payloads declare data layout and producer semantics. They do not prove
//! native solver DOF ordering, execution, or scientific validity.

use crate::solution_field_geometry::{
    serialize_saved_mesh, SavedFieldGeometryRef, SavedFieldRepresentationEvidence,
    MAX_FEM_P1_GEOMETRY_BYTES, MAX_FEM_P1_GEOMETRY_SHAPE_BYTES,
};
use anyhow::{bail, Context, Result};
use fullmag_ir::MeshIR;
use fullmag_quantities::{
    fem_nodal_field::FemP1NodalFieldSemantics, FieldSampleLocation, QuantityId,
};
use serde::{Deserialize, Serialize};

pub const FEM_P1_MESH_GEOMETRY_SCHEMA: &str = "fullmag.fem_p1_mesh_geometry.v1";
pub const FEM_NODAL_ARRAY_BINDING_SCHEMA: &str = "fullmag.zarr_fem_nodal_binding.v1";
pub const FEM_NODAL_OBJECT_DIRECTORY: &str = ".fullmag_geometry";

pub const MAX_FEM_NODAL_SEMANTICS_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARRAY_PATH_BYTES: usize = 4096;

/// Storage order of a real nodal array in its Zarr array path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FemNodalStorageLayout {
    AosNodeMajor,
    SoaComponentMajor,
}

impl FemNodalStorageLayout {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AosNodeMajor => "aos_node_major",
            Self::SoaComponentMajor => "soa_component_major",
        }
    }
}

/// Shared FEM mesh geometry with no quantity-specific support semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedFemP1MeshGeometry {
    pub schema_version: String,
    pub coordinate_unit: String,
    pub representation_evidence: SavedFieldRepresentationEvidence,
    #[serde(serialize_with = "serialize_saved_mesh")]
    pub mesh: MeshIR,
}

impl SavedFemP1MeshGeometry {
    /// Validate the canonical mesh payload and its existing FEM shape budgets.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FEM_P1_MESH_GEOMETRY_SCHEMA
            || self.coordinate_unit != "m"
            || self.representation_evidence != SavedFieldRepresentationEvidence::NotVerified
        {
            bail!("saved FEM P1 mesh geometry schema, unit, or evidence is invalid");
        }
        if self.mesh.nodes.len() > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 24) as usize
            || self.mesh.cells.len() > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 16) as usize
            || self.mesh.facets.len() > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 12) as usize
            || self
                .mesh
                .nodes
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            bail!("saved FEM P1 mesh exceeds its shape budget or contains nonfinite nodes");
        }
        fullmag_ir::validate_mesh_for_execution(&self.mesh)
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
            .context("validating saved FEM mesh structure")?;
        Ok(())
    }
}

/// Immutable metadata binding one Zarr nodal array to shared mesh and semantics objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedFemNodalArrayBinding {
    pub schema_version: String,
    /// Relative to the owning Zarr root, never a host filesystem path.
    pub array_path: String,
    pub quantity_id: QuantityId,
    pub unit: String,
    pub component_count: usize,
    pub node_count: usize,
    pub cell_count: usize,
    pub field_layout: FemNodalStorageLayout,
    pub topology_fingerprint: String,
    pub mesh: SavedFieldGeometryRef,
    pub semantics: SavedFieldGeometryRef,
}

impl SavedFemNodalArrayBinding {
    /// Validate only fields and references intrinsic to this binding.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FEM_NODAL_ARRAY_BINDING_SCHEMA {
            bail!("unsupported FEM nodal array binding schema");
        }
        validate_array_path(&self.array_path, self.quantity_id)?;
        if self.unit.trim().is_empty() {
            bail!("FEM nodal array unit must not be empty");
        }
        if !matches!(self.component_count, 1 | 3) {
            bail!("FEM nodal array component_count must be 1 or 3");
        }
        validate_node_cell_counts(self.node_count, self.cell_count)?;
        validate_topology_fingerprint(&self.topology_fingerprint)?;
        validate_geometry_reference(
            &self.mesh,
            FEM_P1_MESH_GEOMETRY_SCHEMA,
            MAX_FEM_P1_GEOMETRY_BYTES,
        )?;
        validate_geometry_reference(
            &self.semantics,
            FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT,
            MAX_FEM_NODAL_SEMANTICS_BYTES,
        )?;
        Ok(())
    }

    /// Verify both referenced objects and their quantity-specific array binding.
    pub fn parse_payloads(
        &self,
        mesh_bytes: &[u8],
        semantics_bytes: &[u8],
    ) -> Result<(SavedFemP1MeshGeometry, FemP1NodalFieldSemantics)> {
        self.validate()?;
        let mesh = parse_saved_fem_mesh_geometry(mesh_bytes, &self.mesh)?;
        let semantics = parse_saved_fem_nodal_semantics(semantics_bytes, &self.semantics)?;
        self.validate_payload_structure(&mesh, &semantics)?;
        Ok((mesh, semantics))
    }

    /// Validate typed structure only, for producers which already computed both references.
    /// This does not authenticate bytes against object hashes. File readers must use
    /// `parse_payloads`, which verifies both references before checking structure.
    pub fn validate_payload_structure(
        &self,
        mesh: &SavedFemP1MeshGeometry,
        semantics: &FemP1NodalFieldSemantics,
    ) -> Result<()> {
        self.validate()?;
        mesh.validate()?;
        semantics
            .validate(
                self.quantity_id,
                &self.topology_fingerprint,
                self.node_count,
            )
            .context("validating bound FEM nodal field semantics")?;

        if mesh.mesh.nodes.len() != self.node_count
            || mesh.mesh.cells.len() != self.cell_count
            || mesh.mesh.topology_fingerprint_v6() != self.topology_fingerprint
        {
            bail!("saved FEM mesh counts or topology differ from the nodal array binding");
        }
        let descriptor = &semantics.descriptor;
        let expected_components = match descriptor.tensor_rank {
            0 => 1,
            1 => 3,
            _ => bail!("FEM nodal descriptor has an unsupported tensor rank"),
        };
        if descriptor.sample_location != FieldSampleLocation::Node
            || descriptor.unit != self.unit
            || descriptor.quantity_id != self.quantity_id
            || expected_components != self.component_count
        {
            bail!("FEM nodal descriptor differs from array quantity, unit, or component count");
        }
        Ok(())
    }
}

fn validate_array_path(path: &str, quantity: QuantityId) -> Result<()> {
    if path.is_empty()
        || path.len() > MAX_ARRAY_PATH_BYTES
        || path.contains('\\')
        || path.contains('\0')
        || path.contains(':')
    {
        bail!("FEM nodal array path is empty, oversized, or contains a forbidden character");
    }
    let components: Vec<&str> = path.split('/').collect();
    if components.len() != 4
        || components[0] != "stages"
        || components[2] != "fields"
        || components[3] != quantity.as_str()
        || components
            .iter()
            .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        bail!("FEM nodal array path must be stages/<stage-dir>/fields/<canonical quantity>");
    }
    Ok(())
}

fn validate_node_cell_counts(node_count: usize, cell_count: usize) -> Result<()> {
    if node_count == 0 {
        bail!("FEM nodal node_count must be positive");
    }
    if node_count > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 24) as usize
        || cell_count > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 16) as usize
    {
        bail!("FEM nodal array counts exceed the existing FEM geometry shape budget");
    }
    Ok(())
}

fn validate_topology_fingerprint(value: &str) -> Result<()> {
    let hex = value
        .strip_prefix("sha256:")
        .context("FEM topology fingerprint must use the canonical sha256 prefix")?;
    if value != format!("sha256:{hex}")
        || hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("FEM topology fingerprint must be a canonical lowercase SHA-256 digest");
    }
    Ok(())
}

fn validate_geometry_reference(
    reference: &SavedFieldGeometryRef,
    expected_schema: &str,
    max_bytes: u64,
) -> Result<()> {
    if reference.schema_id != expected_schema {
        bail!("saved FEM geometry reference has the wrong schema id");
    }
    crate::cas::validate_hash(&reference.object_ref)?;
    if reference.byte_length == 0 || reference.byte_length > max_bytes {
        bail!("saved FEM geometry reference length is empty or exceeds its byte budget");
    }
    Ok(())
}

/// Derive an immutable object path from a validated hash reference.
pub fn object_relative_path(reference: &SavedFieldGeometryRef) -> Result<String> {
    let max_bytes = match reference.schema_id.as_str() {
        FEM_P1_MESH_GEOMETRY_SCHEMA => MAX_FEM_P1_GEOMETRY_BYTES,
        FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT => MAX_FEM_NODAL_SEMANTICS_BYTES,
        _ => bail!("unsupported FEM nodal immutable object schema"),
    };
    validate_geometry_reference(reference, &reference.schema_id, max_bytes)?;
    Ok(format!(
        "{FEM_NODAL_OBJECT_DIRECTORY}/{}.json",
        reference.object_ref
    ))
}

/// Parse and verify one canonical immutable shared mesh payload.
pub fn parse_saved_fem_mesh_geometry(
    bytes: &[u8],
    reference: &SavedFieldGeometryRef,
) -> Result<SavedFemP1MeshGeometry> {
    validate_geometry_reference(
        reference,
        FEM_P1_MESH_GEOMETRY_SCHEMA,
        MAX_FEM_P1_GEOMETRY_BYTES,
    )?;
    validate_payload_bytes(bytes, reference)?;
    let wire: serde_json::Value = serde_json::from_slice(bytes)?;
    let geometry: SavedFemP1MeshGeometry = serde_json::from_value(wire.clone())?;
    if serde_json::to_value(&geometry)? != wire {
        bail!("saved FEM mesh geometry is not the canonical typed MeshIR representation");
    }
    geometry.validate()?;
    Ok(geometry)
}

/// Parse and verify one canonical immutable nodal semantics payload.
pub fn parse_saved_fem_nodal_semantics(
    bytes: &[u8],
    reference: &SavedFieldGeometryRef,
) -> Result<FemP1NodalFieldSemantics> {
    validate_geometry_reference(
        reference,
        FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT,
        MAX_FEM_NODAL_SEMANTICS_BYTES,
    )?;
    validate_payload_bytes(bytes, reference)?;
    let wire: serde_json::Value = serde_json::from_slice(bytes)?;
    let semantics: FemP1NodalFieldSemantics = serde_json::from_value(wire.clone())?;
    if serde_json::to_value(&semantics)? != wire {
        bail!("saved FEM nodal semantics is not canonical typed JSON");
    }
    semantics
        .validate(
            semantics.quantity_id,
            &semantics.descriptor.topology_id,
            semantics.active_node_mask.len(),
        )
        .context("validating saved FEM nodal semantics")?;
    Ok(semantics)
}

fn validate_payload_bytes(bytes: &[u8], reference: &SavedFieldGeometryRef) -> Result<()> {
    if bytes.len() as u64 != reference.byte_length
        || crate::hex_sha256(bytes) != reference.object_ref
    {
        bail!("saved FEM geometry payload length or hash differs from its reference");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn mesh() -> MeshIR {
        MeshIR::from_legacy_tet4(
            "saved-nodal-tet".into(),
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
            vec![1; 4],
            vec![],
            vec![],
            HashMap::new(),
        )
    }

    fn mesh_geometry(mesh: MeshIR) -> SavedFemP1MeshGeometry {
        SavedFemP1MeshGeometry {
            schema_version: FEM_P1_MESH_GEOMETRY_SCHEMA.into(),
            coordinate_unit: "m".into(),
            representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
            mesh,
        }
    }

    fn semantics(quantity: QuantityId, mesh: &MeshIR, mask: Vec<bool>) -> FemP1NodalFieldSemantics {
        FemP1NodalFieldSemantics::new(
            quantity,
            &mesh.topology_fingerprint_v6(),
            mesh.nodes.len(),
            mask,
        )
        .expect("valid nodal semantics")
    }

    fn reference(schema_id: &str, bytes: &[u8]) -> SavedFieldGeometryRef {
        SavedFieldGeometryRef {
            schema_id: schema_id.into(),
            object_ref: crate::hex_sha256(bytes),
            byte_length: bytes.len() as u64,
        }
    }

    fn binding_for(
        geometry: &SavedFemP1MeshGeometry,
        semantics: &FemP1NodalFieldSemantics,
    ) -> SavedFemNodalArrayBinding {
        let mesh_bytes = serde_json::to_vec(geometry).expect("mesh json");
        let semantics_bytes = serde_json::to_vec(semantics).expect("semantics json");
        SavedFemNodalArrayBinding {
            schema_version: FEM_NODAL_ARRAY_BINDING_SCHEMA.into(),
            array_path: format!("stages/fem-0001/fields/{}", semantics.quantity_id.as_str()),
            quantity_id: semantics.quantity_id,
            unit: semantics.descriptor.unit.clone(),
            component_count: if semantics.descriptor.tensor_rank == 0 {
                1
            } else {
                3
            },
            node_count: geometry.mesh.nodes.len(),
            cell_count: geometry.mesh.cells.len(),
            field_layout: FemNodalStorageLayout::AosNodeMajor,
            topology_fingerprint: geometry.mesh.topology_fingerprint_v6(),
            mesh: reference(FEM_P1_MESH_GEOMETRY_SCHEMA, &mesh_bytes),
            semantics: reference(FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT, &semantics_bytes),
        }
    }

    #[test]
    fn referenced_payloads_reject_a_different_valid_support_mask() {
        let geometry = mesh_geometry(mesh());
        let original = semantics(QuantityId::M, &geometry.mesh, vec![true, false, true, true]);
        let substituted = semantics(QuantityId::M, &geometry.mesh, vec![false, true, true, true]);
        let binding = binding_for(&geometry, &original);
        let mesh_bytes = serde_json::to_vec(&geometry).unwrap();
        let original_bytes = serde_json::to_vec(&original).unwrap();
        let substituted_bytes = serde_json::to_vec(&substituted).unwrap();
        binding
            .parse_payloads(&mesh_bytes, &original_bytes)
            .unwrap();
        assert!(binding
            .parse_payloads(&mesh_bytes, &substituted_bytes)
            .is_err());
    }

    #[test]
    fn shared_mesh_binds_magnetic_and_full_domain_fields_with_distinct_support() {
        let geometry = mesh_geometry(mesh());
        geometry.validate().expect("valid shared FEM mesh");
        let m = semantics(QuantityId::M, &geometry.mesh, vec![true, false, true, true]);
        let h_eff = semantics(QuantityId::HEff, &geometry.mesh, vec![true; 4]);
        let m_binding = binding_for(&geometry, &m);
        let h_eff_binding = binding_for(&geometry, &h_eff);

        m_binding
            .validate_payload_structure(&geometry, &m)
            .expect("M binding matches mesh and support");
        h_eff_binding
            .validate_payload_structure(&geometry, &h_eff)
            .expect("H_eff binding matches full mesh support");
        assert_ne!(m.active_node_mask, h_eff.active_node_mask);
        assert_eq!(m_binding.mesh, h_eff_binding.mesh);
        assert_ne!(m_binding.semantics, h_eff_binding.semantics);
        assert_eq!(
            FemNodalStorageLayout::AosNodeMajor.as_str(),
            "aos_node_major"
        );
        assert_eq!(
            FemNodalStorageLayout::SoaComponentMajor.as_str(),
            "soa_component_major"
        );
    }

    #[test]
    fn object_paths_are_derived_only_from_validated_references() {
        let geometry = mesh_geometry(mesh());
        let bytes = serde_json::to_vec(&geometry).unwrap();
        let reference = reference(FEM_P1_MESH_GEOMETRY_SCHEMA, &bytes);
        assert_eq!(
            object_relative_path(&reference).unwrap(),
            format!("{FEM_NODAL_OBJECT_DIRECTORY}/{}.json", reference.object_ref)
        );

        let mut invalid = reference.clone();
        invalid.schema_id = "arbitrary".into();
        assert!(object_relative_path(&invalid).is_err());
        invalid = reference;
        invalid.object_ref = "A".repeat(64);
        assert!(object_relative_path(&invalid).is_err());
    }

    #[test]
    fn binding_validates_reference_schema_hash_and_length_budgets() {
        let geometry = mesh_geometry(mesh());
        let value = semantics(QuantityId::HEff, &geometry.mesh, vec![true; 4]);
        let original = binding_for(&geometry, &value);

        let mut bad = original.clone();
        bad.mesh.object_ref = "G".repeat(64);
        assert!(bad.validate().is_err());

        bad = original.clone();
        bad.semantics.object_ref = "G".repeat(64);
        assert!(bad.validate().is_err());

        bad = original.clone();
        bad.mesh.byte_length = MAX_FEM_P1_GEOMETRY_BYTES + 1;
        assert!(bad.validate().is_err());

        bad = original.clone();
        bad.semantics.schema_id = FEM_P1_MESH_GEOMETRY_SCHEMA.into();
        assert!(bad.validate().is_err());

        bad = original;
        bad.semantics.byte_length = MAX_FEM_NODAL_SEMANTICS_BYTES + 1;
        assert!(bad.validate().is_err());
    }

    #[test]
    fn parsers_reject_hash_length_schema_drift_and_unknown_mesh_fields() {
        let geometry = mesh_geometry(mesh());
        let bytes = serde_json::to_vec(&geometry).unwrap();
        let valid_ref = reference(FEM_P1_MESH_GEOMETRY_SCHEMA, &bytes);
        parse_saved_fem_mesh_geometry(&bytes, &valid_ref).expect("canonical mesh payload");

        let mut bad = valid_ref.clone();
        bad.object_ref = "0".repeat(64);
        assert!(parse_saved_fem_mesh_geometry(&bytes, &bad).is_err());
        bad = valid_ref.clone();
        bad.byte_length += 1;
        assert!(parse_saved_fem_mesh_geometry(&bytes, &bad).is_err());
        bad = valid_ref.clone();
        bad.schema_id = "fullmag.other.v1".into();
        assert!(parse_saved_fem_mesh_geometry(&bytes, &bad).is_err());

        let mut wire = serde_json::to_value(&geometry).unwrap();
        wire["mesh"]["unrecognized_mesh_field"] = serde_json::Value::Bool(true);
        let unknown_mesh_bytes = serde_json::to_vec(&wire).unwrap();
        let unknown_ref = reference(FEM_P1_MESH_GEOMETRY_SCHEMA, &unknown_mesh_bytes);
        assert!(parse_saved_fem_mesh_geometry(&unknown_mesh_bytes, &unknown_ref).is_err());
    }

    #[test]
    fn semantics_parser_checks_canonical_semantics_and_payload_identity() {
        let geometry = mesh_geometry(mesh());
        let value = semantics(QuantityId::HEff, &geometry.mesh, vec![true; 4]);
        let bytes = serde_json::to_vec(&value).unwrap();
        let reference = reference(FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT, &bytes);
        let parsed = parse_saved_fem_nodal_semantics(&bytes, &reference).unwrap();
        assert_eq!(parsed, value);
        let mut bad_ref = reference.clone();
        bad_ref.object_ref = "0".repeat(64);
        assert!(parse_saved_fem_nodal_semantics(&bytes, &bad_ref).is_err());
        bad_ref = reference.clone();
        bad_ref.byte_length += 1;
        assert!(parse_saved_fem_nodal_semantics(&bytes, &bad_ref).is_err());
        bad_ref = reference.clone();
        bad_ref.schema_id = FEM_P1_MESH_GEOMETRY_SCHEMA.into();
        assert!(parse_saved_fem_nodal_semantics(&bytes, &bad_ref).is_err());

        let mut wire = serde_json::to_value(&value).unwrap();
        wire["descriptor"]["unit"] = serde_json::Value::String("T".into());
        let changed_bytes = serde_json::to_vec(&wire).unwrap();
        let changed_ref = reference(FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT, &changed_bytes);
        assert!(parse_saved_fem_nodal_semantics(&changed_bytes, &changed_ref).is_err());
    }

    #[test]
    fn binding_rejects_traversal_and_wrong_canonical_array_quantity() {
        let geometry = mesh_geometry(mesh());
        let value = semantics(QuantityId::M, &geometry.mesh, vec![true; 4]);
        let mut binding = binding_for(&geometry, &value);
        for path in [
            "",
            "/stages/fem-0001/fields/m",
            "stages/../fields/m",
            "stages/fem-0001/fields/H_eff",
            "stages\\fem-0001\\fields\\m",
            "stages/fem:0001/fields/m",
            "stages/fem-0001/fields/m\0",
        ] {
            binding.array_path = path.into();
            assert!(
                binding.validate().is_err(),
                "path {path:?} must be rejected"
            );
        }
        binding.array_path = format!("stages/{}/fields/m", "x".repeat(MAX_ARRAY_PATH_BYTES));
        assert!(binding.validate().is_err());

        binding.array_path = "stages/fem-0001/fields/m".into();
        binding.quantity_id = QuantityId::HEff;
        assert!(binding.validate().is_err());
    }

    #[test]
    fn payload_validation_rejects_unit_quantity_topology_and_count_mismatches() {
        let geometry = mesh_geometry(mesh());
        let value = semantics(QuantityId::HEff, &geometry.mesh, vec![true; 4]);
        let original = binding_for(&geometry, &value);
        original
            .validate_payload_structure(&geometry, &value)
            .expect("matching payloads");

        let mut bad = original.clone();
        bad.unit = "T".into();
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());

        bad = original.clone();
        bad.topology_fingerprint = format!("sha256:{}", "b".repeat(64));
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());

        bad = original.clone();
        bad.node_count += 1;
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());

        bad = original.clone();
        bad.cell_count += 1;
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());

        bad = original.clone();
        bad.component_count = 1;
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());

        let m = semantics(QuantityId::M, &geometry.mesh, vec![true; 4]);
        bad = binding_for(&geometry, &m);
        assert!(bad.validate_payload_structure(&geometry, &value).is_err());
    }
}

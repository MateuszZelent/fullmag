//! Nonmagnetic owned samples share the existing pinned geometry manifest.
use super::*;
use fullmag_quantities::{DatasetFieldDescriptor, FieldNormalization, FieldSampleLocation, QuantityId, ComplexEncoding, FieldFrameKind, FieldValueRepresentation, FieldResolution, FunctionSpaceOrdering};

pub const OWNED_SAMPLE_GEOMETRY_SCHEMA: &str = "fullmag.owned_sample_field_geometry.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnedSampleGeometryRole { SourceNodes, Tet4CellLocalNodes, SampleNodes }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedSampleIdentity {
    /// Decimal u64, never a floating-point identifier. For SampleNodes this
    /// is the explicitly authored sampling ordinal, not a FEM node identity.
    pub stable_id: String,
    pub local_node: Option<u8>,
    pub stable_vertex_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedOwnedSampleFieldGeometry {
    pub schema_version: String,
    pub coordinate_unit: String,
    pub representation_evidence: SavedFieldRepresentationEvidence,
    pub role: OwnedSampleGeometryRole,
    #[serde(serialize_with = "serialize_saved_mesh")]
    pub mesh: MeshIR,
    pub sample_identities: Vec<OwnedSampleIdentity>,
    pub descriptor: DatasetFieldDescriptor,
    pub producer_id: String,
    pub producer_version: String,
}

fn decimal_id(value: &str) -> Result<u64> {
    let id: u64 = value.parse().context("invalid owned sample u64 identity")?;
    if value != id.to_string() { bail!("noncanonical owned sample identity"); }
    Ok(id)
}

impl SavedOwnedSampleFieldGeometry {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != OWNED_SAMPLE_GEOMETRY_SCHEMA || self.coordinate_unit != "m"
            || self.producer_id != "fullmag.closed-loop-inspection" || self.producer_version != "2"
            || self.mesh.nodes.is_empty() || self.mesh.nodes.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 64
            || self.mesh.cells.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 16
            || self.mesh.facets.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 12
            || self.sample_identities.len() != self.mesh.nodes.len()
            || self.mesh.nodes.iter().flatten().any(|v| !v.is_finite()) {
            bail!("owned sample geometry schema, producer or shape budget is invalid");
        }
        self.descriptor.validate().map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let (quantity, unit, components, role_name) = match self.role {
            OwnedSampleGeometryRole::SourceNodes => (QuantityId::VElectric, "V", 1, "source_nodes"),
            OwnedSampleGeometryRole::Tet4CellLocalNodes => (QuantityId::JCharge, "A/m^2", 3, "tet4_cell_local_nodes"),
            OwnedSampleGeometryRole::SampleNodes => (QuantityId::HAnt, "A/m", 3, "sample_nodes"),
        };
        let d = &self.descriptor;
        let space = d.function_space.as_ref().context("owned sample function space missing")?;
        if d.quantity_id != quantity || d.unit != unit || d.sample_location != FieldSampleLocation::Node
            || d.normalization != FieldNormalization::None || d.complex_encoding != ComplexEncoding::Real
            || d.harmonic_convention.is_some() || d.modal_semantics.is_some()
            || d.value_representation != FieldValueRepresentation::PhysicalField || d.resolution != FieldResolution::Quantitative
            || d.frame.kind != FieldFrameKind::Laboratory || d.frame.frame_id != "frame:lab"
            || d.tensor_rank != if components == 1 { 0 } else { 1 }
            || d.active_support.selection.is_some() || d.active_support.support_fingerprint != d.layout_digest
            || d.topology_id != d.layout_digest || space.ordering != FunctionSpaceOrdering::ByNode
            || space.constraints_fingerprint.is_some() || space.partition_fingerprint.is_some() || space.orientation_mapping_ref.is_some()
            || space.space_id != format!("space:inspection-samples:{}", d.layout_digest)
            || d.axes.len() != if components == 1 { 1 } else { 2 }
            || (components == 1 && d.component_axis.is_some())
            || (components == 3 && (d.component_axis.as_deref() != Some("component")
                || d.axes.get(1).map(|a| (a.axis_id.as_str(), a.unit.as_str(), a.length)) != Some(("component", "1", 3))))
            || space.family != "owned_sample_values"
            || space.order != 0 || space.vector_dimension != components
            || space.basis_id != format!("basis:{role_name}:{}", d.layout_digest)
            || d.carrier_id != format!("carrier:{role_name}:{}", d.layout_digest)
            || d.axes.first().map(|a| (a.axis_id.as_str(), a.length)) != Some(("sample", self.mesh.nodes.len() as u64)) || d.axes[0].unit != "1" {
            bail!("owned sample descriptor differs from geometry role or row count");
        }
        // Validate connectivity independently of magnetic support/materials.
        fullmag_ir::validate_mesh_for_execution(&self.mesh)
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
        let tets = self.mesh.cells.require_tet4().map_err(anyhow::Error::msg)?;
        let mut seen = BTreeSet::new();
        let mut source_vertices = std::collections::BTreeMap::new();
        for (index, identity) in self.sample_identities.iter().enumerate() {
            let id = decimal_id(&identity.stable_id)?;
            if !seen.insert((id, identity.local_node)) { bail!("duplicate owned sample identity"); }
            match self.role {
                OwnedSampleGeometryRole::Tet4CellLocalNodes => {
                    let local = identity.local_node.context("cell-local sample lacks local node")?;
                    let vertex = identity.stable_vertex_id.as_deref().context("cell-local sample lacks source vertex")?;
                    let vertex_id = decimal_id(vertex)?;
                    if source_vertices.insert(vertex_id, self.mesh.nodes[index]).is_some_and(|prior| prior != self.mesh.nodes[index]) {
                        bail!("same source vertex has inconsistent cell-local coordinates");
                    }
                    if index % 4 > 0 && self.sample_identities[index-index%4..index].iter().any(|prior| prior.stable_vertex_id.as_deref() == Some(vertex)) {
                        bail!("cell-local sample repeats a source vertex");
                    }
                    if local as usize != index % 4 || self.sample_identities[index - index % 4].stable_id != identity.stable_id {
                        bail!("cell-local sample order or cell identity differs");
                    }
                }
                _ => if (self.role == OwnedSampleGeometryRole::SampleNodes && id != index as u64) || identity.local_node.is_some() || identity.stable_vertex_id.is_some() {
                    bail!("node sample has an unexpected local or source vertex identity");
                },
            }
        }
        if self.role == OwnedSampleGeometryRole::Tet4CellLocalNodes {
            if self.mesh.nodes.len() != tets.len().checked_mul(4).context("local-node shape overflow")? {
                bail!("cell-local sample mesh must contain four owned nodes per cell");
            }
            for (cell, tet) in tets.iter().enumerate() {
                if self.mesh.cells.global_ordinals[cell] != decimal_id(&self.sample_identities[4*cell].stable_id)?
                    || *tet != [4*cell as u32, 4*cell as u32+1, 4*cell as u32+2, 4*cell as u32+3] {
                    bail!("cell-local sample tetrahedra are not exact disjoint row groups");
                }
            }
        }
        Ok(())
    }
}

pub fn validate_saved_owned_sample_tensor(geometry: &SavedOwnedSampleFieldGeometry, tensor: &TensorDescriptor) -> Result<()> {
    geometry.validate()?;
    validate_solution_tensor_descriptor(tensor)?;
    let binding = tensor.field_binding.as_ref().context("owned sample tensor lacks field binding")?;
    if binding.plane != DatasetSlicePlane::Values || binding.descriptor != geometry.descriptor
        || binding.producer_id != geometry.producer_id || binding.producer_version != geometry.producer_version {
        bail!("owned sample geometry differs from pinned tensor descriptor or producer");
    }
    Ok(())
}

pub fn read_saved_owned_sample_geometry(cas: &CasStore, reference: &SavedFieldGeometryRef) -> Result<SavedOwnedSampleFieldGeometry> {
    validate_geometry_ref(reference)?;
    if reference.schema_id != OWNED_SAMPLE_GEOMETRY_SCHEMA { bail!("not owned sample geometry"); }
    let range = cas.get_verified_range(&reference.object_ref, 0, reference.byte_length, MAX_FEM_P1_GEOMETRY_BYTES)?
        .context("owned sample geometry CAS object missing")?;
    if range.object_length != reference.byte_length || crate::hex_sha256(&range.bytes) != reference.object_ref {
        bail!("owned sample geometry CAS length or content differs");
    }
    let wire: serde_json::Value = serde_json::from_slice(&range.bytes)?;
    let geometry: SavedOwnedSampleFieldGeometry = serde_json::from_value(wire.clone())?;
    if serde_json::to_value(&geometry)? != wire { bail!("owned sample mesh is not canonical typed geometry"); }
    geometry.validate()?;
    Ok(geometry)
}

pub fn build_solution_owned_sample_geometry_artifact(cas: &CasStore, solution: &SolutionSet, member_id: &str,
    tensor_artifact: &SolutionArtifactRef, geometry: &SavedOwnedSampleFieldGeometry) -> Result<SolutionArtifactRef> {
    if tensor_artifact.accepted_state.is_some() { bail!("owned samples cannot claim an accepted magnetic state"); }
    let tensor = read_solution_tensor_artifact(cas, tensor_artifact)?;
    validate_saved_owned_sample_tensor(geometry, &tensor)?;
    let dataset = MaterializedDatasetManifest::from_recorded_tensor(solution, member_id, tensor_artifact, &tensor)?;
    let mut writer = BoundedJsonWriter { bytes: Vec::new(), limit: MAX_FEM_P1_GEOMETRY_BYTES as usize };
    serde_json::to_writer(&mut writer, geometry)?;
    let manifest = SolutionFieldGeometryManifest { schema_version: SOLUTION_FIELD_GEOMETRY_SCHEMA.into(),
        source: dataset.field.source, tensor_artifact: tensor_artifact.clone(),
        geometry: SavedFieldGeometryRef { schema_id: OWNED_SAMPLE_GEOMETRY_SCHEMA.into(), object_ref: crate::hex_sha256(&writer.bytes), byte_length: writer.bytes.len() as u64 } };
    manifest.validate()?;
    validate_field_geometry_owner(&manifest, solution, member_id, true)?;
    let member = solution.members.iter().find(|m| m.member_id == member_id).context("owned sample member missing")?;
    let mut existing = None;
    for artifact in &member.artifacts {
        if artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA { continue; }
        let binding = read_solution_field_geometry_manifest(cas, artifact)?;
        if binding.source != manifest.source { continue; }
        if existing.is_some() || binding != manifest { bail!("owned sample geometry replay conflicts or duplicates its exact owner"); }
        let saved = read_saved_owned_sample_geometry(cas, &binding.geometry)?;
        validate_saved_owned_sample_tensor(&saved, &tensor)?;
        existing = Some(artifact.clone());
    }
    if let Some(artifact) = existing { return Ok(artifact); }
    if cas.put(&writer.bytes)? != manifest.geometry.object_ref { bail!("owned sample CAS identity changed"); }
    let mut writer = BoundedJsonWriter { bytes: Vec::new(), limit: MAX_FIELD_GEOMETRY_MANIFEST_BYTES as usize };
    serde_json::to_writer(&mut writer, &manifest)?;
    let object_ref = cas.put(&writer.bytes)?;
    Ok(SolutionArtifactRef { artifact_id: format!("solution-field-geometry-{object_ref}"), kind: SolutionArtifactKind::Other,
        schema_id: SOLUTION_FIELD_GEOMETRY_SCHEMA.into(), object_ref, byte_length: writer.bytes.len() as u64, accepted_state: None })
}

pub fn read_pinned_solution_owned_sample_geometry(store: &SessionStore, pinned: &PinnedSolutionTensorSource)
    -> Result<Option<(SolutionFieldGeometryManifest, SavedOwnedSampleFieldGeometry)>> {
    let resolved = crate::solution_tensor_source::resolve_solution_tensor(store, pinned)?;
    let owner = store.solution_sets().read_revision(&pinned.solution_set_id, pinned.solution_revision)?
        .context("owned sample exact owner revision missing")?;
    let member = owner.members.iter().find(|m| m.member_id == pinned.member_id).context("owned sample member missing")?;
    let mut selected = None;
    for artifact in &member.artifacts {
        if artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA { continue; }
        let manifest = read_solution_field_geometry_manifest(store.cas(), artifact)?;
        if &manifest.source != pinned { continue; }
        if selected.is_some() { bail!("duplicate exact owned sample geometry bindings"); }
        validate_field_geometry_owner(&manifest, &owner, &member.member_id, true)?;
        if manifest.tensor_artifact.accepted_state.is_some() { bail!("owned samples have an accepted magnetic state"); }
        selected = Some(manifest);
    }
    let Some(manifest) = selected else { return Ok(None); };
    let geometry = read_saved_owned_sample_geometry(store.cas(), &manifest.geometry)?;
    validate_saved_owned_sample_tensor(&geometry, &resolved.tensor)?;
    Ok(Some((manifest, geometry)))
}

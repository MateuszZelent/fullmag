//! Immutable geometry for a saved serial FEM H1/P1 magnetization field.
//!
//! A small owner binding references a deduplicated geometry payload. Neither
//! object contains a live path or grants mesh/solver/scientific qualification.

use anyhow::{bail, Context, Result};
use fullmag_ir::MeshIR;
use fullmag_quantities::{
    fem_state_field::FemP1MagnetizationFieldSemantics, DatasetSlicePlane, SolutionArtifactKind,
    SolutionArtifactRef, SolutionSet,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

use crate::materialized_dataset::MaterializedDatasetManifest;
use crate::solution_tensor_source::{
    read_solution_tensor_artifact, validate_solution_tensor_descriptor, PinnedSolutionTensorSource,
    SOLUTION_TENSOR_SCHEMA,
};
use crate::{CasStore, SessionStore, TensorDescriptor};

pub const SOLUTION_FIELD_GEOMETRY_SCHEMA: &str = "fullmag.solution_field_geometry.v1";
pub const FEM_P1_GEOMETRY_SCHEMA: &str = "fullmag.fem_p1_field_geometry.v1";
pub const MAX_FIELD_GEOMETRY_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const MAX_FEM_P1_GEOMETRY_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedFieldRepresentationEvidence {
    /// Canonical geometry/producer metadata does not prove the actual native
    /// local/true DOF map or the representation used by the executed solver.
    NotVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedFieldGeometryRef {
    pub schema_id: String,
    pub object_ref: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedFemP1FieldGeometry {
    pub schema_version: String,
    /// Nodes and periodic translations use the canonical MeshIR SI contract.
    pub coordinate_unit: String,
    pub representation_evidence: SavedFieldRepresentationEvidence,
    #[serde(serialize_with = "serialize_saved_mesh")]
    pub mesh: MeshIR,
    /// Includes the exact active-node mask; original region markers are not
    /// reinterpreted as a magnetic mask by the saved-result consumer.
    pub field_semantics: FemP1MagnetizationFieldSemantics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionFieldGeometryManifest {
    pub schema_version: String,
    pub source: PinnedSolutionTensorSource,
    pub tensor_artifact: SolutionArtifactRef,
    pub geometry: SavedFieldGeometryRef,
}

fn serialize_saved_mesh<S: serde::Serializer>(
    mesh: &MeshIR,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    // HashMap iteration must not make equal geometry produce different CAS
    // identities across processes. Preserve every canonical MeshIR field.
    #[derive(Serialize)]
    struct CanonicalMesh<'a> {
        mesh_name: &'a str,
        nodes: &'a [[f64; 3]],
        cells: &'a fullmag_ir::FemConnectivityIR,
        element_markers: &'a [u32],
        facets: &'a fullmag_ir::FemFacetConnectivityIR,
        boundary_markers: &'a [u32],
        #[serde(skip_serializing_if = "<[fullmag_ir::MeshPeriodicBoundaryPairIR]>::is_empty")]
        periodic_boundary_pairs: &'a [fullmag_ir::MeshPeriodicBoundaryPairIR],
        #[serde(skip_serializing_if = "<[fullmag_ir::MeshPeriodicNodePairIR]>::is_empty")]
        periodic_node_pairs: &'a [fullmag_ir::MeshPeriodicNodePairIR],
        #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        per_domain_quality: std::collections::BTreeMap<u32, &'a fullmag_ir::MeshQualityIR>,
    }
    CanonicalMesh {
        mesh_name: &mesh.mesh_name,
        nodes: &mesh.nodes,
        cells: &mesh.cells,
        element_markers: &mesh.element_markers,
        facets: &mesh.facets,
        boundary_markers: &mesh.boundary_markers,
        periodic_boundary_pairs: &mesh.periodic_boundary_pairs,
        periodic_node_pairs: &mesh.periodic_node_pairs,
        per_domain_quality: mesh
            .per_domain_quality
            .iter()
            .map(|(key, value)| (*key, value))
            .collect(),
    }
    .serialize(serializer)
}

impl SavedFemP1FieldGeometry {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FEM_P1_GEOMETRY_SCHEMA || self.coordinate_unit != "m" {
            bail!("saved FEM P1 geometry schema or coordinate unit is invalid");
        }
        if self.mesh.nodes.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 24
            || self.mesh.cells.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 16
            || self.mesh.facets.len() > MAX_FEM_P1_GEOMETRY_BYTES as usize / 12
            || self
                .mesh
                .nodes
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            bail!("saved FEM P1 geometry exceeds its shape budget or contains nonfinite nodes");
        }
        fullmag_ir::validate_mesh_for_execution(&self.mesh)
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
            .context("validating saved FEM mesh structure")?;
        self.field_semantics
            .validate(&self.mesh.topology_fingerprint_v6(), self.mesh.nodes.len())
            .context("saved field semantics differ from the canonical mesh and active support")
    }
}

impl SolutionFieldGeometryManifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SOLUTION_FIELD_GEOMETRY_SCHEMA {
            bail!("unsupported saved field geometry binding schema");
        }
        self.source.validate()?;
        validate_geometry_ref(&self.geometry)?;
        crate::solution_tensor_source::validate_metadata_length(&self.tensor_artifact)?;
        if self.tensor_artifact.schema_id != SOLUTION_TENSOR_SCHEMA
            || self.tensor_artifact.kind != SolutionArtifactKind::State
            || self.tensor_artifact.artifact_id != self.source.artifact_id
            || self.tensor_artifact.object_ref != self.source.tensor_object_ref
        {
            bail!("saved field geometry binding differs from its tensor source");
        }
        Ok(())
    }
}

fn validate_geometry_ref(reference: &SavedFieldGeometryRef) -> Result<()> {
    crate::cas::validate_hash(&reference.object_ref)?;
    if reference.schema_id != FEM_P1_GEOMETRY_SCHEMA
        || reference.byte_length == 0
        || reference.byte_length > MAX_FEM_P1_GEOMETRY_BYTES
    {
        bail!("saved FEM geometry reference schema or byte budget is invalid");
    }
    Ok(())
}

pub fn parse_solution_field_geometry_manifest(
    bytes: &[u8],
    artifact: &SolutionArtifactRef,
) -> Result<SolutionFieldGeometryManifest> {
    if artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA
        || artifact.kind != SolutionArtifactKind::Other
        || artifact.byte_length == 0
        || artifact.byte_length > MAX_FIELD_GEOMETRY_MANIFEST_BYTES
        || artifact.byte_length != bytes.len() as u64
        || crate::hex_sha256(bytes) != artifact.object_ref
        || artifact.artifact_id != format!("solution-field-geometry-{}", artifact.object_ref)
    {
        bail!("saved field geometry artifact identity, schema or metadata budget is invalid");
    }
    let manifest: SolutionFieldGeometryManifest = serde_json::from_slice(bytes)?;
    manifest.validate()?;
    if manifest.tensor_artifact.accepted_state != artifact.accepted_state {
        bail!("saved field geometry accepted state differs from its tensor");
    }
    Ok(manifest)
}

pub fn parse_saved_fem_p1_geometry(
    bytes: &[u8],
    reference: &SavedFieldGeometryRef,
) -> Result<SavedFemP1FieldGeometry> {
    validate_geometry_ref(reference)?;
    if bytes.len() as u64 != reference.byte_length
        || crate::hex_sha256(bytes) != reference.object_ref
    {
        bail!("saved FEM geometry CAS content or length differs from its reference");
    }
    let wire: serde_json::Value = serde_json::from_slice(bytes)?;
    let geometry: SavedFemP1FieldGeometry = serde_json::from_value(wire.clone())?;
    // MeshIR supports legacy input and otherwise ignores unknown mesh fields.
    // New immutable geometry roots accept only their canonical serialized
    // shape, so no field can be silently dropped at this schema boundary.
    if serde_json::to_value(&geometry)? != wire {
        bail!("saved FEM geometry is not the canonical typed MeshIR representation");
    }
    geometry.validate()?;
    Ok(geometry)
}

/// Resolve geometry from the exact immutable tensor owner, never from the
/// containing latest revision or an active runtime mesh. Missing geometry is
/// explicit; malformed, duplicate or incompatible bindings are errors.
/// This cold reader verifies CAS integrity and support/layout consistency,
/// but does not certify the native representation or execute a solver.
pub fn read_pinned_solution_field_geometry(
    store: &SessionStore,
    pinned: &PinnedSolutionTensorSource,
) -> Result<Option<(SolutionFieldGeometryManifest, SavedFemP1FieldGeometry)>> {
    let resolved = crate::solution_tensor_source::resolve_solution_tensor(store, pinned)?;
    let owner = store
        .solution_sets()
        .read_revision(&pinned.solution_set_id, pinned.solution_revision)?
        .context("saved geometry exact tensor owner revision is missing")?;
    let member = owner
        .members
        .iter()
        .find(|member| member.member_id == pinned.member_id)
        .context("saved geometry exact tensor member is missing")?;
    let mut selected = None;
    for artifact in &member.artifacts {
        if artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA {
            continue;
        }
        let manifest = read_solution_field_geometry_manifest(store.cas(), artifact)?;
        if &manifest.source != pinned {
            continue;
        }
        if selected.is_some() {
            bail!("saved tensor has duplicate exact geometry bindings");
        }
        validate_field_geometry_owner(&manifest, &owner, &member.member_id, true)?;
        selected = Some(manifest);
    }
    let Some(manifest) = selected else {
        return Ok(None);
    };
    let geometry = read_saved_fem_p1_geometry(store.cas(), &manifest.geometry)?;
    validate_saved_geometry_tensor(&geometry, &resolved.tensor)?;
    Ok(Some((manifest, geometry)))
}

pub fn validate_saved_geometry_tensor(
    geometry: &SavedFemP1FieldGeometry,
    tensor: &TensorDescriptor,
) -> Result<()> {
    validate_solution_tensor_descriptor(tensor)?;
    let binding = tensor
        .field_binding
        .as_ref()
        .context("saved geometry tensor has no field binding")?;
    if binding.plane != DatasetSlicePlane::Values
        || binding.producer_id != geometry.field_semantics.producer_id
        || binding.producer_version != geometry.field_semantics.producer_version
        || binding.descriptor != geometry.field_semantics.descriptor
    {
        bail!("saved geometry differs from the tensor producer, topology, support or layout");
    }
    Ok(())
}

/// Check the binding against a containing revision or its exact historical owner.
pub fn validate_field_geometry_owner(
    manifest: &SolutionFieldGeometryManifest,
    solution: &SolutionSet,
    member_id: &str,
    exact_owner: bool,
) -> Result<()> {
    manifest.validate()?;
    let source = &manifest.source;
    if source.run_id != solution.run_id
        || source.solution_set_id != solution.solution_set_id
        || source.run_spec_digest != solution.provenance.run_spec_digest
        || source.member_id != member_id
        || source.solution_revision > solution.revision
        || (exact_owner && source.solution_revision != solution.revision)
    {
        bail!("saved field geometry owner is outside the containing solution/member");
    }
    let member = solution
        .members
        .iter()
        .find(|member| member.member_id == member_id)
        .context("saved field geometry member is missing")?;
    let tensor = member
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id == source.artifact_id)
        .context("saved field geometry tensor is missing from its solution member")?;
    if tensor != &manifest.tensor_artifact {
        bail!("saved field geometry tensor changed in its owner/containing revision");
    }
    Ok(())
}

pub fn read_solution_field_geometry_manifest(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<SolutionFieldGeometryManifest> {
    if artifact.byte_length == 0 || artifact.byte_length > MAX_FIELD_GEOMETRY_MANIFEST_BYTES {
        bail!("saved field geometry manifest exceeds its metadata budget");
    }
    let range = cas
        .get_verified_range(
            &artifact.object_ref,
            0,
            artifact.byte_length,
            MAX_FIELD_GEOMETRY_MANIFEST_BYTES,
        )?
        .context("saved field geometry manifest CAS object is missing")?;
    if range.object_length != artifact.byte_length {
        bail!("saved field geometry manifest length mismatch");
    }
    parse_solution_field_geometry_manifest(&range.bytes, artifact)
}

pub fn read_saved_fem_p1_geometry(
    cas: &CasStore,
    reference: &SavedFieldGeometryRef,
) -> Result<SavedFemP1FieldGeometry> {
    validate_geometry_ref(reference)?;
    let range = cas
        .get_verified_range(
            &reference.object_ref,
            0,
            reference.byte_length,
            MAX_FEM_P1_GEOMETRY_BYTES,
        )?
        .context("saved FEM geometry CAS object is missing")?;
    if range.object_length != reference.byte_length {
        bail!("saved FEM geometry CAS length mismatch");
    }
    parse_saved_fem_p1_geometry(&range.bytes, reference)
}

struct BoundedJsonWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for BoundedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "saved geometry serialization exceeds its byte budget",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Publish only pinned CAS objects; the caller attaches the returned artifact
/// to the same prospective SolutionSet as the tensor and dataset manifest.
pub fn build_solution_field_geometry_artifact(
    cas: &CasStore,
    solution: &SolutionSet,
    member_id: &str,
    tensor_artifact: &SolutionArtifactRef,
    mesh: &MeshIR,
    semantics: &FemP1MagnetizationFieldSemantics,
) -> Result<SolutionArtifactRef> {
    let tensor = read_solution_tensor_artifact(cas, tensor_artifact)?;
    let dataset = MaterializedDatasetManifest::from_recorded_tensor(
        solution,
        member_id,
        tensor_artifact,
        &tensor,
    )?;
    let geometry = SavedFemP1FieldGeometry {
        schema_version: FEM_P1_GEOMETRY_SCHEMA.into(),
        coordinate_unit: "m".into(),
        representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
        mesh: mesh.clone(),
        field_semantics: semantics.clone(),
    };
    geometry.validate()?;
    validate_saved_geometry_tensor(&geometry, &tensor)?;
    let mut writer = BoundedJsonWriter {
        bytes: Vec::new(),
        limit: MAX_FEM_P1_GEOMETRY_BYTES as usize,
    };
    serde_json::to_writer(&mut writer, &geometry)
        .context("serializing bounded saved FEM geometry")?;
    let geometry_ref = SavedFieldGeometryRef {
        schema_id: FEM_P1_GEOMETRY_SCHEMA.into(),
        object_ref: cas.put(&writer.bytes)?,
        byte_length: writer.bytes.len() as u64,
    };
    let manifest = SolutionFieldGeometryManifest {
        schema_version: SOLUTION_FIELD_GEOMETRY_SCHEMA.into(),
        source: dataset.field.source,
        tensor_artifact: tensor_artifact.clone(),
        geometry: geometry_ref,
    };
    manifest.validate()?;
    let bytes = serde_json::to_vec(&manifest)?;
    if bytes.len() as u64 > MAX_FIELD_GEOMETRY_MANIFEST_BYTES {
        bail!("saved field geometry binding exceeds metadata budget");
    }
    let object_ref = cas.put(&bytes)?;
    Ok(SolutionArtifactRef {
        artifact_id: format!("solution-field-geometry-{object_ref}"),
        kind: SolutionArtifactKind::Other,
        schema_id: SOLUTION_FIELD_GEOMETRY_SCHEMA.into(),
        object_ref,
        byte_length: bytes.len() as u64,
        accepted_state: tensor_artifact.accepted_state.clone(),
    })
}

pub(crate) fn verify_field_geometries_for_solution(
    root: &Path,
    cas: &CasStore,
    solution: &SolutionSet,
) -> Result<Vec<SavedFieldGeometryRef>> {
    let mut sources = BTreeSet::new();
    let mut references = Vec::new();
    for member in &solution.members {
        for artifact in &member.artifacts {
            if artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA {
                continue;
            }
            let manifest = read_solution_field_geometry_manifest(cas, artifact)?;
            if !sources.insert((
                manifest.source.member_id.clone(),
                manifest.source.artifact_id.clone(),
            )) {
                bail!("saved field geometry binding is duplicated for the same tensor");
            }
            validate_field_geometry_owner(&manifest, solution, &member.member_id, false)?;
            if manifest.source.solution_revision != solution.revision {
                let historical = SessionStore::open_existing(root)?
                    .solution_sets()
                    .read_revision(
                        &manifest.source.solution_set_id,
                        manifest.source.solution_revision,
                    )?
                    .context("saved field geometry historical owner revision is missing")?;
                validate_field_geometry_owner(&manifest, &historical, &member.member_id, true)?;
            }
            let geometry = read_saved_fem_p1_geometry(cas, &manifest.geometry)?;
            let tensor = read_solution_tensor_artifact(cas, &manifest.tensor_artifact)?;
            validate_saved_geometry_tensor(&geometry, &tensor)?;
            references.push(manifest.geometry);
        }
    }
    Ok(references)
}

#[cfg(test)]
#[path = "solution_field_geometry_tests.rs"]
mod tests;

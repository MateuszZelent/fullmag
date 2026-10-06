//! Private, borrowed identity for the exact validated waveguide world geometry.
//!
//! This digest is neither a structural-2D certificate nor an operator/equilibrium
//! cache key. Its typed preimage excludes materials, interactions, fields,
//! equilibrium, sampled k, producer build, execution, and provider state.

use crate::study::RegionRefIR;
use crate::waveguide_frame::{ValidatedWaveguideFrameIR, WaveguideFrameIR};
use crate::waveguide_mesh::{
    WaveguideCrossSectionBoundaryComponentIR, WaveguideCrossSectionLoopKindIR,
    WaveguideCrossSectionMeshIR, WaveguideCrossSectionMeshSchemaIR, WaveguideCrossSectionRegionIR,
};
use crate::waveguide_mesh_elements::WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD;
use crate::waveguide_mesh_world::ValidatedWaveguideWorldMapping;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::{error::Error, fmt};

const GEOMETRY_IDENTITY_DOMAIN_V1: &str = "fullmag.waveguide.geometry-identity.v1";
const WORLD_ARITHMETIC_POLICY_V1: &str =
    "world-map-v1:x=(origin+u*Eu)+v*Ev;separate-products-and-additions;canonical-axes-only;reject-nonfinite-products-intermediates-results;no-fma;no-gram-schmidt;no-sign-flip;no-clamp;world-collision-bits:+0=-0";
const WORLD_ORIENTATION_POLICY_V1: &str =
    "world-orientation-v1:exact-dyadic-sign-of-((x1-x0)cross(x2-x0))dot(axis);finite-f64-common-factor-2^-1074;strict-positive;no-epsilon;no-connectivity-reordering";

const MESH_SCHEMA_V1_TAG: u8 = 1;
const REGION_MAGNETIC_TAG: u8 = 1;
const REGION_AIR_TAG: u8 = 2;
const LOOP_OUTER_TAG: u8 = 1;
const LOOP_HOLE_TAG: u8 = 2;
const REGION_TARGET_NO_REGION_TAG: u8 = 0;
const REGION_TARGET_WITH_REGION_TAG: u8 = 1;
/// Preimage tags are persistent protocol bytes. Never renumber or reuse a tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum IdentityTag {
    Domain = 0x01,
    Mesh = 0x10,
    MeshSchema = 0x11,
    MeshNodes = 0x12,
    MeshNode = 0x13,
    MeshTriangles = 0x14,
    MeshTriangle = 0x15,
    MeshEdges = 0x16,
    MeshEdge = 0x17,
    MeshEdgeIncidences = 0x18,
    MeshEdgeIncidence = 0x19,
    MeshRegions = 0x1a,
    MeshRegion = 0x1b,
    MeshBoundaries = 0x1c,
    MeshBoundary = 0x1d,
    BoundaryHalfEdges = 0x1e,
    BoundaryHalfEdge = 0x1f,
    RegionTargetMap = 0x20,
    RegionTarget = 0x21,
    Frame = 0x30,
    FrameRequested = 0x31,
    FrameCanonical = 0x32,
    FrameNormalizationLengths = 0x33,
    FrameGeometryTolerance = 0x34,
    WorldNodes = 0x40,
    WorldNode = 0x41,
    DirichletBoundaryIndices = 0x50,
    DirichletEssentialNodeIndices = 0x51,
    TriangleQualityThreshold = 0x60,
    WorldArithmeticPolicy = 0x61,
    WorldOrientationPolicy = 0x62,
}

/// Failures while framing exact geometry identity bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaveguideGeometryIdentityError {
    IntegerNotRepresentableAsU64,
    PreimageByteCountOverflow,
}

impl fmt::Display for WaveguideGeometryIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "waveguide geometry identity error: {self:?}")
    }
}

impl Error for WaveguideGeometryIdentityError {}

/// Opaque digest tied to the exact borrowed world mapping used to encode it.
#[derive(Debug)]
pub(crate) struct WaveguideGeometryIdentity<'g, 'd, 'b, 'i, 'f> {
    world_mapping: &'g ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f>,
    sha256_hex: String,
    preimage_byte_count: u64,
}

impl<'g, 'd, 'b, 'i, 'f> WaveguideGeometryIdentity<'g, 'd, 'b, 'i, 'f> {
    pub(crate) fn world_mapping(&self) -> &'g ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f> {
        self.world_mapping
    }

    pub(crate) fn sha256_hex(&self) -> &str {
        &self.sha256_hex
    }

    pub(crate) fn preimage_byte_count(&self) -> u64 {
        self.preimage_byte_count
    }
}

/// Hash only the data bound by this exact validated world mapping.
pub(crate) fn compute_waveguide_geometry_identity<'g, 'd, 'b, 'i, 'f>(
    world_mapping: &'g ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f>,
) -> Result<WaveguideGeometryIdentity<'g, 'd, 'b, 'i, 'f>, WaveguideGeometryIdentityError> {
    let mut encoder = PreimageEncoder::new();
    encode_geometry_preimage(&mut encoder, world_mapping)?;
    let preimage_byte_count = encoder.byte_count();
    let sha256_hex = encoder.finalize_hex();

    Ok(WaveguideGeometryIdentity {
        world_mapping,
        sha256_hex,
        preimage_byte_count,
    })
}

#[derive(Debug)]
struct PreimageEncoder {
    hasher: Sha256,
    byte_count: u64,
}

impl PreimageEncoder {
    fn new() -> Self {
        Self {
            hasher: Sha256::new(),
            byte_count: 0,
        }
    }

    fn byte_count(&self) -> u64 {
        self.byte_count
    }

    fn finalize_hex(self) -> String {
        format!("{:x}", self.hasher.finalize())
    }

    fn tag(&mut self, tag: IdentityTag) -> Result<(), WaveguideGeometryIdentityError> {
        self.write_bytes(&[tag as u8])
    }

    fn u8(&mut self, value: u8) -> Result<(), WaveguideGeometryIdentityError> {
        self.write_bytes(&[value])
    }

    fn u64(&mut self, value: u64) -> Result<(), WaveguideGeometryIdentityError> {
        self.write_bytes(&value.to_le_bytes())
    }

    fn count(&mut self, value: usize) -> Result<(), WaveguideGeometryIdentityError> {
        let value = u64::try_from(value)
            .map_err(|_| WaveguideGeometryIdentityError::IntegerNotRepresentableAsU64)?;
        self.u64(value)
    }

    fn index(&mut self, value: usize) -> Result<(), WaveguideGeometryIdentityError> {
        let value = u64::try_from(value)
            .map_err(|_| WaveguideGeometryIdentityError::IntegerNotRepresentableAsU64)?;
        self.u64(value)
    }

    fn f64(&mut self, value: f64) -> Result<(), WaveguideGeometryIdentityError> {
        self.u64(value.to_bits())
    }

    fn string(&mut self, value: &str) -> Result<(), WaveguideGeometryIdentityError> {
        self.count(value.len())?;
        self.write_bytes(value.as_bytes())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), WaveguideGeometryIdentityError> {
        let byte_length = u64::try_from(bytes.len())
            .map_err(|_| WaveguideGeometryIdentityError::IntegerNotRepresentableAsU64)?;
        let next_count = self
            .byte_count
            .checked_add(byte_length)
            .ok_or(WaveguideGeometryIdentityError::PreimageByteCountOverflow)?;
        self.hasher.update(bytes);
        self.byte_count = next_count;
        Ok(())
    }
}

fn encode_geometry_preimage(
    encoder: &mut PreimageEncoder,
    world_mapping: &ValidatedWaveguideWorldMapping<'_, '_, '_, '_>,
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::Domain)?;
    encoder.string(GEOMETRY_IDENTITY_DOMAIN_V1)?;

    let dirichlet = world_mapping.dirichlet();
    let registry = dirichlet.registry();
    let mesh = registry.mesh();
    encode_raw_mesh(encoder, mesh)?;
    encode_region_targets(encoder, registry.region_targets())?;
    encode_frame(encoder, world_mapping.frame())?;
    encode_world_nodes(encoder, world_mapping.world_nodes_m())?;
    encode_resolved_dirichlet_selection(
        encoder,
        dirichlet.boundary_component_indices(),
        dirichlet.essential_node_indices(),
    )?;

    encoder.tag(IdentityTag::TriangleQualityThreshold)?;
    encoder.f64(WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD)?;
    encoder.tag(IdentityTag::WorldArithmeticPolicy)?;
    encoder.string(WORLD_ARITHMETIC_POLICY_V1)?;
    encoder.tag(IdentityTag::WorldOrientationPolicy)?;
    encoder.string(WORLD_ORIENTATION_POLICY_V1)?;
    Ok(())
}

fn encode_raw_mesh(
    encoder: &mut PreimageEncoder,
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::Mesh)?;

    encoder.tag(IdentityTag::MeshSchema)?;
    match mesh.schema {
        WaveguideCrossSectionMeshSchemaIR::V1 => encoder.u8(MESH_SCHEMA_V1_TAG)?,
    }

    encoder.tag(IdentityTag::MeshNodes)?;
    encoder.count(mesh.nodes_uv_m.len())?;
    for (node_index, node) in mesh.nodes_uv_m.iter().copied().enumerate() {
        encoder.tag(IdentityTag::MeshNode)?;
        encoder.index(node_index)?;
        encoder.f64(node[0])?;
        encoder.f64(node[1])?;
    }

    encoder.tag(IdentityTag::MeshTriangles)?;
    encoder.count(mesh.triangles.len())?;
    for (triangle_index, triangle) in mesh.triangles.iter().enumerate() {
        encoder.tag(IdentityTag::MeshTriangle)?;
        encoder.index(triangle_index)?;
        for node_index in triangle.nodes {
            encoder.u64(node_index)?;
        }
        encoder.string(&triangle.region_id)?;
    }

    encoder.tag(IdentityTag::MeshEdges)?;
    encoder.count(mesh.edges.len())?;
    for (edge_index, edge) in mesh.edges.iter().enumerate() {
        encoder.tag(IdentityTag::MeshEdge)?;
        encoder.index(edge_index)?;
        for node_index in edge.nodes {
            encoder.u64(node_index)?;
        }
        encoder.tag(IdentityTag::MeshEdgeIncidences)?;
        encoder.count(edge.incidences.len())?;
        for incidence in &edge.incidences {
            encoder.tag(IdentityTag::MeshEdgeIncidence)?;
            encoder.u64(incidence.triangle_index)?;
            encoder.u8(incidence.local_edge_index.as_u8())?;
        }
    }

    encoder.tag(IdentityTag::MeshRegions)?;
    encoder.count(mesh.regions.len())?;
    for (region_index, region) in mesh.regions.iter().enumerate() {
        encoder.tag(IdentityTag::MeshRegion)?;
        encoder.index(region_index)?;
        match region {
            WaveguideCrossSectionRegionIR::Magnetic {
                region_id,
                object_id,
                material_id,
            } => {
                encoder.u8(REGION_MAGNETIC_TAG)?;
                encoder.string(region_id)?;
                encoder.string(object_id)?;
                encoder.string(material_id)?;
            }
            WaveguideCrossSectionRegionIR::Air {
                region_id,
                object_id,
            } => {
                encoder.u8(REGION_AIR_TAG)?;
                encoder.string(region_id)?;
                encoder.string(object_id)?;
            }
        }
    }

    encoder.tag(IdentityTag::MeshBoundaries)?;
    encoder.count(mesh.boundary_components.len())?;
    for (boundary_index, boundary) in mesh.boundary_components.iter().enumerate() {
        encode_boundary_component(encoder, boundary_index, boundary)?;
    }
    Ok(())
}

fn encode_boundary_component(
    encoder: &mut PreimageEncoder,
    boundary_index: usize,
    boundary: &WaveguideCrossSectionBoundaryComponentIR,
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::MeshBoundary)?;
    encoder.index(boundary_index)?;
    encoder.string(&boundary.boundary_component_id)?;
    encoder.string(&boundary.region_id)?;
    encoder.u8(match boundary.loop_kind {
        WaveguideCrossSectionLoopKindIR::Outer => LOOP_OUTER_TAG,
        WaveguideCrossSectionLoopKindIR::Hole => LOOP_HOLE_TAG,
    })?;
    encoder.tag(IdentityTag::BoundaryHalfEdges)?;
    encoder.count(boundary.half_edges.len())?;
    for half_edge in &boundary.half_edges {
        encoder.tag(IdentityTag::BoundaryHalfEdge)?;
        encoder.u64(half_edge.triangle_index)?;
        encoder.u8(half_edge.local_edge_index.as_u8())?;
    }
    Ok(())
}

fn encode_region_targets(
    encoder: &mut PreimageEncoder,
    targets: &BTreeMap<String, RegionRefIR>,
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::RegionTargetMap)?;
    encoder.count(targets.len())?;
    // BTreeMap iteration is the canonical key order; insertion history is absent.
    for (key, target) in targets {
        encoder.tag(IdentityTag::RegionTarget)?;
        encoder.string(key)?;
        encoder.string(&target.object_id)?;
        match target.region_id.as_deref() {
            None => encoder.u8(REGION_TARGET_NO_REGION_TAG)?,
            Some(region_id) => {
                encoder.u8(REGION_TARGET_WITH_REGION_TAG)?;
                encoder.string(region_id)?;
            }
        }
    }
    Ok(())
}

fn encode_frame(
    encoder: &mut PreimageEncoder,
    frame: &ValidatedWaveguideFrameIR,
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::Frame)?;

    encoder.tag(IdentityTag::FrameRequested)?;
    encode_requested_frame(encoder, frame.requested())?;

    encoder.tag(IdentityTag::FrameCanonical)?;
    let canonical = frame.canonical();
    encode_vector3(encoder, canonical.origin_m())?;
    encode_vector3(encoder, canonical.e_u())?;
    encode_vector3(encoder, canonical.e_v())?;
    encode_vector3(encoder, canonical.axis_unit())?;

    encoder.tag(IdentityTag::FrameNormalizationLengths)?;
    encode_vector3(encoder, frame.normalization_lengths())?;

    encoder.tag(IdentityTag::FrameGeometryTolerance)?;
    encoder.f64(frame.geometry_tolerance())?;
    Ok(())
}

fn encode_requested_frame(
    encoder: &mut PreimageEncoder,
    frame: &WaveguideFrameIR,
) -> Result<(), WaveguideGeometryIdentityError> {
    encode_vector3(encoder, frame.origin_m)?;
    encode_vector3(encoder, frame.e_u)?;
    encode_vector3(encoder, frame.e_v)?;
    encode_vector3(encoder, frame.axis_unit)
}

fn encode_vector3(
    encoder: &mut PreimageEncoder,
    vector: [f64; 3],
) -> Result<(), WaveguideGeometryIdentityError> {
    for value in vector {
        encoder.f64(value)?;
    }
    Ok(())
}

fn encode_world_nodes(
    encoder: &mut PreimageEncoder,
    world_nodes: &[[f64; 3]],
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::WorldNodes)?;
    encoder.count(world_nodes.len())?;
    for (node_index, node) in world_nodes.iter().copied().enumerate() {
        encoder.tag(IdentityTag::WorldNode)?;
        encoder.index(node_index)?;
        encode_vector3(encoder, node)?;
    }
    Ok(())
}

fn encode_resolved_dirichlet_selection(
    encoder: &mut PreimageEncoder,
    boundary_component_indices: &[usize],
    essential_node_indices: &[u64],
) -> Result<(), WaveguideGeometryIdentityError> {
    encoder.tag(IdentityTag::DirichletBoundaryIndices)?;
    encoder.count(boundary_component_indices.len())?;
    for index in boundary_component_indices.iter().copied() {
        encoder.index(index)?;
    }

    encoder.tag(IdentityTag::DirichletEssentialNodeIndices)?;
    encoder.count(essential_node_indices.len())?;
    for node_index in essential_node_indices.iter().copied() {
        encoder.u64(node_index)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::waveguide_frame::validate_waveguide_frame;
    use crate::waveguide_mesh_bindings::{
        tests::valid_fixture, validate_waveguide_registry_bindings,
    };
    use crate::waveguide_mesh_dirichlet::validate_finite_air_dirichlet_bindings;
    use crate::waveguide_mesh_world::validate_waveguide_world_mapping;
    use crate::ProblemIRV04;

    fn identity_for_fixture(
        problem: &ProblemIRV04,
        mesh: &WaveguideCrossSectionMeshIR,
        targets: &BTreeMap<String, RegionRefIR>,
        frame_request: WaveguideFrameIR,
        selected_boundaries: &[&str],
    ) -> (String, u64, Vec<usize>) {
        let registry = validate_waveguide_registry_bindings(problem, mesh, targets)
            .expect("identity fixture registry bindings");
        let boundary_ids = selected_boundaries
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>();
        let dirichlet = validate_finite_air_dirichlet_bindings(&registry, &boundary_ids)
            .expect("identity fixture Dirichlet selection");
        let frame = validate_waveguide_frame(frame_request).expect("identity fixture frame");
        let world = validate_waveguide_world_mapping(&dirichlet, &frame)
            .expect("identity fixture world mapping");
        let identity =
            compute_waveguide_geometry_identity(&world).expect("identity fixture digest");
        (
            identity.sha256_hex().to_string(),
            identity.preimage_byte_count(),
            dirichlet.boundary_component_indices().to_vec(),
        )
    }

    fn identity_frame(origin_m: [f64; 3]) -> WaveguideFrameIR {
        WaveguideFrameIR {
            origin_m,
            e_u: [1.0, 0.0, 0.0],
            e_v: [0.0, 1.0, 0.0],
            axis_unit: [0.0, 0.0, 1.0],
        }
    }

    fn framed_string_pair(
        first: &str,
        second: &str,
    ) -> Result<(String, u64), WaveguideGeometryIdentityError> {
        let mut encoder = PreimageEncoder::new();
        encoder.tag(IdentityTag::RegionTarget)?;
        encoder.string(first)?;
        encoder.tag(IdentityTag::RegionTarget)?;
        encoder.string(second)?;
        let byte_count = encoder.byte_count();
        Ok((encoder.finalize_hex(), byte_count))
    }

    fn dirichlet_selection_digest(
        boundary_indices: &[usize],
        essential_nodes: &[u64],
    ) -> Result<String, WaveguideGeometryIdentityError> {
        let mut encoder = PreimageEncoder::new();
        encode_resolved_dirichlet_selection(&mut encoder, boundary_indices, essential_nodes)?;
        Ok(encoder.finalize_hex())
    }

    #[test]
    fn frozen_tag_enum_and_policy_manifest_matches_golden_digest() {
        // This independent test manifest is not part of the production preimage.
        const GOLDEN_TAG_VALUES: [u8; 31] = [
            0x01, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x30, 0x31, 0x32, 0x33, 0x34, 0x40, 0x41, 0x50, 0x51,
            0x60, 0x61, 0x62,
        ];
        const GOLDEN_ENUM_VALUES: [u8; 7] = [1, 1, 2, 1, 2, 0, 1];
        const GOLDEN_ARITHMETIC_POLICY: &str = "world-map-v1:x=(origin+u*Eu)+v*Ev;separate-products-and-additions;canonical-axes-only;reject-nonfinite-products-intermediates-results;no-fma;no-gram-schmidt;no-sign-flip;no-clamp;world-collision-bits:+0=-0";
        const GOLDEN_ORIENTATION_POLICY: &str = "world-orientation-v1:exact-dyadic-sign-of-((x1-x0)cross(x2-x0))dot(axis);finite-f64-common-factor-2^-1074;strict-positive;no-epsilon;no-connectivity-reordering";
        const EXPECTED_SHA256: &str =
            "f75bf01e7eeaf7a11696fc9c9f21243d7c35ebc265e5e2b6563e0d391b1fc172";

        let actual_tag_values = [
            IdentityTag::Domain as u8,
            IdentityTag::Mesh as u8,
            IdentityTag::MeshSchema as u8,
            IdentityTag::MeshNodes as u8,
            IdentityTag::MeshNode as u8,
            IdentityTag::MeshTriangles as u8,
            IdentityTag::MeshTriangle as u8,
            IdentityTag::MeshEdges as u8,
            IdentityTag::MeshEdge as u8,
            IdentityTag::MeshEdgeIncidences as u8,
            IdentityTag::MeshEdgeIncidence as u8,
            IdentityTag::MeshRegions as u8,
            IdentityTag::MeshRegion as u8,
            IdentityTag::MeshBoundaries as u8,
            IdentityTag::MeshBoundary as u8,
            IdentityTag::BoundaryHalfEdges as u8,
            IdentityTag::BoundaryHalfEdge as u8,
            IdentityTag::RegionTargetMap as u8,
            IdentityTag::RegionTarget as u8,
            IdentityTag::Frame as u8,
            IdentityTag::FrameRequested as u8,
            IdentityTag::FrameCanonical as u8,
            IdentityTag::FrameNormalizationLengths as u8,
            IdentityTag::FrameGeometryTolerance as u8,
            IdentityTag::WorldNodes as u8,
            IdentityTag::WorldNode as u8,
            IdentityTag::DirichletBoundaryIndices as u8,
            IdentityTag::DirichletEssentialNodeIndices as u8,
            IdentityTag::TriangleQualityThreshold as u8,
            IdentityTag::WorldArithmeticPolicy as u8,
            IdentityTag::WorldOrientationPolicy as u8,
        ];
        let actual_enum_values = [
            MESH_SCHEMA_V1_TAG,
            REGION_MAGNETIC_TAG,
            REGION_AIR_TAG,
            LOOP_OUTER_TAG,
            LOOP_HOLE_TAG,
            REGION_TARGET_NO_REGION_TAG,
            REGION_TARGET_WITH_REGION_TAG,
        ];
        assert_eq!(actual_tag_values, GOLDEN_TAG_VALUES);
        assert_eq!(actual_enum_values, GOLDEN_ENUM_VALUES);
        assert_eq!(WORLD_ARITHMETIC_POLICY_V1, GOLDEN_ARITHMETIC_POLICY);
        assert_eq!(WORLD_ORIENTATION_POLICY_V1, GOLDEN_ORIENTATION_POLICY);

        let mut literal = b"fullmag.waveguide.geometry-identity.protocol-manifest.v1\0".to_vec();
        literal.extend_from_slice(&31_u64.to_le_bytes());
        literal.extend_from_slice(&GOLDEN_TAG_VALUES);
        literal.extend_from_slice(&7_u64.to_le_bytes());
        literal.extend_from_slice(&GOLDEN_ENUM_VALUES);
        let arithmetic_len = u64::try_from(GOLDEN_ARITHMETIC_POLICY.len())
            .expect("golden arithmetic policy length fits u64");
        literal.extend_from_slice(&arithmetic_len.to_le_bytes());
        literal.extend_from_slice(GOLDEN_ARITHMETIC_POLICY.as_bytes());
        let orientation_len = u64::try_from(GOLDEN_ORIENTATION_POLICY.len())
            .expect("golden orientation policy length fits u64");
        literal.extend_from_slice(&orientation_len.to_le_bytes());
        literal.extend_from_slice(GOLDEN_ORIENTATION_POLICY.as_bytes());

        let digest = format!("{:x}", Sha256::digest(&literal));
        assert_eq!(digest, EXPECTED_SHA256);
    }
    #[test]
    fn identical_validated_tokens_produce_a_deterministic_borrowed_identity() {
        let (problem, mesh, targets) = valid_fixture();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &targets)
            .expect("shared registry fixture");
        let dirichlet =
            validate_finite_air_dirichlet_bindings(&registry, &["boundary-air-outer".into()])
                .expect("outer air Dirichlet fixture");
        let frame =
            validate_waveguide_frame(identity_frame([0.0; 3])).expect("identity frame fixture");
        let world =
            validate_waveguide_world_mapping(&dirichlet, &frame).expect("world mapping fixture");

        let first = compute_waveguide_geometry_identity(&world).expect("first geometry identity");
        let second = compute_waveguide_geometry_identity(&world).expect("second geometry identity");
        assert!(std::ptr::eq(first.world_mapping(), &world));
        assert!(std::ptr::eq(second.world_mapping(), &world));
        assert_eq!(first.sha256_hex(), second.sha256_hex());
        assert_eq!(first.preimage_byte_count(), second.preimage_byte_count());
        assert_eq!(first.sha256_hex().len(), 64);
        assert!(first
            .sha256_hex()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn length_prefixed_strings_match_a_literal_preimage_and_do_not_alias() {
        let (ab_then_c, byte_count) =
            framed_string_pair("ab", "c").expect("framed string identity");
        let (a_then_bc, other_byte_count) =
            framed_string_pair("a", "bc").expect("second framed string identity");
        let expected_preimage = [
            0x21, 2, 0, 0, 0, 0, 0, 0, 0, b'a', b'b', 0x21, 1, 0, 0, 0, 0, 0, 0, 0, b'c',
        ];

        assert_eq!(byte_count, expected_preimage.len() as u64);
        assert_eq!(other_byte_count, expected_preimage.len() as u64);
        assert_eq!(
            ab_then_c,
            format!("{:x}", Sha256::digest(expected_preimage))
        );
        assert_ne!(ab_then_c, a_then_bc);
    }

    #[test]
    fn signed_zero_in_raw_mesh_changes_exact_authored_identity() {
        let (problem, mut mesh, targets) = valid_fixture();
        let baseline = identity_for_fixture(
            &problem,
            &mesh,
            &targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        let node_index = mesh
            .nodes_uv_m
            .iter()
            .position(|node| node[0].to_bits() == 0)
            .expect("fixture has an authored positive-zero coordinate");
        mesh.nodes_uv_m[node_index][0] = -0.0;
        let changed = identity_for_fixture(
            &problem,
            &mesh,
            &targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        assert_ne!(baseline.0, changed.0);
    }

    #[test]
    fn geometry_scale_frame_origin_and_binding_target_change_identity() {
        let (problem, mesh, targets) = valid_fixture();
        let baseline = identity_for_fixture(
            &problem,
            &mesh,
            &targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );

        let mut scaled_mesh = mesh.clone();
        for node in &mut scaled_mesh.nodes_uv_m {
            node[0] *= 2.0;
            node[1] *= 2.0;
        }
        let scaled = identity_for_fixture(
            &problem,
            &scaled_mesh,
            &targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        assert_ne!(baseline.0, scaled.0);

        let shifted_frame = identity_for_fixture(
            &problem,
            &mesh,
            &targets,
            identity_frame([0.25, 0.0, 0.0]),
            &["boundary-air-outer"],
        );
        assert_ne!(baseline.0, shifted_frame.0);

        // Whole-object module and assignment bindings cover this valid target.
        let mut changed_targets = targets.clone();
        changed_targets
            .get_mut("region-magnetic")
            .expect("fixture magnetic target")
            .region_id = None;
        let rebound = identity_for_fixture(
            &problem,
            &mesh,
            &changed_targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        assert_ne!(baseline.0, rebound.0);
    }

    #[test]
    fn target_map_insertion_order_does_not_change_identity() {
        let (problem, mesh, targets) = valid_fixture();
        let reversed = targets
            .iter()
            .rev()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        let first = identity_for_fixture(
            &problem,
            &mesh,
            &targets,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        let second = identity_for_fixture(
            &problem,
            &mesh,
            &reversed,
            identity_frame([0.0; 3]),
            &["boundary-air-outer"],
        );
        assert_eq!(first.0, second.0);
    }

    #[test]
    fn resolved_boundary_selection_and_node_union_are_identity_inputs() {
        let baseline =
            dirichlet_selection_digest(&[2], &[0, 1, 4, 7]).expect("baseline resolved selection");
        let different_boundary =
            dirichlet_selection_digest(&[3], &[0, 1, 4, 7]).expect("changed resolved boundary");
        let different_union =
            dirichlet_selection_digest(&[2], &[0, 1, 4, 8]).expect("changed essential-node union");
        assert_ne!(baseline, different_boundary);
        assert_ne!(baseline, different_union);
    }

    #[test]
    fn byte_count_overflow_is_checked_before_updating_the_digest() {
        let mut encoder = PreimageEncoder::new();
        encoder.byte_count = u64::MAX;
        assert_eq!(
            encoder.tag(IdentityTag::Domain),
            Err(WaveguideGeometryIdentityError::PreimageByteCountOverflow)
        );
        assert_eq!(encoder.byte_count(), u64::MAX);
        assert_eq!(encoder.finalize_hex(), format!("{:x}", Sha256::digest(b"")));
    }
}

use super::eigen_digest::{is_sha256_digest, sha256_text, shared_domain_content_digest};
use crate::types::RunError;
use fullmag_ir::FemEigenPlanIR;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;

const MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH: u32 = 1;
const MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD: u32 = 2;
const MODAL_CERTIFICATE_PART_MAGNETIC: u32 = 1;
const MODAL_CERTIFICATE_PART_SCALAR_AIRBOX: u32 = 2;
pub(super) const MODAL_CERTIFICATE_BINDING_ACCEPTED: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6Relation {
    pub source_node: u64,
    pub destination_node: u64,
    pub axis_mask: u32,
    pub kind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6RegionRole {
    pub region_id: u32,
    pub part_role: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6ClassDigest {
    pub canonical_class_id: u64,
    pub member_count: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnedModalCertificateV6View {
    pub view_kind: u32,
    pub part_role: u32,
    pub part_identity: String,
    pub topology_fingerprint: String,
    pub region_ids: Vec<u32>,
    pub boundary_axis_masks: Vec<u32>,
    pub region_roles: Vec<OwnedModalCertificateV6RegionRole>,
    pub generator_relations: Vec<OwnedModalCertificateV6Relation>,
    pub closure_relations: Vec<OwnedModalCertificateV6Relation>,
    pub expected_class_ids: Vec<u64>,
    pub expected_class_digests: Vec<OwnedModalCertificateV6ClassDigest>,
}

impl OwnedModalCertificateV6View {
    pub(super) fn node_count(&self) -> u64 {
        self.region_ids.len() as u64
    }

    pub(super) fn canonical_state(
        &self,
    ) -> Result<(Vec<u64>, Vec<OwnedModalCertificateV6ClassDigest>, String), RunError> {
        let node_count = self.region_ids.len();
        if node_count == 0
            || self.boundary_axis_masks.len() != node_count
            || self.region_roles.is_empty()
            || self.generator_relations.is_empty()
            || self.closure_relations.is_empty()
            || !is_sha256_digest(&self.topology_fingerprint)
        {
            return Err(modal_v6_error("owned_view_incomplete"));
        }
        let expected_identity_prefix = if self.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            "magnetic:"
        } else if self.part_role == MODAL_CERTIFICATE_PART_SCALAR_AIRBOX {
            "airbox:"
        } else {
            return Err(modal_v6_error("owned_part_role_invalid"));
        };
        if !self.part_identity.starts_with(expected_identity_prefix) {
            return Err(modal_v6_error("owned_part_identity_invalid"));
        }
        let mut known_regions = BTreeSet::new();
        for role in &self.region_roles {
            if role.part_role != self.part_role || !known_regions.insert(role.region_id) {
                return Err(modal_v6_error("owned_region_role_invalid"));
            }
        }
        if self
            .region_ids
            .iter()
            .any(|region| !known_regions.contains(region))
            || self.boundary_axis_masks.iter().any(|mask| *mask > 7)
        {
            return Err(modal_v6_error("owned_node_identity_invalid"));
        }
        let mut parent = (0..node_count).collect::<Vec<_>>();
        fn find(parent: &mut [usize], mut node: usize) -> usize {
            let mut root = node;
            while parent[root] != root {
                root = parent[root];
            }
            while parent[node] != node {
                let next = parent[node];
                parent[node] = root;
                node = next;
            }
            root
        }
        let relation_key = |relation: &OwnedModalCertificateV6Relation| {
            (
                relation.source_node.min(relation.destination_node),
                relation.source_node.max(relation.destination_node),
                relation.axis_mask,
                relation.kind,
            )
        };
        let validate_relation = |relation: &OwnedModalCertificateV6Relation| {
            let source = relation.source_node as usize;
            let destination = relation.destination_node as usize;
            source < node_count
                && destination < node_count
                && source != destination
                && relation.axis_mask > 0
                && relation.axis_mask <= 7
                && relation.kind == relation.axis_mask.count_ones()
                && self.region_ids[source] == self.region_ids[destination]
                && (self.boundary_axis_masks[source] ^ self.boundary_axis_masks[destination])
                    == relation.axis_mask
        };
        let mut generator_pairs = BTreeSet::new();
        for relation in &self.generator_relations {
            if !validate_relation(relation)
                || !generator_pairs.insert((
                    relation.source_node.min(relation.destination_node),
                    relation.source_node.max(relation.destination_node),
                ))
            {
                return Err(modal_v6_error("owned_generator_invalid"));
            }
            let source = find(&mut parent, relation.source_node as usize);
            let destination = find(&mut parent, relation.destination_node as usize);
            if source != destination {
                parent[destination] = source;
            }
        }
        let mut closure = BTreeSet::new();
        for relation in &self.closure_relations {
            if !validate_relation(relation) || !closure.insert(relation_key(relation)) {
                return Err(modal_v6_error("owned_closure_invalid"));
            }
            if find(&mut parent, relation.source_node as usize)
                != find(&mut parent, relation.destination_node as usize)
            {
                return Err(modal_v6_error("owned_closure_outside_class"));
            }
        }
        if self
            .generator_relations
            .iter()
            .any(|relation| !closure.contains(&relation_key(relation)))
        {
            return Err(modal_v6_error("owned_generator_missing_from_closure"));
        }
        let mut classes = BTreeMap::<usize, Vec<u64>>::new();
        for node in 0..node_count {
            let root = find(&mut parent, node);
            classes.entry(root).or_default().push(node as u64);
        }
        let mut ordered = classes.into_values().collect::<Vec<_>>();
        ordered.sort_by_key(|members| members[0]);
        let mut class_ids = vec![0; node_count];
        for members in &ordered {
            for member in members {
                class_ids[*member as usize] = members[0];
            }
            for lhs in 0..members.len() {
                for rhs in lhs + 1..members.len() {
                    let source = members[lhs] as usize;
                    let destination = members[rhs] as usize;
                    let axis_mask =
                        self.boundary_axis_masks[source] ^ self.boundary_axis_masks[destination];
                    if axis_mask != 0
                        && !closure.contains(&(
                            members[lhs],
                            members[rhs],
                            axis_mask,
                            axis_mask.count_ones(),
                        ))
                    {
                        return Err(modal_v6_error(if axis_mask.count_ones() >= 3 {
                            "owned_corner_closure_incomplete"
                        } else if axis_mask.count_ones() == 2 {
                            "owned_edge_closure_incomplete"
                        } else {
                            "owned_face_closure_incomplete"
                        }));
                    }
                }
            }
        }
        let class_digests = ordered
            .iter()
            .map(|members| {
                let mut preimage = "periodic_modal_equivalence_class.v1\n".to_string();
                preimage.push_str("schema=periodic_mesh_certificate.v6\n");
                preimage.push_str(&format!(
                    "part_role={}\n",
                    if self.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
                        "magnetic"
                    } else {
                        "scalar_airbox"
                    }
                ));
                append_modal_v6_text(&mut preimage, "part_identity", &self.part_identity);
                append_modal_v6_text(
                    &mut preimage,
                    "topology_fingerprint",
                    &self.topology_fingerprint,
                );
                preimage.push_str(&format!("canonical_class_id={}\n", members[0]));
                preimage.push_str(&format!("member_count={}\n", members.len()));
                for member in members {
                    preimage.push_str(&format!(
                        "member={},region={},boundary_axis_mask={}\n",
                        member,
                        self.region_ids[*member as usize],
                        self.boundary_axis_masks[*member as usize]
                    ));
                }
                OwnedModalCertificateV6ClassDigest {
                    canonical_class_id: members[0],
                    member_count: members.len() as u64,
                    sha256: sha256_text(&preimage),
                }
            })
            .collect::<Vec<_>>();
        let mut aggregate = "periodic_modal_equivalence_classes.v1\n".to_string();
        aggregate.push_str("schema=periodic_mesh_certificate.v6\n");
        for digest in &class_digests {
            aggregate.push_str(&format!(
                "class={},members={},digest={}\n",
                digest.canonical_class_id, digest.member_count, digest.sha256
            ));
        }
        Ok((class_ids, class_digests, sha256_text(&aggregate)))
    }

    pub(super) fn validate(&self, view_kind: u32) -> Result<(), RunError> {
        if self.view_kind != view_kind {
            return Err(modal_v6_error("owned_view_kind_invalid"));
        }
        let (ids, digests, _) = self.canonical_state()?;
        if ids != self.expected_class_ids || digests != self.expected_class_digests {
            return Err(modal_v6_error("owned_class_metadata_mismatch"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OwnedModalCertificateV6Binding {
    pub mesh_generation_identity: String,
    pub mesh_magnetic: OwnedModalCertificateV6View,
    pub payload_magnetic: OwnedModalCertificateV6View,
    pub mesh_scalar: OwnedModalCertificateV6View,
    pub payload_scalar: OwnedModalCertificateV6View,
    pub canonical_preimage: String,
    pub canonical_preimage_sha256: String,
    pub magnetic_class_digest_sha256: String,
    pub scalar_class_digest_sha256: String,
    pub shared_domain_map_binding_sha256: String,
    pub boundary_gauge_digest: String,
    pub(super) boundary_kind: String,
    pub(super) boundary_marker: u32,
    pub(super) robin_beta: f64,
    pub(super) source_topology_fingerprint: String,
    pub bias_field_sample_index: u64,
    pub bias_field_sample_id: String,
    pub bias_field_sample_signature: String,
    pub(super) bias_field_sample_a_per_m: Vec<f64>,
    pub(super) cell_markers: Vec<u32>,
    pub(super) scalar_reduced_node: Vec<u32>,
    pub(super) scalar_reduced_class_count: u64,
    pub(super) magnetic_reduced_node: Vec<u32>,
    pub(super) magnetic_reduced_class_count: u64,
}

impl OwnedModalCertificateV6Binding {
    #[cfg(test)]
    pub(crate) fn test_fixture(
        digest: &str,
        mesh_magnetic: OwnedModalCertificateV6View,
        payload_magnetic: OwnedModalCertificateV6View,
        mesh_scalar: OwnedModalCertificateV6View,
        payload_scalar: OwnedModalCertificateV6View,
    ) -> Self {
        Self {
            mesh_generation_identity: "mesh-generation:fixture".to_string(),
            mesh_magnetic,
            payload_magnetic,
            mesh_scalar,
            payload_scalar,
            canonical_preimage: "fixture".to_string(),
            canonical_preimage_sha256: digest.to_string(),
            magnetic_class_digest_sha256: digest.to_string(),
            scalar_class_digest_sha256: digest.to_string(),
            shared_domain_map_binding_sha256: digest.to_string(),
            boundary_gauge_digest: digest.to_string(),
            boundary_kind: "robin".to_string(),
            boundary_marker: 1,
            robin_beta: 1.0,
            source_topology_fingerprint: digest.to_string(),
            bias_field_sample_index: 3,
            bias_field_sample_id: "bias-field-sample:3".to_string(),
            bias_field_sample_signature: digest.to_string(),
            bias_field_sample_a_per_m: vec![0.0, 0.0, 0.0],
            cell_markers: vec![1, 0],
            scalar_reduced_node: vec![0, 0, 0, 0, 1],
            scalar_reduced_class_count: 2,
            magnetic_reduced_node: vec![0, 0, 0, 0, u32::MAX],
            magnetic_reduced_class_count: 1,
        }
    }

    pub(super) fn validate(&self) -> Result<(), RunError> {
        self.mesh_magnetic
            .validate(MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH)?;
        self.payload_magnetic
            .validate(MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD)?;
        self.mesh_scalar
            .validate(MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH)?;
        self.payload_scalar
            .validate(MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD)?;
        if !modal_v6_views_equal(&self.mesh_magnetic, &self.payload_magnetic)
            || !modal_v6_views_equal(&self.mesh_scalar, &self.payload_scalar)
            || self.mesh_magnetic.part_identity == self.mesh_scalar.part_identity
        {
            return Err(modal_v6_error("owned_mesh_payload_mismatch"));
        }
        let (_, _, magnetic_digest) = self.mesh_magnetic.canonical_state()?;
        let (_, _, scalar_digest) = self.mesh_scalar.canonical_state()?;
        let preimage = modal_v6_canonical_preimage(
            &self.mesh_generation_identity,
            &self.mesh_magnetic,
            &self.mesh_scalar,
        )?;
        if preimage != self.canonical_preimage
            || sha256_text(&preimage) != self.canonical_preimage_sha256
            || magnetic_digest != self.magnetic_class_digest_sha256
            || scalar_digest != self.scalar_class_digest_sha256
            || self.boundary_gauge_digest
                != shared_domain_content_digest(
                    "modal_boundary_gauge",
                    &(
                        self.boundary_kind.as_str(),
                        self.boundary_marker,
                        self.robin_beta,
                        self.source_topology_fingerprint.as_str(),
                    ),
                )?
            || self.bias_field_sample_id
                != format!("bias-field-sample:{}", self.bias_field_sample_index)
            || self.bias_field_sample_a_per_m.is_empty()
            || self
                .bias_field_sample_a_per_m
                .iter()
                .any(|value| !value.is_finite())
            || self.bias_field_sample_signature
                != shared_domain_content_digest(
                    "modal_bias_field_sample",
                    &(
                        self.bias_field_sample_index,
                        self.bias_field_sample_a_per_m.as_slice(),
                    ),
                )?
        {
            return Err(modal_v6_error("owned_binding_digest_mismatch"));
        }
        let map_digest = modal_shared_domain_map_binding_digest(
            &self.mesh_generation_identity,
            &self.mesh_magnetic,
            &self.mesh_scalar,
            &self.canonical_preimage_sha256,
            &self.magnetic_class_digest_sha256,
            &self.scalar_class_digest_sha256,
            &self.cell_markers,
            &self.scalar_reduced_node,
            self.scalar_reduced_class_count,
            &self.magnetic_reduced_node,
            self.magnetic_reduced_class_count,
        )?;
        if map_digest != self.shared_domain_map_binding_sha256 {
            return Err(modal_v6_error("owned_map_binding_digest_mismatch"));
        }
        Ok(())
    }
}

pub(super) fn modal_v6_error(reason: &str) -> RunError {
    RunError {
        message: format!("periodic_mesh_certificate_v6_producer_{reason}"),
    }
}

fn append_modal_v6_text(preimage: &mut String, name: &str, value: &str) {
    preimage.push_str(&format!("{name}={}:{}\n", value.len(), value));
}

fn modal_certificate_marker_map_fingerprint(mesh: &fullmag_ir::MeshIR) -> String {
    let payload = serde_json::json!({
        "element_markers": mesh.element_markers,
        "boundary_markers": mesh.boundary_markers,
        "periodic_boundary_pairs": mesh.periodic_boundary_pairs.iter().map(|pair| {
            serde_json::json!({
                "pair_id": pair.pair_id,
                "marker_a": pair.marker_a,
                "marker_b": pair.marker_b,
                "axis": pair.axis_hint,
            })
        }).collect::<Vec<_>>(),
    });
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default())
    )
}

fn modal_v6_views_equal(
    mesh: &OwnedModalCertificateV6View,
    payload: &OwnedModalCertificateV6View,
) -> bool {
    mesh.part_role == payload.part_role
        && mesh.part_identity == payload.part_identity
        && mesh.topology_fingerprint == payload.topology_fingerprint
        && mesh.region_ids == payload.region_ids
        && mesh.boundary_axis_masks == payload.boundary_axis_masks
        && mesh.region_roles == payload.region_roles
        && mesh.generator_relations == payload.generator_relations
        && mesh.closure_relations == payload.closure_relations
        && mesh.expected_class_ids == payload.expected_class_ids
        && mesh.expected_class_digests == payload.expected_class_digests
}

fn append_modal_v6_view(
    preimage: &mut String,
    name: &str,
    view: &OwnedModalCertificateV6View,
) -> Result<(), RunError> {
    let (_, class_digests, _) = view.canonical_state()?;
    preimage.push_str(&format!(
        "{name}.part_role={}\n",
        if view.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            "magnetic"
        } else {
            "scalar_airbox"
        }
    ));
    append_modal_v6_text(
        preimage,
        &format!("{name}.part_identity"),
        &view.part_identity,
    );
    append_modal_v6_text(
        preimage,
        &format!("{name}.topology_fingerprint"),
        &view.topology_fingerprint,
    );
    preimage.push_str(&format!("{name}.node_count={}\n", view.node_count()));
    let mut roles = view.region_roles.clone();
    roles.sort_by_key(|role| (role.region_id, role.part_role));
    for role in roles {
        preimage.push_str(&format!(
            "{name}.region_role={},{}\n",
            role.region_id, role.part_role
        ));
    }
    for node in 0..view.region_ids.len() {
        preimage.push_str(&format!(
            "{name}.node={},region={},boundary_axis_mask={}\n",
            node, view.region_ids[node], view.boundary_axis_masks[node]
        ));
    }
    let mut generators = view.generator_relations.clone();
    generators.sort_by_key(|relation| {
        (
            relation.source_node.min(relation.destination_node),
            relation.source_node.max(relation.destination_node),
            relation.axis_mask,
            relation.kind,
        )
    });
    let mut closure = view.closure_relations.clone();
    closure.sort_by_key(|relation| {
        (
            relation.source_node.min(relation.destination_node),
            relation.source_node.max(relation.destination_node),
            relation.axis_mask,
            relation.kind,
        )
    });
    for (prefix, relations) in [("generator", generators), ("closure", closure)] {
        for relation in relations {
            preimage.push_str(&format!(
                "{name}.{prefix}={},{},{},{}\n",
                relation.source_node.min(relation.destination_node),
                relation.source_node.max(relation.destination_node),
                relation.axis_mask,
                relation.kind
            ));
        }
    }
    for digest in class_digests {
        preimage.push_str(&format!(
            "{name}.class={},members={},digest={}\n",
            digest.canonical_class_id, digest.member_count, digest.sha256
        ));
    }
    Ok(())
}

pub(super) fn modal_v6_canonical_preimage(
    mesh_generation_identity: &str,
    magnetic: &OwnedModalCertificateV6View,
    scalar: &OwnedModalCertificateV6View,
) -> Result<String, RunError> {
    let mut preimage = "periodic_modal_equivalence_map_binding.v1\n".to_string();
    preimage.push_str("schema=periodic_mesh_certificate.v6\n");
    append_modal_v6_text(
        &mut preimage,
        "mesh_generation_identity",
        mesh_generation_identity,
    );
    append_modal_v6_view(&mut preimage, "magnetic", magnetic)?;
    append_modal_v6_view(&mut preimage, "scalar", scalar)?;
    Ok(preimage)
}

#[derive(Default)]
struct ModalCanonicalDigestBuilder(Vec<u8>);

impl ModalCanonicalDigestBuilder {
    fn new(schema: &str) -> Self {
        let mut builder = Self::default();
        builder.add_string("schema", schema);
        builder
    }

    fn add_field(&mut self, name: &str, kind: u8, value: &[u8]) {
        self.0.extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.0.extend_from_slice(name.as_bytes());
        self.0.push(kind);
        self.0
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.0.extend_from_slice(value);
    }

    fn add_string(&mut self, name: &str, value: &str) {
        self.add_field(name, 1, value.as_bytes());
    }

    fn add_u64(&mut self, name: &str, value: u64) {
        self.add_field(name, 2, &value.to_be_bytes());
    }

    fn digest(&self) -> String {
        format!("sha256:{:x}", Sha256::digest(&self.0))
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn modal_shared_domain_map_binding_digest(
    mesh_generation_identity: &str,
    magnetic: &OwnedModalCertificateV6View,
    scalar: &OwnedModalCertificateV6View,
    canonical_preimage_sha256: &str,
    magnetic_class_digest_sha256: &str,
    scalar_class_digest_sha256: &str,
    cell_markers: &[u32],
    scalar_reduced_node: &[u32],
    scalar_reduced_class_count: u64,
    magnetic_reduced_node: &[u32],
    magnetic_reduced_class_count: u64,
) -> Result<String, RunError> {
    let node_count = scalar.node_count() as usize;
    let magnetic_count = magnetic.node_count() as usize;
    if scalar_reduced_node.len() != node_count
        || magnetic_reduced_node.len() != node_count
        || magnetic_count == 0
        || magnetic_count > node_count
    {
        return Err(modal_v6_error("map_binding_cardinality_invalid"));
    }
    validate_modal_reduction_map(
        &scalar.expected_class_ids,
        scalar_reduced_node,
        scalar_reduced_class_count,
        node_count,
        false,
    )?;
    validate_modal_reduction_map(
        &magnetic.expected_class_ids,
        magnetic_reduced_node,
        magnetic_reduced_class_count,
        node_count,
        true,
    )?;
    let mut digest = ModalCanonicalDigestBuilder::new("shared_domain_map_binding.v1");
    digest.add_string("mesh_generation_identity", mesh_generation_identity);
    digest.add_string(
        "node_order_contract",
        "scalar_global_nodes_authoritative;magnetic_compact_exact_prefix",
    );
    digest.add_u64("scalar_global_node_count", node_count as u64);
    digest.add_u64("magnetic_compact_node_count", magnetic_count as u64);
    for node in 0..node_count {
        digest.add_u64(
            &format!("global_node_magnetic_marker[{node}]"),
            u64::from(node < magnetic_count),
        );
    }
    for node in 0..magnetic_count {
        digest.add_u64(
            &format!("magnetic_compact_source_global_node[{node}]"),
            node as u64,
        );
    }
    digest.add_string("magnetic_part_identity", &magnetic.part_identity);
    digest.add_string("airbox_part_identity", &scalar.part_identity);
    digest.add_u64(
        "certificate_binding_status",
        MODAL_CERTIFICATE_BINDING_ACCEPTED as u64,
    );
    digest.add_string("certificate_binding_reason", "none");
    digest.add_string("v6_canonical_preimage_sha256", canonical_preimage_sha256);
    digest.add_string(
        "v6_magnetic_class_digest_sha256",
        magnetic_class_digest_sha256,
    );
    digest.add_string("v6_scalar_class_digest_sha256", scalar_class_digest_sha256);
    digest.add_u64("cell_marker_count", cell_markers.len() as u64);
    for (index, marker) in cell_markers.iter().enumerate() {
        digest.add_u64(&format!("cell_marker[{index}]"), *marker as u64);
    }
    for (name, ids) in [
        ("magnetic", &magnetic.expected_class_ids),
        ("scalar", &scalar.expected_class_ids),
    ] {
        digest.add_u64(
            &format!("{name}_canonical_class_id_count"),
            ids.len() as u64,
        );
        for (index, value) in ids.iter().enumerate() {
            digest.add_u64(&format!("{name}_canonical_class_id[{index}]"), *value);
        }
    }
    digest.add_u64("scalar_reduced_class_count", scalar_reduced_class_count);
    digest.add_u64("magnetic_reduced_class_count", magnetic_reduced_class_count);
    for node in 0..node_count {
        digest.add_u64(
            &format!("scalar_reduced_node[{node}]"),
            scalar_reduced_node[node] as u64,
        );
        digest.add_u64(
            &format!("magnetic_reduced_node[{node}]"),
            magnetic_reduced_node[node] as u64,
        );
    }
    Ok(digest.digest())
}

fn validate_modal_reduction_map(
    canonical_ids: &[u64],
    reduced: &[u32],
    class_count: u64,
    global_count: usize,
    magnetic_prefix: bool,
) -> Result<(), RunError> {
    if canonical_ids.is_empty()
        || canonical_ids.len() > global_count
        || reduced.len() != global_count
    {
        return Err(modal_v6_error("reduction_map_cardinality_invalid"));
    }
    let ordered = canonical_ids.iter().copied().collect::<BTreeSet<_>>();
    if ordered.len() as u64 != class_count {
        return Err(modal_v6_error("reduction_map_class_count_mismatch"));
    }
    let mapping = ordered
        .into_iter()
        .enumerate()
        .map(|(index, canonical)| (canonical, index as u32))
        .collect::<BTreeMap<_, _>>();
    if canonical_ids
        .iter()
        .enumerate()
        .any(|(node, id)| reduced[node] != mapping[id])
        || (magnetic_prefix
            && reduced[canonical_ids.len()..]
                .iter()
                .any(|value| *value != u32::MAX))
        || (!magnetic_prefix && canonical_ids.len() != global_count)
    {
        return Err(modal_v6_error("reduction_map_not_canonical"));
    }
    Ok(())
}

struct ModalV6PartRegistry {
    magnetic_identity: String,
    air_identity: String,
    magnetic_mask: Vec<bool>,
    magnetic_node_count: usize,
}

fn modal_participation_source_mesh_identity(
    plan: &FemEigenPlanIR,
) -> crate::eigen::ModalParticipationSourceMeshIdentity {
    crate::eigen::ModalParticipationSourceMeshIdentity {
        mesh_id: plan.mesh_name.clone(),
        topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
        indexing: "full_domain_node_order".to_string(),
        node_count: plan.mesh.nodes.len(),
    }
}

pub(super) fn modal_participation_for_mode(
    context: &Result<
        crate::eigen::ModalParticipationMeshContext,
        crate::eigen::ModalParticipationUnavailableDetail,
    >,
    plan: &FemEigenPlanIR,
    real: &[[f64; 3]],
    imag: &[[f64; 3]],
    solver_device: &str,
) -> crate::eigen::ModalParticipationObservable {
    match context {
        Ok(context) => context.compute(real, imag, solver_device),
        Err(detail) => crate::eigen::ModalParticipationObservable::unavailable(
            *detail,
            solver_device,
            Some(modal_participation_source_mesh_identity(plan)),
        ),
    }
}

pub(super) fn modal_participation_mesh_context(
    plan: &FemEigenPlanIR,
) -> Result<
    crate::eigen::ModalParticipationMeshContext,
    crate::eigen::ModalParticipationUnavailableDetail,
> {
    use crate::eigen::{
        ModalParticipationMeshContext, ModalParticipationObjectMarkerMembership,
        ModalParticipationUnavailableDetail,
    };
    use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector};

    if plan.fe_order != 1 {
        return Err(ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported);
    }
    let tet4_elements = plan
        .mesh
        .require_tet4_elements()
        .map_err(|_| ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported)?;
    if tet4_elements.is_empty() || plan.mesh.element_markers.len() != tet4_elements.len() {
        return Err(ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported);
    }

    let mut element_owners = vec![None::<String>; tet4_elements.len()];
    let mut saw_magnetic_part = false;
    for part in plan
        .mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::MagneticObject)
    {
        saw_magnetic_part = true;
        let object_id = part
            .object_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(ModalParticipationUnavailableDetail::ObjectMembershipMissing)?;
        let selected = match &part.element_selector {
            FemMeshPartSelector::ElementRange { start, count } => {
                let start = *start as usize;
                let end = start
                    .checked_add(*count as usize)
                    .filter(|end| *end <= tet4_elements.len())
                    .ok_or(ModalParticipationUnavailableDetail::ObjectMembershipMissing)?;
                (start..end).collect::<Vec<_>>()
            }
            FemMeshPartSelector::ElementMarkerSet { markers } => {
                if markers.is_empty() {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
                }
                let marker_set = markers.iter().copied().collect::<BTreeSet<_>>();
                if marker_set.len() != markers.len() {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
                }
                plan.mesh
                    .element_markers
                    .iter()
                    .enumerate()
                    .filter_map(|(index, marker)| marker_set.contains(marker).then_some(index))
                    .collect()
            }
            _ => return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing),
        };
        if selected.is_empty() {
            return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
        }
        for element_index in selected {
            if plan.mesh.element_markers[element_index] == 0 {
                return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
            }
            match &element_owners[element_index] {
                Some(existing) if existing != object_id => {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing)
                }
                Some(_) => {}
                None => element_owners[element_index] = Some(object_id.to_string()),
            }
        }
    }
    if !saw_magnetic_part {
        return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
    }

    let mut marker_owners = BTreeMap::<u32, String>::new();
    for (marker, owner) in plan.mesh.element_markers.iter().zip(&element_owners) {
        if *marker == 0 {
            if owner.is_some() {
                return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
            }
            continue;
        }
        let owner = owner
            .as_deref()
            .ok_or(ModalParticipationUnavailableDetail::ObjectCoverageIncomplete)?;
        if marker_owners
            .insert(*marker, owner.to_string())
            .is_some_and(|existing| existing != owner)
        {
            return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
        }
    }

    let mut object_markers = BTreeMap::<String, BTreeSet<u32>>::new();
    for (marker, object_id) in marker_owners {
        object_markers.entry(object_id).or_default().insert(marker);
    }
    if object_markers.is_empty() {
        return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
    }

    Ok(ModalParticipationMeshContext {
        source_mesh_identity: modal_participation_source_mesh_identity(plan),
        nodes_m: plan.mesh.nodes.clone(),
        tet4_elements,
        element_markers: plan.mesh.element_markers.clone(),
        object_marker_membership: object_markers
            .into_iter()
            .map(
                |(object_id, markers)| ModalParticipationObjectMarkerMembership {
                    object_id,
                    markers: markers.into_iter().collect(),
                },
            )
            .collect(),
    })
}

fn modal_v6_part_registry(
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
) -> Result<ModalV6PartRegistry, RunError> {
    use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector};

    let cells = mesh
        .require_tet4_elements()
        .map_err(|_| modal_v6_error("mesh_part_tet4_topology_invalid"))?;
    if mesh_parts.is_empty() {
        return Err(modal_v6_error("mesh_part_registry_missing"));
    }
    let mut part_ids = BTreeSet::new();
    if mesh_parts
        .iter()
        .any(|part| part.id.is_empty() || !part_ids.insert(part.id.as_str()))
    {
        return Err(modal_v6_error("mesh_part_id_duplicate"));
    }
    let magnetic_parts = mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::MagneticObject)
        .collect::<Vec<_>>();
    let air_parts = mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::Air)
        .collect::<Vec<_>>();
    if magnetic_parts.is_empty() || air_parts.len() != 1 {
        return Err(modal_v6_error("mesh_part_role_registry_invalid"));
    }
    let air_part = air_parts[0];
    let magnetic_object_id = magnetic_parts[0]
        .object_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| modal_v6_error("magnetic_part_owner_missing"))?;
    if magnetic_parts.iter().any(|part| {
        part.object_id.as_deref() != Some(magnetic_object_id)
            || part
                .geometry_id
                .as_deref()
                .is_some_and(|value| value.is_empty())
    }) {
        return Err(modal_v6_error("multiple_magnetic_objects_unsupported"));
    }
    if air_part.id != "part:__air__"
        || air_part.object_id.is_some()
        || air_part.geometry_id.is_some()
    {
        return Err(modal_v6_error("mesh_part_identity_mismatch"));
    }

    let resolve_elements = |part: &fullmag_ir::FemMeshPartIR| {
        let indices = match &part.element_selector {
            FemMeshPartSelector::ElementRange { start, count } => {
                let start = *start as usize;
                let end = start
                    .checked_add(*count as usize)
                    .filter(|end| *end <= cells.len())
                    .ok_or_else(|| modal_v6_error("mesh_part_element_selector_out_of_bounds"))?;
                (start..end).collect::<BTreeSet<_>>()
            }
            FemMeshPartSelector::ElementMarkerSet { markers } => {
                if markers.is_empty() {
                    return Err(modal_v6_error("mesh_part_element_marker_set_empty"));
                }
                let unique_markers = markers.iter().copied().collect::<BTreeSet<_>>();
                if unique_markers.len() != markers.len() {
                    return Err(modal_v6_error("mesh_part_element_marker_duplicate"));
                }
                mesh.element_markers
                    .iter()
                    .enumerate()
                    .filter_map(|(index, marker)| unique_markers.contains(marker).then_some(index))
                    .collect()
            }
            _ => return Err(modal_v6_error("mesh_part_element_selector_kind_invalid")),
        };
        if indices.is_empty() {
            return Err(modal_v6_error("mesh_part_element_selector_empty"));
        }
        Ok(indices)
    };
    let resolve_nodes = |part: &fullmag_ir::FemMeshPartIR| {
        let indices = if !part.node_indices.is_empty() {
            part.node_indices
                .iter()
                .map(|node| *node as usize)
                .collect::<BTreeSet<_>>()
        } else {
            match &part.node_selector {
                FemMeshPartSelector::NodeRange { start, count } => {
                    let start = *start as usize;
                    let end = start
                        .checked_add(*count as usize)
                        .filter(|end| *end <= mesh.nodes.len())
                        .ok_or_else(|| modal_v6_error("mesh_part_node_selector_out_of_bounds"))?;
                    (start..end).collect()
                }
                _ => return Err(modal_v6_error("mesh_part_node_selector_kind_invalid")),
            }
        };
        if indices.is_empty() || indices.iter().any(|node| *node >= mesh.nodes.len()) {
            return Err(modal_v6_error("mesh_part_node_selector_invalid"));
        }
        Ok(indices)
    };
    let validate_boundary_selector = |part: &fullmag_ir::FemMeshPartIR| {
        if !part.boundary_face_indices.is_empty() {
            if part
                .boundary_face_indices
                .iter()
                .any(|face| *face as usize >= mesh.facet_count())
            {
                return Err(modal_v6_error("mesh_part_boundary_selector_out_of_bounds"));
            }
            return Ok(());
        }
        match part.boundary_face_selector {
            FemMeshPartSelector::BoundaryFaceRange { start, count } => {
                let start = start as usize;
                start
                    .checked_add(count as usize)
                    .filter(|end| *end <= mesh.facet_count())
                    .map(|_| ())
                    .ok_or_else(|| modal_v6_error("mesh_part_boundary_selector_out_of_bounds"))
            }
            _ => Err(modal_v6_error("mesh_part_boundary_selector_kind_invalid")),
        }
    };

    let expected_magnetic_elements = mesh
        .element_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| (*marker != 0).then_some(index))
        .collect::<BTreeSet<_>>();
    let expected_air_elements = mesh
        .element_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| (*marker == 0).then_some(index))
        .collect::<BTreeSet<_>>();
    if expected_magnetic_elements.is_empty() || expected_air_elements.is_empty() {
        return Err(modal_v6_error("mesh_part_marker_partition_invalid"));
    }

    let mut selected_magnetic_elements = BTreeSet::new();
    let mut magnetic_markers = BTreeSet::new();
    let mut magnetic_parts_with_markers = Vec::with_capacity(magnetic_parts.len());
    let mut element_cursor = 0_usize;
    let mut owned_node_cursor = 0_usize;
    for part in magnetic_parts {
        let part_owner = part
            .geometry_id
            .as_deref()
            .or(part.object_id.as_deref())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| modal_v6_error("magnetic_part_owner_missing"))?;
        if part.id != format!("part:{part_owner}") {
            return Err(modal_v6_error("mesh_part_identity_mismatch"));
        }
        let selected_elements = resolve_elements(part)?;
        if selected_elements
            .iter()
            .any(|element| selected_magnetic_elements.contains(element))
        {
            return Err(modal_v6_error("mesh_part_element_overlap"));
        }
        let selected_markers = selected_elements
            .iter()
            .map(|element| mesh.element_markers[*element])
            .collect::<BTreeSet<_>>();
        if selected_markers.contains(&0) {
            return Err(modal_v6_error("magnetic_part_selects_air_marker"));
        }
        if selected_markers.len() != 1 {
            return Err(modal_v6_error("magnetic_part_marker_ambiguous"));
        }
        let marker = *selected_markers
            .first()
            .ok_or_else(|| modal_v6_error("magnetic_part_marker_missing"))?;
        if !magnetic_markers.insert(marker) {
            return Err(modal_v6_error("magnetic_marker_duplicate"));
        }
        let canonical_elements =
            (element_cursor..element_cursor + selected_elements.len()).collect::<BTreeSet<_>>();
        if selected_elements != canonical_elements {
            return Err(modal_v6_error("magnetic_part_order_noncanonical"));
        }
        if marker as usize != magnetic_parts_with_markers.len() + 1 {
            return Err(modal_v6_error("magnetic_marker_order_noncanonical"));
        }
        element_cursor += selected_elements.len();
        selected_magnetic_elements.extend(selected_elements.iter().copied());

        if !matches!(
            part.node_selector,
            FemMeshPartSelector::NodeRange { start, count }
                if start as usize == owned_node_cursor
                    && (start as usize).checked_add(count as usize)
                        .is_some_and(|end| end <= mesh.nodes.len())
        ) {
            return Err(modal_v6_error("mesh_part_node_selector_ownership_mismatch"));
        }
        let owned_node_count = match part.node_selector {
            FemMeshPartSelector::NodeRange { count, .. } => count as usize,
            _ => unreachable!("NodeRange was checked above"),
        };
        let owned_nodes =
            (owned_node_cursor..owned_node_cursor + owned_node_count).collect::<BTreeSet<_>>();
        owned_node_cursor += owned_node_count;
        let selected_nodes = resolve_nodes(part)?;
        let expected_nodes = selected_elements
            .iter()
            .flat_map(|element| cells[*element].iter().copied())
            .map(|node| node as usize)
            .collect::<BTreeSet<_>>();
        if selected_nodes != expected_nodes || !owned_nodes.is_subset(&selected_nodes) {
            return Err(modal_v6_error("mesh_part_node_selector_topology_mismatch"));
        }
        validate_boundary_selector(part)?;
        magnetic_parts_with_markers.push((part, marker));
    }
    if selected_magnetic_elements != expected_magnetic_elements {
        return Err(modal_v6_error("magnetic_marker_uncovered"));
    }

    let selected_air_elements = resolve_elements(air_part)?;
    if selected_air_elements != expected_air_elements
        || selected_air_elements
            .iter()
            .any(|element| selected_magnetic_elements.contains(element))
    {
        return Err(modal_v6_error("air_part_element_selector_marker_mismatch"));
    }
    let mut magnetic_mask = vec![false; mesh.nodes.len()];
    for element in &selected_magnetic_elements {
        for node in &cells[*element] {
            let is_magnetic = magnetic_mask
                .get_mut(*node as usize)
                .ok_or_else(|| modal_v6_error("marker_node_invalid"))?;
            *is_magnetic = true;
        }
    }
    let magnetic_node_count = magnetic_mask.iter().take_while(|value| **value).count();
    if magnetic_node_count == 0
        || magnetic_mask[magnetic_node_count..]
            .iter()
            .any(|value| *value)
        || magnetic_node_count != owned_node_cursor
    {
        return Err(modal_v6_error("magnetic_nodes_not_exact_prefix"));
    }
    if !matches!(
        air_part.node_selector,
        FemMeshPartSelector::NodeRange { start, count }
            if start as usize == magnetic_node_count
                && count as usize == mesh.nodes.len() - magnetic_node_count
    ) {
        return Err(modal_v6_error("mesh_part_node_selector_ownership_mismatch"));
    }
    let selected_air_nodes = resolve_nodes(air_part)?;
    let expected_air_nodes = selected_air_elements
        .iter()
        .flat_map(|element| cells[*element].iter().copied())
        .map(|node| node as usize)
        .collect::<BTreeSet<_>>();
    if selected_air_nodes != expected_air_nodes {
        return Err(modal_v6_error("mesh_part_node_selector_topology_mismatch"));
    }
    validate_boundary_selector(air_part)?;

    let mut magnetic_identity = format!(
        "magnetic:object-id={}:{};part-count={}",
        magnetic_object_id.len(),
        magnetic_object_id,
        magnetic_parts_with_markers.len()
    );
    for (index, (part, marker)) in magnetic_parts_with_markers.iter().enumerate() {
        magnetic_identity.push_str(&format!(
            ";part[{index}]-id={}:{};part[{index}]-marker={marker}",
            part.id.len(),
            part.id
        ));
    }

    Ok(ModalV6PartRegistry {
        magnetic_identity,
        air_identity: format!("airbox:part-id={}:{}", air_part.id.len(), air_part.id),
        magnetic_mask,
        magnetic_node_count,
    })
}

#[cfg(test)]
pub(super) fn modal_v6_part_identities(
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    magnetic_node_count: usize,
) -> Result<(String, String), RunError> {
    let registry = modal_v6_part_registry(mesh, mesh_parts)?;
    if registry.magnetic_node_count != magnetic_node_count {
        return Err(modal_v6_error("magnetic_node_count_registry_mismatch"));
    }
    Ok((registry.magnetic_identity, registry.air_identity))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_owned_modal_certificate_v6_binding(
    mesh: &fullmag_ir::MeshIR,
    certificate: &fullmag_ir::PeriodicMeshCertificateV6IR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    ms_nodal_field: Option<&[f64]>,
    a_nodal_field: Option<&[f64]>,
    scalar_reduced_node: &[u32],
    scalar_reduced_class_count: u64,
    magnetic_reduced_node: &[u32],
    magnetic_reduced_class_count: u64,
    boundary_kind: &str,
    boundary_marker: u32,
    robin_beta: f64,
    bias_field_sample_index: u64,
    bias_field_a_per_m: &[f64],
) -> Result<OwnedModalCertificateV6Binding, RunError> {
    let authoritative_certificate = mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            ms_nodal_field,
            a_nodal_field,
        )
        .map_err(|_| modal_v6_error("authoritative_certificate_rebuild_failed"))?;
    if certificate.schema_version != "periodic_mesh_certificate.v6"
        || certificate.certificate_status != "accepted"
        || certificate != &authoritative_certificate
        || certificate.topology_fingerprint != mesh.topology_fingerprint_v6()
        || certificate.marker_map_fingerprint != modal_certificate_marker_map_fingerprint(mesh)
        || !certificate.boundary_topology_match
        || !certificate.material_region_match
        || !certificate.corner_edge_cycle_unique
    {
        return Err(modal_v6_error("accepted_certificate_missing_or_stale"));
    }
    let cells = mesh
        .require_tet4_elements()
        .map_err(|_| modal_v6_error("tet4_marker_map_invalid"))?;
    if mesh.element_markers.len() != cells.len() {
        return Err(modal_v6_error("marker_map_invalid"));
    }
    let part_registry = modal_v6_part_registry(mesh, mesh_parts)?;
    let node_count = mesh.nodes.len();
    let magnetic_node_count = part_registry.magnetic_node_count;
    let magnetic_mask = part_registry.magnetic_mask;
    let mut axis_by_pair = BTreeMap::<String, u32>::new();
    for pair in &mesh.periodic_boundary_pairs {
        let axis = pair
            .axis_hint
            .as_deref()
            .and_then(|axis| match axis {
                "x" => Some(1),
                "y" => Some(2),
                "z" => Some(4),
                _ => None,
            })
            .or_else(|| {
                pair.translation.and_then(|translation| {
                    let nonzero = translation
                        .iter()
                        .enumerate()
                        .filter(|(_, value)| value.abs() > 1.0e-15)
                        .map(|(axis, _)| 1_u32 << axis)
                        .collect::<Vec<_>>();
                    (nonzero.len() == 1).then_some(nonzero[0])
                })
            })
            .ok_or_else(|| modal_v6_error("periodic_axis_ambiguous"))?;
        if axis_by_pair
            .insert(pair.pair_id.clone(), axis)
            .is_some_and(|previous| previous != axis)
        {
            return Err(modal_v6_error("periodic_axis_conflict"));
        }
    }
    if axis_by_pair.iter().any(|(pair_id, mask)| {
        let axis = match *mask {
            1 => "x",
            2 => "y",
            4 => "z",
            _ => return true,
        };
        !certificate
            .axis_pairs
            .iter()
            .any(|evidence| evidence.pair_id == *pair_id && evidence.axis.as_deref() == Some(axis))
    }) {
        return Err(modal_v6_error("certificate_axis_evidence_missing"));
    }
    let generators = mesh
        .periodic_node_pairs
        .iter()
        .map(|pair| {
            let axis_mask = *axis_by_pair
                .get(&pair.pair_id)
                .ok_or_else(|| modal_v6_error("periodic_pair_axis_missing"))?;
            if pair.node_a as usize >= node_count || pair.node_b as usize >= node_count {
                return Err(modal_v6_error("periodic_pair_node_invalid"));
            }
            Ok(OwnedModalCertificateV6Relation {
                source_node: pair.node_a.min(pair.node_b) as u64,
                destination_node: pair.node_a.max(pair.node_b) as u64,
                axis_mask,
                kind: 1,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let mut adjacency = vec![Vec::<(usize, u32)>::new(); node_count];
    for relation in &generators {
        let source = relation.source_node as usize;
        let destination = relation.destination_node as usize;
        adjacency[source].push((destination, relation.axis_mask));
        adjacency[destination].push((source, relation.axis_mask));
    }
    let mut masks = vec![None; node_count];
    for root in 0..node_count {
        if masks[root].is_some() {
            continue;
        }
        masks[root] = Some(0);
        let mut queue = VecDeque::from([root]);
        while let Some(node) = queue.pop_front() {
            let node_mask = masks[node].unwrap_or(0);
            for (neighbor, axis) in &adjacency[node] {
                let expected = node_mask ^ axis;
                match masks[*neighbor] {
                    Some(actual) if actual != expected => {
                        return Err(modal_v6_error("periodic_axis_cycle_inconsistent"));
                    }
                    Some(_) => {}
                    None => {
                        masks[*neighbor] = Some(expected);
                        queue.push_back(*neighbor);
                    }
                }
            }
        }
    }
    let masks = masks.into_iter().map(Option::unwrap).collect::<Vec<_>>();
    let make_view = |view_kind: u32,
                     part_role: u32,
                     part_len: usize,
                     part_identity: String,
                     topology_fingerprint: String|
     -> Result<OwnedModalCertificateV6View, RunError> {
        let region_ids = if part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            vec![1; part_len]
        } else {
            magnetic_mask
                .iter()
                .map(|is_magnetic| u32::from(*is_magnetic))
                .collect()
        };
        let region_roles = region_ids
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|region_id| OwnedModalCertificateV6RegionRole {
                region_id,
                part_role,
            })
            .collect::<Vec<_>>();
        let mut view_generators = Vec::new();
        for relation in &generators {
            let source_in = relation.source_node < part_len as u64;
            let destination_in = relation.destination_node < part_len as u64;
            if source_in != destination_in && part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
                return Err(modal_v6_error("periodic_relation_crosses_magnetic_prefix"));
            }
            if source_in && destination_in {
                view_generators.push(relation.clone());
            }
        }
        view_generators.sort_by_key(|relation| {
            (
                relation.source_node,
                relation.destination_node,
                relation.axis_mask,
            )
        });
        let mut parent = (0..part_len).collect::<Vec<_>>();
        fn root(parent: &mut [usize], node: usize) -> usize {
            if parent[node] != node {
                parent[node] = root(parent, parent[node]);
            }
            parent[node]
        }
        for relation in &view_generators {
            let source = root(&mut parent, relation.source_node as usize);
            let destination = root(&mut parent, relation.destination_node as usize);
            if source != destination {
                parent[destination] = source;
            }
        }
        let mut classes = BTreeMap::<usize, Vec<usize>>::new();
        for node in 0..part_len {
            let class = root(&mut parent, node);
            classes.entry(class).or_default().push(node);
        }
        let mut closure_relations = Vec::new();
        for members in classes.values() {
            for lhs in 0..members.len() {
                for rhs in lhs + 1..members.len() {
                    let source = members[lhs];
                    let destination = members[rhs];
                    let axis_mask = masks[source] ^ masks[destination];
                    if axis_mask != 0 {
                        closure_relations.push(OwnedModalCertificateV6Relation {
                            source_node: source as u64,
                            destination_node: destination as u64,
                            axis_mask,
                            kind: axis_mask.count_ones(),
                        });
                    }
                }
            }
        }
        closure_relations.sort_by_key(|relation| {
            (
                relation.source_node,
                relation.destination_node,
                relation.axis_mask,
                relation.kind,
            )
        });
        let mut view = OwnedModalCertificateV6View {
            view_kind,
            part_role,
            part_identity,
            topology_fingerprint,
            region_ids,
            boundary_axis_masks: masks[..part_len].to_vec(),
            region_roles,
            generator_relations: view_generators,
            closure_relations,
            expected_class_ids: Vec::new(),
            expected_class_digests: Vec::new(),
        };
        let (ids, digests, _) = view.canonical_state()?;
        view.expected_class_ids = ids;
        view.expected_class_digests = digests;
        Ok(view)
    };
    let magnetic_topology = shared_domain_content_digest(
        "periodic_modal_magnetic_view_topology",
        &(
            &certificate.topology_fingerprint,
            &certificate.marker_map_fingerprint,
            magnetic_node_count,
            &masks[..magnetic_node_count],
            &generators,
        ),
    )?;
    let scalar_topology = shared_domain_content_digest(
        "periodic_modal_scalar_view_topology",
        &(
            &certificate.topology_fingerprint,
            &certificate.marker_map_fingerprint,
            node_count,
            &masks,
            &generators,
        ),
    )?;
    let magnetic_identity = part_registry.magnetic_identity;
    let scalar_identity = part_registry.air_identity;
    let mesh_magnetic = make_view(
        MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH,
        MODAL_CERTIFICATE_PART_MAGNETIC,
        magnetic_node_count,
        magnetic_identity.clone(),
        magnetic_topology.clone(),
    )?;
    let payload_magnetic = make_view(
        MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD,
        MODAL_CERTIFICATE_PART_MAGNETIC,
        magnetic_node_count,
        magnetic_identity,
        magnetic_topology,
    )?;
    let mesh_scalar = make_view(
        MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH,
        MODAL_CERTIFICATE_PART_SCALAR_AIRBOX,
        node_count,
        scalar_identity.clone(),
        scalar_topology.clone(),
    )?;
    let payload_scalar = make_view(
        MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD,
        MODAL_CERTIFICATE_PART_SCALAR_AIRBOX,
        node_count,
        scalar_identity,
        scalar_topology,
    )?;
    let view_class_evidence = |view: &OwnedModalCertificateV6View| {
        let mut members = BTreeMap::<u64, u64>::new();
        for class_id in &view.expected_class_ids {
            *members.entry(*class_id).or_default() += 1;
        }
        (
            members.values().filter(|count| **count > 1).count() as u64,
            members
                .values()
                .map(|count| count.saturating_sub(1))
                .sum::<u64>(),
        )
    };
    let (magnetic_view_class_count, magnetic_view_pair_count) = view_class_evidence(&mesh_magnetic);
    let (scalar_view_class_count, scalar_view_pair_count) = view_class_evidence(&mesh_scalar);
    if magnetic_view_class_count != certificate.magnetic_class_count
        || magnetic_view_pair_count != certificate.magnetic_pair_count
        || scalar_view_class_count != certificate.scalar_class_count
        || scalar_view_pair_count != certificate.scalar_pair_count
    {
        return Err(modal_v6_error("certificate_view_class_evidence_mismatch"));
    }
    let mesh_generation_identity = format!("mesh-generation:{}", certificate.topology_fingerprint);
    let canonical_preimage =
        modal_v6_canonical_preimage(&mesh_generation_identity, &mesh_magnetic, &mesh_scalar)?;
    let canonical_preimage_sha256 = sha256_text(&canonical_preimage);
    let (_, _, magnetic_class_digest_sha256) = mesh_magnetic.canonical_state()?;
    let (_, _, scalar_class_digest_sha256) = mesh_scalar.canonical_state()?;
    let boundary_gauge_digest = shared_domain_content_digest(
        "modal_boundary_gauge",
        &(
            boundary_kind,
            boundary_marker,
            robin_beta,
            &certificate.topology_fingerprint,
        ),
    )?;
    if bias_field_a_per_m.is_empty() || bias_field_a_per_m.iter().any(|value| !value.is_finite()) {
        return Err(modal_v6_error("bias_field_sample_invalid"));
    }
    let bias_field_sample_signature = shared_domain_content_digest(
        "modal_bias_field_sample",
        &(bias_field_sample_index, bias_field_a_per_m),
    )?;
    let bias_field_sample_id = format!("bias-field-sample:{bias_field_sample_index}");
    let operator_cell_markers = mesh
        .element_markers
        .iter()
        .map(|marker| u32::from(*marker != 0))
        .collect::<Vec<_>>();
    let shared_domain_map_binding_sha256 = modal_shared_domain_map_binding_digest(
        &mesh_generation_identity,
        &mesh_magnetic,
        &mesh_scalar,
        &canonical_preimage_sha256,
        &magnetic_class_digest_sha256,
        &scalar_class_digest_sha256,
        &operator_cell_markers,
        scalar_reduced_node,
        scalar_reduced_class_count,
        magnetic_reduced_node,
        magnetic_reduced_class_count,
    )?;
    let binding = OwnedModalCertificateV6Binding {
        mesh_generation_identity,
        mesh_magnetic,
        payload_magnetic,
        mesh_scalar,
        payload_scalar,
        canonical_preimage,
        canonical_preimage_sha256,
        magnetic_class_digest_sha256,
        scalar_class_digest_sha256,
        shared_domain_map_binding_sha256,
        boundary_gauge_digest,
        boundary_kind: boundary_kind.to_string(),
        boundary_marker,
        robin_beta,
        source_topology_fingerprint: certificate.topology_fingerprint.clone(),
        bias_field_sample_index,
        bias_field_sample_id,
        bias_field_sample_signature,
        bias_field_sample_a_per_m: bias_field_a_per_m.to_vec(),
        cell_markers: operator_cell_markers,
        scalar_reduced_node: scalar_reduced_node.to_vec(),
        scalar_reduced_class_count,
        magnetic_reduced_node: magnetic_reduced_node.to_vec(),
        magnetic_reduced_class_count,
    };
    binding.validate()?;
    Ok(binding)
}

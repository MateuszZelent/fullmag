//! Copy-on-write FEM mesh held in the live session snapshot.
//!
//! Mesh read handlers clone `SessionStateResponse` to work outside its lock.
//! A shared-domain mesh with a million cells is hundreds of megabytes of
//! nodes, connectivity, facets and part indices; deep-cloning it made even a
//! 14-byte mesh summary cost most of a second and serialized concurrent mesh
//! reads. `SharedFemMesh` makes that clone one reference-count bump, and
//! memoizes the topology fingerprint that several handlers derive per request,
//! and the mixed-certificate quality evidence, whose re-validation walks every
//! cell (seconds on such a mesh). Any mutable access drops the memos for the
//! mutated copy only.

use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex, OnceLock};

use fullmag_runner::FemMeshPayload;

use crate::schemas::mesh::MeshMixedCertificateQualityEvidenceResource;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone)]
pub(crate) struct SharedFemMesh {
    mesh: Arc<FemMeshPayload>,
    topology_fingerprint: Arc<OnceLock<String>>,
    mixed_certificate_evidence: Arc<Mutex<Option<(u64, MeshMixedCertificateQualityEvidenceResource)>>>,
}

impl SharedFemMesh {
    /// `fullmag_runner::fem_mesh_topology_fingerprint`, computed once per mesh version.
    pub(crate) fn topology_fingerprint(&self) -> &str {
        self.topology_fingerprint
            .get_or_init(|| fullmag_runner::fem_mesh_topology_fingerprint(&self.mesh))
    }

    /// The mixed-certificate evidence for `mesh_revision`, computed once per
    /// mesh version and revision. The evidence embeds the revision, so a new
    /// revision recomputes it even when the mesh is unchanged.
    pub(crate) fn mixed_certificate_evidence(
        &self,
        mesh_revision: u64,
        compute: impl FnOnce() -> MeshMixedCertificateQualityEvidenceResource,
    ) -> MeshMixedCertificateQualityEvidenceResource {
        // Holding the lock while computing lets concurrent readers wait for one
        // validation instead of repeating it.
        let mut memo = self
            .mixed_certificate_evidence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match memo.as_ref() {
            Some((revision, evidence)) if *revision == mesh_revision => evidence.clone(),
            _ => {
                let evidence = compute();
                *memo = Some((mesh_revision, evidence.clone()));
                evidence
            }
        }
    }

    /// The owned mesh, cloned only when another snapshot still shares it.
    pub(crate) fn into_inner(self) -> FemMeshPayload {
        Arc::try_unwrap(self.mesh).unwrap_or_else(|shared| (*shared).clone())
    }
}

impl From<FemMeshPayload> for SharedFemMesh {
    fn from(mesh: FemMeshPayload) -> Self {
        Self {
            mesh: Arc::new(mesh),
            topology_fingerprint: Arc::default(),
            mixed_certificate_evidence: Arc::default(),
        }
    }
}

impl Deref for SharedFemMesh {
    type Target = FemMeshPayload;

    fn deref(&self) -> &FemMeshPayload {
        &self.mesh
    }
}

impl DerefMut for SharedFemMesh {
    fn deref_mut(&mut self) -> &mut FemMeshPayload {
        self.topology_fingerprint = Arc::default();
        self.mixed_certificate_evidence = Arc::default();
        Arc::make_mut(&mut self.mesh)
    }
}

impl Serialize for SharedFemMesh {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.mesh.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SharedFemMesh {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        FemMeshPayload::deserialize(deserializer).map(Self::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_the_mesh_and_fingerprint_until_written() {
        let original = SharedFemMesh::from(FemMeshPayload {
            mesh_name: "tet".to_string(),
            mesh_id: "tet:1".to_string(),
            nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: None,
            per_domain_quality: Default::default(),
            build_report: None,
        });
        let fingerprint = original.topology_fingerprint().to_owned();
        let mut copy = original.clone();
        assert!(Arc::ptr_eq(&original.mesh, &copy.mesh));
        assert!(Arc::ptr_eq(&original.topology_fingerprint, &copy.topology_fingerprint));
        copy.nodes[3] = [0.0, 0.0, 2.0];
        assert!(!Arc::ptr_eq(&original.mesh, &copy.mesh));
        assert!(copy.topology_fingerprint.get().is_none());
        assert_eq!(original.topology_fingerprint(), fingerprint);
        assert_eq!(
            copy.topology_fingerprint(),
            fullmag_runner::fem_mesh_topology_fingerprint(&copy)
        );
    }
}

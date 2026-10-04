//! Exact saved geometry binding and core periodic-map consistency.
//! This is source integrity, not proof of live native coordinates or MFEM
//! restriction/prolongation, and never promotes representation evidence.

use anyhow::{bail, Context, Result};
use fullmag_ir::MeshPeriodicNodePairIR;
use fullmag_quantities::fem_local_node_map::FemLocalNodeIndexMap;
use fullmag_session::solution_field_geometry::read_pinned_solution_field_geometry;
use fullmag_session::solution_tensor_source::PinnedSolutionTensorSource;
use fullmag_session::SessionStore;

pub(super) fn validate_saved_native_map_geometry(
    store: &SessionStore,
    pinned: &PinnedSolutionTensorSource,
    map: &FemLocalNodeIndexMap,
    native_indexed_geometry_sha256: Option<&str>,
) -> Result<()> {
    let (_, geometry) = read_pinned_solution_field_geometry(store, pinned)?
        .context("saved native map has no exact geometry binding")?;
    if let Some(expected) = native_indexed_geometry_sha256 {
        validate_indexed_geometry_digest(expected, &geometry.mesh)?;
    }
    validate_core_periodic_map(
        map,
        geometry.mesh.nodes.len(),
        &geometry.mesh.periodic_node_pairs,
    )
}

fn validate_indexed_geometry_digest(expected: &str, mesh: &fullmag_ir::MeshIR) -> Result<()> {
    let actual = fullmag_ir::native_indexed_geometry::fem_native_indexed_geometry_sha256(
        &mesh.nodes,
        &mesh.cells,
    )
    .map_err(anyhow::Error::msg)?;
    if actual != expected {
        bail!("saved canonical geometry differs from the native indexed geometry snapshot");
    }
    Ok(())
}

fn root(parent: &mut [u32], node: u32) -> u32 {
    let mut representative = node;
    while parent[representative as usize] != representative {
        representative = parent[representative as usize];
    }
    let mut cursor = node;
    while parent[cursor as usize] != cursor {
        let next = parent[cursor as usize];
        parent[cursor as usize] = representative;
        cursor = next;
    }
    representative
}

/// Mirror the core's union-min class ordering, not MFEM true DOF reduction.
fn validate_core_periodic_map(
    map: &FemLocalNodeIndexMap,
    node_count: usize,
    pairs: &[MeshPeriodicNodePairIR],
) -> Result<()> {
    map.validate().map_err(anyhow::Error::msg)?;
    if node_count as u64 != map.local_node_count {
        bail!("saved native map node count differs from canonical geometry");
    }
    // map.validate bounds n before these O(n) cold allocations.
    let mut parent = (0..node_count as u32).collect::<Vec<_>>();
    for pair in pairs {
        if pair.node_a as usize >= node_count
            || pair.node_b as usize >= node_count
            || pair.node_a == pair.node_b
        {
            bail!("saved geometry periodic pair is invalid");
        }
        let a = root(&mut parent, pair.node_a);
        let b = root(&mut parent, pair.node_b);
        parent[a.max(b) as usize] = a.min(b);
    }
    let mut root_to_class = vec![u32::MAX; node_count];
    let mut class_count = 0usize;
    // Compatibility revision uses wrapping FNV over values, as native core
    // does. Exact arrays are compared first; this is not a crypto certificate.
    let mut revision = 1469598103934665603u64;
    let mix = |hash: &mut u64, value: u64| {
        *hash = (*hash ^ value).wrapping_mul(1099511628211);
    };
    mix(&mut revision, node_count as u64);
    mix(&mut revision, node_count as u64);
    for node in 0..node_count {
        let representative = root(&mut parent, node as u32);
        let class = &mut root_to_class[representative as usize];
        if *class == u32::MAX {
            if map.core_class_representatives.get(class_count) != Some(&representative) {
                bail!("native core representative differs from saved geometry periodic classes");
            }
            *class = class_count as u32;
            class_count += 1;
        }
        if map.local_node_to_core_class[node] != *class {
            bail!("native core class differs from saved geometry periodic classes");
        }
        mix(&mut revision, *class as u64);
    }
    if class_count != map.core_class_representatives.len() {
        bail!("native core class count differs from saved geometry periodic classes");
    }
    mix(&mut revision, class_count as u64);
    for representative in &map.core_class_representatives {
        mix(&mut revision, *representative as u64);
    }
    let expected_revision = if pairs.is_empty() { 0 } else { revision.max(1) };
    if map.core_periodic_map_revision != expected_revision {
        bail!("native core revision differs from saved geometry periodic classes");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::fem_local_node_map::FEM_LOCAL_NODE_MAP_SCHEMA;

    fn pair(a: u32, b: u32) -> MeshPeriodicNodePairIR {
        MeshPeriodicNodePairIR {
            pair_id: "seam".into(),
            node_a: a,
            node_b: b,
        }
    }

    fn map(classes: Vec<u32>, representatives: Vec<u32>, periodic: bool) -> FemLocalNodeIndexMap {
        let mut revision = 1469598103934665603u64;
        for value in std::iter::once(classes.len() as u64)
            .chain(std::iter::once(classes.len() as u64))
            .chain(classes.iter().map(|value| *value as u64))
            .chain(std::iter::once(representatives.len() as u64))
            .chain(representatives.iter().map(|value| *value as u64))
        {
            revision = (revision ^ value).wrapping_mul(1099511628211);
        }
        FemLocalNodeIndexMap {
            schema_version: FEM_LOCAL_NODE_MAP_SCHEMA.into(),
            local_node_count: classes.len() as u64,
            mfem_local_dof_count: classes.len() as u64,
            mfem_true_dof_count: classes.len() as u64,
            core_periodic_class_count: representatives.len() as u64,
            core_periodic_map_revision: if periodic { revision.max(1) } else { 0 },
            canonical_node_to_mfem_local_dof: (0..classes.len() as u32).collect(),
            local_node_to_core_class: classes,
            core_class_representatives: representatives,
        }
    }

    #[test]
    fn core_classes_require_exact_geometry_partition_not_only_counts() {
        let original = map(vec![0, 1, 0, 2], vec![0, 1, 3], true);
        validate_core_periodic_map(&original, 4, &[pair(0, 2)]).unwrap();
        let different = map(vec![0, 1, 2, 1], vec![0, 1, 2], true);
        different.validate().unwrap();
        assert!(validate_core_periodic_map(&different, 4, &[pair(0, 2)]).is_err());
        let mut wrong_revision = original.clone();
        wrong_revision.core_periodic_map_revision += 1;
        assert!(validate_core_periodic_map(&wrong_revision, 4, &[pair(0, 2)]).is_err());
    }

    #[test]
    fn core_classes_use_transitive_minimum_and_accept_pair_reordering() {
        let original = map(vec![0, 0, 0, 1], vec![0, 3], true);
        validate_core_periodic_map(&original, 4, &[pair(2, 1), pair(0, 2)]).unwrap();
        validate_core_periodic_map(&original, 4, &[pair(2, 0), pair(1, 2)]).unwrap();
        assert!(validate_core_periodic_map(&original, 3, &[pair(0, 2)]).is_err());
        assert!(validate_core_periodic_map(&original, 4, &[pair(0, 4)]).is_err());
        assert!(validate_core_periodic_map(&original, 4, &[pair(0, 0)]).is_err());
    }

    #[test]
    fn empty_periodic_geometry_requires_identity_and_zero_revision() {
        let original = map(vec![0, 1], vec![0, 1], false);
        validate_core_periodic_map(&original, 2, &[]).unwrap();
        assert!(validate_core_periodic_map(&map(vec![0, 0], vec![0], true), 2, &[]).is_err());
    }

    #[test]
    fn observed_indexed_projection_rejects_saved_geometry_changes() {
        let mut mesh = fullmag_ir::MeshIR::from_legacy_tet4(
            "indexed".into(),
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![],
            vec![],
            vec![],
            vec![],
            std::collections::HashMap::new(),
        );
        let expected = "sha256:46fbbd2c176d321c10ca26d7f9297fb1381d086a9f27c368151867462925c578";
        validate_indexed_geometry_digest(expected, &mesh).unwrap();
        mesh.nodes[0][0] = -0.;
        assert!(validate_indexed_geometry_digest(expected, &mesh).is_err());
        mesh.nodes[0][0] = 0.;
        mesh.cells.nodes.swap(1, 2);
        assert!(validate_indexed_geometry_digest(expected, &mesh).is_err());
    }
}

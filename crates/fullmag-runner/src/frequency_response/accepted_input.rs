use crate::types::RunError;
use fullmag_ir::FemFrequencyResponsePlanIR;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Identity and raw input binding for the M0 vectors consumed by native FMR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponseInputDescriptor {
    pub full_node_count: u64,
    pub native_node_count: u64,
    pub topology_fingerprint: String,
    pub equilibrium_sha256: String,
    pub magnetic_node_indices: Vec<u64>,
    pub magnetic_node_indices_sha256: String,
}

/// Describe the exact provided equilibrium slice and native magnetic-node order.
pub fn frequency_response_input_descriptor(
    plan: &FemFrequencyResponsePlanIR,
) -> Result<FrequencyResponseInputDescriptor, RunError> {
    if plan.fe_order != 1 {
        return Err(invalid(
            "frequency-response input descriptor supports first-order FEM only",
        ));
    }
    if !matches!(
        &plan.equilibrium,
        fullmag_ir::EquilibriumSourceIR::Provided
    ) {
        return Err(invalid(
            "frequency-response input descriptor requires a provided equilibrium",
        ));
    }

    let full_node_count = u64::try_from(plan.mesh.nodes.len())
        .map_err(|_| invalid("frequency-response full node count exceeds u64"))?;
    let magnetic_node_indices = super::frequency_response_magnetic_node_indices(plan).ok_or_else(
        || {
            invalid(
                "frequency-response input mesh and M0 node counts do not match or the native magnetic map is empty",
            )
        },
    )?;
    let native_node_count = u64::try_from(magnetic_node_indices.len())
        .map_err(|_| invalid("frequency-response native node count exceeds u64"))?;

    // Validate the exact index list selected by the native compaction helper
    // before converting it into the stable, serialized u64 representation.
    super::compact_node_index_map(plan.mesh.nodes.len(), &magnetic_node_indices).ok_or_else(
        || {
            invalid(
                "frequency-response native magnetic node map has an out-of-range or duplicate index",
            )
        },
    )?;
    let magnetic_node_indices = magnetic_node_indices
        .into_iter()
        .map(|index| {
            u64::try_from(index)
                .map_err(|_| invalid("frequency-response magnetic node index exceeds u64"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let topology_fingerprint = plan
        .mesh
        .mixed_topology_fingerprint_v3()
        .map_err(|reason| {
            invalid(format!(
                "frequency-response mesh topology fingerprint failed: {reason}"
            ))
        })?;

    let mut equilibrium_hasher = Sha256::new();
    for component in plan.equilibrium_magnetization.iter().flatten() {
        equilibrium_hasher.update(component.to_le_bytes());
    }
    let equilibrium_sha256 = format!("{:x}", equilibrium_hasher.finalize());

    let mut magnetic_node_indices_hasher = Sha256::new();
    for index in &magnetic_node_indices {
        magnetic_node_indices_hasher.update(index.to_le_bytes());
    }
    let magnetic_node_indices_sha256 = format!("{:x}", magnetic_node_indices_hasher.finalize());

    Ok(FrequencyResponseInputDescriptor {
        full_node_count,
        native_node_count,
        topology_fingerprint,
        equilibrium_sha256,
        magnetic_node_indices,
        magnetic_node_indices_sha256,
    })
}

fn invalid(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn shared_domain_plan(
        node_count: usize,
        magnetic_node_indices: &[usize],
    ) -> FemFrequencyResponsePlanIR {
        let mut plan = super::super::tests::minimal_frequency_response_plan();
        plan.mesh.nodes = (0..node_count)
            .map(|node_index| [node_index as f64, 0.0, 0.0])
            .collect();
        plan.equilibrium_magnetization = vec![[0.0; 3]; node_count];
        for node_index in magnetic_node_indices {
            plan.equilibrium_magnetization[*node_index] = [1.0, 0.0, 0.0];
        }
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    }

    fn raw_magnetization_bytes(plan: &FemFrequencyResponsePlanIR) -> Vec<u8> {
        plan.equilibrium_magnetization
            .iter()
            .flat_map(|vector| vector.iter())
            .flat_map(|component| component.to_le_bytes())
            .collect()
    }

    fn node_index_bytes(indices: &[u64]) -> Vec<u8> {
        indices
            .iter()
            .flat_map(|index| index.to_le_bytes())
            .collect()
    }

    #[test]
    fn descriptor_uses_the_exact_nonprefix_shared_domain_native_map() {
        let plan = shared_domain_plan(7, &[1, 3, 4, 6]);

        let descriptor = frequency_response_input_descriptor(&plan)
            .expect("provided shared-domain M0 should be describable");

        assert_eq!(descriptor.full_node_count, 7);
        assert_eq!(descriptor.native_node_count, 4);
        assert_eq!(descriptor.magnetic_node_indices, vec![1, 3, 4, 6]);
        assert_eq!(
            descriptor.topology_fingerprint,
            plan.mesh.mixed_topology_fingerprint_v3().unwrap()
        );
    }

    #[test]
    fn descriptor_hashes_all_raw_m0_bits_and_ordered_u64_indices() {
        let mut plan = shared_domain_plan(7, &[1, 3, 4, 6]);
        plan.equilibrium_magnetization[0] = [-0.0, 0.0, 0.0];
        let raw_m0 = raw_magnetization_bytes(&plan);

        let descriptor = frequency_response_input_descriptor(&plan)
            .expect("provided shared-domain M0 should be describable");

        assert_eq!(descriptor.equilibrium_sha256, sha256_hex(&raw_m0));
        assert_eq!(
            descriptor.magnetic_node_indices_sha256,
            sha256_hex(&node_index_bytes(&[1, 3, 4, 6]))
        );

        plan.equilibrium_magnetization[0][0] = 0.0;
        let positive_zero_descriptor = frequency_response_input_descriptor(&plan)
            .expect("air-node signed zero does not change the compacted map");
        assert_ne!(
            descriptor.equilibrium_sha256,
            positive_zero_descriptor.equilibrium_sha256,
            "the raw equilibrium digest must preserve signed-zero bits, including air nodes"
        );
    }

    #[test]
    fn merged_domain_descriptor_keeps_all_nodes_in_full_order() {
        let mut plan = super::super::tests::minimal_frequency_response_plan();
        plan.mesh.nodes = (0..5)
            .map(|node_index| [node_index as f64, 0.0, 0.0])
            .collect();
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 5];
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh;

        let descriptor = frequency_response_input_descriptor(&plan)
            .expect("merged magnetic mesh keeps the full node order");

        assert_eq!(descriptor.full_node_count, 5);
        assert_eq!(descriptor.native_node_count, 5);
        assert_eq!(descriptor.magnetic_node_indices, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn descriptor_rejects_empty_or_count_mismatched_shared_maps() {
        let empty = shared_domain_plan(4, &[]);
        assert!(frequency_response_input_descriptor(&empty).is_err());

        let mut mismatched = shared_domain_plan(4, &[0, 2]);
        mismatched.mesh.nodes.pop();
        assert!(frequency_response_input_descriptor(&mismatched).is_err());
    }

    #[test]
    fn descriptor_rejects_artifact_equilibrium_and_unsupported_p2() {
        let mut artifact = shared_domain_plan(4, &[0, 2]);
        artifact.equilibrium = fullmag_ir::EquilibriumSourceIR::Artifact {
            path: "state.json".to_string(),
        };
        assert!(frequency_response_input_descriptor(&artifact).is_err());

        let mut p2 = shared_domain_plan(4, &[0, 2]);
        p2.fe_order = 2;
        assert!(frequency_response_input_descriptor(&p2).is_err());
    }
}

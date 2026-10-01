//! Actual native local-node index maps. Core periodic classes are distinct
//! from MFEM true DOFs; this payload never asserts a true-DOF prolongation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FEM_LOCAL_NODE_MAP_SCHEMA: &str = "fullmag.fem_local_node_index_map.v1";
pub const FEM_FINAL_NODE_MAP_ARTIFACT: &str = "representation/fem_final_node_map.v1.json";
pub const MAX_FEM_LOCAL_NODE_MAP_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FEM_MAPPED_STATE_JSON_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FEM_LOCAL_NODE_MAP_NODES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemLocalNodeIndexMap {
    pub schema_version: String,
    pub local_node_count: u64,
    pub mfem_local_dof_count: u64,
    pub mfem_true_dof_count: u64,
    pub core_periodic_class_count: u64,
    pub core_periodic_map_revision: u64,
    pub canonical_node_to_mfem_local_dof: Vec<u32>,
    pub local_node_to_core_class: Vec<u32>,
    pub core_class_representatives: Vec<u32>,
}

impl FemLocalNodeIndexMap {
    pub fn validate(&self) -> Result<(), String> {
        let n = usize::try_from(self.local_node_count).map_err(|_| "node map extent overflow")?;
        let classes = usize::try_from(self.core_periodic_class_count)
            .map_err(|_| "node map class extent overflow")?;
        if self.schema_version != FEM_LOCAL_NODE_MAP_SCHEMA
            || n == 0
            || n > MAX_FEM_LOCAL_NODE_MAP_NODES
            || self.mfem_local_dof_count != self.local_node_count
            || self.mfem_true_dof_count == 0
            || self.mfem_true_dof_count > self.local_node_count
            || classes == 0
            || classes > n
            || (classes < n && self.core_periodic_map_revision == 0)
            || self.canonical_node_to_mfem_local_dof.len() != n
            || self.local_node_to_core_class.len() != n
            || self.core_class_representatives.len() != classes
        {
            return Err("invalid native FEM local-node index map extents or schema".into());
        }
        for (node, &dof) in self.canonical_node_to_mfem_local_dof.iter().enumerate() {
            // The current AoS/MFEM adapter cannot consume a permutation.
            if dof as usize != node {
                return Err("native FEM local DOF ordering is not canonical identity".into());
            }
        }
        for &class in &self.local_node_to_core_class {
            if class as usize >= classes {
                return Err("native FEM periodic class is out of range".into());
            }
        }
        for (class, &representative) in self.core_class_representatives.iter().enumerate() {
            if representative as usize >= n
                || self.local_node_to_core_class[representative as usize] as usize != class
            {
                return Err(
                    "native FEM periodic representative does not belong to its class".into(),
                );
            }
        }
        if self.core_periodic_map_revision == 0
            && (classes != n
                || self
                    .local_node_to_core_class
                    .iter()
                    .enumerate()
                    .any(|(i, &x)| x as usize != i)
                || self
                    .core_class_representatives
                    .iter()
                    .enumerate()
                    .any(|(i, &x)| x as usize != i))
        {
            return Err("native FEM absent periodic map must be identity".into());
        }
        Ok(())
    }

    /// Domain-separated counts followed by length-prefixed U32LE arrays.
    /// No JSON ordering or host endianness participates in this identity.
    pub fn content_sha256(&self) -> Result<String, String> {
        self.validate()?;
        let mut digest = Sha256::new();
        digest.update(FEM_LOCAL_NODE_MAP_SCHEMA.as_bytes());
        digest.update([0_u8]);
        for value in [
            self.local_node_count,
            self.mfem_local_dof_count,
            self.mfem_true_dof_count,
            self.core_periodic_class_count,
            self.core_periodic_map_revision,
        ] {
            digest.update(value.to_le_bytes());
        }
        for array in [
            &self.canonical_node_to_mfem_local_dof,
            &self.local_node_to_core_class,
            &self.core_class_representatives,
        ] {
            digest.update((array.len() as u64).to_le_bytes());
            for value in array {
                digest.update(value.to_le_bytes());
            }
        }
        Ok(format!("sha256:{:x}", digest.finalize()))
    }

    pub fn validate_representation(
        &self,
        representation: &crate::FemRepresentationReceipt,
    ) -> Result<(), String> {
        self.validate()?;
        if representation.state_space != crate::FemStateRepresentation::LocalNodeAos
            || representation.local_node_count != self.local_node_count
            || representation.true_node_count != self.core_periodic_class_count
            || representation.periodic_map_revision != self.core_periodic_map_revision
        {
            return Err("native FEM node map differs from its snapshot representation".into());
        }
        Ok(())
    }
}

pub fn parse_fem_local_node_map(bytes: &[u8]) -> Result<FemLocalNodeIndexMap, String> {
    if bytes.is_empty() || bytes.len() > MAX_FEM_LOCAL_NODE_MAP_BYTES {
        return Err("native FEM node map exceeds its serialized byte budget".into());
    }
    let map: FemLocalNodeIndexMap =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    map.validate()?;
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn map() -> FemLocalNodeIndexMap {
        FemLocalNodeIndexMap {
            schema_version: FEM_LOCAL_NODE_MAP_SCHEMA.into(),
            local_node_count: 3,
            mfem_local_dof_count: 3,
            mfem_true_dof_count: 3,
            core_periodic_class_count: 2,
            core_periodic_map_revision: 42,
            canonical_node_to_mfem_local_dof: vec![0, 1, 2],
            local_node_to_core_class: vec![0, 1, 0],
            core_class_representatives: vec![0, 1],
        }
    }
    #[test]
    fn mfem_true_extent_is_not_core_periodic_class_extent() {
        let original = map();
        original.validate().unwrap();
        let mut other = original.clone();
        other.mfem_true_dof_count = 2;
        assert_ne!(
            original.content_sha256().unwrap(),
            other.content_sha256().unwrap()
        );
        assert_eq!(
            parse_fem_local_node_map(&serde_json::to_vec(&original).unwrap()).unwrap(),
            original
        );
    }
    #[test]
    fn invalid_permutation_class_and_representative_fail_closed() {
        let mut value = map();
        value.canonical_node_to_mfem_local_dof.swap(0, 1);
        assert!(value.validate().is_err());
        let mut value = map();
        value.local_node_to_core_class[2] = 2;
        assert!(value.validate().is_err());
        let mut value = map();
        value.core_class_representatives[1] = 2;
        assert!(value.validate().is_err());
        let mut value = map();
        value.core_periodic_map_revision = 0;
        assert!(value.validate().is_err());
    }
}

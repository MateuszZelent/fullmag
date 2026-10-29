//! Phase-free geometric CSR, including its native snapshot provenance.
use num_complex::Complex64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NativeCsrMass {
    pub generation: u64,
    pub magnetic_volume_m3: f64,
    pub row_offsets: Vec<u64>,
    pub columns: Vec<u32>,
    pub values_m3: Vec<f64>,
    pub canonical_vertex_ids: Vec<u32>,
    pub scalar_dof_ids: Vec<u32>,
    pub topology_sha256: [u8; 32],
    pub marker_map_sha256: [u8; 32],
    pub element_mask_sha256: [u8; 32],
    pub canonical_dof_map_sha256: [u8; 32],
    pub csr_sha256: [u8; 32],
    pub source_snapshot_sha256: [u8; 32],
    pub identity_sha256: [u8; 32],
}

// Same typed, length-prefixed byte stream as native CanonicalDigestBuilder v1.
fn field(hash: &mut Sha256, name: &str, kind: u8, bytes: &[u8]) {
    hash.update((name.len() as u64).to_be_bytes());
    hash.update(name.as_bytes());
    hash.update([kind]);
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn digest(schema: &str) -> Sha256 {
    let mut hash = Sha256::new();
    field(&mut hash, "schema", 1, schema.as_bytes());
    hash
}

impl NativeCsrMass {
    #[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
    pub(super) fn from_snapshot(s: &crate::native_fem::TrackingMassSnapshot) -> Self {
        Self {
            generation: s.generation(),
            magnetic_volume_m3: s.magnetic_volume_m3(),
            row_offsets: s.row_offsets().to_vec(),
            columns: s.columns().to_vec(),
            values_m3: s.values_m3().to_vec(),
            canonical_vertex_ids: s.canonical_vertex_ids().to_vec(),
            scalar_dof_ids: s.scalar_dof_ids().to_vec(),
            topology_sha256: *s.topology_sha256(),
            marker_map_sha256: *s.marker_map_sha256(),
            element_mask_sha256: *s.element_mask_sha256(),
            canonical_dof_map_sha256: *s.canonical_dof_map_sha256(),
            csr_sha256: *s.csr_sha256(),
            source_snapshot_sha256: *s.source_snapshot_sha256(),
            identity_sha256: *s.identity_sha256(),
        }
    }

    fn csr_digest(&self) -> [u8; 32] {
        let mut hash = digest("mfem_tracking_mass.csr.v1");
        let bytes = self.row_offsets.len() as u64 * 8
            + self.columns.len() as u64 * 4
            + self.values_m3.len() as u64 * 8;
        hash.update(("payload_be".len() as u64).to_be_bytes());
        hash.update(b"payload_be");
        hash.update([3]);
        hash.update(bytes.to_be_bytes());
        for v in &self.row_offsets {
            hash.update(v.to_be_bytes());
        }
        for v in &self.columns {
            hash.update(v.to_be_bytes());
        }
        for v in &self.values_m3 {
            hash.update(v.to_bits().to_be_bytes());
        }
        hash.finalize().into()
    }
    fn map_digest(&self) -> [u8; 32] {
        let mut hash = digest("mfem_tracking_mass.canonical_dof_map.v1");
        field(
            &mut hash,
            "vertex_count",
            2,
            &(self.canonical_vertex_ids.len() as u64).to_be_bytes(),
        );
        for (name, values) in [
            ("canonical_vertex_ids_be", &self.canonical_vertex_ids),
            ("scalar_dof_ids_be", &self.scalar_dof_ids),
        ] {
            hash.update((name.len() as u64).to_be_bytes());
            hash.update(name.as_bytes());
            hash.update([3]);
            hash.update((values.len() as u64 * 4).to_be_bytes());
            for v in values {
                hash.update(v.to_be_bytes());
            }
        }
        hash.finalize().into()
    }
    fn identity_digest(&self) -> [u8; 32] {
        let mut hash = digest("mfem_tracking_mass.snapshot_identity.v1");
        for (name, value) in [
            ("generation", self.generation),
            (
                "canonical_vertex_count",
                self.canonical_vertex_ids.len() as u64,
            ),
            ("nonzero_count", self.values_m3.len() as u64),
        ] {
            field(&mut hash, name, 2, &value.to_be_bytes());
        }
        field(
            &mut hash,
            "magnetic_volume_m3",
            4,
            &self.magnetic_volume_m3.to_bits().to_be_bytes(),
        );
        for (name, value) in [
            ("topology_sha256", &self.topology_sha256),
            ("marker_map_sha256", &self.marker_map_sha256),
            ("element_mask_sha256", &self.element_mask_sha256),
            ("canonical_dof_map_sha256", &self.canonical_dof_map_sha256),
            ("csr_sha256", &self.csr_sha256),
            ("source_snapshot_sha256", &self.source_snapshot_sha256),
        ] {
            field(&mut hash, name, 3, value);
        }
        hash.finalize().into()
    }

    pub(super) fn validate(&self, nodes: &[usize]) -> Result<(), String> {
        let invalid = || "invalid native consistent P1 tracking CSR or provenance".to_string();
        let rows = self.canonical_vertex_ids.len();
        if rows == 0
            || nodes.is_empty()
            || nodes.windows(2).any(|p| p[0] >= p[1])
            || nodes.last().is_some_and(|i| *i >= rows)
            || self.generation == 0
            || !self.magnetic_volume_m3.is_finite()
            || self.magnetic_volume_m3 <= 0.0
            || self.scalar_dof_ids.len() != rows
            || self.row_offsets.len() != rows.checked_add(1).ok_or_else(invalid)?
            || self.values_m3.len() != self.columns.len()
            || self.row_offsets.first() != Some(&0)
            || self.row_offsets.last() != Some(&(self.columns.len() as u64))
            || self
                .row_offsets
                .windows(2)
                .any(|p| p[0] > p[1] || p[1] > self.columns.len() as u64)
        {
            return Err(invalid());
        }
        // The bounded native provider promises identity canonical maps. Fail
        // explicitly if that contract changes; never silently assume a permutation.
        if self
            .canonical_vertex_ids
            .iter()
            .zip(&self.scalar_dof_ids)
            .enumerate()
            .any(|(i, (vertex, dof))| *vertex as usize != i || *dof as usize != i)
        {
            return Err(invalid());
        }
        let mut total = 0.0;
        let mut compensation = 0.0;
        for row in 0..rows {
            let begin = self.row_offsets[row] as usize;
            let end = self.row_offsets[row + 1] as usize;
            let active = nodes.binary_search(&row).is_ok();
            if active == (begin == end) {
                return Err(invalid());
            }
            if active
                && self.columns[begin..end]
                    .binary_search(&(row as u32))
                    .is_err()
            {
                return Err(invalid());
            }
            let mut previous = None;
            for i in begin..end {
                let col = self.columns[i] as usize;
                let v = self.values_m3[i];
                if col >= rows
                    || !v.is_finite()
                    || v <= 0.0
                    || previous.is_some_and(|p| p >= col)
                    || nodes.binary_search(&col).is_err()
                {
                    return Err(invalid());
                }
                previous = Some(col);
                let rb = self.row_offsets[col] as usize;
                let re = self.row_offsets[col + 1] as usize;
                let j = self.columns[rb..re]
                    .binary_search(&(row as u32))
                    .map_err(|_| invalid())?
                    + rb;
                let reverse = self.values_m3[j];
                if !reverse.is_finite()
                    || (v - reverse).abs() > 128.0 * f64::EPSILON * v.abs().max(reverse.abs())
                {
                    return Err(invalid());
                }
                let corrected = v - compensation;
                let next = total + corrected;
                compensation = (next - total) - corrected;
                total = next;
            }
        }
        if !total.is_finite()
            || (total - self.magnetic_volume_m3).abs()
                > 1e-12 * total.abs().max(self.magnetic_volume_m3)
            || [
                &self.topology_sha256,
                &self.marker_map_sha256,
                &self.element_mask_sha256,
                &self.canonical_dof_map_sha256,
                &self.csr_sha256,
                &self.source_snapshot_sha256,
                &self.identity_sha256,
            ]
            .iter()
            .any(|d| d.iter().all(|b| *b == 0))
            || self.csr_digest() != self.csr_sha256
            || self.map_digest() != self.canonical_dof_map_sha256
            || self.identity_digest() != self.identity_sha256
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn inner_product(
        &self,
        nodes: &[usize],
        lhs: &[Complex64],
        rhs: &[Complex64],
    ) -> Option<Complex64> {
        if nodes.len().checked_mul(3)? != lhs.len()
            || lhs.len() != rhs.len()
            || lhs
                .iter()
                .chain(rhs)
                .any(|v| !v.re.is_finite() || !v.im.is_finite())
        {
            return None;
        }
        let scale = self.values_m3.iter().copied().fold(0.0_f64, f64::max);
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        let mut result = Complex64::new(0.0, 0.0);
        for (local_row, row) in nodes.iter().copied().enumerate() {
            for i in self.row_offsets[row] as usize..self.row_offsets[row + 1] as usize {
                let col = nodes.binary_search(&(self.columns[i] as usize)).ok()?;
                for c in 0..3 {
                    result += lhs[3 * local_row + c].conj()
                        * (self.values_m3[i] / scale)
                        * rhs[3 * col + c];
                }
            }
        }
        (result.re.is_finite() && result.im.is_finite()).then_some(result)
    }

    #[cfg(test)]
    pub(super) fn test_tetra_with_air() -> Self {
        let mut s = Self {
            generation: 1,
            magnetic_volume_m3: 6e-24,
            row_offsets: vec![0, 4, 4, 8, 12, 16],
            columns: vec![0, 2, 3, 4, 0, 2, 3, 4, 0, 2, 3, 4, 0, 2, 3, 4],
            values_m3: (0..16)
                .map(|i| if i / 4 == i % 4 { 6e-25 } else { 3e-25 })
                .collect(),
            canonical_vertex_ids: (0..5).collect(),
            scalar_dof_ids: (0..5).collect(),
            topology_sha256: [1; 32],
            marker_map_sha256: [2; 32],
            element_mask_sha256: [3; 32],
            canonical_dof_map_sha256: [0; 32],
            csr_sha256: [0; 32],
            source_snapshot_sha256: [4; 32],
            identity_sha256: [0; 32],
        };
        s.csr_sha256 = s.csr_digest();
        s.canonical_dof_map_sha256 = s.map_digest();
        s.identity_sha256 = s.identity_digest();
        s
    }
}

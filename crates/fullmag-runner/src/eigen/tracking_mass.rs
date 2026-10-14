//! Exact consistent P1 tetra mass embedding for Cartesian mode tracking.
//! This is postprocessing, not a FEM solver or a spectral certificate.

use num_complex::Complex64;

#[derive(Debug, Clone, PartialEq)]
pub struct ConsistentP1TrackingMetric {
    mesh_identity: String,
    physical_node_indices: Vec<usize>,
    tetra: Vec<[usize; 4]>,
    sqrt_factors: Vec<f64>,
    volumes_m3: Vec<f64>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedConsistentP1Metric {
    schema: String,
    definition_id: String,
    source_mesh_topology_sha256: String,
    physical_node_indices: Vec<usize>,
    tetra: Vec<[usize; 4]>,
    volumes_m3: Vec<f64>,
}

impl ConsistentP1TrackingMetric {
    pub fn new(
        mesh_identity: String,
        physical_node_indices: Vec<usize>,
        tetra: Vec<[usize; 4]>,
        volumes_m3: &[f64],
    ) -> Result<Self, String> {
        if mesh_identity.is_empty()
            || physical_node_indices.is_empty()
            || tetra.is_empty()
            || tetra.len() != volumes_m3.len()
            || physical_node_indices
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || volumes_m3
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(
                "consistent tracking mass requires ordered nodes and positive tetra volumes".into(),
            );
        }
        let mut covered = vec![false; physical_node_indices.len()];
        for cell in &tetra {
            for (slot, node) in cell.iter().copied().enumerate() {
                if node >= covered.len() || cell[..slot].contains(&node) {
                    return Err("consistent tracking mass has invalid tetra node indices".into());
                }
                covered[node] = true;
            }
        }
        if covered.iter().any(|value| !value) {
            return Err("consistent tracking mass leaves a selected node uncovered".into());
        }
        let volume_scale = volumes_m3.iter().copied().fold(0.0_f64, f64::max);
        let sqrt_factors = volumes_m3
            .iter()
            .map(|volume| ((volume / volume_scale) / 20.0).sqrt())
            .collect::<Vec<_>>();
        if sqrt_factors
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err("consistent tracking mass volume scaling is not representable".into());
        }
        Ok(Self {
            mesh_identity,
            physical_node_indices,
            tetra,
            sqrt_factors,
            volumes_m3: volumes_m3.to_vec(),
        })
    }

    pub fn artifact_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema": "fullmag.tracking_consistent_p1_metric.v1",
            "definition_id": "consistent_p1_tet4_cartesian_nodal_envelope.v1",
            "source_mesh_topology_sha256": self.mesh_identity,
            "physical_node_indices": self.physical_node_indices,
            "tetra": self.tetra,
            "volumes_m3": self.volumes_m3,
        })
    }

    pub fn from_artifact_json(
        value: &serde_json::Value,
        expected_mesh_identity: &str,
    ) -> Result<Self, String> {
        let record: PersistedConsistentP1Metric = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid persisted consistent mass: {error}"))?;
        if record.schema != "fullmag.tracking_consistent_p1_metric.v1"
            || record.definition_id != "consistent_p1_tet4_cartesian_nodal_envelope.v1"
            || record.source_mesh_topology_sha256 != expected_mesh_identity
        {
            return Err("persisted consistent mass schema or mesh identity mismatch".into());
        }
        Self::new(
            record.source_mesh_topology_sha256,
            record.physical_node_indices,
            record.tetra,
            &record.volumes_m3,
        )
    }

    /// Relative Cartesian magnetic-field seam defect, not a phi certificate.
    pub fn periodic_seam_relative(
        &self,
        envelope: &[Complex64],
        coordinates_m: &[[f64; 3]],
        k: [f64; 3],
        node_map: &[Option<usize>],
        root_nodes: &[usize],
        phases: &[Complex64],
    ) -> Result<Option<(usize, f64)>, String> {
        let invalid = || "invalid periodic mode seam context".to_string();
        if envelope.len() != self.physical_node_indices.len() * 3
            || coordinates_m.len() != node_map.len()
            || phases.len() != node_map.len()
            || k.iter().any(|value| !value.is_finite())
            || envelope
                .iter()
                .any(|value| !value.re.is_finite() || !value.im.is_finite())
        {
            return Err(invalid());
        }
        let scale = envelope
            .iter()
            .map(|value| value.norm())
            .fold(0.0_f64, f64::max);
        if !scale.is_finite() || scale <= 0.0 {
            return Err(invalid());
        }
        let mut fields = Vec::with_capacity(self.physical_node_indices.len());
        let mut max_norm = 0.0_f64;
        for (slot, &node) in self.physical_node_indices.iter().enumerate() {
            let coord = coordinates_m.get(node).ok_or_else(invalid)?;
            if coord.iter().any(|value| !value.is_finite()) {
                return Err(invalid());
            }
            let angle = -coord.iter().zip(k).map(|(x, k)| x * k).sum::<f64>();
            if !angle.is_finite() {
                return Err(invalid());
            }
            let unwind = Complex64::new(angle.cos(), angle.sin());
            let field: [Complex64; 3] =
                std::array::from_fn(|component| (envelope[3 * slot + component] / scale) * unwind);
            max_norm = max_norm.max(
                field
                    .iter()
                    .map(|value| value.norm_sqr())
                    .sum::<f64>()
                    .sqrt(),
            );
            fields.push(field);
        }
        let mut checked = 0;
        let mut max_defect = 0.0_f64;
        for (slot, &node) in self.physical_node_indices.iter().enumerate() {
            let reduced = node_map.get(node).copied().flatten().ok_or_else(invalid)?;
            let root = *root_nodes.get(reduced).ok_or_else(invalid)?;
            let root_slot = self
                .physical_node_indices
                .binary_search(&root)
                .map_err(|_| invalid())?;
            if node == root {
                continue;
            }
            let phase = phases[node];
            let root_phase = phases[root];
            if [phase, root_phase].iter().any(|value| {
                !value.re.is_finite() || !value.im.is_finite() || (value.norm() - 1.0).abs() > 1e-12
            }) {
                return Err(invalid());
            }
            let ratio = phase / root_phase;
            let defect = (0..3)
                .map(|component| {
                    (fields[slot][component] - ratio * fields[root_slot][component]).norm_sqr()
                })
                .sum::<f64>()
                .sqrt();
            if !defect.is_finite() {
                return Err(invalid());
            }
            checked += 1;
            max_defect = max_defect.max(defect);
        }
        if checked == 0 {
            return Ok(None);
        }
        let relative = max_defect / max_norm;
        if !relative.is_finite() {
            return Err(invalid());
        }
        Ok(Some((checked, relative)))
    }

    pub fn compatible(&self, other: &Self) -> bool {
        std::ptr::eq(self, other) || self == other
    }

    pub fn mesh_identity(&self) -> &str {
        &self.mesh_identity
    }

    pub fn node_indices(&self) -> &[usize] {
        &self.physical_node_indices
    }

    pub fn embed(&self, vector: &[Complex64]) -> Option<Vec<Complex64>> {
        if self.physical_node_indices.len().checked_mul(3)? != vector.len()
            || vector
                .iter()
                .any(|value| !value.re.is_finite() || !value.im.is_finite())
        {
            return None;
        }
        let mut result = Vec::with_capacity(self.tetra.len().checked_mul(15)?);
        for (cell, factor) in self.tetra.iter().zip(&self.sqrt_factors) {
            let mut sum = [Complex64::new(0.0, 0.0); 3];
            for node in cell {
                for component in 0..3 {
                    let value = vector[3 * node + component] * *factor;
                    result.push(value);
                    sum[component] += value;
                }
            }
            result.extend(sum);
        }
        result
            .iter()
            .all(|value| value.re.is_finite() && value.im.is_finite())
            .then_some(result)
    }

    pub fn uniform_projection_squared(&self, vector: &[Complex64]) -> Option<f64> {
        if vector
            .iter()
            .any(|v| !v.re.is_finite() || !v.im.is_finite())
        {
            return None;
        }
        let scale = vector
            .iter()
            .map(|value| value.norm())
            .fold(0.0_f64, f64::max);
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        let scaled = vector
            .iter()
            .map(|value| *value / scale)
            .collect::<Vec<_>>();
        let field = self.embed(&scaled)?;
        let norm = field.iter().map(Complex64::norm_sqr).sum::<f64>();
        if !norm.is_finite() || norm <= 0.0 {
            return None;
        }
        let mut score = 0.0;
        for component in 0..3 {
            let mut constant = vec![Complex64::new(0.0, 0.0); vector.len()];
            for node in 0..self.physical_node_indices.len() {
                constant[3 * node + component] = Complex64::new(1.0, 0.0);
            }
            let basis = self.embed(&constant)?;
            let basis_norm = basis.iter().map(Complex64::norm_sqr).sum::<f64>();
            if !basis_norm.is_finite() || basis_norm <= 0.0 {
                return None;
            }
            let inner = basis
                .iter()
                .zip(&field)
                .map(|(a, b)| a.conj() * b)
                .sum::<Complex64>();
            score += inner.norm_sqr() / (norm * basis_norm);
        }
        (score.is_finite() && score <= 1.0 + 1e-12).then(|| score.clamp(0.0, 1.0))
    }

    /// Left inverse on the range of embed, including linear combinations of
    /// embedded orthonormal basis vectors after Procrustes transport.
    pub fn recover(&self, embedded: &[Complex64]) -> Option<Vec<Complex64>> {
        if self.tetra.len().checked_mul(15)? != embedded.len()
            || embedded
                .iter()
                .any(|value| !value.re.is_finite() || !value.im.is_finite())
        {
            return None;
        }
        let mut result =
            vec![Complex64::new(0.0, 0.0); self.physical_node_indices.len().checked_mul(3)?];
        let mut weights = vec![0.0; self.physical_node_indices.len()];
        for (element, (cell, factor)) in self.tetra.iter().zip(&self.sqrt_factors).enumerate() {
            for (local, node) in cell.iter().copied().enumerate() {
                weights[node] += factor * factor;
                for component in 0..3 {
                    result[3 * node + component] +=
                        *factor * embedded[15 * element + 3 * local + component];
                }
            }
        }
        for (node, weight) in weights.into_iter().enumerate() {
            if !weight.is_finite() || weight <= 0.0 {
                return None;
            }
            for component in 0..3 {
                result[3 * node + component] /= weight;
            }
        }
        result
            .iter()
            .all(|value| value.re.is_finite() && value.im.is_finite())
            .then_some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metric() -> ConsistentP1TrackingMetric {
        ConsistentP1TrackingMetric::new(
            "mesh:a".into(),
            vec![0, 1, 2, 3],
            vec![[0, 1, 2, 3]],
            &[6e-24],
        )
        .unwrap()
    }
    #[test]
    fn p1_basis_vectors_have_nonzero_offdiagonal_mass() {
        let m = metric();
        let mut a = vec![Complex64::new(0.0, 0.0); 12];
        let mut b = a.clone();
        a[0] = Complex64::new(1.0, 0.0);
        b[3] = Complex64::new(1.0, 0.0);
        let x = m.embed(&a).unwrap();
        let y = m.embed(&b).unwrap();
        let dot = x
            .iter()
            .zip(&y)
            .map(|(p, q)| p.conj() * q)
            .sum::<Complex64>();
        assert!((dot.re - 0.05).abs() < 1e-14);
        let norm = x.iter().map(Complex64::norm_sqr).sum::<f64>();
        assert!((norm - 0.1).abs() < 1e-14);
    }
    #[test]
    fn consistent_embedding_recovers_complex_nodal_values() {
        let m = metric();
        let q = (0..12)
            .map(|i| Complex64::new(i as f64, (i % 3) as f64))
            .collect::<Vec<_>>();
        let reconstructed = m.recover(&m.embed(&q).unwrap()).unwrap();
        for (a, b) in q.iter().zip(reconstructed) {
            assert!((*a - b).norm() < 1e-12);
        }
    }
    #[test]
    fn consistent_metric_rejects_uncovered_or_duplicated_nodes() {
        assert!(ConsistentP1TrackingMetric::new(
            "a".into(),
            vec![0, 1, 2, 3, 4],
            vec![[0, 1, 2, 3]],
            &[1.0]
        )
        .is_err());
        assert!(ConsistentP1TrackingMetric::new(
            "a".into(),
            vec![0, 1, 2, 3],
            vec![[0, 1, 1, 3]],
            &[1.0]
        )
        .is_err());
    }
    #[test]
    fn consistent_uniform_projection_uses_integrated_p1_basis() {
        let m = metric();
        let constant = vec![Complex64::new(1.0, 0.0); 12];
        assert!((m.uniform_projection_squared(&constant).unwrap() - 1.0).abs() < 1e-12);
        let mut basis = vec![Complex64::new(0.0, 0.0); 12];
        basis[0] = Complex64::new(1.0, 0.0);
        // Integral(phi_0)=V/4, integral(phi_0^2)=V/10: projection=10/16.
        assert!((m.uniform_projection_squared(&basis).unwrap() - 0.625).abs() < 1e-12);
    }
}

#[cfg(test)]
mod persisted_metric_tests {
    use super::*;

    fn metric() -> ConsistentP1TrackingMetric {
        ConsistentP1TrackingMetric::new(
            "mesh-a".into(),
            vec![0, 2, 4, 6],
            vec![[0, 1, 2, 3]],
            &[1.6e-23],
        )
        .unwrap()
    }

    #[test]
    fn persisted_consistent_mass_roundtrip_preserves_embedding() {
        let original = metric();
        let restored =
            ConsistentP1TrackingMetric::from_artifact_json(&original.artifact_json(), "mesh-a")
                .unwrap();
        assert!(original.compatible(&restored));
        let vector = vec![Complex64::new(0.5, -0.25); 12];
        assert_eq!(original.embed(&vector), restored.embed(&vector));
    }

    #[test]
    fn persisted_consistent_mass_rejects_schema_mesh_and_corrupt_indices() {
        let value = metric().artifact_json();
        assert!(ConsistentP1TrackingMetric::from_artifact_json(&value, "mesh-b").is_err());
        for (key, replacement) in [
            ("schema", serde_json::json!("future")),
            ("definition_id", serde_json::json!("lumped")),
            ("physical_node_indices", serde_json::json!([0, 2, 2, 6])),
            ("tetra", serde_json::json!([[0, 1, 2, 9]])),
            ("volumes_m3", serde_json::json!([0.0])),
        ] {
            let mut corrupt = value.clone();
            corrupt[key] = replacement;
            assert!(ConsistentP1TrackingMetric::from_artifact_json(&corrupt, "mesh-a").is_err());
        }
        let mut corrupt = value;
        corrupt["unknown"] = serde_json::json!(true);
        assert!(ConsistentP1TrackingMetric::from_artifact_json(&corrupt, "mesh-a").is_err());
    }
    #[test]
    fn periodic_seam_checks_physical_bloch_phase_and_rejects_wrong_sign() {
        let metric = metric();
        let mut coords = vec![[0.0; 3]; 7];
        coords[6][0] = 1e-8;
        let map = vec![Some(0), None, Some(1), None, Some(2), None, Some(0)];
        let roots = vec![0, 2, 4];
        let mut phases = vec![Complex64::new(1.0, 0.0); 7];
        phases[6] = Complex64::new(0.1_f64.cos(), -0.1_f64.sin());
        let values = vec![Complex64::new(1.0, 0.0); 12];
        let (count, mismatch) = metric
            .periodic_seam_relative(&values, &coords, [1e7, 0.0, 0.0], &map, &roots, &phases)
            .unwrap()
            .unwrap();
        assert_eq!(count, 1);
        assert!(mismatch < 1e-14);
        phases[6] = phases[6].conj();
        let (_, mismatch) = metric
            .periodic_seam_relative(&values, &coords, [1e7, 0.0, 0.0], &map, &roots, &phases)
            .unwrap()
            .unwrap();
        assert!(mismatch > 0.19);
        let rotated = values
            .iter()
            .map(|value| value * Complex64::new(0.0, 1e100))
            .collect::<Vec<_>>();
        let (_, rotated_mismatch) = metric
            .periodic_seam_relative(&rotated, &coords, [1e7, 0.0, 0.0], &map, &roots, &phases)
            .unwrap()
            .unwrap();
        assert!((mismatch - rotated_mismatch).abs() < 1e-14);
    }

    #[test]
    fn periodic_seam_does_not_invent_measurement_without_slave_nodes() {
        let metric = metric();
        let coords = vec![[0.0; 3]; 7];
        let map = vec![Some(0), None, Some(1), None, Some(2), None, Some(3)];
        let phases = vec![Complex64::new(1.0, 0.0); 7];
        let values = vec![Complex64::new(1.0, 0.0); 12];
        assert_eq!(
            metric
                .periodic_seam_relative(&values, &coords, [0.0; 3], &map, &[0, 2, 4, 6], &phases)
                .unwrap(),
            None
        );
        assert!(metric
            .periodic_seam_relative(
                &values[..9],
                &coords,
                [0.0; 3],
                &map,
                &[0, 2, 4, 6],
                &phases
            )
            .is_err());
    }
}

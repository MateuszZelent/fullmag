//! Physical P1 scalar-potential and element field exports on the shared mesh.
use super::eigen_output::json_artifact;
use crate::types::{AuxiliaryArtifact, RunError};
use fullmag_engine::fem::MeshTopology;
use num_complex::Complex64;
use sha2::{Digest, Sha256};

fn expand_potential(
    reduced: &[Complex64],
    scalar_class_count: usize,
    classes: &[u32],
    phases: &[Complex64],
) -> Result<Vec<Complex64>, RunError> {
    if scalar_class_count == 0
        || reduced.len() != scalar_class_count
        || classes.len() != phases.len()
    {
        return Err(RunError {
            message: "physical potential has inconsistent class/phase dimensions".into(),
        });
    }
    classes
        .iter()
        .zip(phases)
        .map(|(&class, &phase)| {
            let value = reduced.get(class as usize).ok_or_else(|| RunError {
                message: "physical potential references a missing scalar class".into(),
            })?;
            if !value.re.is_finite()
                || !value.im.is_finite()
                || !phase.re.is_finite()
                || !phase.im.is_finite()
                || (phase.norm_sqr() - 1.0).abs() > 1e-10
            {
                return Err(RunError {
                    message: "physical potential contains invalid coefficients or phase".into(),
                });
            }
            Ok(phase * value)
        })
        .collect()
}

/// Convert the native Floquet certificate's doubled real-split scalar vector
/// back to the complex scalar potential used by the physical mesh export.
/// The native layout is `[phi_real, phi_imag]`, where both halves can carry
/// complex modal coefficients because the magnetic mode itself is complex.
pub(super) fn doubled_real_split_to_complex(
    real_split: &[Complex64],
    scalar_class_count: usize,
) -> Result<Vec<Complex64>, RunError> {
    let expected_len = scalar_class_count.checked_mul(2).ok_or_else(|| RunError {
        message: "physical potential scalar class count overflows doubled layout".to_string(),
    })?;
    if scalar_class_count == 0 || real_split.len() != expected_len {
        return Err(RunError {
            message: format!(
                "native Floquet potential has {} coefficients; expected {} for {} scalar classes",
                real_split.len(),
                expected_len,
                scalar_class_count
            ),
        });
    }
    let imaginary = Complex64::new(0.0, 1.0);
    let reduced = (0..scalar_class_count)
        .map(|index| real_split[index] + imaginary * real_split[scalar_class_count + index])
        .collect::<Vec<_>>();
    if reduced
        .iter()
        .any(|value| !value.re.is_finite() || !value.im.is_finite())
    {
        return Err(RunError {
            message: "native Floquet potential contains non-finite reconstructed coefficients"
                .to_string(),
        });
    }
    Ok(reduced)
}

fn complex_bytes(values: impl IntoIterator<Item = Complex64>) -> Vec<u8> {
    values
        .into_iter()
        .flat_map(|v| v.re.to_le_bytes().into_iter().chain(v.im.to_le_bytes()))
        .collect()
}

fn element_demag_field(
    full: &[Complex64],
    nodes: &[u32; 4],
    gradients: &[[f64; 3]; 4],
) -> Result<[Complex64; 3], RunError> {
    let mut field = [Complex64::new(0.0, 0.0); 3];
    for axis in 0..3 {
        for local in 0..4 {
            let phi = full.get(nodes[local] as usize).ok_or_else(|| RunError {
                message: "physical potential element references a missing node".into(),
            })?;
            if !gradients[local][axis].is_finite() {
                return Err(RunError {
                    message: "physical potential element has a non-finite gradient".into(),
                });
            }
            field[axis] -= phi * gradients[local][axis];
        }
        if !field[axis].re.is_finite() || !field[axis].im.is_finite() {
            return Err(RunError {
                message: "physical demag field is non-finite".into(),
            });
        }
    }
    Ok(field)
}

fn required_source_identity(provenance: &serde_json::Value, key: &str) -> Result<String, RunError> {
    provenance
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RunError {
            message: format!(
                "physical potential export requires non-empty source identity '{key}'"
            ),
        })
}

/// The phases must use the same class representatives as native C_phi.
/// Gradients are element-wise: no nodal recovery across material interfaces.
pub(super) fn physical_potential_artifacts(
    topology: &MeshTopology,
    reduced: &[Complex64],
    scalar_class_count: usize,
    classes: &[u32],
    phases: &[Complex64],
    sample_index: usize,
    mode_index: usize,
    provenance: &serde_json::Value,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    if classes.len() != topology.n_nodes || topology.grad_phi.len() != topology.elements.len() {
        return Err(RunError {
            message: "physical potential mesh dimensions do not match the scalar map".into(),
        });
    }
    let full = expand_potential(reduced, scalar_class_count, classes, phases)?;
    let mut fields = Vec::with_capacity(topology.elements.len() * 3);
    for (nodes, gradients) in topology.elements.iter().zip(&topology.grad_phi) {
        fields.extend(element_demag_field(&full, nodes, gradients)?);
    }
    let source_mesh_topology_sha256 =
        required_source_identity(provenance, "source_mesh_topology_sha256")?;
    let operator_input_signature_sha256 =
        required_source_identity(provenance, "operator_input_signature_sha256")?;
    let phase_constraint_sha256 = required_source_identity(provenance, "phase_constraint_sha256")?;
    let prefix = format!("eigen/mode_fields/sample_{sample_index:04}/mode_{mode_index:04}");
    let phi_path = format!("{prefix}/potential_full.bin");
    let h_path = format!("{prefix}/demag_element_full.bin");
    let phi_bytes = complex_bytes(full);
    let h_bytes = complex_bytes(fields);
    let manifest = serde_json::json!({
        "schema_version": "fem_modal_physical_potential.v1",
        "sample_index": sample_index, "mode_index": mode_index,
        "representation": "full_physical_phasor", "phasor_convention": "exp(+i*omega*t)",
        "reconstruction": "phi_full[node] = C_phi[node,class] * phi_reduced[class]",
        "normalization": "same_complex_scale_as_published_magnetization_mode",
        "source_mesh_topology_sha256": source_mesh_topology_sha256,
        "operator_input_signature_sha256": operator_input_signature_sha256,
        "phase_constraint_sha256": phase_constraint_sha256,
        "potential": {"path": phi_path, "sha256": format!("sha256:{:x}", Sha256::digest(&phi_bytes)),
            "dtype": "float64", "byte_order": "little", "layout": "node_major_real_imag",
            "association": "source_mesh_nodes", "count": topology.n_nodes, "unit": "A"},
        "demag_field": {"path": h_path, "sha256": format!("sha256:{:x}", Sha256::digest(&h_bytes)),
            "dtype": "float64", "byte_order": "little", "layout": "element_major_xyz_real_imag",
            "association": "source_mesh_tet4_elements", "count": topology.elements.len(),
            "unit": "A/m", "reconstruction": "-grad(phi_full)", "recovery": "none"}
    });
    Ok(vec![
        AuxiliaryArtifact {
            relative_path: phi_path,
            bytes: phi_bytes,
        },
        AuxiliaryArtifact {
            relative_path: h_path,
            bytes: h_bytes,
        },
        json_artifact(format!("{prefix}/physical_potential.v1.json"), &manifest)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eigen_physical_potential_expands_complex_phase_and_preserves_scaling() {
        let q = [Complex64::new(2.0, 3.0), Complex64::new(-1.0, 4.0)];
        let phases = [
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, -1.0),
            Complex64::new(-1.0, 0.0),
        ];
        let full = expand_potential(&q, 2, &[0, 0, 1], &phases).unwrap();
        assert_eq!(full, vec![q[0], Complex64::new(3.0, -2.0), -q[1]]);
        let bytes = complex_bytes(full);
        assert_eq!(bytes.len(), 48);
        assert_eq!(f64::from_le_bytes(bytes[16..24].try_into().unwrap()), 3.0);
        assert_eq!(f64::from_le_bytes(bytes[24..32].try_into().unwrap()), -2.0);
    }
    #[test]
    fn eigen_physical_potential_rejects_invalid_map_and_phase() {
        let q = [Complex64::new(1.0, 0.0)];
        assert!(expand_potential(&q, 1, &[1], &q).is_err());
        assert!(expand_potential(&q, 1, &[0], &[Complex64::new(2.0, 0.0)]).is_err());
        assert!(expand_potential(&q, 2, &[0], &[Complex64::new(1.0, 0.0)]).is_err());
    }

    #[test]
    fn physical_potential_manifest_requires_non_null_source_identities() {
        let missing = serde_json::json!({
            "source_mesh_topology_sha256": null,
            "operator_input_signature_sha256": "",
        });
        assert!(required_source_identity(&missing, "source_mesh_topology_sha256").is_err());
        assert!(required_source_identity(&missing, "operator_input_signature_sha256").is_err());

        let valid = serde_json::json!({
            "source_mesh_topology_sha256": "sha256:topology",
        });
        assert_eq!(
            required_source_identity(&valid, "source_mesh_topology_sha256").unwrap(),
            "sha256:topology"
        );
    }

    #[test]
    fn doubled_real_split_potential_reconstructs_complex_scalar_coefficients() {
        let real_split = [
            Complex64::new(2.0, 1.0),
            Complex64::new(-3.0, 4.0),
            Complex64::new(5.0, -2.0),
            Complex64::new(7.0, 6.0),
        ];
        let reduced = doubled_real_split_to_complex(&real_split, 2).unwrap();
        assert_eq!(
            reduced,
            vec![
                real_split[0] + Complex64::new(0.0, 1.0) * real_split[2],
                real_split[1] + Complex64::new(0.0, 1.0) * real_split[3],
            ]
        );
        assert!(doubled_real_split_to_complex(&real_split[..3], 2).is_err());
    }

    #[test]
    fn tet4_linear_potential_produces_constant_negative_gradient_field() {
        // Reference tetrahedron N0=1-x-y-z, N1=x, N2=y, N3=z.
        let gradients = [
            [-1.0, -1.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let full = [
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let field = element_demag_field(&full, &[0, 1, 2, 3], &gradients).unwrap();
        assert_eq!(
            field,
            [
                Complex64::new(-1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0)
            ]
        );
    }
}

//! Canonical validation for Bloch/Floquet wavevectors.
//!
//! The public unit is `rad/m`.  Mesh-dependent legality is deliberately
//! checked here against the accepted periodic-mesh certificate rather than in
//! a UI parser, so Python and browser authoring share the same rejection
//! reasons.

use crate::PeriodicMeshCertificateV6IR;
use serde::{Deserialize, Serialize};

/// Typed authoring representation of a Bloch/Floquet wavevector in SI units.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct BlochWavevectorIR {
    pub k_vector_rad_per_m: [f64; 3],
}

impl BlochWavevectorIR {
    /// Validate finite components and compatibility with the current v6 mesh
    /// certificate.  The zero vector still requires a valid certificate.
    pub fn validate_against_certificate(
        &self,
        certificate: Option<&PeriodicMeshCertificateV6IR>,
    ) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self
            .k_vector_rad_per_m
            .iter()
            .any(|component| !component.is_finite())
        {
            errors.push("k_vector_rad_per_m must contain finite values".to_string());
        }

        let Some(certificate) = certificate else {
            errors.push(
                "k_vector_rad_per_m requires an accepted periodic_mesh_certificate.v6".to_string(),
            );
            return Err(errors);
        };

        if certificate.schema_version != "periodic_mesh_certificate.v6"
            || certificate.certificate_status != "accepted"
        {
            errors.push(format!(
                "k_vector_rad_per_m requires an accepted periodic_mesh_certificate.v6 (schema='{}', status='{}')",
                certificate.schema_version, certificate.certificate_status
            ));
        }

        let mut active_axes = [false; 3];
        for axis in &certificate.axis_pairs {
            match axis.axis.as_deref() {
                Some("x") => active_axes[0] = true,
                Some("y") => active_axes[1] = true,
                Some("z") => active_axes[2] = true,
                Some(other) => errors.push(format!(
                    "periodic_mesh_certificate.v6 contains unsupported axis '{other}'"
                )),
                None => errors.push(
                    "periodic_mesh_certificate.v6 axis pair is missing its axis".to_string(),
                ),
            }
        }
        for (index, (&component, active)) in self
            .k_vector_rad_per_m
            .iter()
            .zip(active_axes)
            .enumerate()
        {
            if component != 0.0 && !active {
                errors.push(format!(
                    "k_vector_rad_per_m[{index}] is nonzero on a non-periodic mesh axis"
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PeriodicAxisCertificateV6IR, PeriodicMeshCertificateV6IR};

    fn certificate(status: &str, schema: &str) -> PeriodicMeshCertificateV6IR {
        PeriodicMeshCertificateV6IR {
            schema_version: schema.to_string(),
            certificate_status: status.to_string(),
            topology_fingerprint: "sha256:mesh".to_string(),
            axis_pairs: vec![PeriodicAxisCertificateV6IR {
                pair_id: "x_faces".to_string(),
                axis: Some("x".to_string()),
                node_pair_count: 4,
                face_pair_count: 1,
                face_pairs: Vec::new(),
                translation_residual_max_m: 0.0,
                orientation_residual_max: 0.0,
                normal_mismatch_max: 0.0,
                boundary_topology_match: true,
                material_region_match: true,
            }],
            magnetic_class_count: 1,
            magnetic_pair_count: 1,
            scalar_class_count: 1,
            scalar_pair_count: 1,
            magnetic_equivalence_classes_sha256: "sha256:magnetic".to_string(),
            scalar_equivalence_classes_sha256: "sha256:scalar".to_string(),
            translation_residual_max_m: 0.0,
            orientation_residual_max: 0.0,
            normal_mismatch_max: 0.0,
            boundary_topology_match: true,
            fe_order_match: true,
            material_region_match: true,
            corner_edge_cycle_unique: true,
            edge_class_count: 0,
            corner_class_count: 0,
            max_commutation_residual_m: 0.0,
            m0_seam_mismatch_max: 0.0,
            h_demag0_seam_mismatch_max: 0.0,
            marker_map_fingerprint: "sha256:markers".to_string(),
            material_realization_fingerprint: "sha256:materials".to_string(),
            region_class_count: 1,
            max_material_residual: 0.0,
        }
    }

    #[test]
    fn rejects_non_finite_components() {
        let vector = BlochWavevectorIR {
            k_vector_rad_per_m: [f64::NAN, 0.0, f64::INFINITY],
        };
        let errors = vector
            .validate_against_certificate(Some(&certificate("accepted", "periodic_mesh_certificate.v6")))
            .expect_err("non-finite wavevector must be rejected");
        assert!(errors.iter().any(|error| error.contains("finite")));
    }

    #[test]
    fn serde_rejects_wrong_component_count() {
        let error = serde_json::from_value::<BlochWavevectorIR>(serde_json::json!({
            "k_vector_rad_per_m": [1.0, 0.0]
        }))
        .expect_err("wavevector must have exactly three components");
        assert!(error.to_string().contains("length 2"));
    }

    #[test]
    fn rejects_missing_or_stale_certificate() {
        let vector = BlochWavevectorIR {
            k_vector_rad_per_m: [0.0, 0.0, 0.0],
        };
        let missing = vector
            .validate_against_certificate(None)
            .expect_err("k=0 must not bypass certificate validation");
        assert!(missing.iter().any(|error| error.contains("accepted")));

        let stale = vector
            .validate_against_certificate(Some(&certificate("stale", "periodic_mesh_certificate.v5")))
            .expect_err("stale certificate must be rejected");
        assert!(stale.iter().any(|error| error.contains("schema='periodic_mesh_certificate.v5'")));
    }

    #[test]
    fn accepts_zero_and_nonzero_components_on_certified_axis() {
        let certificate = certificate("accepted", "periodic_mesh_certificate.v6");
        BlochWavevectorIR {
            k_vector_rad_per_m: [0.0, 0.0, 0.0],
        }
        .validate_against_certificate(Some(&certificate))
        .expect("certified k=0 should be valid");
        BlochWavevectorIR {
            k_vector_rad_per_m: [1.0e7, 0.0, 0.0],
        }
        .validate_against_certificate(Some(&certificate))
        .expect("nonzero k on certified x axis should be valid");
    }

    #[test]
    fn rejects_nonzero_component_on_open_axis() {
        let vector = BlochWavevectorIR {
            k_vector_rad_per_m: [0.0, 1.0e7, 0.0],
        };
        let errors = vector
            .validate_against_certificate(Some(&certificate("accepted", "periodic_mesh_certificate.v6")))
            .expect_err("nonzero y component must be rejected without y periodicity");
        assert!(errors
            .iter()
            .any(|error| error.contains("non-periodic mesh axis")));
    }
}

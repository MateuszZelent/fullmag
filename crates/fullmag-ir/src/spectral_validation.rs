//! Canonical validation for Bloch/Floquet wavevectors.
//!
//! The public unit is `rad/m`.  Mesh-dependent legality is deliberately
//! checked here against the accepted periodic-mesh certificate rather than in
//! a UI parser, so Python and browser authoring share the same rejection
//! reasons.

use crate::{
    KSamplingIR, MeshIR, MeshPeriodicBoundaryPairIR, PeriodicMeshCertificateV6IR,
    SpinWaveBoundaryConditionIR,
};
use serde::{Deserialize, Serialize};

/// Translation components below this threshold are treated as zero when
/// inferring the unique lattice axis for the bounded Floquet demag lane.
pub const FLOQUET_TRANSLATION_AXIS_TOLERANCE_M: f64 = 1.0e-15;

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
                None => errors
                    .push("periodic_mesh_certificate.v6 axis pair is missing its axis".to_string()),
            }
        }
        for (index, (&component, active)) in
            self.k_vector_rad_per_m.iter().zip(active_axes).enumerate()
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

fn periodic_axis_from_hint(hint: &str) -> Option<usize> {
    match hint {
        "x" => Some(0),
        "y" => Some(1),
        "z" => Some(2),
        _ => None,
    }
}

fn unique_translation_axis(translation: [f64; 3]) -> Result<usize, &'static str> {
    if !translation.iter().all(|value| value.is_finite()) {
        return Err("translation must contain finite values");
    }
    let mut axis = None;
    for (index, value) in translation.iter().enumerate() {
        if value.abs() > FLOQUET_TRANSLATION_AXIS_TOLERANCE_M {
            if axis.replace(index).is_some() {
                return Err(
                    "translation must have exactly one nonzero axis component above 1e-15 m",
                );
            }
        }
    }
    axis.ok_or("translation must have one nonzero axis component above 1e-15 m")
}

fn selected_floquet_boundary_pairs<'a>(
    mesh: &'a MeshIR,
    boundary: &SpinWaveBoundaryConditionIR,
    errors: &mut Vec<String>,
) -> Vec<&'a MeshPeriodicBoundaryPairIR> {
    if mesh.periodic_boundary_pairs.is_empty() {
        errors.push(
            "bounded Floquet dynamic demag requires non-empty mesh.periodic_boundary_pairs"
                .to_string(),
        );
    }
    if mesh.periodic_node_pairs.is_empty() {
        errors.push(
            "bounded Floquet dynamic demag requires non-empty mesh.periodic_node_pairs"
                .to_string(),
        );
    }

    let requested = boundary.boundary_pair_ids();
    if requested.is_empty() {
        return mesh.periodic_boundary_pairs.iter().collect();
    }

    let mut selected = Vec::with_capacity(requested.len());
    for pair_id in requested {
        let Some(pair) = mesh
            .periodic_boundary_pairs
            .iter()
            .find(|pair| pair.pair_id == pair_id)
        else {
            errors.push(format!(
                "bounded Floquet dynamic demag selector references unknown periodic pair '{pair_id}'"
            ));
            continue;
        };
        selected.push(pair);
    }
    selected
}

fn validate_floquet_k_vector(
    label: &str,
    k_vector: &[f64; 3],
    periodic_axes: [bool; 3],
    errors: &mut Vec<String>,
) {
    for (axis, component) in k_vector.iter().enumerate() {
        if !component.is_finite() {
            errors.push(format!(
                "bounded Floquet dynamic demag {label}[{axis}] must be finite"
            ));
        } else if !periodic_axes[axis] && *component != 0.0 {
            errors.push(format!(
                "bounded Floquet dynamic demag {label}[{axis}] must be exactly zero on an open axis"
            ));
        }
    }
}

/// Strict post-mesh admission for the bounded CPU nonzero-k Floquet dynamic
/// demag lane.
///
/// The caller retains the existing 1e-12 rad/m Gamma/nonzero classification.
/// This helper only validates the materialized pair payload and every supplied
/// k sample, so it must not be reused to tighten general Gamma certificate
/// resolution or hint-only modal metadata outside this lane.
pub fn validate_bounded_floquet_dynamic_demag_admission(
    mesh: &MeshIR,
    boundary: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let selected_pairs = selected_floquet_boundary_pairs(mesh, boundary, &mut errors);
    let mut periodic_axes = [false; 3];

    for pair in selected_pairs {
        let Some(translation) = pair.translation else {
            errors.push(format!(
                "bounded Floquet dynamic demag periodic pair '{}' translation is missing",
                pair.pair_id
            ));
            continue;
        };
        let axis = match unique_translation_axis(translation) {
            Ok(axis) => axis,
            Err(reason) => {
                errors.push(format!(
                    "bounded Floquet dynamic demag periodic pair '{}' {reason}",
                    pair.pair_id
                ));
                continue;
            }
        };
        if let Some(hint) = pair.axis_hint.as_deref() {
            let Some(hinted_axis) = periodic_axis_from_hint(hint) else {
                errors.push(format!(
                    "bounded Floquet dynamic demag periodic pair '{}' has unknown axis_hint '{}'; expected x, y, or z",
                    pair.pair_id, hint
                ));
                continue;
            };
            if hinted_axis != axis {
                errors.push(format!(
                    "bounded Floquet dynamic demag periodic pair '{}' axis_hint conflicts with translation axis",
                    pair.pair_id
                ));
                continue;
            }
        }
        periodic_axes[axis] = true;
    }

    let Some(k_sampling) = k_sampling else {
        errors.push("bounded Floquet dynamic demag requires k_sampling".to_string());
        return Err(errors);
    };
    match k_sampling {
        KSamplingIR::Single { k_vector } => {
            validate_floquet_k_vector("k_sampling.Single.k_vector", k_vector, periodic_axes, &mut errors);
        }
        KSamplingIR::Path { points, .. } => {
            if points.is_empty() {
                errors.push(
                    "bounded Floquet dynamic demag requires at least one k_sampling.Path point"
                        .to_string(),
                );
            }
            for (index, point) in points.iter().enumerate() {
                validate_floquet_k_vector(
                    &format!("k_sampling.Path.points[{index}].k_vector"),
                    &point.k_vector,
                    periodic_axes,
                    &mut errors,
                );
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MeshPeriodicNodePairIR, PeriodicAxisCertificateV6IR, PeriodicMeshCertificateV6IR,
        SpinWaveBoundaryConfigIR, SpinWaveBoundaryKindIR,
    };

    fn floquet_mesh(translations: &[[f64; 3]], hints: &[Option<&str>]) -> MeshIR {
        assert_eq!(translations.len(), hints.len());
        let pair_ids = ["x_faces", "y_faces", "z_faces"];
        let mut mesh = MeshIR::default();
        mesh.periodic_boundary_pairs = translations
            .iter()
            .enumerate()
            .map(|(index, translation)| MeshPeriodicBoundaryPairIR {
                pair_id: pair_ids[index].to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: index as u32 + 1,
                marker_b: index as u32 + 11,
                translation: Some(*translation),
                tolerance: None,
                axis_hint: hints[index].map(str::to_string),
                orientation: None,
                pairing_policy: None,
            })
            .collect();
        mesh.periodic_node_pairs = translations
            .iter()
            .enumerate()
            .map(|(index, _)| MeshPeriodicNodePairIR {
                pair_id: pair_ids[index].to_string(),
                node_a: index as u32,
                node_b: index as u32 + 1,
            })
            .collect();
        mesh
    }

    fn floquet_boundary(pair_ids: &[&str]) -> SpinWaveBoundaryConditionIR {
        SpinWaveBoundaryConditionIR::Config(SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: None,
            pair_ids: pair_ids.iter().map(|pair_id| (*pair_id).to_string()).collect(),
            phase_convention: crate::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        })
    }

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
            .validate_against_certificate(Some(&certificate(
                "accepted",
                "periodic_mesh_certificate.v6",
            )))
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
            .validate_against_certificate(Some(&certificate(
                "stale",
                "periodic_mesh_certificate.v5",
            )))
            .expect_err("stale certificate must be rejected");
        assert!(stale
            .iter()
            .any(|error| error.contains("schema='periodic_mesh_certificate.v5'")));
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
            .validate_against_certificate(Some(&certificate(
                "accepted",
                "periodic_mesh_certificate.v6",
            )))
            .expect_err("nonzero y component must be rejected without y periodicity");
        assert!(errors
            .iter()
            .any(|error| error.contains("non-periodic mesh axis")));
    }

    #[test]
    fn strict_floquet_admission_accepts_signed_mixed_k_and_all_pathpoints() {
        let mesh = floquet_mesh(
            &[[1.0, 0.0, 0.0], [0.0, -1.0, 0.0]],
            &[Some("x"), Some("y")],
        );
        let boundary = floquet_boundary(&[]);
        let sampling = KSamplingIR::Path {
            points: vec![
                crate::KPointIR::gamma(),
                crate::KPointIR {
                    label: Some("mixed".to_string()),
                    k_vector: [-1.0e7, 1.0e7, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        };
        validate_bounded_floquet_dynamic_demag_admission(
            &mesh,
            &boundary,
            Some(&sampling),
        )
        .expect("finite signed mixed k path should satisfy strict admission");
    }

    #[test]
    fn strict_floquet_admission_rejects_open_axis_at_one_e_minus_fifteen() {
        let mesh = floquet_mesh(&[[1.0, 0.0, 0.0]], &[Some("x")]);
        let boundary = floquet_boundary(&[]);
        let sampling = KSamplingIR::Single {
            k_vector: [1.0e7, 0.0, 1.0e-15],
        };
        let errors = validate_bounded_floquet_dynamic_demag_admission(
            &mesh,
            &boundary,
            Some(&sampling),
        )
        .expect_err("a nonzero open-axis component must be rejected exactly");
        assert!(errors
            .iter()
            .any(|error| error.contains("exactly zero on an open axis")));
    }

    #[test]
    fn strict_floquet_admission_requires_translation_even_with_hint() {
        for translation in [
            None,
            Some([f64::NAN, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0]),
            Some([1.0e-15, 0.0, 0.0]),
            Some([1.0, 1.0, 0.0]),
        ] {
            let mut mesh = floquet_mesh(&[[1.0, 0.0, 0.0]], &[Some("x")]);
            mesh.periodic_boundary_pairs[0].translation = translation;
            let errors = validate_bounded_floquet_dynamic_demag_admission(
                &mesh,
                &floquet_boundary(&[]),
                Some(&KSamplingIR::Single {
                    k_vector: [1.0e7, 0.0, 0.0],
                }),
            )
            .expect_err("a hint must not substitute invalid translation metadata");
            assert!(errors
                .iter()
                .any(|error| error.contains("periodic pair 'x_faces'")));
        }
    }

    #[test]
    fn strict_floquet_admission_rejects_unknown_or_conflicting_hint() {
        for hint in [Some("diagonal"), Some("y")] {
            let mesh = floquet_mesh(&[[1.0, 0.0, 0.0]], &[hint]);
            let errors = validate_bounded_floquet_dynamic_demag_admission(
                &mesh,
                &floquet_boundary(&[]),
                Some(&KSamplingIR::Single {
                    k_vector: [1.0e7, 0.0, 0.0],
                }),
            )
            .expect_err("unknown or conflicting axis hints must fail closed");
            assert!(errors
                .iter()
                .any(|error| error.contains("axis_hint")));
        }
    }

    #[test]
    fn strict_floquet_admission_rejects_empty_mesh_pair_metadata() {
        let errors = validate_bounded_floquet_dynamic_demag_admission(
            &MeshIR::default(),
            &floquet_boundary(&[]),
            Some(&KSamplingIR::Single {
                k_vector: [1.0e7, 0.0, 0.0],
            }),
        )
        .expect_err("empty periodic mesh metadata must not be admitted");
        assert!(errors
            .iter()
            .any(|error| error.contains("periodic_boundary_pairs")));
        assert!(errors
            .iter()
            .any(|error| error.contains("periodic_node_pairs")));
    }
}

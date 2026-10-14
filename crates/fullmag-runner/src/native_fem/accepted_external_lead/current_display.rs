use super::AcceptedExternalLeadBundle;
use crate::types::RunError;
pub(crate) use fullmag_antenna_artifacts::current_display::AcceptedExternalLeadCurrentDisplay;
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
use fullmag_antenna_artifacts::current_display::HEADER;
pub(super) use fullmag_antenna_artifacts::current_display::{OPERATOR, SCHEMA};
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
use sha2::{Digest, Sha256};
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
use std::collections::HashSet;

pub(crate) fn decode_current_display(
    payload: Vec<u8>,
    expected_sha: &str,
    bundle: &AcceptedExternalLeadBundle,
) -> Result<AcceptedExternalLeadCurrentDisplay, RunError> {
    fullmag_antenna_artifacts::current_display::decode_current_display(
        payload,
        expected_sha,
        bundle,
    )
    .map_err(Into::into)
}

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
mod tests {
    use super::*;

    // Independent codec fixture, not evidence that a native current solve ran.
    fn field(bytes: &mut Vec<u8>, name: &str, tag: u8, value: &[u8]) {
        bytes.extend_from_slice(&(name.len() as u64).to_be_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.push(tag);
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value);
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn fixture() -> (AcceptedExternalLeadBundle, Vec<u8>) {
        let bytes = super::super::inspection_test_bundle();
        let bundle = super::super::decode_owned_bundle(bytes.clone(), &sha(&bytes)).unwrap();
        let device = bundle
            .source
            .device_vertex_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let selected = bundle
            .charge
            .elements
            .iter()
            .enumerate()
            .filter(|(_, element)| element.vertex_ids.iter().all(|id| device.contains(id)))
            .collect::<Vec<_>>();
        let mut bytes = Vec::new();
        for (name, value) in [
            (
                "schema",
                "accepted_external_lead_current_display.ordered.v1",
            ),
            (
                "operator_version",
                "fem_accepted_external_lead_current_display.v1",
            ),
            ("current_evaluator_version", "fem_generic_affine_rt0.v1"),
            ("sampling_policy", "cell_center_and_cell_local_vertices.v1"),
            ("center_policy", "vertex_quarter_sum.long_double.v1"),
            ("field_scope", "external_electrode_truncation"),
            ("status", "inspection_only"),
            ("normalization", "raw_authored_current"),
            ("coordinate_unit", "m"),
            ("current_density_unit", "A/m^2"),
            ("bundle_content_sha256", bundle.content_sha256.as_str()),
            (
                "charge_content_sha256",
                bundle.charge.content_sha256.as_str(),
            ),
            (
                "source_content_sha256",
                bundle.source_content_sha256.as_str(),
            ),
            (
                "stable_vertex_id_version",
                bundle.charge.stable_vertex_version.as_str(),
            ),
        ] {
            field(&mut bytes, name, 1, value.as_bytes());
        }
        field(
            &mut bytes,
            "cell_count",
            2,
            &(selected.len() as u64).to_be_bytes(),
        );
        for (index, element) in selected {
            field(
                &mut bytes,
                "source_element_index",
                2,
                &(index as u64).to_be_bytes(),
            );
            for id in element.vertex_ids {
                field(&mut bytes, "vertex_id", 2, &id.to_be_bytes());
                let xyz = bundle
                    .charge
                    .vertices
                    .iter()
                    .find(|vertex| vertex.id == id)
                    .unwrap()
                    .xyz_m;
                for value in xyz {
                    field(
                        &mut bytes,
                        "vertex_coordinate_m",
                        4,
                        &value.to_bits().to_be_bytes(),
                    );
                }
                for value in [1.0f64, -2., 3.] {
                    field(
                        &mut bytes,
                        "vertex_current_apm2",
                        4,
                        &value.to_bits().to_be_bytes(),
                    );
                }
            }
            for value in [0.25f64, 0.5, 0.75] {
                field(
                    &mut bytes,
                    "center_coordinate_m",
                    4,
                    &value.to_bits().to_be_bytes(),
                );
            }
            for value in [1.0f64, -2., 3.] {
                field(
                    &mut bytes,
                    "center_current_apm2",
                    4,
                    &value.to_bits().to_be_bytes(),
                );
            }
        }
        (bundle, bytes)
    }

    fn replace_value(bytes: &mut [u8], name: &str, occurrence: usize, value: &[u8]) {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(name.len() as u64).to_be_bytes());
        prefix.extend_from_slice(name.as_bytes());
        let begin = bytes
            .windows(prefix.len())
            .enumerate()
            .filter(|(_, window)| *window == prefix.as_slice())
            .nth(occurrence)
            .unwrap()
            .0
            + 17
            + name.len();
        bytes[begin..begin + value.len()].copy_from_slice(value);
    }

    #[test]
    fn retains_native_samples_and_complete_local_geometry() {
        let (bundle, bytes) = fixture();
        let digest = sha(&bytes);
        let decoded = decode_current_display(bytes.clone(), &digest, &bundle).unwrap();
        assert_eq!(decoded.canonical_payload, bytes);
        assert_eq!(decoded.content_sha256, digest);
        assert_eq!(decoded.cells.len(), 6);
        for cell in decoded.cells {
            assert_eq!(
                cell.vertex_ids,
                bundle.charge.elements[cell.source_element_index as usize].vertex_ids
            );
            assert_eq!(cell.center_xyz_m, [0.25, 0.5, 0.75]);
            assert_eq!(cell.center_j_apm2, [1., -2., 3.]);
            assert_eq!(cell.vertex_j_apm2, [[1., -2., 3.]; 4]);
        }
    }

    #[test]
    fn refuses_foreign_pins_indices_local_ids_geometry_and_noncanonical_scalars() {
        let (bundle, original) = fixture();
        for (name, _) in HEADER {
            let mut bytes = original.clone();
            replace_value(&mut bytes, name, 0, b"X");
            assert!(
                decode_current_display(bytes.clone(), &sha(&bytes), &bundle).is_err(),
                "{name}"
            );
        }
        for (name, occurrence, value) in [
            ("bundle_content_sha256", 0, b"X".to_vec()),
            ("charge_content_sha256", 0, b"X".to_vec()),
            ("source_content_sha256", 0, b"X".to_vec()),
            ("stable_vertex_id_version", 0, b"X".to_vec()),
            ("current_density_unit", 0, b"X".to_vec()),
            ("operator_version", 0, b"X".to_vec()),
            ("cell_count", 0, u64::MAX.to_be_bytes().to_vec()),
            ("source_element_index", 0, 6u64.to_be_bytes().to_vec()),
            ("source_element_index", 1, 0u64.to_be_bytes().to_vec()),
            ("vertex_id", 0, 999u64.to_be_bytes().to_vec()),
            (
                "vertex_id",
                0,
                bundle.charge.elements[0].vertex_ids[1]
                    .to_be_bytes()
                    .to_vec(),
            ),
            (
                "vertex_coordinate_m",
                0,
                0.125f64.to_bits().to_be_bytes().to_vec(),
            ),
            (
                "vertex_current_apm2",
                0,
                f64::NAN.to_bits().to_be_bytes().to_vec(),
            ),
            (
                "center_current_apm2",
                0,
                f64::INFINITY.to_bits().to_be_bytes().to_vec(),
            ),
            (
                "center_coordinate_m",
                0,
                (-0.0f64).to_bits().to_be_bytes().to_vec(),
            ),
        ] {
            let mut bytes = original.clone();
            replace_value(&mut bytes, name, occurrence, &value);
            assert!(
                decode_current_display(bytes.clone(), &sha(&bytes), &bundle).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_incomplete_extra_bytes_bad_sha_and_missing_partition() {
        let (mut bundle, original) = fixture();
        assert!(decode_current_display(original.clone(), &"0".repeat(64), &bundle).is_err());
        for bytes in [
            original[..original.len() - 1].to_vec(),
            [original.clone(), vec![0]].concat(),
        ] {
            assert!(decode_current_display(bytes.clone(), &sha(&bytes), &bundle).is_err());
        }
        bundle.source.device_vertex_ids.pop();
        assert!(decode_current_display(original.clone(), &sha(&original), &bundle).is_err());
    }
}

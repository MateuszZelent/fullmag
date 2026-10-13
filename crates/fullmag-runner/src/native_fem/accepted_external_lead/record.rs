#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use super::AcceptedExternalLeadRequest;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use crate::native_fem::accepted_terminal_charge::{require, validate_record_inputs};
use crate::types::RunError;
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
use sha2::{Digest, Sha256};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use std::collections::{BTreeMap, BTreeSet};

pub(crate) use fullmag_antenna_artifacts::bundle::AcceptedExternalLeadBundle;

pub(crate) fn decode_owned_bundle(
    payload: Vec<u8>,
    sha: &str,
) -> Result<AcceptedExternalLeadBundle, RunError> {
    fullmag_antenna_artifacts::bundle::decode_owned_bundle(payload, sha).map_err(Into::into)
}

// Intent binding is deliberately separate: no request is synthesized from a result.
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) fn validate_bundle_request(
    bundle: &AcceptedExternalLeadBundle,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<(), RunError> {
    super::preflight(request)?;
    bind_preflighted_request(bundle, request)
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn bind_preflighted_request(
    bundle: &AcceptedExternalLeadBundle,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<(), RunError> {
    validate_record_inputs(&bundle.charge, &request.charge)?;
    let source = &bundle.source;
    require(
        source.closure_revision == request.closure_revision
            && source
                .device_vertex_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                == request.device_vertex_ids.iter().copied().collect()
            && source
                .lead_vertex_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                == request.lead_vertex_ids.iter().copied().collect(),
        "external source closure/partitions differ from request",
    )?;
    let expected_boundary = request
        .boundary_faces
        .iter()
        .map(|b| (b.vertex_ids, (b.role, b.circuit_id.as_str())))
        .collect::<BTreeMap<_, _>>();
    require(
        expected_boundary.len() == request.boundary_faces.len()
            && expected_boundary.len() == source.boundary_faces.len()
            && source.boundary_faces.iter().all(|b| {
                expected_boundary.get(&b.vertex_ids) == Some(&(b.role, b.circuit_id.as_str()))
            }),
        "external boundary differs from request",
    )?;
    require(
        source.branches.len() == request.branches.len(),
        "external branch count differs from request",
    )?;
    for (actual, expected) in source.branches.iter().zip(request.branches) {
        let mut pairs = expected.interface_pair_ids.clone();
        pairs.sort_unstable();
        require(
            actual.id == expected.id
                && actual.interface_pair_ids == pairs
                && actual.requested_device_outward_current_a
                    == expected.requested_device_outward_current_a,
            "external branch differs from request",
        )?;
    }
    let p = bundle.field.quadrature;
    let expected = request.quadrature;
    require(
        bundle.field.quadrature_operator_version
            == fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION
            && p.base_quadrature_order == expected.base_quadrature_order
            && p.maximum_subdivision_depth == expected.maximum_subdivision_depth
            && p.absolute_tolerance_apm == expected.absolute_tolerance_apm
            && p.relative_tolerance == expected.relative_tolerance
            && p.maximum_source_target_pairs == expected.maximum_source_target_pairs
            && bundle.field.targets_m == request.targets_m,
        "external field targets/policy differ from request",
    )
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn decode_bundle(
    payload: Vec<u8>,
    sha: &str,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<AcceptedExternalLeadBundle, RunError> {
    super::preflight(request)?;
    let bundle = decode_owned_bundle(payload, sha)?;
    bind_preflighted_request(&bundle, request)?;
    Ok(bundle)
}

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
#[path = "bundle_tests.rs"]
mod tests;

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
pub(crate) use tests::inspection_test_bundle;

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
mod fixture_helpers {
    use crate::native_fem::accepted_terminal_charge::require;
    use crate::types::RunError;
    pub(super) fn key<const N: usize>(mut ids: [u64; N]) -> [u64; N] {
        ids.sort_unstable();
        ids
    }

    pub(super) fn current_gate(measured: f64, requested: f64) -> Result<(), RunError> {
        let gate = 1e-18 + 1e-8 * requested.abs();
        require(
            gate.is_finite() && (measured - requested).abs() <= gate,
            "external lead signed current gate failed",
        )
    }

    #[derive(Default)]
    pub(super) struct Sum {
        value: f64,
        correction: f64,
    }
    impl Sum {
        pub(super) fn add(&mut self, value: f64) {
            let next = self.value + value;
            self.correction += if self.value.abs() >= value.abs() {
                (self.value - next) + value
            } else {
                (value - next) + self.value
            };
            self.value = next;
        }
        pub(super) fn total(&self) -> f64 {
            self.value + self.correction
        }
        pub(super) fn of(values: impl IntoIterator<Item = f64>) -> f64 {
            let mut sum = Self::default();
            for value in values {
                sum.add(value);
            }
            sum.total()
        }
    }
}
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
use fixture_helpers::{current_gate, key, Sum};

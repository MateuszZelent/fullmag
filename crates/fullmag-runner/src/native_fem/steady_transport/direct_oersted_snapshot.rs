//! Cold, owned OE-F1 output validation. No solve or field reconstruction.
use crate::types::RunError;
use fullmag_fem_sys as ffi;
use crate::antenna_field_solution::direct_quadrature::DirectOerstedTarget;
#[cfg(test)]
use crate::antenna_field_solution::direct_quadrature::target_error_fits;
use std::ffi::c_char;

const MAX_LEAVES: u64 = 1_000_000;
const MAX_KERNEL_EVALUATIONS: u64 = 100_000_000;
const MAX_LEDGER_VISITS: u64 = 100_000_000;

pub(crate) use crate::antenna_field_solution::direct_quadrature::DirectOerstedSnapshot;

pub(super) struct SnapshotBuffer {
    records: Vec<ffi::fullmag_fem_direct_oersted_target_record_v1>,
    pub(super) header: ffi::fullmag_fem_direct_oersted_snapshot_result_v1,
}

fn invalid(reason: &str) -> RunError {
    RunError { message: format!("native FEM OE-F1 snapshot refused: {reason}") }
}

fn text<const N: usize>(value: &[c_char; N]) -> Result<String, RunError> {
    let end = value.iter().position(|byte| *byte == 0)
        .ok_or_else(|| invalid("unterminated metadata"))?;
    if value[end..].iter().any(|byte| *byte != 0) {
        return Err(invalid("noncanonical metadata padding"));
    }
    String::from_utf8(value[..end].iter().map(|byte| *byte as u8).collect())
        .map_err(|_| invalid("invalid metadata UTF-8"))
}
impl SnapshotBuffer {
    pub(super) fn new(target_count: usize) -> Result<Self, RunError> {
        if target_count == 0 || target_count as u64 > ffi::FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_MAX_TARGETS {
            return Err(invalid("target count outside snapshot bound"));
        }
        let sentinel = ffi::fullmag_fem_direct_oersted_target_record_v1 {
            target_xyz_m: [f64::NAN; 3], h_xyz_apm: [f64::NAN; 3],
            estimated_error_apm: f64::NAN, tolerance_apm: f64::NAN,
            roundoff_indicator_apm: f64::NAN, final_leaf_count: 0,
            kernel_evaluations: 0, ledger_leaf_visits: 0,
        };
        let mut records = Vec::new();
        records.try_reserve_exact(target_count).map_err(|_| invalid("record allocation failed"))?;
        records.resize(target_count, sentinel);
        let header = ffi::fullmag_fem_direct_oersted_snapshot_result_v1 {
            abi_version: ffi::FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_direct_oersted_snapshot_result_v1>() as u64,
            target_records: records.as_mut_ptr(), target_records_capacity: records.len() as u64,
            target_records_len: 0, source_target_pairs: 0, refined_pairs: 0,
            unconverged_pair_count: 0, maximum_pair_error_apm: f64::NAN,
            kernel_evaluations: 0, ledger_leaf_visits: 0, base_quadrature_order: 0,
            maximum_subdivision_depth: 0, absolute_tolerance_apm: f64::NAN,
            relative_tolerance: f64::NAN, relative_scale_floor_apm: f64::NAN,
            maximum_source_target_pairs: 0, maximum_final_leaves_per_target: 0,
            maximum_kernel_evaluations: 0, maximum_ledger_leaf_visits: 0,
            schema_version: [0; 96], operator_version: [0; 96], quadrature_scope: [0; 32],
            estimated_error_policy: [0; 96], roundoff_indicator_policy: [0; 96],
            source_view_identity_digest: [0; 65], error_message: [0; 256],
        };
        Ok(Self { records, header })
    }

    // Consume only after the native status is OK. Never dereference a pointer returned by native.
    pub(super) fn finish(
        mut self,
        legacy: &ffi::fullmag_fem_steady_transport_rt0_oersted_result_v1,
        target_points: &[[f64; 3]],
        raw_h: &[f64],
        source_count: usize,
        expected_source_digest: &str,
    ) -> Result<DirectOerstedSnapshot, RunError> {
        let h = &self.header;
        if h.abi_version != ffi::FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_ABI_VERSION
            || h.reserved_flags != 0
            || h.struct_size != std::mem::size_of::<ffi::fullmag_fem_direct_oersted_snapshot_result_v1>() as u64
            || h.target_records != self.records.as_mut_ptr()
            || h.target_records_capacity != self.records.len() as u64
            || h.target_records_len != self.records.len() as u64
            || target_points.len() != self.records.len()
            || raw_h.len() != 3 * self.records.len()
            || text(&h.error_message)? != ""
        {
            return Err(invalid("header, buffer ownership or target lengths"));
        }
        for (actual, expected) in [
            (text(&h.schema_version)?, "fem_direct_oersted_target_snapshot.v1"),
            (text(&h.operator_version)?, fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION),
            (text(&h.quadrature_scope)?, "global_target"),
            (text(&h.estimated_error_policy)?, "sum_final_leaf_l2_difference.v1"),
            (text(&h.roundoff_indicator_policy)?, "weighted_terms_binary64_epsilon.v1"),
        ] {
            if actual != expected { return Err(invalid("schema/operator/policy mismatch")); }
        }
        let source_digest = text(&h.source_view_identity_digest)?;
        if source_digest != expected_source_digest || source_digest.len() != 64
            || !source_digest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || text(&legacy.source_view_identity_digest)? != source_digest
            || text(&legacy.operator_version)? != fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION
        {
            return Err(invalid("RT0 source identity or legacy operator mismatch"));
        }
        if h.base_quadrature_order != fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER
            || h.maximum_subdivision_depth != fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH
            || h.absolute_tolerance_apm.to_bits() != fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM.to_bits()
            || h.relative_tolerance.to_bits() != fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE.to_bits()
            || h.relative_scale_floor_apm.to_bits() != 0.0_f64.to_bits()
            || h.maximum_source_target_pairs != super::DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS
            || h.maximum_final_leaves_per_target != MAX_LEAVES
            || h.maximum_kernel_evaluations != MAX_KERNEL_EVALUATIONS
            || h.maximum_ledger_leaf_visits != MAX_LEDGER_VISITS
        {
            return Err(invalid("request options or kernel budget mismatch"));
        }
        let source_count = u64::try_from(source_count).map_err(|_| invalid("source count overflow"))?;
        let roots = source_count.checked_mul(self.records.len() as u64)
            .ok_or_else(|| invalid("source-target count overflow"))?;
        if source_count == 0 || roots > h.maximum_source_target_pairs
            || h.source_target_pairs != roots || legacy.source_target_pairs != roots
            || h.unconverged_pair_count != 0 || legacy.unconverged_pair_count != 0
            || h.refined_pairs != legacy.refined_pairs
            || !h.maximum_pair_error_apm.is_finite() || h.maximum_pair_error_apm < 0.0
            || h.maximum_pair_error_apm.to_bits() != legacy.maximum_pair_error_apm.to_bits()
        {
            return Err(invalid("source counts or legacy diagnostic mismatch"));
        }
        for (index, row) in self.records.iter().enumerate() {
            for component in 0..3 {
                if !row.target_xyz_m[component].is_finite() || !row.h_xyz_apm[component].is_finite()
                    || row.target_xyz_m[component].to_bits() != target_points[index][component].to_bits()
                    || row.h_xyz_apm[component].to_bits() != raw_h[3 * index + component].to_bits()
                {
                    return Err(invalid("ordered raw xyz/H binding mismatch"));
                }
            }
        }
        let snapshot = DirectOerstedSnapshot {
            targets: self.records.into_iter().map(|row| DirectOerstedTarget {
                target_xyz_m: row.target_xyz_m, h_xyz_apm: row.h_xyz_apm,
                estimated_error_apm: row.estimated_error_apm, tolerance_apm: row.tolerance_apm,
                roundoff_indicator_apm: row.roundoff_indicator_apm, final_leaf_count: row.final_leaf_count,
                kernel_evaluations: row.kernel_evaluations, ledger_leaf_visits: row.ledger_leaf_visits,
            }).collect(),
            source_view_identity_digest: source_digest, source_target_pairs: h.source_target_pairs,
            refined_pairs: h.refined_pairs, unconverged_pair_count: h.unconverged_pair_count,
            maximum_pair_error_apm: h.maximum_pair_error_apm, kernel_evaluations: h.kernel_evaluations,
            ledger_leaf_visits: h.ledger_leaf_visits, base_quadrature_order: h.base_quadrature_order,
            maximum_subdivision_depth: h.maximum_subdivision_depth, absolute_tolerance_apm: h.absolute_tolerance_apm,
            relative_tolerance: h.relative_tolerance, relative_scale_floor_apm: h.relative_scale_floor_apm,
            maximum_source_target_pairs: h.maximum_source_target_pairs,
            maximum_final_leaves_per_target: h.maximum_final_leaves_per_target,
            maximum_kernel_evaluations: h.maximum_kernel_evaluations,
            maximum_ledger_leaf_visits: h.maximum_ledger_leaf_visits,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put<const N: usize>(target: &mut [c_char; N], value: &str) {
        assert!(value.len() < N);
        for (byte, source) in target.iter_mut().zip(value.bytes()) { *byte = source as c_char; }
    }

    fn example() -> (SnapshotBuffer, ffi::fullmag_fem_steady_transport_rt0_oersted_result_v1, Vec<[f64; 3]>, Vec<f64>) {
        let points = (0..12).map(|i| [i as f64, 1.0, 2.0]).collect::<Vec<_>>();
        let raw_h = vec![0.0; 36];
        let mut buffer = SnapshotBuffer::new(points.len()).unwrap();
        for (row, point) in buffer.records.iter_mut().zip(&points) {
            *row = ffi::fullmag_fem_direct_oersted_target_record_v1 {
                target_xyz_m: *point, h_xyz_apm: [0.0; 3], estimated_error_apm: 0.0,
                tolerance_apm: fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
                roundoff_indicator_apm: 0.0, final_leaf_count: 1,
                kernel_evaluations: 4, ledger_leaf_visits: 1,
            };
        }
        let h = &mut buffer.header;
        h.target_records_len = 12;
        h.source_target_pairs = 12;
        h.maximum_pair_error_apm = 0.0;
        h.kernel_evaluations = 48;
        h.ledger_leaf_visits = 12;
        h.base_quadrature_order = fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER;
        h.maximum_subdivision_depth = fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH;
        h.absolute_tolerance_apm = fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM;
        h.relative_tolerance = fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE;
        h.relative_scale_floor_apm = 0.0;
        h.maximum_source_target_pairs = super::super::DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS;
        h.maximum_final_leaves_per_target = MAX_LEAVES;
        h.maximum_kernel_evaluations = MAX_KERNEL_EVALUATIONS;
        h.maximum_ledger_leaf_visits = MAX_LEDGER_VISITS;
        put(&mut h.schema_version, "fem_direct_oersted_target_snapshot.v1");
        put(&mut h.operator_version, fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION);
        put(&mut h.quadrature_scope, "global_target");
        put(&mut h.estimated_error_policy, "sum_final_leaf_l2_difference.v1");
        put(&mut h.roundoff_indicator_policy, "weighted_terms_binary64_epsilon.v1");
        put(&mut h.source_view_identity_digest, &"a".repeat(64));
        // All fields of this C POD are integers, floats, pointers or POD arrays;
        // zero is a valid Rust representation. This fixture is never sent to native.
        let mut legacy: ffi::fullmag_fem_steady_transport_rt0_oersted_result_v1 = unsafe { std::mem::zeroed() };
        legacy.source_target_pairs = 12;
        put(&mut legacy.operator_version, fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION);
        put(&mut legacy.source_view_identity_digest, &"a".repeat(64));
        (buffer, legacy, points, raw_h)
    }

    #[test]
    fn owns_twelve_complete_targets_without_json_truncation() {
        let (buffer, legacy, points, raw_h) = example();
        let snapshot = buffer.finish(&legacy, &points, &raw_h, 1, &"a".repeat(64)).unwrap();
        assert_eq!(snapshot.targets.len(), 12);
        assert_eq!(snapshot.targets[11].target_xyz_m, points[11]);
        assert_eq!(snapshot.targets[11].h_xyz_apm, [0.0; 3]);
        assert_eq!(snapshot.targets[11].estimated_error_apm, 0.0);
        assert_eq!(snapshot.targets[11].tolerance_apm, fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM);
        assert_eq!(snapshot.targets[11].roundoff_indicator_apm, 0.0);
        assert_eq!(snapshot.targets[11].final_leaf_count, 1);
        assert_eq!(snapshot.targets[11].kernel_evaluations, 4);
        assert_eq!(snapshot.targets[11].ledger_leaf_visits, 1);
        assert!(snapshot.diagnostics().get("targets").is_none());
    }

    #[test]
    fn refuses_mutated_headers_bindings_and_work() {
        for mutation in 0..15 {
            let (mut buffer, legacy, points, raw_h) = example();
            match mutation {
                0 => buffer.header.target_records = std::ptr::null_mut(),
                1 => buffer.header.target_records_len -= 1,
                2 => buffer.header.target_records_capacity += 1,
                3 => buffer.header.reserved_flags = 1,
                4 => buffer.header.source_view_identity_digest[0] = b'b' as c_char,
                5 => buffer.header.relative_scale_floor_apm = 1.0,
                6 => buffer.records[0].target_xyz_m[0] = -0.0,
                7 => buffer.records[0].h_xyz_apm[0] = -0.0,
                8 => buffer.records[0].tolerance_apm *= 2.0,
                9 => buffer.records[0].estimated_error_apm = 1.0,
                10 => buffer.records[0].final_leaf_count = 2,
                11 => buffer.header.kernel_evaluations += 1,
                12 => buffer.header.ledger_leaf_visits += 1,
                13 => buffer.header.refined_pairs = u64::MAX,
                _ => buffer.header.schema_version.fill(b'x' as c_char),
            }
            assert!(buffer.finish(&legacy, &points, &raw_h, 1, &"a".repeat(64)).is_err(), "mutation {mutation}");
        }
    }

    #[test]
    fn refuses_positive_sub_ulp_roundoff_on_gate() {
        assert!(!target_error_fits(1.0, f64::EPSILON / 4.0, 1.0));
        assert!(target_error_fits(1.0, 0.0, 1.0));
        assert!(!target_error_fits(1.0, f64::INFINITY, 1.0));
    }

    #[test]
    fn refuses_empty_or_excess_capacity_before_allocating() {
        assert!(SnapshotBuffer::new(0).is_err());
        assert!(SnapshotBuffer::new(ffi::FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_MAX_TARGETS as usize + 1).is_err());
    }
}

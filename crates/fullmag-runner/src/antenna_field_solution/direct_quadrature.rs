//! Backend-neutral cold evidence. No solve or reconstruction of raw H.
use crate::types::RunError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const EVIDENCE_SCHEMA: &str = "fem_direct_oersted_evidence.v1";
const MAGIC: &[u8; 16] = b"FM-OEF1-Q3-V1\0\0\0";
const HEADER_BYTES: usize = 288;
const RECORD_BYTES: usize = 96;
const MAX_TARGETS: u64 = 1_000_000;
pub(crate) const MAX_LEAVES: u64 = 1_000_000;
pub(crate) const MAX_WORK: u64 = 100_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaQuadratureEvidenceRef {
    pub schema_version: String,
    pub path: String,
    pub sha256: String,
    pub byte_length: usize,
    pub target_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct DirectOerstedTarget {
    pub target_xyz_m: [f64; 3],
    pub h_xyz_apm: [f64; 3],
    pub estimated_error_apm: f64,
    pub tolerance_apm: f64,
    pub roundoff_indicator_apm: f64,
    pub final_leaf_count: u64,
    pub kernel_evaluations: u64,
    pub ledger_leaf_visits: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct DirectOerstedSnapshot {
    pub targets: Vec<DirectOerstedTarget>,
    pub source_view_identity_digest: String,
    pub source_target_pairs: u64,
    pub refined_pairs: u64,
    pub unconverged_pair_count: u64,
    pub maximum_pair_error_apm: f64,
    pub kernel_evaluations: u64,
    pub ledger_leaf_visits: u64,
    pub base_quadrature_order: i32,
    pub maximum_subdivision_depth: i32,
    pub absolute_tolerance_apm: f64,
    pub relative_tolerance: f64,
    pub relative_scale_floor_apm: f64,
    pub maximum_source_target_pairs: u64,
    pub maximum_final_leaves_per_target: u64,
    pub maximum_kernel_evaluations: u64,
    pub maximum_ledger_leaf_visits: u64,
}

fn invalid(reason: &str) -> RunError {
    RunError {
        message: format!("antenna direct-quadrature evidence refused: {reason}"),
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn target_error_fits(error: f64, roundoff: f64, tolerance: f64) -> bool {
    // Native FastTwoSum retains positive sub-ULP roundoff at equality.
    let larger = error.max(roundoff);
    let smaller = error.min(roundoff);
    let sum = larger + smaller;
    let residual = smaller - (sum - larger);
    sum < tolerance || (sum == tolerance && residual <= 0.0)
}

impl DirectOerstedSnapshot {
    /// Thin summary; target tables belong in the binary payload.
    pub(crate) fn diagnostics(&self) -> Value {
        json!({
            "schema_version": fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION,
            "operator_version": fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION,
            "source_view_identity_digest": self.source_view_identity_digest,
            "target_count": self.targets.len(),
            "source_target_pairs": self.source_target_pairs,
            "refined_pairs": self.refined_pairs,
            "unconverged_pair_count": self.unconverged_pair_count,
            "maximum_pair_error_apm": self.maximum_pair_error_apm,
            "kernel_evaluations": self.kernel_evaluations,
            "ledger_leaf_visits": self.ledger_leaf_visits,
            "base_quadrature_order": self.base_quadrature_order,
            "maximum_subdivision_depth": self.maximum_subdivision_depth,
            "absolute_tolerance_apm": self.absolute_tolerance_apm,
            "relative_tolerance": self.relative_tolerance,
            "relative_scale_floor_apm": self.relative_scale_floor_apm,
            "maximum_source_target_pairs": self.maximum_source_target_pairs,
            "maximum_final_leaves_per_target": self.maximum_final_leaves_per_target,
            "maximum_kernel_evaluations": self.maximum_kernel_evaluations,
            "maximum_ledger_leaf_visits": self.maximum_ledger_leaf_visits,
            "quadrature_scope": "global_target",
            "estimated_error_policy": "sum_final_leaf_l2_difference.v1",
            "roundoff_indicator_policy": "weighted_terms_binary64_epsilon.v1",
        })
    }

    pub(crate) fn validate(&self) -> Result<(), RunError> {
        let n = self.targets.len() as u64;
        if n == 0
            || n > MAX_TARGETS
            || !is_digest(&self.source_view_identity_digest)
            || self.base_quadrature_order
                != fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER
            || self.maximum_subdivision_depth
                != fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH
            || self.absolute_tolerance_apm.to_bits()
                != fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM.to_bits()
            || self.relative_tolerance.to_bits()
                != fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE.to_bits()
            || self.relative_scale_floor_apm.to_bits() != 0.0_f64.to_bits()
            || self.maximum_source_target_pairs
                != fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS
            || self.maximum_final_leaves_per_target != MAX_LEAVES
            || self.maximum_kernel_evaluations != MAX_WORK
            || self.maximum_ledger_leaf_visits != MAX_WORK
            || self.source_target_pairs == 0
            || self.source_target_pairs > self.maximum_source_target_pairs
            || self.source_target_pairs % n != 0
            || self.unconverged_pair_count != 0
            || !self.maximum_pair_error_apm.is_finite()
            || self.maximum_pair_error_apm < 0.0
        {
            return Err(invalid("options, source identity, bounds or convergence"));
        }
        let source_count = self.source_target_pairs / n;
        let depth_bound = source_count
            .checked_mul(8_u64.pow(self.maximum_subdivision_depth as u32))
            .ok_or_else(|| invalid("depth bound overflow"))?;
        let mut sums = [0_u64; 3];
        for row in &self.targets {
            let norm = row.h_xyz_apm[0]
                .hypot(row.h_xyz_apm[1])
                .hypot(row.h_xyz_apm[2]);
            let tolerance = self
                .relative_tolerance
                .mul_add(norm, self.absolute_tolerance_apm);
            if row
                .target_xyz_m
                .iter()
                .chain(&row.h_xyz_apm)
                .any(|v| !v.is_finite())
                || [
                    row.estimated_error_apm,
                    row.tolerance_apm,
                    row.roundoff_indicator_apm,
                ]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0)
                || !tolerance.is_finite()
                || tolerance.to_bits() != row.tolerance_apm.to_bits()
                || !target_error_fits(
                    row.estimated_error_apm,
                    row.roundoff_indicator_apm,
                    tolerance,
                )
                || row.final_leaf_count < source_count
                || row.final_leaf_count > MAX_LEAVES
                || row.final_leaf_count > depth_bound
                || (row.final_leaf_count - source_count) % 7 != 0
                || row.kernel_evaluations < row.final_leaf_count
                || row.ledger_leaf_visits < row.final_leaf_count
            {
                return Err(invalid("target numeric acceptance or leaf/work counts"));
            }
            for (sum, value) in sums.iter_mut().zip([
                row.final_leaf_count,
                row.kernel_evaluations,
                row.ledger_leaf_visits,
            ]) {
                *sum = sum
                    .checked_add(value)
                    .ok_or_else(|| invalid("aggregate work overflow"))?;
            }
        }
        let leaves = self
            .refined_pairs
            .checked_mul(7)
            .and_then(|value| self.source_target_pairs.checked_add(value))
            .ok_or_else(|| invalid("refinement count overflow"))?;
        if sums != [leaves, self.kernel_evaluations, self.ledger_leaf_visits]
            || self.kernel_evaluations > MAX_WORK
            || self.ledger_leaf_visits > MAX_WORK
        {
            return Err(invalid("global work/refinement conservation"));
        }
        Ok(())
    }
}

pub(crate) struct DirectQuadratureEvidence {
    pub snapshot: DirectOerstedSnapshot,
    pub measured_positive_terminal_current_a: f64,
    pub normalization_scale: f64,
    pub current_balance_certificate_digest: String,
}

impl DirectQuadratureEvidence {
    fn validate(&self) -> Result<(), RunError> {
        self.snapshot.validate()?;
        let current = self.measured_positive_terminal_current_a;
        if !current.is_finite()
            || current <= 1.0e-30
            || !self.normalization_scale.is_finite()
            || self.normalization_scale.to_bits() != (1.0 / current).to_bits()
            || !is_digest(&self.current_balance_certificate_digest)
        {
            return Err(invalid(
                "measured current, normalization or balance certificate",
            ));
        }
        Ok(())
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, RunError> {
        self.validate()?;
        let s = &self.snapshot;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(HEADER_BYTES + RECORD_BYTES * s.targets.len())
            .map_err(|_| invalid("binary allocation failed"))?;
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(s.source_view_identity_digest.as_bytes());
        bytes.extend_from_slice(self.current_balance_certificate_digest.as_bytes());
        for value in [
            s.targets.len() as u64,
            s.source_target_pairs,
            s.refined_pairs,
            s.unconverged_pair_count,
            s.kernel_evaluations,
            s.ledger_leaf_visits,
            s.base_quadrature_order as u64,
            s.maximum_subdivision_depth as u64,
            s.maximum_source_target_pairs,
            s.maximum_final_leaves_per_target,
            s.maximum_kernel_evaluations,
            s.maximum_ledger_leaf_visits,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [
            s.maximum_pair_error_apm,
            s.absolute_tolerance_apm,
            s.relative_tolerance,
            s.relative_scale_floor_apm,
            self.measured_positive_terminal_current_a,
            self.normalization_scale,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for row in &s.targets {
            for value in row
                .target_xyz_m
                .iter()
                .chain(&row.h_xyz_apm)
                .copied()
                .chain([
                    row.estimated_error_apm,
                    row.tolerance_apm,
                    row.roundoff_indicator_apm,
                ])
            {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in [
                row.final_leaf_count,
                row.kernel_evaluations,
                row.ledger_leaf_visits,
            ] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        Ok(bytes)
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, RunError> {
        if bytes.len() < HEADER_BYTES || &bytes[..16] != MAGIC {
            return Err(invalid("truncated header or unknown magic"));
        }
        let mut integer = [0_u64; 12];
        for (value, chunk) in integer.iter_mut().zip(bytes[144..240].chunks_exact(8)) {
            *value = u64::from_le_bytes(chunk.try_into().expect("header bounded"));
        }
        let count = usize::try_from(integer[0]).map_err(|_| invalid("target count overflow"))?;
        if integer[0] == 0
            || integer[0] > MAX_TARGETS
            || HEADER_BYTES.checked_add(
                count
                    .checked_mul(RECORD_BYTES)
                    .ok_or_else(|| invalid("record size overflow"))?,
            ) != Some(bytes.len())
        {
            return Err(invalid("target bound or exact binary length"));
        }
        let mut real = [0_f64; 6];
        for (value, chunk) in real
            .iter_mut()
            .zip(bytes[240..HEADER_BYTES].chunks_exact(8))
        {
            *value = f64::from_le_bytes(chunk.try_into().expect("header bounded"));
        }
        let source_digest =
            std::str::from_utf8(&bytes[16..80]).map_err(|_| invalid("source digest encoding"))?;
        let balance_digest =
            std::str::from_utf8(&bytes[80..144]).map_err(|_| invalid("balance digest encoding"))?;
        let order = i32::try_from(integer[6]).map_err(|_| invalid("quadrature order overflow"))?;
        let depth = i32::try_from(integer[7]).map_err(|_| invalid("depth overflow"))?;
        let mut targets = Vec::new();
        targets
            .try_reserve_exact(count)
            .map_err(|_| invalid("record allocation failed"))?;
        for record in bytes[HEADER_BYTES..].chunks_exact(RECORD_BYTES) {
            let mut values = [0_f64; 9];
            for (value, chunk) in values.iter_mut().zip(record[..72].chunks_exact(8)) {
                *value = f64::from_le_bytes(chunk.try_into().expect("record bounded"));
            }
            let mut counts = [0_u64; 3];
            for (value, chunk) in counts.iter_mut().zip(record[72..].chunks_exact(8)) {
                *value = u64::from_le_bytes(chunk.try_into().expect("record bounded"));
            }
            targets.push(DirectOerstedTarget {
                target_xyz_m: [values[0], values[1], values[2]],
                h_xyz_apm: [values[3], values[4], values[5]],
                estimated_error_apm: values[6],
                tolerance_apm: values[7],
                roundoff_indicator_apm: values[8],
                final_leaf_count: counts[0],
                kernel_evaluations: counts[1],
                ledger_leaf_visits: counts[2],
            });
        }
        let result = Self {
            snapshot: DirectOerstedSnapshot {
                targets,
                source_view_identity_digest: source_digest.into(),
                source_target_pairs: integer[1],
                refined_pairs: integer[2],
                unconverged_pair_count: integer[3],
                kernel_evaluations: integer[4],
                ledger_leaf_visits: integer[5],
                base_quadrature_order: order,
                maximum_subdivision_depth: depth,
                maximum_source_target_pairs: integer[8],
                maximum_final_leaves_per_target: integer[9],
                maximum_kernel_evaluations: integer[10],
                maximum_ledger_leaf_visits: integer[11],
                maximum_pair_error_apm: real[0],
                absolute_tolerance_apm: real[1],
                relative_tolerance: real[2],
                relative_scale_floor_apm: real[3],
            },
            measured_positive_terminal_current_a: real[4],
            normalization_scale: real[5],
            current_balance_certificate_digest: balance_digest.into(),
        };
        result.validate()?;
        Ok(result)
    }

    pub(crate) fn verify_binding(
        &self,
        positions: &[[f64; 3]],
        per_ampere: &[[f64; 3]],
        current: f64,
        scale: f64,
        balance_digest: &str,
        diagnostics: &Value,
    ) -> Result<(), RunError> {
        self.validate()?;
        if current.to_bits() != self.measured_positive_terminal_current_a.to_bits()
            || scale.to_bits() != self.normalization_scale.to_bits()
            || balance_digest != self.current_balance_certificate_digest
            || diagnostics != &self.snapshot.diagnostics()
            || positions.len() != self.snapshot.targets.len()
            || per_ampere.len() != positions.len()
        {
            return Err(invalid(
                "manifest normalization, summary or carrier binding",
            ));
        }
        for (name, value) in [
            (
                "maximum_pair_error_apm",
                self.snapshot.maximum_pair_error_apm,
            ),
            (
                "absolute_tolerance_apm",
                self.snapshot.absolute_tolerance_apm,
            ),
            ("relative_tolerance", self.snapshot.relative_tolerance),
            (
                "relative_scale_floor_apm",
                self.snapshot.relative_scale_floor_apm,
            ),
        ] {
            if diagnostics
                .get(name)
                .and_then(Value::as_f64)
                .map(f64::to_bits)
                != Some(value.to_bits())
            {
                return Err(invalid("summary floating-point bit binding"));
            }
        }
        for ((row, position), field) in self.snapshot.targets.iter().zip(positions).zip(per_ampere)
        {
            for component in 0..3 {
                let normalized = row.h_xyz_apm[component] * scale;
                if !normalized.is_finite()
                    || position[component].to_bits() != row.target_xyz_m[component].to_bits()
                    || field[component].to_bits() != normalized.to_bits()
                {
                    return Err(invalid("ordered xyz or raw H to per-A bit binding"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn example() -> DirectQuadratureEvidence {
        let tolerance = fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE.mul_add(
            0.5,
            fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
        );
        DirectQuadratureEvidence {
            snapshot: DirectOerstedSnapshot {
                targets: (0..12)
                    .map(|i| DirectOerstedTarget {
                        target_xyz_m: [i as f64, -0.0, 2.0],
                        h_xyz_apm: [0.5, -0.0, 0.0],
                        estimated_error_apm: 0.0,
                        tolerance_apm: tolerance,
                        roundoff_indicator_apm: 0.0,
                        final_leaf_count: 1,
                        kernel_evaluations: 4,
                        ledger_leaf_visits: 1,
                    })
                    .collect(),
                source_view_identity_digest: "a".repeat(64),
                source_target_pairs: 12,
                refined_pairs: 0,
                unconverged_pair_count: 0,
                maximum_pair_error_apm: 0.0,
                kernel_evaluations: 48,
                ledger_leaf_visits: 12,
                base_quadrature_order: fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER,
                maximum_subdivision_depth: fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH,
                absolute_tolerance_apm: fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
                relative_tolerance: fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE,
                relative_scale_floor_apm: 0.0,
                maximum_source_target_pairs:
                    fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS,
                maximum_final_leaves_per_target: MAX_LEAVES,
                maximum_kernel_evaluations: MAX_WORK,
                maximum_ledger_leaf_visits: MAX_WORK,
            },
            measured_positive_terminal_current_a: 3.0,
            normalization_scale: 1.0 / 3.0,
            current_balance_certificate_digest: "b".repeat(64),
        }
    }

    #[test]
    fn binary_roundtrip_preserves_all_raw_bits_and_nonunit_current() {
        let original = example();
        let bytes = original.encode().unwrap();
        assert_eq!(bytes.len(), HEADER_BYTES + 12 * RECORD_BYTES);
        let restored = DirectQuadratureEvidence::decode(&bytes).unwrap();
        assert_eq!(restored.encode().unwrap(), bytes);
        let xyz = restored
            .snapshot
            .targets
            .iter()
            .map(|r| r.target_xyz_m)
            .collect::<Vec<_>>();
        let mut per_a = restored
            .snapshot
            .targets
            .iter()
            .map(|r| r.h_xyz_apm.map(|v| v / 3.0))
            .collect::<Vec<_>>();
        restored
            .verify_binding(
                &xyz,
                &per_a,
                3.0,
                1.0 / 3.0,
                &"b".repeat(64),
                &restored.snapshot.diagnostics(),
            )
            .unwrap();
        per_a[0][1] = 0.0;
        assert!(restored
            .verify_binding(
                &xyz,
                &per_a,
                3.0,
                1.0 / 3.0,
                &"b".repeat(64),
                &restored.snapshot.diagnostics()
            )
            .is_err());
    }

    #[test]
    fn binary_refuses_bad_lengths_and_counts_before_target_allocation() {
        let original = example().encode().unwrap();
        for length in [0, 15, 287, 288, original.len() - 1] {
            assert!(DirectQuadratureEvidence::decode(&original[..length]).is_err());
        }
        let mut trailing = original.clone();
        trailing.push(0);
        assert!(DirectQuadratureEvidence::decode(&trailing).is_err());
        for count in [0_u64, 1_000_001, u64::MAX] {
            let mut bytes = original.clone();
            bytes[144..152].copy_from_slice(&count.to_le_bytes());
            assert!(DirectQuadratureEvidence::decode(&bytes).is_err());
        }
    }

    #[test]
    fn binary_refuses_rehashed_numeric_corruption() {
        let original = example().encode().unwrap();
        for (offset, value) in [
            (168, 1_u64),
            (176, 49),
            (192, u64::MAX),
            (208, 1_000_001),
            (264, (-0.0_f64).to_bits()),
            (280, 1.0_f64.to_bits()),
            (HEADER_BYTES + 48, 1.0_f64.to_bits()),
            (HEADER_BYTES + 72, 2),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            // No hash can change these semantic refusals.
            assert!(
                DirectQuadratureEvidence::decode(&bytes).is_err(),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn equality_gate_keeps_positive_sub_ulp_roundoff() {
        assert!(!target_error_fits(1.0, f64::EPSILON / 4.0, 1.0));
        assert!(target_error_fits(1.0, 0.0, 1.0));
    }
}

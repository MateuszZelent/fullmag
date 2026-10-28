//! Explicit v2 evidence codec; the raw native H is retained without reconstruction.
use super::closed_loop_v2::{invalid, normalization_scale};
use super::direct_quadrature::{DirectOerstedSnapshot, DirectOerstedTarget, MAX_TARGETS};
use crate::types::RunError;
const MAGIC: &[u8; 16] = b"FM-OEF1-Q3-V2\0\0\0";
const HEADER: usize = 296;
const RECORD: usize = 96;
pub(crate) const SCHEMA: &str = "fem_direct_oersted_evidence.v2";

#[derive(Debug, Clone)]
pub(crate) struct DirectQuadratureEvidenceV2 {
    pub snapshot: DirectOerstedSnapshot,
    pub signed_normalization_a: f64,
    pub source_absolute_flux_a: f64,
    pub scale_per_a: f64,
    pub current_balance_certificate_digest: String,
}
impl DirectQuadratureEvidenceV2 {
    fn validate(&self) -> Result<(), RunError> {
        self.snapshot.validate_closed_loop()?;
        if normalization_scale(self.signed_normalization_a, self.source_absolute_flux_a)?.to_bits()
            != self.scale_per_a.to_bits()
            || !super::closed_loop_v2::is_digest(&self.current_balance_certificate_digest)
        {
            return Err(invalid("direct evidence normalization or certificate"));
        }
        Ok(())
    }
    pub(crate) fn verify_policy_binding(
        &self, requested: &serde_json::Value, resolved: &serde_json::Value,
    ) -> Result<(), RunError> {
        self.validate()?;
        match (requested.get("solver_policy"), resolved.get("direct_field_policy")) {
            (None, None) => self.snapshot.validate(),
            (Some(name), Some(policy)) => {
                let budget = name.as_str().and_then(fullmag_ir::antenna_closed_loop_direct_budget)
                    .ok_or_else(|| invalid("unknown retained direct field policy"))?;
                let s = &self.snapshot;
                let expected = serde_json::json!({
                    "policy_version": budget.policy_version,
                    "maximum_source_target_pairs": budget.maximum_source_target_pairs,
                    "maximum_kernel_evaluations": budget.maximum_kernel_evaluations,
                    "maximum_ledger_leaf_visits": budget.maximum_ledger_leaf_visits,
                });
                if *policy != expected
                    || s.maximum_source_target_pairs != budget.maximum_source_target_pairs
                    || s.maximum_kernel_evaluations != budget.maximum_kernel_evaluations
                    || s.maximum_ledger_leaf_visits != budget.maximum_ledger_leaf_visits {
                    return Err(invalid("direct evidence differs from retained requested/resolved policy"));
                }
                Ok(())
            }
            _ => Err(invalid("incomplete retained direct field policy")),
        }
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, RunError> {
        self.validate()?;
        let s = &self.snapshot;
        let length = HEADER
            .checked_add(
                s.targets
                    .len()
                    .checked_mul(RECORD)
                    .ok_or_else(|| invalid("evidence size overflow"))?,
            )
            .ok_or_else(|| invalid("evidence size overflow"))?;
        let mut b = Vec::new();
        b.try_reserve_exact(length)
            .map_err(|_| invalid("evidence allocation"))?;
        b.extend_from_slice(MAGIC);
        b.extend_from_slice(s.source_view_identity_digest.as_bytes());
        b.extend_from_slice(self.current_balance_certificate_digest.as_bytes());
        for x in [
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
            b.extend_from_slice(&x.to_le_bytes());
        }
        for x in [
            s.maximum_pair_error_apm,
            s.absolute_tolerance_apm,
            s.relative_tolerance,
            s.relative_scale_floor_apm,
            self.signed_normalization_a,
            self.scale_per_a,
            self.source_absolute_flux_a,
        ] {
            b.extend_from_slice(&x.to_le_bytes());
        }
        for r in &s.targets {
            for x in r.target_xyz_m.iter().chain(&r.h_xyz_apm).copied().chain([
                r.estimated_error_apm,
                r.tolerance_apm,
                r.roundoff_indicator_apm,
            ]) {
                b.extend_from_slice(&x.to_le_bytes());
            }
            for x in [
                r.final_leaf_count,
                r.kernel_evaluations,
                r.ledger_leaf_visits,
            ] {
                b.extend_from_slice(&x.to_le_bytes());
            }
        }
        Ok(b)
    }
    pub(crate) fn decode(b: &[u8]) -> Result<Self, RunError> {
        if b.len() < HEADER || &b[..16] != MAGIC {
            return Err(invalid("direct v2 header"));
        }
        let mut ints = [0u64; 12];
        for (v, p) in ints.iter_mut().zip(b[144..240].chunks_exact(8)) {
            *v = u64::from_le_bytes(p.try_into().unwrap());
        }
        let n = usize::try_from(ints[0]).map_err(|_| invalid("target count overflow"))?;
        if n == 0
            || ints[0] > MAX_TARGETS
            || n.checked_mul(RECORD).and_then(|v| v.checked_add(HEADER)) != Some(b.len())
        {
            return Err(invalid("direct v2 target count or length"));
        }
        let mut real = [0f64; 7];
        for (v, p) in real.iter_mut().zip(b[240..HEADER].chunks_exact(8)) {
            *v = f64::from_le_bytes(p.try_into().unwrap());
        }
        let mut targets = Vec::new();
        targets
            .try_reserve_exact(n)
            .map_err(|_| invalid("target allocation"))?;
        for row in b[HEADER..].chunks_exact(RECORD) {
            let mut r = [0f64; 9];
            let mut c = [0u64; 3];
            for (v, p) in r.iter_mut().zip(row[..72].chunks_exact(8)) {
                *v = f64::from_le_bytes(p.try_into().unwrap());
            }
            for (v, p) in c.iter_mut().zip(row[72..].chunks_exact(8)) {
                *v = u64::from_le_bytes(p.try_into().unwrap());
            }
            targets.push(DirectOerstedTarget {
                target_xyz_m: [r[0], r[1], r[2]],
                h_xyz_apm: [r[3], r[4], r[5]],
                estimated_error_apm: r[6],
                tolerance_apm: r[7],
                roundoff_indicator_apm: r[8],
                final_leaf_count: c[0],
                kernel_evaluations: c[1],
                ledger_leaf_visits: c[2],
            });
        }
        let digest = |range: std::ops::Range<usize>| {
            std::str::from_utf8(&b[range])
                .map(str::to_owned)
                .map_err(|_| invalid("evidence digest encoding"))
        };
        let result = Self {
            snapshot: DirectOerstedSnapshot {
                targets,
                source_view_identity_digest: digest(16..80)?,
                source_target_pairs: ints[1],
                refined_pairs: ints[2],
                unconverged_pair_count: ints[3],
                kernel_evaluations: ints[4],
                ledger_leaf_visits: ints[5],
                base_quadrature_order: i32::try_from(ints[6])
                    .map_err(|_| invalid("order overflow"))?,
                maximum_subdivision_depth: i32::try_from(ints[7])
                    .map_err(|_| invalid("depth overflow"))?,
                maximum_source_target_pairs: ints[8],
                maximum_final_leaves_per_target: ints[9],
                maximum_kernel_evaluations: ints[10],
                maximum_ledger_leaf_visits: ints[11],
                maximum_pair_error_apm: real[0],
                absolute_tolerance_apm: real[1],
                relative_tolerance: real[2],
                relative_scale_floor_apm: real[3],
            },
            signed_normalization_a: real[4],
            scale_per_a: real[5],
            source_absolute_flux_a: real[6],
            current_balance_certificate_digest: digest(80..144)?,
        };
        result.validate()?;
        Ok(result)
    }
    pub(crate) fn verify_binding(
        &self,
        positions: &[[f64; 3]],
        raw: &[[f64; 3]],
        per_a: &[[f64; 3]],
    ) -> Result<(), RunError> {
        self.validate()?;
        if positions.len() != self.snapshot.targets.len()
            || raw.len() != positions.len()
            || per_a.len() != positions.len()
        {
            return Err(invalid("evidence carrier count"));
        }
        for (((t, p), h), a) in self
            .snapshot
            .targets
            .iter()
            .zip(positions)
            .zip(raw)
            .zip(per_a)
        {
            for k in 0..3 {
                let normalized = t.h_xyz_apm[k] * self.scale_per_a;
                if t.target_xyz_m[k].to_bits() != p[k].to_bits()
                    || t.h_xyz_apm[k].to_bits() != h[k].to_bits()
                    || !normalized.is_finite()
                    || normalized.to_bits() != a[k].to_bits()
                {
                    return Err(invalid("evidence raw H or per-A bit binding"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod volume_policy_tests {
    use super::*;
    fn example(name: &str) -> DirectQuadratureEvidenceV2 {
        let legacy = super::super::direct_quadrature::tests::example();
        let mut snapshot = legacy.snapshot;
        let budget = fullmag_ir::antenna_closed_loop_direct_budget(name).unwrap();
        snapshot.maximum_source_target_pairs = budget.maximum_source_target_pairs;
        snapshot.maximum_kernel_evaluations = budget.maximum_kernel_evaluations;
        snapshot.maximum_ledger_leaf_visits = budget.maximum_ledger_leaf_visits;
        DirectQuadratureEvidenceV2 {
            snapshot, signed_normalization_a: 3.0, source_absolute_flux_a: 3.0,
            scale_per_a: 1.0 / 3.0, current_balance_certificate_digest: "b".repeat(64),
        }
    }
    fn provenance(name: &str) -> (serde_json::Value, serde_json::Value) {
        let b = fullmag_ir::antenna_closed_loop_direct_budget(name).unwrap();
        (serde_json::json!({"solver_policy": name}), serde_json::json!({"direct_field_policy": {
            "policy_version": b.policy_version, "maximum_source_target_pairs": b.maximum_source_target_pairs,
            "maximum_kernel_evaluations": b.maximum_kernel_evaluations,
            "maximum_ledger_leaf_visits": b.maximum_ledger_leaf_visits,
        }}))
    }
    #[test]
    fn both_profiles_roundtrip_without_changing_raw_bits() {
        for name in ["production_default", "volume_inspection_v1"] {
            let original = example(name);
            let bytes = original.encode().unwrap();
            let restored = DirectQuadratureEvidenceV2::decode(&bytes).unwrap();
            assert_eq!(restored.encode().unwrap(), bytes);
            assert_eq!(restored.snapshot.targets[0].h_xyz_apm[1].to_bits(), (-0.0_f64).to_bits());
            let (requested, resolved) = provenance(name);
            restored.verify_policy_binding(&requested, &resolved).unwrap();
        }
    }
    #[test]
    fn legacy_evidence_stays_readable_but_volume_cannot_lose_its_policy() {
        let empty = serde_json::json!({});
        example("production_default").verify_policy_binding(&empty, &empty).unwrap();
        let volume = example("volume_inspection_v1");
        assert!(volume.snapshot.validate().is_err());
        assert!(volume.verify_policy_binding(&empty, &empty).is_err());
        let (requested, resolved) = provenance("production_default");
        assert!(volume.verify_policy_binding(&requested, &resolved).is_err());
        let (requested, mut resolved) = provenance("volume_inspection_v1");
        assert!(volume.verify_policy_binding(&requested, &empty).is_err());
        resolved["direct_field_policy"]["policy_version"] = "unknown".into();
        assert!(volume.verify_policy_binding(&requested, &resolved).is_err());
        let mut hybrid = volume;
        hybrid.snapshot.maximum_ledger_leaf_visits = 100_000_000;
        assert!(hybrid.encode().is_err());
    }
    #[test]
    fn aggregate_work_is_not_reset_for_each_target() {
        let mut volume = example("volume_inspection_v1");
        for row in &mut volume.snapshot.targets { row.kernel_evaluations = 10_000_000; }
        volume.snapshot.kernel_evaluations = 120_000_000;
        volume.encode().unwrap();
        let mut legacy = example("production_default");
        legacy.snapshot.targets = volume.snapshot.targets.clone();
        legacy.snapshot.kernel_evaluations = 120_000_000;
        assert!(legacy.encode().is_err());
        for row in &mut volume.snapshot.targets { row.kernel_evaluations = 42_000_000; }
        volume.snapshot.kernel_evaluations = 504_000_000;
        assert!(volume.encode().is_err());
    }
}

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
        self.snapshot.validate()?;
        if normalization_scale(self.signed_normalization_a, self.source_absolute_flux_a)?.to_bits()
            != self.scale_per_a.to_bits()
            || !super::closed_loop_v2::is_digest(&self.current_balance_certificate_digest)
        {
            return Err(invalid("direct evidence normalization or certificate"));
        }
        Ok(())
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

//! Bounded inspection evidence for the accepted-source FEM CPU surface operator.
//! Decimal diagnostics are retained, not promoted to an independent error certificate.
use super::closed_loop_v2::{invalid, is_digest, normalization_scale};
use crate::types::RunError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const SCHEMA: &str = "fem_rt0_surface_evidence.v1";
pub(crate) const SNAPSHOT_SCHEMA: &str = "fem_rt0_surface_snapshot.v1";
pub(crate) const OPERATOR_VERSION: &str = "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1";
const LEGACY_OPERATOR_VERSION: &str = "fem_oersted_rt0_surface.inspection.v1";
pub(crate) const BASIS_VERSION: &str = "fem_generic_affine_rt0.v1";
const MAGIC: &[u8; 16] = b"FM-RT0-SURF-V1\0\0";
const HEADER: usize = 176;
const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_TARGETS: usize = 1_000_000;
// Encoding safety bounds, not numerical policy or work budgets.
const MAX_DECIMAL_BYTES: usize = 4096;
type Counts = [u64; 14];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0Limits {
    pub total: Counts,
    pub per_target: Counts,
    pub maximum_raw_integer_bits: u64,
    pub maximum_reduced_fraction_bits: u64,
    pub maximum_lifetime_peak_rss_bytes: u64,
    pub guard_interval_events: u64,
    pub maximum_total_seconds: f64,
    pub maximum_target_seconds: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0Tolerances {
    pub absolute_field_apm: f64,
    pub relative_field: f64,
    pub cancellation_floor_apm: f64,
    pub scalar_relative_80: f64,
    pub scalar_relative_120: f64,
    pub angle_relative_80: f64,
    pub angle_relative_120: f64,
    pub binary_scalar_epsilon_factor: f64,
    pub binary_roundoff_epsilon_factor: f64,
    pub binary_cancellation_limit: f64,
    pub highprecision_cancellation_limit: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0WorkReport {
    pub total: Counts,
    pub current_target: Counts,
    pub by_precision: [Counts; 3],
    pub current_target_index: u64,
    pub maximum_raw_integer_bits: u64,
    pub maximum_reduced_fraction_bits: u64,
    pub last_sampled_lifetime_peak_rss_bytes: u64,
    pub elapsed_seconds: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0Precision {
    pub evaluated: bool,
    pub refusal_reason: String,
    pub h_xyz_apm: [String; 3],
    pub whole_h_xyz_apm: [String; 3],
    pub sum_local_norm_apm: String,
    pub cancellation: String,
    pub maximum_face_cancellation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0Target {
    pub h_xyz_apm: [f64; 3],
    pub precisions: [SurfaceRt0Precision; 3],
    pub work: Counts,
    pub binary64_requires_highprecision: bool,
    pub precision_budget_apm: String,
    pub local_precision_delta_apm: String,
    pub local_formula_delta_apm: String,
    pub local_formula_delta_80_apm: String,
    pub binary64_roundoff_indicator_apm: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRt0Snapshot {
    pub schema_version: String,
    pub operator_version: String,
    pub basis_version: String,
    pub policy_version: String,
    pub inspection_only: bool,
    pub error_certificate_available: bool,
    pub source_view_identity_digest: String,
    pub accepted_source_state_digest: String,
    pub targets_xyz_m: Vec<[f64; 3]>,
    pub limits: SurfaceRt0Limits,
    pub tolerances: SurfaceRt0Tolerances,
    pub work_report: SurfaceRt0WorkReport,
    pub targets: Vec<SurfaceRt0Target>,
}

// Return whether the finite decimal is nonzero; no conversion through binary64.
fn decimal(value: &str, nonnegative: bool) -> Result<bool, RunError> {
    if value.is_empty() || value.len() > MAX_DECIMAL_BYTES || !value.is_ascii() {
        return Err(invalid("surface decimal encoding bound"));
    }
    let bytes = value.as_bytes();
    let mut i = usize::from(matches!(bytes[0], b'+' | b'-'));
    let mut digits = 0;
    let mut nonzero = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        digits += 1;
        nonzero |= bytes[i] != b'0';
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            digits += 1;
            nonzero |= bytes[i] != b'0';
            i += 1;
        }
    }
    if digits == 0 || (nonnegative && bytes[0] == b'-' && nonzero) {
        return Err(invalid("surface decimal sign or mantissa"));
    }
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        let exponent = &value[i + 1..];
        let body = exponent
            .strip_prefix('+')
            .or_else(|| exponent.strip_prefix('-'))
            .unwrap_or(exponent);
        if body.is_empty()
            || !body.bytes().all(|b| b.is_ascii_digit())
            || exponent.parse::<i32>().is_err()
        {
            return Err(invalid("surface decimal exponent"));
        }
        i = bytes.len();
    }
    if i != bytes.len() {
        return Err(invalid("surface decimal trailing bytes"));
    }
    Ok(nonzero)
}
// Compare finite nonnegative decimal values without binary64 underflow or rounding.
fn decimal_le(left: &str, right: &str) -> Result<bool, RunError> {
    fn parts(value: &str) -> Result<(Vec<u8>, i64), RunError> {
        decimal(value, true)?;
        let unsigned = value
            .strip_prefix('+')
            .or_else(|| value.strip_prefix('-'))
            .unwrap_or(value);
        let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
        let exponent = i64::from(
            exponent
                .parse::<i32>()
                .map_err(|_| invalid("surface decimal exponent"))?,
        );
        let fractional = mantissa.split_once('.').map_or(0, |(_, tail)| tail.len());
        let digits: Vec<u8> = mantissa
            .bytes()
            .filter(|b| *b != b'.')
            .skip_while(|b| *b == b'0')
            .collect();
        let magnitude = i64::try_from(digits.len())
            .ok()
            .and_then(|length| length.checked_add(exponent))
            .and_then(|length| length.checked_sub(fractional as i64))
            .ok_or_else(|| invalid("surface decimal magnitude overflow"))?;
        Ok((digits, magnitude))
    }
    let (left, le) = parts(left)?;
    let (right, re) = parts(right)?;
    if left.is_empty() || right.is_empty() {
        return Ok(left.is_empty());
    }
    if le != re {
        return Ok(le < re);
    }
    for i in 0..left.len().max(right.len()) {
        let l = left.get(i).copied().unwrap_or(b'0');
        let r = right.get(i).copied().unwrap_or(b'0');
        if l != r {
            return Ok(l < r);
        }
    }
    Ok(true)
}
fn outward_up(value: f64) -> f64 {
    if value == f64::INFINITY {
        value
    } else {
        f64::from_bits(value.to_bits() + 1)
    }
}
// The retained 120-digit field rounds to raw H. Its component magnitudes are
// bounded by the next larger binary64 value. L1 then bounds its L2 norm.
// This interval detects inconsistent budgets; it does not recompute the
// high-precision norm or certify an integration error.
fn budget_bound(row: &SurfaceRt0Target, t: &SurfaceRt0Tolerances) -> Result<(), RunError> {
    let lower = f64::from_bits(t.absolute_field_apm.to_bits() - 1);
    let mut upper = outward_up(t.absolute_field_apm);
    for component in row.h_xyz_apm {
        // Scale a half-component first, so a maximum finite raw component
        // does not create an infinite bound before a small relative tolerance.
        let half = outward_up(component.abs() / 2.0);
        let term = outward_up(outward_up(t.relative_field * half) * 2.0);
        upper = outward_up(upper + term);
    }
    if !decimal_le(&lower.to_string(), &row.precision_budget_apm)?
        || (upper.is_finite() && !decimal_le(&row.precision_budget_apm, &upper.to_string())?)
    {
        return Err(invalid(
            "surface field budget outside raw-H rounding interval",
        ));
    }
    Ok(())
}
fn positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}
fn bounded_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_DECIMAL_BYTES && !value.contains('\0')
}
fn precision(value: &SurfaceRt0Precision, required: bool) -> Result<(), RunError> {
    let numbers = value.h_xyz_apm.iter().chain(&value.whole_h_xyz_apm);
    if !value.evaluated {
        if required
            || !bounded_text(&value.refusal_reason)
            || numbers.clone().any(|s| !s.is_empty())
            || [
                &value.sum_local_norm_apm,
                &value.cancellation,
                &value.maximum_face_cancellation,
            ]
            .iter()
            .any(|s| !s.is_empty())
        {
            return Err(invalid("surface refused precision record"));
        }
    } else {
        if !value.refusal_reason.is_empty() {
            return Err(invalid("surface evaluated precision refusal"));
        }
        for number in numbers {
            decimal(number, false)?;
        }
        for number in [
            &value.sum_local_norm_apm,
            &value.cancellation,
            &value.maximum_face_cancellation,
        ] {
            decimal(number, true)?;
        }
    }
    Ok(())
}
impl SurfaceRt0Snapshot {
    pub(crate) fn from_native_json(bytes: &[u8]) -> Result<Self, RunError> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES - HEADER {
            return Err(invalid("surface snapshot byte bound"));
        }
        let crate::artifact_json::UnambiguousJson(value) = serde_json::from_slice(bytes)
            .map_err(|_| invalid("surface ambiguous or invalid JSON"))?;
        let snapshot: Self =
            serde_json::from_value(value).map_err(|_| invalid("surface snapshot shape"))?;
        snapshot.validate()?;
        Ok(snapshot)
    }
    pub(crate) fn policy_binding(&self) -> serde_json::Value {
        serde_json::json!({"policy_version": self.policy_version, "limits": self.limits, "tolerances": self.tolerances})
    }
    pub(crate) fn validate(&self) -> Result<(), RunError> {
        let n = self.targets.len();
        let limits = &self.limits;
        let report = &self.work_report;
        let t = &self.tolerances;
        if self.schema_version != SNAPSHOT_SCHEMA
            || !matches!(self.operator_version.as_str(), OPERATOR_VERSION | LEGACY_OPERATOR_VERSION)
            || self.basis_version != BASIS_VERSION
            || !self.inspection_only
            || self.error_certificate_available
            || self.policy_version.is_empty()
            || self.policy_version.len() > 95
            || self.policy_version.contains('\0')
            || !is_digest(&self.source_view_identity_digest)
            || !is_digest(&self.accepted_source_state_digest)
            || n == 0
            || n > MAX_TARGETS
            || self.targets_xyz_m.len() != n
            || self.targets_xyz_m.iter().flatten().any(|v| !v.is_finite())
            || limits.total.contains(&0)
            || limits.per_target.contains(&0)
            || [
                limits.maximum_raw_integer_bits,
                limits.maximum_reduced_fraction_bits,
                limits.maximum_lifetime_peak_rss_bytes,
                limits.guard_interval_events,
            ]
            .contains(&0)
            || !positive(limits.maximum_total_seconds)
            || !positive(limits.maximum_target_seconds)
            || [
                t.absolute_field_apm,
                t.relative_field,
                t.cancellation_floor_apm,
                t.scalar_relative_80,
                t.scalar_relative_120,
                t.angle_relative_80,
                t.angle_relative_120,
                t.binary_scalar_epsilon_factor,
                t.binary_roundoff_epsilon_factor,
                t.binary_cancellation_limit,
                t.highprecision_cancellation_limit,
            ]
            .into_iter()
            .any(|v| !positive(v))
        {
            return Err(invalid(
                "surface versions, identity, options or target bounds",
            ));
        }
        if report.current_target_index != (n - 1) as u64
            || report.current_target != self.targets[n - 1].work
            || report.maximum_raw_integer_bits == 0
            || report.maximum_raw_integer_bits > limits.maximum_raw_integer_bits
            || report.maximum_reduced_fraction_bits == 0
            || report.maximum_reduced_fraction_bits > limits.maximum_reduced_fraction_bits
            || report.last_sampled_lifetime_peak_rss_bytes == 0
            || report.last_sampled_lifetime_peak_rss_bytes > limits.maximum_lifetime_peak_rss_bytes
            || !report.elapsed_seconds.is_finite()
            || report.elapsed_seconds < 0.0
            || report.elapsed_seconds > limits.maximum_total_seconds
            || report.total[0] == 0
            || report.total[0] % n as u64 != 0
        {
            return Err(invalid("surface final work report"));
        }
        let source_count = report.total[0] / n as u64;
        let mut target_sum = [0u64; 14];
        for row in &self.targets {
            if row.h_xyz_apm.iter().any(|v| !v.is_finite())
                || row.work[0] != source_count
                || (!row.precisions[0].evaluated && !row.binary64_requires_highprecision)
            {
                return Err(invalid("surface target H, source count or precision flag"));
            }
            for (index, pass) in row.precisions.iter().enumerate() {
                precision(pass, index != 0)?;
            }
            if !decimal(&row.precision_budget_apm, true)? {
                return Err(invalid("surface zero field budget"));
            }
            for value in [
                &row.local_precision_delta_apm,
                &row.local_formula_delta_apm,
                &row.local_formula_delta_80_apm,
            ] {
                if !decimal_le(value, &row.precision_budget_apm)? {
                    return Err(invalid("surface retained local agreement exceeds budget"));
                }
            }
            budget_bound(row, t)?;
            for k in 0..3 {
                let retained = row.precisions[2].h_xyz_apm[k]
                    .parse::<f64>()
                    .map_err(|_| invalid("surface 120-digit H rounding"))?;
                if !retained.is_finite() || retained.to_bits() != row.h_xyz_apm[k].to_bits() {
                    return Err(invalid("surface 120-digit H differs from raw H"));
                }
            }
            for (index, factor) in [(1, 8), (2, 8), (3, 24)] {
                let minimum = source_count
                    .checked_mul(factor)
                    .ok_or_else(|| invalid("surface minimum work overflow"))?;
                if row.work[index] < minimum {
                    return Err(invalid("surface mandatory target work missing"));
                }
            }
            if row.precisions[0].evaluated {
                decimal(&row.binary64_roundoff_indicator_apm, true)?;
            } else if !row.binary64_roundoff_indicator_apm.is_empty() {
                return Err(invalid("surface refused binary roundoff"));
            }
            for i in 0..14 {
                if row.work[i] > limits.per_target[i] {
                    return Err(invalid("surface per-target work limit"));
                }
                target_sum[i] = target_sum[i]
                    .checked_add(row.work[i])
                    .ok_or_else(|| invalid("surface target work overflow"))?;
            }
        }
        for i in 0..14 {
            let precision_sum = report
                .by_precision
                .iter()
                .try_fold(0u64, |sum, row| sum.checked_add(row[i]))
                .ok_or_else(|| invalid("surface precision work overflow"))?;
            if report.total[i] > limits.total[i]
                || target_sum[i] > report.total[i]
                || precision_sum > report.total[i]
            {
                return Err(invalid("surface aggregate work conservation or limit"));
            }
        }
        for pass in &report.by_precision[1..] {
            for (index, factor) in [(1, 4), (2, 4), (3, 12)] {
                let minimum = report.total[0]
                    .checked_mul(factor)
                    .ok_or_else(|| invalid("surface minimum precision work overflow"))?;
                if pass[index] < minimum {
                    return Err(invalid("surface mandatory 80/120-digit work missing"));
                }
            }
        }
        if target_sum[0] != report.total[0] {
            return Err(invalid("surface pair conservation"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SurfaceRt0EvidenceV1 {
    pub snapshot: SurfaceRt0Snapshot,
    pub signed_normalization_a: f64,
    pub source_absolute_flux_a: f64,
    pub scale_per_a: f64,
    pub current_balance_certificate_digest: String,
    pub ordered_target_digest: String,
}
fn ordered_target_digest(positions: &[[f64; 3]]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"antenna_rt0_surface_ordered_targets.v1");
    hash.update((positions.len() as u64).to_le_bytes());
    for value in positions.iter().flatten() {
        hash.update(value.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
impl SurfaceRt0EvidenceV1 {
    pub(crate) fn new(
        snapshot: SurfaceRt0Snapshot,
        signed_normalization_a: f64,
        source_absolute_flux_a: f64,
        current_balance_certificate_digest: String,
    ) -> Result<Self, RunError> {
        let result = Self {
            ordered_target_digest: ordered_target_digest(&snapshot.targets_xyz_m),
            snapshot,
            signed_normalization_a,
            source_absolute_flux_a,
            scale_per_a: normalization_scale(signed_normalization_a, source_absolute_flux_a)?,
            current_balance_certificate_digest,
        };
        result.validate()?;
        Ok(result)
    }
    pub(crate) fn validate(&self) -> Result<(), RunError> {
        self.snapshot.validate()?;
        if normalization_scale(self.signed_normalization_a, self.source_absolute_flux_a)?.to_bits()
            != self.scale_per_a.to_bits()
            || !is_digest(&self.current_balance_certificate_digest)
            || !is_digest(&self.ordered_target_digest)
            || self.ordered_target_digest != ordered_target_digest(&self.snapshot.targets_xyz_m)
        {
            return Err(invalid(
                "surface evidence normalization, certificate or ordered targets",
            ));
        }
        Ok(())
    }
    pub(crate) fn verify_policy_binding(
        &self,
        expected: &serde_json::Value,
    ) -> Result<(), RunError> {
        self.validate()?;
        if &self.snapshot.policy_binding() != expected {
            return Err(invalid("surface evidence differs from owned policy"));
        }
        Ok(())
    }
    pub(crate) fn verify_source_binding(
        &self,
        view_digest: &str,
        accepted_digest: &str,
    ) -> Result<(), RunError> {
        self.validate()?;
        if self.snapshot.source_view_identity_digest != view_digest
            || self.snapshot.accepted_source_state_digest != accepted_digest
        {
            return Err(invalid("surface evidence accepted source binding"));
        }
        Ok(())
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
            || ordered_target_digest(positions) != self.ordered_target_digest
        {
            return Err(invalid("surface target carrier binding"));
        }
        for (((position, expected), row), (raw_h, per_h)) in positions
            .iter()
            .zip(&self.snapshot.targets_xyz_m)
            .zip(&self.snapshot.targets)
            .zip(raw.iter().zip(per_a))
        {
            for k in 0..3 {
                let scaled = row.h_xyz_apm[k] * self.scale_per_a;
                if position[k].to_bits() != expected[k].to_bits()
                    || row.h_xyz_apm[k].to_bits() != raw_h[k].to_bits()
                    || !scaled.is_finite()
                    || scaled.to_bits() != per_h[k].to_bits()
                {
                    return Err(invalid("surface raw H or per-A bit binding"));
                }
            }
        }
        Ok(())
    }
    pub(crate) fn encode(&self) -> Result<Vec<u8>, RunError> {
        self.validate()?;
        let json =
            serde_json::to_vec(&self.snapshot).map_err(|_| invalid("surface snapshot encoding"))?;
        let length = HEADER
            .checked_add(json.len())
            .filter(|n| *n <= MAX_BYTES)
            .ok_or_else(|| invalid("surface evidence byte bound"))?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| invalid("surface evidence allocation"))?;
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
        for value in [
            self.signed_normalization_a,
            self.source_absolute_flux_a,
            self.scale_per_a,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(self.current_balance_certificate_digest.as_bytes());
        bytes.extend_from_slice(self.ordered_target_digest.as_bytes());
        bytes.extend_from_slice(&json);
        Ok(bytes)
    }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, RunError> {
        if bytes.len() <= HEADER || bytes.len() > MAX_BYTES || &bytes[..16] != MAGIC {
            return Err(invalid("surface evidence header or bound"));
        }
        let length = usize::try_from(u64::from_le_bytes(bytes[16..24].try_into().unwrap()))
            .map_err(|_| invalid("surface JSON length overflow"))?;
        if HEADER.checked_add(length) != Some(bytes.len()) {
            return Err(invalid("surface exact evidence length"));
        }
        let number = |offset| f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        let digest = |a, b| {
            std::str::from_utf8(&bytes[a..b])
                .map(str::to_owned)
                .map_err(|_| invalid("surface digest encoding"))
        };
        let result = Self {
            snapshot: SurfaceRt0Snapshot::from_native_json(&bytes[HEADER..])?,
            signed_normalization_a: number(24),
            source_absolute_flux_a: number(32),
            scale_per_a: number(40),
            current_balance_certificate_digest: digest(48, 112)?,
            ordered_target_digest: digest(112, 176)?,
        };
        result.validate()?;
        if result.encode()? != bytes {
            return Err(invalid("noncanonical surface evidence encoding"));
        }
        Ok(result)
    }
}

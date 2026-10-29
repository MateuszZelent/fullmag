//! Caller-owned buffers and policy binding for prepared RT0 surface inspection.
use super::{NativeFemOerstedField, PreparedClosedLoopAcceptedSnapshot};
use crate::antenna_field_solution::surface_rt0_evidence_v1::{SurfaceRt0Snapshot, OPERATOR_VERSION};
use crate::types::RunError;
use fullmag_fem_sys as ffi;
use fullmag_ir::AntennaSurfaceFieldPolicyIR;
use std::ffi::CString;

fn bad(message: &str) -> RunError { RunError { message: format!("prepared RT0 surface refused: {message}") } }
pub(super) struct SurfaceSnapshotBuffer {
    pub header: ffi::fullmag_fem_prepared_closed_loop_rt0_surface_result_v1,
    h: Vec<f64>, evidence: Vec<u8>, policy: AntennaSurfaceFieldPolicyIR,
    policy_version: CString,
}
impl SurfaceSnapshotBuffer {
    pub fn new(policy: &AntennaSurfaceFieldPolicyIR, targets: usize,
        rt0: ffi::fullmag_fem_steady_transport_rt0_result_v1) -> Result<Self, RunError> {
        if !policy.validation_errors("surface_field_policy").is_empty() || targets == 0 {
            return Err(bad("invalid explicit policy or empty targets"));
        }
        let count = targets.checked_mul(3).ok_or_else(|| bad("target count overflow"))?;
        let bytes = usize::try_from(policy.limits.total[9]).map_err(|_| bad("evidence capacity overflow"))?;
        if bytes == 0 || bytes > 512 * 1024 * 1024 - 176 { return Err(bad("evidence capacity exceeds bundle bound")); }
        let mut h = Vec::new(); h.try_reserve_exact(count).map_err(|_| bad("H allocation failed"))?; h.resize(count, f64::NAN);
        let mut evidence = Vec::new(); evidence.try_reserve_exact(bytes).map_err(|_| bad("evidence allocation failed"))?; evidence.resize(bytes, 0);
        let policy_version = CString::new(policy.policy_version.as_str()).map_err(|_| bad("policy contains NUL"))?;
        let header = ffi::fullmag_fem_prepared_closed_loop_rt0_surface_result_v1 {
            abi_version: 1, reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_prepared_closed_loop_rt0_surface_result_v1>() as u64,
            rt0, h_xyz_apm: h.as_mut_ptr(), h_xyz_apm_capacity: count as u64, h_xyz_apm_len: 0,
            evidence_json: evidence.as_mut_ptr(), evidence_json_capacity: bytes as u64, evidence_json_len: 0,
            error_message: [0; 256],
        };
        Ok(Self { header, h, evidence, policy: policy.clone(), policy_version })
    }
    pub fn options(&self) -> ffi::fullmag_fem_surface_rt0_options_v1 {
        let l = &self.policy.limits; let t = &self.policy.tolerances;
        ffi::fullmag_fem_surface_rt0_options_v1 {
            work_limits: ffi::fullmag_fem_surface_rt0_work_limits_v1 {
                total: l.total, per_target: l.per_target,
                maximum_raw_integer_bits: l.maximum_raw_integer_bits,
                maximum_reduced_fraction_bits: l.maximum_reduced_fraction_bits,
                maximum_lifetime_peak_rss_bytes: l.maximum_lifetime_peak_rss_bytes,
                guard_interval_events: l.guard_interval_events,
                maximum_total_seconds: l.maximum_total_seconds, maximum_target_seconds: l.maximum_target_seconds,
            },
            tolerances: ffi::fullmag_fem_surface_rt0_tolerances_v1 {
                absolute_field_apm:t.absolute_field_apm, relative_field:t.relative_field,
                cancellation_floor_apm:t.cancellation_floor_apm, scalar_relative_80:t.scalar_relative_80,
                scalar_relative_120:t.scalar_relative_120, angle_relative_80:t.angle_relative_80,
                angle_relative_120:t.angle_relative_120, binary_scalar_epsilon_factor:t.binary_scalar_epsilon_factor,
                binary_roundoff_epsilon_factor:t.binary_roundoff_epsilon_factor,
                binary_cancellation_limit:t.binary_cancellation_limit,
                highprecision_cancellation_limit:t.highprecision_cancellation_limit,
            }, policy_version:self.policy_version.as_ptr(),
        }
    }
    pub fn finish(self, points: &[[f64;3]], source: &PreparedClosedLoopAcceptedSnapshot,
        view_digest: &str) -> Result<(NativeFemOerstedField, SurfaceRt0Snapshot), RunError> {
        let h = &self.header;
        if h.abi_version != 1 || h.reserved_flags != 0
            || h.struct_size != std::mem::size_of_val(h) as u64
            || h.h_xyz_apm != self.h.as_ptr().cast_mut() || h.h_xyz_apm_capacity != self.h.len() as u64
            || h.h_xyz_apm_len != self.h.len() as u64 || self.h.iter().any(|v| !v.is_finite())
            || h.evidence_json != self.evidence.as_ptr().cast_mut()
            || h.evidence_json_capacity != self.evidence.len() as u64
            || h.evidence_json_len == 0 || h.evidence_json_len > self.evidence.len() as u64 {
            return Err(bad("native output header or buffer"));
        }
        let snapshot = SurfaceRt0Snapshot::from_native_json(&self.evidence[..h.evidence_json_len as usize])?;
        let expected_policy = serde_json::to_value(&self.policy).map_err(|_| bad("policy encoding"))?;
        if snapshot.operator_version != OPERATOR_VERSION
            || snapshot.policy_binding() != expected_policy
            || snapshot.source_view_identity_digest != view_digest
            || snapshot.accepted_source_state_digest != source.accepted_source_state_digest
            || snapshot.targets_xyz_m.len() != points.len()
            || !snapshot.targets_xyz_m.iter().flatten().zip(points.iter().flatten()).all(|(a,b)|a.to_bits()==b.to_bits())
            || !snapshot.targets.iter().flat_map(|t|t.h_xyz_apm).zip(&self.h).all(|(a,b)|a.to_bits()==b.to_bits()) {
            return Err(bad("policy, accepted source, ordered targets or raw H binding"));
        }
        let source_count = source.source.cells.len() as u64;
        let expected_pairs = source_count.checked_mul(points.len() as u64).ok_or_else(|| bad("pair count overflow"))?;
        if source_count == 0 || snapshot.work_report.total[0] != expected_pairs
            || snapshot.targets.iter().any(|target| target.work[0] != source_count) {
            return Err(bad("accepted source pair counts"));
        }
        let diagnostics = serde_json::json!({
            "schema_version": snapshot.schema_version,
            "operator_version": snapshot.operator_version,
            "status": "inspection_only",
            "source_target_pairs": expected_pairs,
            "target_count": points.len(),
            "elapsed_seconds": snapshot.work_report.elapsed_seconds,
            "last_sampled_lifetime_peak_rss_bytes": snapshot.work_report.last_sampled_lifetime_peak_rss_bytes,
            "inspection_only": true,
            "error_certificate_available": false,
        });
        let field = NativeFemOerstedField {
            field:self.h, operator_version:snapshot.operator_version.clone(),
            source_view_identity_digest:snapshot.source_view_identity_digest.clone(),
            source_target_pairs:Some(snapshot.work_report.total[0]), refined_pairs:None,
            unconverged_pair_count:None, maximum_pair_error_apm:None,
            diagnostics, quadrature_snapshot:None,
        };
        Ok((field,snapshot))
    }
}

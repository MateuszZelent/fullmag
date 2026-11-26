//! Surface evaluation of the shared canonical retained RT0 freeze.
use crate::antenna_field_solution::closed_loop_v2::ClosedLoopAcceptedSourceInputV2;
use crate::types::RunError;
use fullmag_fem_sys as ffi;
pub(super) use super::retained_rt0_source::freeze_verified_source;
use super::retained_rt0_source::bad;


/// Evaluate only H from the already authenticated retained v2 source.
/// The accepted preparation owner must verify the parent before this call.
pub(crate) fn evaluate_retained_rt0_surface(
    source: &ClosedLoopAcceptedSourceInputV2,
    points: &[[f64; 3]],
    policy: &fullmag_ir::AntennaSurfaceFieldPolicyIR,
    surface_profile: Option<&mut super::NativeFemSurfaceRt0Profile>,
    observer: Option<&crate::AntennaOperationProgressObserver<'_>>,
) -> Result<crate::antenna_field_solution::surface_rt0_evidence_v1::SurfaceRt0Snapshot, RunError> {
    if !policy.validation_errors("surface_field_policy").is_empty()
        || points.is_empty() || points.len() > 1_000_000
        || points.iter().flatten().any(|value| !value.is_finite()) {
        return Err(bad("invalid policy or ordered targets"));
    }
    let source_count = u64::try_from(source.cells.len()).map_err(|_| bad("source count overflow"))?;
    let pairs = source_count.checked_mul(points.len() as u64).ok_or_else(|| bad("pair count overflow"))?;
    if source_count == 0 || source_count > policy.limits.per_target[0] || pairs > policy.limits.total[0] {
        return Err(bad("source/target pairs exceed the explicit policy"));
    }
    // Match native mandatory lower bounds before any source/output allocation.
    for (index, multiplier) in [1u64, 12, 12, 36].into_iter().enumerate() {
        let per_target = source_count.checked_mul(multiplier).ok_or_else(|| bad("mandatory work overflow"))?;
        let total = per_target.checked_mul(points.len() as u64).ok_or_else(|| bad("total mandatory work overflow"))?;
        if per_target > policy.limits.per_target[index] || total > policy.limits.total[index] {
            return Err(bad("mandatory precision/formula work exceeds the explicit policy"));
        }
    }
    let frozen_bytes = source_count.checked_mul(std::mem::size_of::<ffi::fullmag_fem_frozen_rt0_element_v1>() as u64)
        .ok_or_else(|| bad("frozen source byte count overflow"))?;
    let target_bytes = (points.len() as u64).checked_mul(24).ok_or_else(|| bad("ordered target byte count overflow"))?;
    let copied = frozen_bytes.checked_add(target_bytes).ok_or_else(|| bad("copied input byte count overflow"))?;
    if copied > policy.limits.total[8] || target_bytes > policy.limits.total[9] {
        return Err(bad("mandatory copy/output bytes exceed the explicit policy"));
    }
    let capacity = usize::try_from(policy.limits.total[9]).map_err(|_| bad("evidence capacity overflow"))?;
    if capacity == 0 || capacity > 512 * 1024 * 1024 - 176 { return Err(bad("evidence capacity exceeds bundle bound")); }
    let view_digest = source.metadata.view_identity_digest.as_str();
    let accepted_source_digest = source.metadata.accepted_source_state_digest.as_str();
    let digest = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !digest(view_digest) || !digest(accepted_source_digest) {
        return Err(bad("noncanonical retained source digest"));
    }
    let view = std::ffi::CString::new(view_digest).map_err(|_| bad("source view contains NUL"))?;
    let accepted = std::ffi::CString::new(accepted_source_digest).map_err(|_| bad("accepted source contains NUL"))?;
    let policy_version = std::ffi::CString::new(policy.policy_version.as_str()).map_err(|_| bad("policy contains NUL"))?;
    let frozen = freeze_verified_source(source)?;
    let count = points.len().checked_mul(3).ok_or_else(|| bad("XYZ count overflow"))?;
    let mut flat = Vec::new(); flat.try_reserve_exact(count).map_err(|_| bad("XYZ allocation failed"))?;
    flat.extend(points.iter().flatten().copied());
    let mut h = Vec::new(); h.try_reserve_exact(count).map_err(|_| bad("H allocation failed"))?;
    h.resize(count, f64::NAN);
    let mut evidence = Vec::new(); evidence.try_reserve_exact(capacity).map_err(|_| bad("evidence allocation failed"))?;
    evidence.resize(capacity, 0);
    let request = ffi::fullmag_fem_frozen_rt0_surface_request_v1 {
        abi_version: ffi::FULLMAG_FEM_FROZEN_RT0_SURFACE_ABI_VERSION, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_frozen_rt0_surface_request_v1>() as u64,
        execution_lane: ffi::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
        reserved: 0, source: frozen.as_ptr(), source_count,
        target_points_xyz: flat.as_ptr(), target_points_xyz_len: count as u64,
        source_view_identity_digest: view.as_ptr(), accepted_source_state_digest: accepted.as_ptr(),
        options: super::surface_rt0::policy_options(policy, &policy_version),
    };
    let mut result = ffi::fullmag_fem_frozen_rt0_surface_result_v1 {
        abi_version: ffi::FULLMAG_FEM_FROZEN_RT0_SURFACE_ABI_VERSION, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_frozen_rt0_surface_result_v1>() as u64,
        h_xyz_apm: h.as_mut_ptr(), h_xyz_apm_capacity: count as u64, h_xyz_apm_len: 0,
        evidence_json: evidence.as_mut_ptr(), evidence_json_capacity: capacity as u64, evidence_json_len: 0,
        error_message: [0; 256],
    };
    let native_observer = observer.map(|_| ffi::fullmag_fem_antenna_operation_observer_v1 {
        abi_version: 1, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_antenna_operation_observer_v1>() as u64,
        callback: Some(super::antenna_operation_progress_callback),
        user_data: (&observer as *const Option<&crate::AntennaOperationProgressObserver<'_>>).cast_mut().cast(),
    });
    let mut native_profile = surface_profile.as_ref().map(|_| ffi::fullmag_fem_surface_rt0_profile_result_v1 {
        abi_version: ffi::FULLMAG_FEM_SURFACE_RT0_PROFILE_ABI_VERSION, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_surface_rt0_profile_result_v1>() as u64,
        ..Default::default()
    });
    let started = surface_profile.as_ref().map(|_| std::time::Instant::now());
    // Every pointer remains owned by this stack frame for the synchronous call.
    let status = unsafe { ffi::fullmag_fem_evaluate_frozen_rt0_surface_observed_v1(
        &request, &mut result,
        native_profile.as_mut().map_or(std::ptr::null_mut(), |value| value as *mut _),
        native_observer.as_ref().map_or(std::ptr::null(), |value| value as *const _)) };
    if let Some(profile) = surface_profile {
        profile.native_call_wall_ns = started.map(|start| start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64);
        let native = native_profile.as_ref().ok_or_else(|| bad("requested profile is absent"))?;
        if native.abi_version != ffi::FULLMAG_FEM_SURFACE_RT0_PROFILE_ABI_VERSION
            || native.reserved_flags != 0 || native.struct_size != std::mem::size_of_val(native) as u64
            || native.available > 1 || native.accounting_issue > 1 {
            return Err(bad("native profile ABI mismatch"));
        }
        profile.available = native.available == 1;
        profile.accounting_issue = native.accounting_issue == 1;
        profile.operator_wall_time_ns = native.operator_wall_time_ns;
        profile.phase_wall_time_ns = native.phase_wall_time_ns;
    }
    if status != ffi::FULLMAG_FEM_OK {
        let message = result.error_message.iter().map(|b| *b as u8).take_while(|b| *b != 0).collect::<Vec<_>>();
        return Err(bad(&format!("native status {status}: {}", String::from_utf8_lossy(&message))));
    }
    if result.abi_version != ffi::FULLMAG_FEM_FROZEN_RT0_SURFACE_ABI_VERSION
        || result.reserved_flags != 0 || result.struct_size != std::mem::size_of_val(&result) as u64
        || result.h_xyz_apm != h.as_mut_ptr() || result.h_xyz_apm_capacity != count as u64
        || result.h_xyz_apm_len != count as u64 || h.iter().any(|v| !v.is_finite())
        || result.evidence_json != evidence.as_mut_ptr() || result.evidence_json_capacity != capacity as u64
        || result.evidence_json_len == 0 || result.evidence_json_len > capacity as u64 {
        return Err(bad("native output header or buffer"));
    }
    super::surface_rt0::finish_surface_output(h, &evidence[..result.evidence_json_len as usize],
        points, source_count, policy, view_digest, accepted_source_digest).map(|(_, snapshot)| snapshot)
}

#pragma once

#include "frequency_domain/modal_eigen_result.hpp"
#include "fullmag_fem.h"
#include "gpu/cuda/runtime/cuda_activity_trace.hpp"

#include <algorithm>

namespace fullmag::fem::frequency_domain {

// Returns a reason when the modal execution cannot publish a measured
// cuDSS augmented modal result. The PETSc path has its own qualification.
inline const char *augmented_robin_attestation_failure(
    const ModalGpuExecutionAttestation &observed) noexcept
{
    if (observed.operator_kind != FULLMAG_FEM_MODAL_OPERATOR_AUGMENTED_ROBIN_CUDSS_CUDA &&
        observed.operator_kind != FULLMAG_FEM_MODAL_OPERATOR_AUGMENTED_FLOQUET_CUDSS_CUDA) {
        return "augmented_robin_operator_kind_mismatch";
    }
    if (!observed.device_residency_verified || !observed.production_shared_domain ||
        observed.validation_only || observed.operator_dimension == 0 ||
        observed.compute_capability_major == 0 || observed.device_name.empty() ||
        observed.cuda_driver_version == 0 || observed.cuda_runtime_version == 0 ||
        observed.mfem_version.empty()) {
        return "augmented_robin_execution_identity_incomplete";
    }
    if (!observed.native_scope_completed || !observed.native_scope_gpu_context_acquired ||
        !observed.native_scope_operator_identity_consistent || !observed.native_scope_resources_released ||
        observed.native_scope_subsolve_count == 0 || observed.operator_state_generation == 0 ||
        observed.target_state_generation == 0) {
        return "augmented_robin_execution_scope_incomplete";
    }
    constexpr auto coverage =
        FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP | FULLMAG_FEM_MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP |
        FULLMAG_FEM_MODAL_GPU_COVERAGE_OBJECT_GRAPH | FULLMAG_FEM_MODAL_GPU_COVERAGE_SCALAR_TELEMETRY |
        FULLMAG_FEM_MODAL_GPU_COVERAGE_EXPORT;
    if ((observed.measurement_coverage_flags & coverage) != coverage ||
        !observed.native_trace_complete || observed.native_trace_kernel_records == 0 ||
        (observed.native_trace_counter_coverage & cuda_trace::modal_eps_counter_coverage_scalar_telemetry_d2h) == 0 ||
        observed.native_trace_start_ns == 0 || observed.native_trace_start_ns >= observed.native_trace_end_ns ||
        observed.setup_h2d_count == 0 || observed.setup_h2d_bytes == 0 ||
        observed.export_d2h_count == 0 || observed.export_d2h_bytes == 0) {
        return "augmented_robin_execution_measurement_incomplete";
    }
    if (observed.native_trace_h2d_count != 0 || observed.native_trace_h2d_bytes != 0 ||
        observed.native_trace_d2h_count != 0 || observed.native_trace_d2h_bytes != 0 ||
        observed.native_trace_allocation_count != 0 || observed.native_trace_release_count != 0 ||
        observed.native_trace_allocation_bytes != 0 || observed.native_trace_release_bytes != 0 ||
        observed.native_trace_host_sync_count != 0 || observed.native_trace_host_sync_duration_ns != 0 ||
        observed.hot_loop_full_vector_crossings != 0 || observed.hot_loop_allocations != 0 ||
        observed.hot_loop_computational_h2d_count != 0 || observed.hot_loop_computational_h2d_bytes != 0 ||
        observed.hot_loop_computational_d2h_count != 0 || observed.hot_loop_computational_d2h_bytes != 0 ||
        observed.hot_loop_computational_host_syncs != 0 ||
        observed.hot_loop_scalar_telemetry_d2h_count != 0 || observed.hot_loop_scalar_telemetry_d2h_bytes != 0 ||
        observed.hot_loop_scalar_telemetry_syncs != 0) {
        return "augmented_robin_iteration_host_activity_or_allocation";
    }
    if (observed.device_memory_peak_bytes == 0 ||
        observed.device_memory_peak_bytes < observed.device_memory_baseline_bytes ||
        observed.device_memory_peak_bytes < observed.device_memory_final_bytes) {
        return "augmented_robin_memory_measurement_incomplete";
    }
    const auto missing = [](const auto &bytes) {
        return std::none_of(bytes.begin(), bytes.end(), [](std::uint8_t byte) { return byte != 0; });
    };
    if (missing(observed.device_uuid)) {
        return "augmented_robin_device_uuid_missing";
    }
    const std::array<std::uint8_t, 32> *const digests[] = {
        &observed.object_graph_sha256, &observed.native_trace_sha256, &observed.source_snapshot_sha256,
        &observed.runtime_manifest_sha256, &observed.mesh_identity_sha256, &observed.equilibrium_sha256,
        &observed.certificate_sha256, &observed.linearization_sha256, &observed.material_sha256,
        &observed.physics_sha256, &observed.boundary_sha256, &observed.gauge_sha256,
        &observed.operator_terms_sha256, &observed.solver_policy_sha256, &observed.operator_key_sha256,
        &observed.target_key_sha256, &observed.session_context_sha256,
    };
    if (std::any_of(std::begin(digests), std::end(digests), [&](const auto *digest) {
            return missing(*digest);
        })) {
        return "augmented_robin_execution_digest_missing";
    }
    return nullptr;
}

} // namespace fullmag::fem::frequency_domain

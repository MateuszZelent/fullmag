#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <array>
#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct ModalEigenTypedResult {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::vector<std::complex<double>> mode_lambda{};
    std::vector<std::complex<double>> mode_q_complex{};
    std::vector<std::complex<double>> mode_phi_complex{};
    std::vector<std::complex<double>> mode_delta_m_xyz_complex{};
    std::vector<double> mode_residuals{};
    std::vector<std::uint64_t> mode_cluster_ids{};
};

enum class ModalResolvedFallbackState : std::uint32_t {
    none = 0,
    explicit_fallback = 1,
};

struct ModalExecutionProvenance {
    std::uint32_t execution_target = 0;
    std::uint32_t scalar_representation = 1;
    std::uint32_t spectral_transform_kind = 0;
    ModalResolvedFallbackState fallback_state = ModalResolvedFallbackState::none;
    std::string engine_id = "unavailable";
    std::string fallback_reason = "none";
};

struct ModalCertificateBindingProvenance {
    std::uint32_t status = 0;
    std::string canonical_preimage_sha256{};
    std::string reason = "none";
};

/*
 * Native execution evidence accumulated by the modal adapter.  This is an
 * internal typed bridge to the caller-sized result v20 sidecar; it is not
 * part of the frozen by-value v18 result layout.  A partial T3 snapshot may
 * attest HYPRE setup while the overall v20 measurement remains unavailable
 * until the complete T4 object graph and digest set have been measured.
 */
struct ModalGpuHostPhaseBoundaries {
    std::uint64_t setup_begin_ns = 0u;
    std::uint64_t eps_begin_ns = 0u;
    std::uint64_t eps_end_ns = 0u;
    std::uint64_t first_export_begin_ns = 0u;
    std::uint64_t last_export_end_ns = 0u;
};

struct ModalGpuExecutionAttestation {
    // Native measurements use the same field semantics as the append-only
    // V20 sidecar, but remain typed C++ state until the public boundary owns
    // and publishes them.
    std::uint32_t measurement_state = 2u; // FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE
    std::uint64_t measurement_coverage_flags = 0u;
    bool device_residency_verified = false;
    bool production_shared_domain = false;
    bool validation_only = false;
    std::uint32_t operator_kind = 0u;
    std::uint32_t hypre_memory_location = 0u;
    std::uint32_t hypre_execution_policy = 0u;
    std::uint32_t compute_capability_major = 0u;
    std::uint32_t compute_capability_minor = 0u;
    std::uint32_t cuda_driver_version = 0u;
    std::uint32_t cuda_runtime_version = 0u;
    std::string device_name{};
    std::string mfem_version{};
    std::string hypre_version{};
    std::string petsc_version{};
    std::string slepc_version{};
    std::string petsc_vec_type{};
    std::string petsc_matrix_type{};
    std::string matshell_vec_type{};
    std::string slepc_bv_type{};
    std::string eps_type{};
    std::string st_type{};
    std::string ksp_type{};
    std::string poisson_pc_type{};
    std::string shift_pc_type{};
    std::string last_invalidation_reason{};
    std::array<std::uint8_t, 16> device_uuid{};
    std::array<std::uint8_t, 32> object_graph_sha256{};
    std::array<std::uint8_t, 32> native_trace_sha256{};
    ModalGpuHostPhaseBoundaries host_phase_boundaries{};
    bool native_trace_complete = false;
    std::uint64_t native_trace_flags = 0u;
    std::uint64_t native_trace_phase_coverage = 0u;
    std::uint64_t native_trace_counter_coverage = 0u;
    std::uint64_t native_trace_start_ns = 0u;
    std::uint64_t native_trace_end_ns = 0u;
    std::uint64_t native_trace_observed_activity_records = 0u;
    std::uint64_t native_trace_kernel_records = 0u;
    std::uint64_t native_trace_kernel_duration_ns = 0u;
    std::uint64_t native_trace_h2d_count = 0u;
    std::uint64_t native_trace_h2d_bytes = 0u;
    std::uint64_t native_trace_d2h_count = 0u;
    std::uint64_t native_trace_d2h_bytes = 0u;
    std::uint64_t native_trace_d2d_count = 0u;
    std::uint64_t native_trace_d2d_bytes = 0u;
    std::uint64_t native_trace_allocation_count = 0u;
    std::uint64_t native_trace_allocation_bytes = 0u;
    std::uint64_t native_trace_release_count = 0u;
    std::uint64_t native_trace_release_bytes = 0u;
    std::uint64_t native_trace_host_sync_count = 0u;
    std::uint64_t native_trace_host_sync_duration_ns = 0u;
    std::string native_trace_unavailable_reason{};
    bool native_scope_completed = false;
    bool native_scope_gpu_context_acquired = false;
    bool native_scope_operator_identity_consistent = false;
    bool native_scope_resources_released = false;
    std::uint64_t native_scope_subsolve_count = 0u;
    std::array<std::uint8_t, 32> source_snapshot_sha256{};
    std::array<std::uint8_t, 32> runtime_manifest_sha256{};
    std::array<std::uint8_t, 32> mesh_identity_sha256{};
    std::array<std::uint8_t, 32> equilibrium_sha256{};
    std::array<std::uint8_t, 32> certificate_sha256{};
    std::array<std::uint8_t, 32> linearization_sha256{};
    std::array<std::uint8_t, 32> material_sha256{};
    std::array<std::uint8_t, 32> physics_sha256{};
    std::array<std::uint8_t, 32> boundary_sha256{};
    std::array<std::uint8_t, 32> gauge_sha256{};
    std::array<std::uint8_t, 32> operator_terms_sha256{};
    std::array<std::uint8_t, 32> solver_policy_sha256{};
    std::array<std::uint8_t, 32> operator_key_sha256{};
    std::array<std::uint8_t, 32> target_key_sha256{};
    std::array<std::uint8_t, 32> session_context_sha256{};
    std::uint64_t setup_h2d_count = 0u;
    std::uint64_t setup_h2d_bytes = 0u;
    std::uint64_t hot_loop_computational_h2d_count = 0u;
    std::uint64_t hot_loop_computational_h2d_bytes = 0u;
    std::uint64_t hot_loop_computational_d2h_count = 0u;
    std::uint64_t hot_loop_computational_d2h_bytes = 0u;
    std::uint64_t hot_loop_scalar_telemetry_d2h_count = 0u;
    std::uint64_t hot_loop_scalar_telemetry_d2h_bytes = 0u;
    std::uint64_t hot_loop_full_vector_crossings = 0u;
    std::uint64_t hot_loop_computational_host_syncs = 0u;
    std::uint64_t hot_loop_scalar_telemetry_syncs = 0u;
    std::uint64_t hot_loop_allocations = 0u;
    std::uint64_t export_d2h_count = 0u;
    std::uint64_t export_d2h_bytes = 0u;
    std::uint64_t device_memory_baseline_bytes = 0u;
    std::uint64_t device_memory_peak_bytes = 0u;
    std::uint64_t device_memory_final_bytes = 0u;
    std::uint64_t operator_dimension = 0u;
    std::uint64_t operator_apply_count = 0u;
    std::uint64_t poisson_solve_count = 0u;
    std::uint64_t poisson_iteration_count = 0u;
    std::uint64_t eps_iteration_count = 0u;
    std::uint64_t eps_restart_count = 0u;
    std::int64_t eps_converged_reason = 0;
    std::uint64_t operator_state_generation = 0u;
    std::uint64_t target_state_generation = 0u;
    std::uint64_t operator_reuse_count = 0u;
    std::uint64_t target_rebuild_count = 0u;
    std::uint64_t invalidation_flags = 0u;
    std::string measurement_unavailable_reason{};

    // Exact v6 boundary/gauge identity carried through the native V20 sidecar.
    // This is the prefixed source digest, not a digest of the digest.
    std::string boundary_gauge_digest{};
    bool hypre_policy_observed = false;
    bool hypre_policy_configured = false;
    bool hypre_memory_location_device = false;
    bool hypre_execution_policy_device = false;
    bool hypre_vendor_sptrans_enabled = false;
    bool hypre_vendor_spmv_enabled = false;
    bool hypre_vendor_spgemm_enabled = false;
    int hypre_first_error_code = 0;
    std::string hypre_failure_reason{};
};

struct FrequencyDomainContractResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::string error_message;
    std::string diagnostics_json;
    std::string result_json;
    std::string artifact_manifest_path;
    ModalEigenTypedResult modal_eigen{};
    ModalExecutionProvenance modal_execution{};
    ModalCertificateBindingProvenance certificate_binding{};
    ModalGpuExecutionAttestation modal_gpu_attestation{};
};

} // namespace fullmag::fem::frequency_domain

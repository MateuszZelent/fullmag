#pragma once

#include "fullmag_fem.h"

#include <array>
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/* Internal runner handoff. The digest is accepted only after the managed
 * runtime identity verifier checks the canonical manifest, build receipt and
 * loaded library. Existing v20 callers remain fail-closed through the legacy
 * entrypoint when no digest is available. */
FULLMAG_FEM_API int fullmag_fem_modal_eigen_solve_v20_with_runtime_identity(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV20 *out_result,
    const uint8_t *runtime_manifest_sha256);

/* Internal runner handoff for one explicitly owned native GPU stage. */
FULLMAG_FEM_API int fullmag_fem_modal_eigen_solve_v20_with_runtime_scope(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV20 *out_result,
    const uint8_t *runtime_manifest_sha256,
    const uint8_t *stage_session_sha256);

#ifdef __cplusplus
}
#endif

namespace fullmag::fem::frequency_domain {

struct ModalGpuNativeScopeReportV1 {
    bool scope_completed = false;
    bool gpu_context_acquired = false;
    bool operator_identity_consistent = false;
    bool resources_released = false;
    std::array<std::uint8_t, 32> session_context_sha256{};
    std::array<std::uint8_t, 32> operator_key_sha256{};
    std::array<std::uint8_t, 32> target_key_sha256{};
    std::uint64_t operator_state_generation = 0u;
    std::uint64_t target_state_generation = 0u;
    std::uint64_t operator_reuse_count = 0u;
    std::uint64_t target_rebuild_count = 0u;
    std::uint64_t subsolve_count = 0u;
};

bool begin_modal_gpu_native_scope_v1(
    const std::uint8_t *session_context_sha256,
    std::uint64_t *token) noexcept;
bool finish_modal_gpu_native_scope_v1(
    std::uint64_t token,
    ModalGpuNativeScopeReportV1 *report) noexcept;

} // namespace fullmag::fem::frequency_domain

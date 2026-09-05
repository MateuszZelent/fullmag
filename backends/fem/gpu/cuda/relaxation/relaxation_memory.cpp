/*
 * GPU CUDA relaxation memory source contract.
 *
 * Allocates persistent relaxation algorithm buffers. It does not own RK scratch
 * fields, effective-field kernels, line-search policy, or public C ABI
 * dispatch.
 */

#include "gpu/cuda/relaxation/relaxation_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner_kernels.hpp"

#include <cuda_runtime.h>
#endif

#include <cmath>

#include <utility>

namespace fullmag::fem {

bool gpu_relaxation_state_allocate(
    FemGpuRelaxationDeviceState &relaxation,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    relaxation.node_count = node_count;
    relaxation.state_generation = 0;
    relaxation.nonlinear_cg_direction_valid = false;
    relaxation.next_nonlinear_cg_failure = GpuRelaxNcgFailurePoint::None;
    relaxation.nonlinear_cg_failures_injected = 0;
    relaxation.accepted_evaluation = {};
    gpu_relax_reset_step_diagnostics(relaxation);
    relaxation.direct_energy_refinements = 0;
    relaxation.preconditioner_request = {};
    relaxation.resolved_preconditioner = {};
    relaxation.preconditioner_setup_identity = {};
    relaxation.preconditioner_setup_profile.clear();
    relaxation.preconditioner_setup_weight = 0.0;
    relaxation.preconditioner_setup_complete = false;
    relaxation.preconditioner_setup_hits = 0;
    relaxation.preconditioner_setup_misses = 0;
    relaxation.preconditioner_setup_invalidations = 0;
    relaxation.preconditioner_apply_failures = 0;
    relaxation.preconditioner_mass_diagonal.clear();
    relaxation.preconditioner_exchange_diagonal.clear();
    relaxation.preconditioner_mass_ms.clear();
    relaxation.preconditioner_mass_ms_device = nullptr;
    if (!gpu_device_allocate_component(
            relaxation.projected_gradient_accepted_h_eff,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.preconditioned_gradient,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.previous_preconditioned_gradient,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.nonlinear_cg_direction,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.nonlinear_cg_direction_backup,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.nonlinear_cg_direction_entry_backup,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_double(
            relaxation.preconditioner_mass_ms_device,
            node_count,
            device_bytes,
            error)) {
        gpu_relaxation_state_free(relaxation);
        return false;
    }
    return true;
}

void gpu_relaxation_state_free(FemGpuRelaxationDeviceState &relaxation)
{
    gpu_device_free_component(relaxation.projected_gradient_accepted_h_eff);
    gpu_device_free_component(relaxation.preconditioned_gradient);
    gpu_device_free_component(relaxation.previous_preconditioned_gradient);
    gpu_device_free_component(relaxation.nonlinear_cg_direction);
    gpu_device_free_component(relaxation.nonlinear_cg_direction_backup);
    gpu_device_free_component(relaxation.nonlinear_cg_direction_entry_backup);
    gpu_device_free_double(relaxation.preconditioner_mass_ms_device);
    relaxation.preconditioner.reset();
    relaxation.exchange_mass_cg4.reset();
    relaxation.exchange_mass_cg8.reset();
    relaxation.node_count = 0;
    relaxation.state_generation = 0;
    relaxation.nonlinear_cg_direction_valid = false;
    relaxation.next_nonlinear_cg_failure = GpuRelaxNcgFailurePoint::None;
    relaxation.nonlinear_cg_failures_injected = 0;
    relaxation.accepted_evaluation = {};
    gpu_relax_reset_step_diagnostics(relaxation);
    relaxation.direct_energy_refinements = 0;
    relaxation.preconditioner_request = {};
    relaxation.resolved_preconditioner = {};
    relaxation.preconditioner_setup_identity = {};
    relaxation.preconditioner_setup_profile.clear();
    relaxation.preconditioner_setup_weight = 0.0;
    relaxation.preconditioner_setup_complete = false;
    relaxation.preconditioner_setup_hits = 0;
    relaxation.preconditioner_setup_misses = 0;
    relaxation.preconditioner_setup_invalidations = 0;
    relaxation.preconditioner_apply_failures = 0;
    relaxation.preconditioner_mass_diagonal.clear();
    relaxation.preconditioner_exchange_diagonal.clear();
    relaxation.preconditioner_mass_ms.clear();
    relaxation.preconditioner_mass_ms_device = nullptr;
}

namespace {

const char *normalized_profile_id(
    const GpuRelaxationPreconditionerRequest &profile) noexcept
{
    return profile.requested_kind.empty() ? "none" : profile.requested_kind.c_str();
}

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_status(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}

bool cuda_launch_status(const char *operation, std::string &error)
{
    return cuda_status(cudaPeekAtLastError(), operation, error);
}
#endif

void clear_preconditioner_dispatch(FemGpuRelaxationDeviceState &relaxation)
{
    relaxation.preconditioner.reset();
    relaxation.exchange_mass_cg4.reset();
    relaxation.exchange_mass_cg8.reset();
    relaxation.resolved_preconditioner = {};
    relaxation.preconditioner_setup_identity = {};
    relaxation.preconditioner_setup_profile.clear();
    relaxation.preconditioner_setup_weight = 0.0;
    relaxation.preconditioner_setup_complete = false;
}

bool setup_cache_matches(
    const FemGpuRelaxationDeviceState &relaxation,
    const GpuRelaxationPreconditionerSetupRequest &request,
    const GpuRelaxationPreconditionerDecision &decision)
{
    if (!relaxation.preconditioner_setup_complete ||
        relaxation.resolved_preconditioner.kind != decision.kind ||
        relaxation.resolved_preconditioner.fixed_iterations != decision.fixed_iterations ||
        relaxation.preconditioner_setup_identity != request.identity ||
        relaxation.preconditioner_setup_profile != normalized_profile_id(request.profile)) {
        return false;
    }
    if (decision.kind == GpuRelaxationPreconditionerKind::Diagonal &&
        relaxation.preconditioner_setup_weight != request.exchange_weight) {
        return false;
    }
    return true;
}

} // namespace

bool gpu_relaxation_prepare_preconditioner(
    FemGpuRelaxationDeviceState &relaxation,
    const GpuRelaxationPreconditionerSetupRequest &request,
    std::string &error)
{
    GpuRelaxationPreconditionerDecision decision{};
    if (!resolve_gpu_relaxation_preconditioner(
            request.profile, decision, error)) {
        clear_preconditioner_dispatch(relaxation);
        relaxation.preconditioner_setup_misses += 1u;
        relaxation.preconditioner_apply_failures += 1u;
        return false;
    }
    if (request.node_count == 0u || request.node_count != relaxation.node_count) {
        clear_preconditioner_dispatch(relaxation);
        error = "GPU relaxation preconditioner setup node count does not match persistent state";
        relaxation.preconditioner_setup_misses += 1u;
        return false;
    }
    if (setup_cache_matches(relaxation, request, decision)) {
        relaxation.preconditioner_setup_hits += 1u;
        error.clear();
        return true;
    }

    relaxation.preconditioner_setup_misses += 1u;
    clear_preconditioner_dispatch(relaxation);

#if FULLMAG_HAS_CUDA_RUNTIME
    if (decision.kind == GpuRelaxationPreconditionerKind::Diagonal) {
        if (request.mass_diagonal == nullptr || request.exchange_diagonal == nullptr ||
            request.mass_diagonal->size() != request.node_count ||
            request.exchange_diagonal->size() != request.node_count) {
            error = "GPU diagonal preconditioner setup requires complete host diagonals";
            return false;
        }
        if (!relaxation.preconditioner.setup(
                *request.mass_diagonal,
                *request.exchange_diagonal,
                request.exchange_weight,
                request.stream,
                error)) {
            clear_preconditioner_dispatch(relaxation);
            return false;
        }
    } else if (decision.kind == GpuRelaxationPreconditionerKind::ExchangeMass) {
        if (request.sparse_plan == nullptr || request.d_mass_ms == nullptr ||
            request.d_active_mask == nullptr || relaxation.preconditioner_mass_ms_device == nullptr ||
            request.mass_ms == nullptr || request.mass_ms->size() != request.node_count) {
            error = "GPU exchange-mass preconditioner setup requires sparse, mass, and mask state";
            return false;
        }
        if (!std::isfinite(request.exchange_weight) || request.exchange_weight < 0.0) {
            error = "GPU exchange-mass preconditioner setup has an invalid exchange weight";
            return false;
        }
        const std::size_t bytes = request.node_count * sizeof(double);
        if (!cuda_status(
                cudaMemcpyAsync(
                    relaxation.preconditioner_mass_ms_device,
                    request.mass_ms->data(),
                    bytes,
                    cudaMemcpyHostToDevice,
                    static_cast<cudaStream_t>(request.stream)),
                "upload GPU exchange-mass setup mass-ms diagonal",
                error) ||
            !cuda_launch_status(
                "check GPU exchange-mass setup mass-ms upload", error)) {
            clear_preconditioner_dispatch(relaxation);
            return false;
        }
        GpuExchangeMassPreconditioner *exchange =
            decision.fixed_iterations == 4u
                ? &relaxation.exchange_mass_cg4
                : &relaxation.exchange_mass_cg8;
        if (!exchange->setup(
                *request.sparse_plan,
                request.d_mass_ms,
                request.d_active_mask,
                request.node_count,
                GpuExchangeMassSetupIdentity{
                    request.identity.operator_revision,
                    request.identity.mass_revision,
                    request.identity.mask_revision},
                request.stream,
                error)) {
            clear_preconditioner_dispatch(relaxation);
            return false;
        }
    }
#else
    (void)request;
    error = "GPU relaxation preconditioner setup requires CUDA runtime support";
    clear_preconditioner_dispatch(relaxation);
    return false;
#endif

    relaxation.preconditioner_request = request.profile;
    relaxation.resolved_preconditioner = decision;
    relaxation.preconditioner_setup_identity = request.identity;
    relaxation.preconditioner_setup_profile = normalized_profile_id(request.profile);
    relaxation.preconditioner_setup_weight =
        decision.kind == GpuRelaxationPreconditionerKind::Diagonal
            ? request.exchange_weight
            : 0.0;
    relaxation.preconditioner_setup_complete = true;
    error.clear();
    return true;
}

bool gpu_relaxation_apply_preconditioner(
    FemGpuRelaxationDeviceState &relaxation,
    const FemGpuComponentField &gradient,
    FemGpuComponentField &preconditioned_gradient,
    uint64_t node_count,
    double exchange_weight,
    void *stream,
    std::string &error)
{
    if (!relaxation.preconditioner_setup_complete ||
        node_count == 0u || node_count != relaxation.node_count ||
        gradient.x == nullptr || gradient.y == nullptr || gradient.z == nullptr ||
        preconditioned_gradient.x == nullptr || preconditioned_gradient.y == nullptr ||
        preconditioned_gradient.z == nullptr) {
        error = "GPU relaxation preconditioner apply requires a complete setup and device fields";
        relaxation.preconditioner_apply_failures += 1u;
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const cudaStream_t cuda_stream = static_cast<cudaStream_t>(stream);
    if (relaxation.resolved_preconditioner.kind ==
        GpuRelaxationPreconditionerKind::None) {
        const std::size_t bytes = node_count * sizeof(double);
        if (!cuda_status(
                cudaMemcpyAsync(preconditioned_gradient.x, gradient.x, bytes,
                    cudaMemcpyDeviceToDevice, cuda_stream),
                "copy raw GPU gradient x to unpreconditioned z", error) ||
            !cuda_status(
                cudaMemcpyAsync(preconditioned_gradient.y, gradient.y, bytes,
                    cudaMemcpyDeviceToDevice, cuda_stream),
                "copy raw GPU gradient y to unpreconditioned z", error) ||
            !cuda_status(
                cudaMemcpyAsync(preconditioned_gradient.z, gradient.z, bytes,
                    cudaMemcpyDeviceToDevice, cuda_stream),
                "copy raw GPU gradient z to unpreconditioned z", error) ||
            !cuda_launch_status("check unpreconditioned GPU gradient copies", error)) {
            relaxation.preconditioner_apply_failures += 1u;
            return false;
        }
        error.clear();
        return true;
    }
    if (relaxation.resolved_preconditioner.kind ==
            GpuRelaxationPreconditionerKind::Diagonal &&
        relaxation.preconditioner_setup_weight != exchange_weight) {
        error = "GPU diagonal preconditioner apply weight differs from setup; setup must be refreshed before apply";
        relaxation.preconditioner_apply_failures += 1u;
        return false;
    }
    if (relaxation.resolved_preconditioner.kind ==
        GpuRelaxationPreconditionerKind::Diagonal) {
        if (!relaxation.preconditioner.apply_device_component(
                gradient.x, gradient.y, gradient.z,
                preconditioned_gradient.x,
                preconditioned_gradient.y,
                preconditioned_gradient.z,
                node_count,
                stream,
                error)) {
            relaxation.preconditioner_apply_failures += 1u;
            return false;
        }
        error.clear();
        return true;
    }
    GpuExchangeMassPreconditioner *exchange =
        relaxation.resolved_preconditioner.fixed_iterations == 4u
            ? &relaxation.exchange_mass_cg4
            : &relaxation.exchange_mass_cg8;
    if (!exchange->apply_device_xyz(
            gradient.x, gradient.y, gradient.z,
            preconditioned_gradient.x,
            preconditioned_gradient.y,
            preconditioned_gradient.z,
            node_count,
            exchange_weight,
            stream,
            error)) {
        relaxation.preconditioner_apply_failures += 1u;
        return false;
    }
    error.clear();
    return true;
#else
    (void)exchange_weight;
    (void)stream;
    error = "GPU relaxation preconditioner apply requires CUDA runtime support";
    relaxation.preconditioner_apply_failures += 1u;
    return false;
#endif
}

bool gpu_relaxation_enqueue_preconditioner_failure(
    const FemGpuRelaxationDeviceState &relaxation,
    double *device_scalar_slot,
    void *stream,
    std::string &error)
{
    if (device_scalar_slot == nullptr) {
        error = "GPU relaxation preconditioner failure packet slot is null";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const cudaStream_t cuda_stream = static_cast<cudaStream_t>(stream);
    const std::uint32_t *latch =
        gpu_relaxation_preconditioner_failure_latch(relaxation);
    if (latch == nullptr) {
        if (!cuda_status(
                cudaMemsetAsync(device_scalar_slot, 0, sizeof(double), cuda_stream),
                "clear GPU relaxation preconditioner failure packet slot", error) ||
            !cuda_launch_status(
                "check GPU relaxation preconditioner failure packet clear", error)) {
            return false;
        }
        return true;
    }
    fullmag_cuda_exchange_mass_export_failure_latch(
        latch, device_scalar_slot, cuda_stream);
    return cuda_launch_status(
        "enqueue GPU exchange-mass failure latch packet", error);
#else
    (void)relaxation;
    (void)stream;
    error = "GPU relaxation preconditioner failure packet requires CUDA runtime support";
    return false;
#endif
}

const uint32_t *gpu_relaxation_preconditioner_failure_latch(
    const FemGpuRelaxationDeviceState &relaxation) noexcept
{
    if (!relaxation.preconditioner_setup_complete ||
        relaxation.resolved_preconditioner.kind !=
            GpuRelaxationPreconditionerKind::ExchangeMass) {
        return nullptr;
    }
    return relaxation.resolved_preconditioner.fixed_iterations == 4u
        ? relaxation.exchange_mass_cg4.device_failure_latch()
        : relaxation.exchange_mass_cg8.device_failure_latch();
}

} // namespace fullmag::fem

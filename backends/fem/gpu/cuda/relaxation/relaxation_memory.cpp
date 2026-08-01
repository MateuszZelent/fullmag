/*
 * GPU CUDA relaxation memory source contract.
 *
 * Allocates persistent relaxation algorithm buffers. It does not own RK scratch
 * fields, effective-field kernels, line-search policy, or public C ABI
 * dispatch.
 */

#include "gpu/cuda/relaxation/relaxation_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

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
    relaxation.accepted_evaluation = {};
    gpu_relax_reset_step_diagnostics(relaxation);
    relaxation.direct_energy_refinements = 0;
    if (!gpu_device_allocate_component(
            relaxation.projected_gradient_accepted_h_eff,
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
            error)) {
        gpu_relaxation_state_free(relaxation);
        return false;
    }
    return true;
}

void gpu_relaxation_state_free(FemGpuRelaxationDeviceState &relaxation)
{
    gpu_device_free_component(relaxation.projected_gradient_accepted_h_eff);
    gpu_device_free_component(relaxation.nonlinear_cg_direction);
    gpu_device_free_component(relaxation.nonlinear_cg_direction_backup);
    relaxation.node_count = 0;
    relaxation.state_generation = 0;
    relaxation.nonlinear_cg_direction_valid = false;
    relaxation.accepted_evaluation = {};
    gpu_relax_reset_step_diagnostics(relaxation);
    relaxation.direct_energy_refinements = 0;
}

} // namespace fullmag::fem

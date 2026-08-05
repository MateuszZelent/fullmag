/*
 * GPU CUDA RK direct torque source contract.
 *
 * This source owns direct tau contributions added to the device-resident RK
 * RHS after the LLG effective-field RHS. It delegates Slonczewski, Zhang-Li
 * STT, and prescribed-SOT validation and kernel launches. It does not own RHS
 * orchestration, exchange, demag dispatch, local field generation, H_eff
 * accumulation, LLG RHS evaluation, RK step scheduling, final statistics, GPU
 * RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"

#include "gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp"
#include "gpu/cuda/integrators/rk/rk_sot_torque.hpp"
#include "gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp"

#include <string>

namespace fullmag::fem {

bool gpu_rk_add_direct_torques(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    std::string &reason)
{
    if (!gpu_rk_add_slonczewski_torque(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_add_zhang_li_torque(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_add_prescribed_sot_torque(
            ctx, m, rhs, stream, n, evaluation_time_s, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem

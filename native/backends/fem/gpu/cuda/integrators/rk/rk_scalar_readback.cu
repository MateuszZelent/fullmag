// ── GPU CUDA RK scalar readback source contract ───────────────────────
// This source owns audited device-to-host scalar result reads used by
// device-resident RK. It does not own component-field copies, RK orchestration,
// RHS assembly, adaptive policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"

#include "context.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

namespace fullmag::fem {

namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace

bool gpu_rk_read_scalar_result(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!cuda_ok(
            cudaMemcpyAsync(
                &value,
                gpu.reductions.scalar_result,
                sizeof(double),
                cudaMemcpyDeviceToHost,
                stream),
            label,
            reason)) {
        return false;
    }
    if (!cuda_ok(cudaStreamSynchronize(stream), "cudaStreamSynchronize GPU RK scalar stats", reason)) {
        return false;
    }
    record_device_to_host(ctx.transfer_audit.audit, sizeof(double));
    return true;
}

bool gpu_rk_read_scalar_results(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double *values,
    size_t count,
    std::string &reason)
{
    if (count == 0) {
        return true;
    }
    auto &gpu = ctx.gpu_state.device;
    if (!cuda_ok(
            cudaMemcpyAsync(
                values,
                gpu.reductions.scalar_result,
                count * sizeof(double),
                cudaMemcpyDeviceToHost,
                stream),
            label,
            reason)) {
        return false;
    }
    if (!cuda_ok(cudaStreamSynchronize(stream), "cudaStreamSynchronize GPU RK scalar stats", reason)) {
        return false;
    }
    record_device_to_host(ctx.transfer_audit.audit, count * sizeof(double));
    return true;
}

} // namespace fullmag::fem

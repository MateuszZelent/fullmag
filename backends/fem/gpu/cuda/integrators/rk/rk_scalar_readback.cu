// ── GPU CUDA RK scalar readback source contract ───────────────────────
// This source owns audited device-to-host scalar result reads used by
// device-resident RK. It does not own component-field copies, RK orchestration,
// RHS assembly, adaptive policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"

#include "context.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <algorithm>

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

bool read_scalar_result_impl(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    bool control_scalar_readback,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.reductions.host_scalar_result == nullptr) {
        reason = "GPU RK scalar readback requires scalar host staging";
        return false;
    }
    if (!cuda_ok(
            cudaMemcpyAsync(
                gpu.reductions.host_scalar_result,
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
    value = gpu.reductions.host_scalar_result[0];
    if (control_scalar_readback) {
        record_device_control_scalar_to_host(ctx.transfer_audit.audit, sizeof(double));
    } else {
        record_device_to_host(ctx.transfer_audit.audit, sizeof(double));
    }
    return true;
}

bool read_scalar_results_impl(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double *values,
    size_t count,
    bool control_scalar_readback,
    std::string &reason)
{
    if (count == 0) {
        return true;
    }
    auto &gpu = ctx.gpu_state.device;
    if (count > FEM_GPU_SCALAR_RESULT_SLOTS) {
        reason = "GPU RK scalar readback count exceeds scalar staging capacity";
        return false;
    }
    if (gpu.reductions.host_scalar_result == nullptr) {
        reason = "GPU RK scalar readback requires scalar host staging";
        return false;
    }
    if (!cuda_ok(
            cudaMemcpyAsync(
                gpu.reductions.host_scalar_result,
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
    std::copy_n(gpu.reductions.host_scalar_result, count, values);
    if (control_scalar_readback) {
        record_device_control_scalar_to_host(
            ctx.transfer_audit.audit,
            count * sizeof(double));
    } else {
        record_device_to_host(ctx.transfer_audit.audit, count * sizeof(double));
    }
    return true;
}

} // namespace

bool gpu_rk_read_scalar_result(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    std::string &reason)
{
    return read_scalar_result_impl(
        ctx,
        stream,
        label,
        value,
        false,
        reason);
}

bool gpu_rk_read_scalar_results(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double *values,
    size_t count,
    std::string &reason)
{
    return read_scalar_results_impl(
        ctx,
        stream,
        label,
        values,
        count,
        false,
        reason);
}

bool gpu_rk_read_control_scalar_result(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double &value,
    std::string &reason)
{
    return read_scalar_result_impl(
        ctx,
        stream,
        label,
        value,
        true,
        reason);
}

bool gpu_rk_read_control_scalar_results(
    Context &ctx,
    cudaStream_t stream,
    const char *label,
    double *values,
    size_t count,
    std::string &reason)
{
    return read_scalar_results_impl(
        ctx,
        stream,
        label,
        values,
        count,
        true,
        reason);
}

} // namespace fullmag::fem

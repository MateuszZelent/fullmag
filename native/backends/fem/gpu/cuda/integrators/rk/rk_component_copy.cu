// ── GPU CUDA RK component copy source contract ────────────────────────
// This source owns component-field device copies and device-to-host AoS
// downloads used by device-resident RK. It does not own scalar readback, RK
// orchestration, RHS assembly, adaptive policy, interaction kernels, or C ABI
// entrypoints.

#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"

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

bool gpu_rk_copy_component_device(
    const FemGpuComponentField &src,
    FemGpuComponentField &dst,
    uint64_t node_count,
    cudaStream_t stream,
    const char *operation,
    std::string &reason)
{
    const size_t bytes = static_cast<size_t>(node_count) * sizeof(double);
    if (!cuda_ok(
            cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason) ||
        !cuda_ok(
            cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason) ||
        !cuda_ok(
            cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream),
            operation,
            reason)) {
        return false;
    }
    return true;
}

bool gpu_rk_download_component_device_to_aos(
    Context &ctx,
    const FemGpuComponentField &src,
    std::vector<double> &out_xyz,
    cudaStream_t stream,
    const char *operation,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (src.x == nullptr || src.y == nullptr || src.z == nullptr) {
        reason = std::string(operation) + " requires allocated source component buffers";
        return false;
    }
    out_xyz.resize(static_cast<size_t>(gpu.dof_len));
    const size_t node_count = static_cast<size_t>(gpu.node_count);
    const size_t host_pitch = 3u * sizeof(double);
    const size_t component_bytes = node_count * sizeof(double);
    if (!cuda_ok(cudaMemcpy2DAsync(
                out_xyz.data() + 0u,
                host_pitch,
                src.x,
                sizeof(double),
                sizeof(double),
                node_count,
                cudaMemcpyDeviceToHost,
                stream),
            operation,
            reason) ||
        !cuda_ok(cudaMemcpy2DAsync(
                out_xyz.data() + 1u,
                host_pitch,
                src.y,
                sizeof(double),
                sizeof(double),
                node_count,
                cudaMemcpyDeviceToHost,
                stream),
            operation,
            reason) ||
        !cuda_ok(cudaMemcpy2DAsync(
                out_xyz.data() + 2u,
                host_pitch,
                src.z,
                sizeof(double),
                sizeof(double),
                node_count,
                cudaMemcpyDeviceToHost,
                stream),
            operation,
            reason)) {
        return false;
    }
    if (!cuda_ok(cudaStreamSynchronize(stream), operation, reason)) {
        return false;
    }
    record_device_to_host(ctx.transfer_audit.audit, static_cast<uint64_t>(component_bytes) * 3ull);
    return true;
}

} // namespace fullmag::fem

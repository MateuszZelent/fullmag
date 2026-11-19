/*
 * GPU CUDA component-transfer source contract.
 *
 * Owns generic component-field AoS/SoA upload/download and device zero-fill
 * helpers for the native FEM CUDA state layer. It does not own FemGpuState
 * lifecycle policy, interaction-specific field selection, RK execution, or C
 * ABI entrypoints.
 */

#include "gpu/cuda/transfer/component_transfer.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/transfer/transfer_kernels.hpp"
#endif

#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace
#endif

bool gpu_component_download_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    const FemGpuComponentField &field,
    std::vector<double> &out_xyz,
    TransferAudit &audit,
    const char *label,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        error = std::string("FemGpuState ") + label +
            " readback requires allocated device buffers";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!gpu_device_checked_node_bytes(lifecycle.node_count, component_bytes, error)) {
        return false;
    }
    if (lifecycle.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = std::string("FemGpuState ") + label +
            " download node count exceeds CUDA kernel range";
        return false;
    }

    out_xyz.resize(static_cast<size_t>(lifecycle.dof_len));
    if (!cuda_ok(fullmag_cuda_download_soa_to_aos(
            field.x,
            field.y,
            field.z,
            out_xyz.data(),
            static_cast<int>(lifecycle.node_count),
            nullptr),
            (std::string("fullmag_cuda_download_soa_to_aos FemGpuState ") +
                label + " device->host").c_str(),
            error)) {
        return false;
    }

    record_device_to_host(audit, static_cast<uint64_t>(component_bytes) * 3ull);
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_component_download_aos_packed(
    const FemGpuLifecycleDeviceState &lifecycle,
    const FemGpuComponentField &field,
    double *aos_device_scratch,
    uint64_t scratch_dof_len,
    void *raw_stream,
    std::vector<double> &out_xyz,
    TransferAudit &audit,
    const char *label,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    if (lifecycle.node_count == 0 && lifecycle.dof_len == 0) {
        out_xyz.clear();
        return true;
    }
    if (lifecycle.node_count > std::numeric_limits<uint64_t>::max() / 3ull ||
        lifecycle.dof_len != lifecycle.node_count * 3ull) {
        error = std::string("FemGpuState ") + label +
            " packed download has inconsistent vector DOF metadata";
        return false;
    }
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        error = std::string("FemGpuState ") + label +
            " packed download requires allocated device component buffers";
        return false;
    }
    if (aos_device_scratch == nullptr || scratch_dof_len != lifecycle.dof_len) {
        error = std::string("FemGpuState ") + label +
            " packed download requires a matching persistent device AoS buffer";
        return false;
    }
    if (raw_stream == nullptr) {
        error = std::string("FemGpuState ") + label +
            " packed download requires an explicit non-default CUDA stream";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    if (lifecycle.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = std::string("FemGpuState ") + label +
            " packed download node count exceeds CUDA kernel range";
        return false;
    }

    size_t packed_bytes = 0;
    if (!gpu_device_checked_node_bytes(lifecycle.dof_len, packed_bytes, error)) {
        return false;
    }
    out_xyz.resize(static_cast<size_t>(lifecycle.dof_len));
    const cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    const std::string pack_operation = std::string(
        "fullmag_cuda_pack_soa_to_aos FemGpuState ") + label + " device pack";
    if (!cuda_ok(
            fullmag_cuda_pack_soa_to_aos(
                field.x,
                field.y,
                field.z,
                aos_device_scratch,
                static_cast<int>(lifecycle.node_count),
                stream),
            pack_operation.c_str(),
            error)) {
        const cudaError_t sync_rc = cudaStreamSynchronize(stream);
        if (sync_rc != cudaSuccess) {
            error += std::string("; cudaStreamSynchronize after failed device pack failed: ") +
                cudaGetErrorString(sync_rc);
        }
        return false;
    }

    const std::string copy_operation = std::string(
        "cudaMemcpyAsync FemGpuState ") + label + " packed device->host";
    if (!cuda_ok(
            cudaMemcpyAsync(
                out_xyz.data(),
                aos_device_scratch,
                packed_bytes,
                cudaMemcpyDeviceToHost,
                stream),
            copy_operation.c_str(),
            error)) {
        const cudaError_t sync_rc = cudaStreamSynchronize(stream);
        if (sync_rc != cudaSuccess) {
            error += std::string("; cudaStreamSynchronize after failed packed copy failed: ") +
                cudaGetErrorString(sync_rc);
        }
        return false;
    }

    if (!cuda_ok(
            cudaStreamSynchronize(stream),
            (std::string("cudaStreamSynchronize FemGpuState ") + label +
                " packed device->host").c_str(),
            error)) {
        return false;
    }

    record_device_to_host(audit, static_cast<uint64_t>(packed_bytes));
    return true;
#else
    (void)audit;
    error = "FemGpuState packed download requires CUDA runtime support";
    return false;
#endif
}

bool gpu_component_upload_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    if (xyz == nullptr) {
        error = std::string("FemGpuState ") + label + " upload received a null pointer";
        return false;
    }
    if (len != lifecycle.dof_len) {
        error = std::string("FemGpuState ") + label + " upload length mismatch";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!gpu_device_checked_node_bytes(lifecycle.node_count, component_bytes, error)) {
        return false;
    }
    if (lifecycle.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = std::string("FemGpuState ") + label +
            " upload node count exceeds CUDA kernel range";
        return false;
    }

    const std::string op_prefix = std::string("cudaMemcpy FemGpuState ") + label;
    if (!cuda_ok(fullmag_cuda_upload_aos_to_soa(
            xyz,
            field.x,
            field.y,
            field.z,
            static_cast<int>(lifecycle.node_count),
            nullptr),
            (op_prefix + " fullmag_cuda_upload_aos_to_soa host->device").c_str(),
            error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(component_bytes) * 3ull);
    return true;
#else
    (void)field;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_component_zero_device(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    (void)audit;
    size_t component_bytes = 0;
    if (!gpu_device_checked_node_bytes(lifecycle.node_count, component_bytes, error)) {
        return false;
    }
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        error = std::string("FemGpuState ") + label + " zero fill received unallocated device components";
        return false;
    }

    const std::string op_prefix = std::string("cudaMemset FemGpuState ") + label;
    if (!cuda_ok(cudaMemset(field.x, 0, component_bytes),
            (op_prefix + " x zero device").c_str(),
            error) ||
        !cuda_ok(cudaMemset(field.y, 0, component_bytes),
            (op_prefix + " y zero device").c_str(),
            error) ||
        !cuda_ok(cudaMemset(field.z, 0, component_bytes),
            (op_prefix + " z zero device").c_str(),
            error)) {
        return false;
    }
    return true;
#else
    (void)field;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

bool gpu_component_upload_optional_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error)
{
    if (xyz == nullptr || len == 0) {
        return gpu_component_zero_device(lifecycle, field, label, audit, error);
    }
    return gpu_component_upload_aos(lifecycle, field, xyz, len, label, audit, error);
}

} // namespace fullmag::fem

/*
 * GPU CUDA RK DMI field contributions source contract.
 *
 * This source owns per-stage interfacial and bulk DMI weak-residual field
 * generation used by the device-resident RK RHS. It does not own RHS
 * orchestration, exchange, demag dispatch, H_eff accumulation, LLG RHS
 * evaluation, direct torque terms, RK step scheduling, final statistics, GPU
 * RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp"

#include <cuda_runtime.h>

#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>

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

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

bool zero_dmi_field(
    FemGpuComponentField &field,
    int n,
    cudaStream_t stream,
    std::string &reason)
{
    if (n <= 0) {
        return true;
    }
    const size_t bytes = static_cast<size_t>(n) * sizeof(double);
    return cuda_ok(cudaMemsetAsync(field.x, 0, bytes, stream),
               "cudaMemsetAsync GPU RK DMI field x", reason) &&
        cuda_ok(cudaMemsetAsync(field.y, 0, bytes, stream),
            "cudaMemsetAsync GPU RK DMI field y", reason) &&
        cuda_ok(cudaMemsetAsync(field.z, 0, bytes, stream),
            "cudaMemsetAsync GPU RK DMI field z", reason);
}

bool gpu_rk_compute_one_dmi_field(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    bool bulk_mode,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    const auto &chan = bulk_mode ? gpu.dmi_csr.bulk : gpu.dmi_csr.interfacial;
    if (!chan.uploaded ||
        chan.rows != static_cast<uint64_t>(ctx.mesh.n_nodes) ||
        chan.csr_row_offsets == nullptr ||
        gpu.materials.ms == nullptr ||
        gpu.mesh_metrics.lumped_mass == nullptr) {
        reason = "GPU RK DMI requires device-resident CSR operator, Ms, and lumped mass buffers";
        return false;
    }
    FemGpuComponentField &field = bulk_mode ? gpu.fields.h_bulk_dmi : gpu.fields.h_dmi;
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        reason = "GPU RK DMI requires device-resident H_dmi buffers";
        return false;
    }
    if (n <= 0) {
        return true;
    }

    if (gpu.mesh_regions.has_periodic_reduced_nodes) {
        if (!chan.periodic_reduced_ready ||
            chan.periodic_reduced_row_offsets == nullptr ||
            chan.periodic_reduced_mass == nullptr ||
            chan.periodic_reduced_rx == nullptr ||
            chan.periodic_reduced_ry == nullptr ||
            chan.periodic_reduced_rz == nullptr ||
            gpu.mesh_regions.periodic_reduced_node == nullptr ||
            gpu.mesh_regions.periodic_reduced_representative_nodes == nullptr ||
            chan.periodic_reduced_rows == 0u ||
            chan.periodic_reduced_rows > static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
            chan.periodic_reduced_rows != gpu.mesh_regions.periodic_reduced_node_count) {
            reason = "GPU RK periodic DMI requires precomputed periodic reduced CSR buffers";
            return false;
        }
        if (chan.periodic_reduced_nnz == 0u) {
            return zero_dmi_field(field, n, stream, reason);
        }
        if (chan.periodic_reduced_col_indices == nullptr ||
            chan.periodic_reduced_dx == nullptr ||
            chan.periodic_reduced_dy == nullptr ||
            chan.periodic_reduced_dz == nullptr) {
            reason = "GPU RK periodic DMI CSR value buffers are null for non-zero nnz";
            return false;
        }
        fullmag_cuda_dmi_csr_periodic_field_energy(
            chan.periodic_reduced_row_offsets,
            chan.periodic_reduced_col_indices,
            chan.periodic_reduced_dx,
            chan.periodic_reduced_dy,
            chan.periodic_reduced_dz,
            chan.periodic_reduced_mass,
            gpu.mesh_regions.periodic_reduced_node,
            gpu.mesh_regions.periodic_reduced_representative_nodes,
            m.x,
            m.y,
            m.z,
            gpu.materials.ms,
            gpu.mesh_regions.magnetic_node_mask,
            chan.periodic_reduced_rx,
            chan.periodic_reduced_ry,
            chan.periodic_reduced_rz,
            field.x,
            field.y,
            field.z,
            /*energy_block_sums=*/nullptr,
            ctx.material_fields.material.saturation_magnetisation,
            static_cast<int>(chan.periodic_reduced_rows),
            n,
            stream);
    } else {
        if (chan.nnz == 0u) {
            return zero_dmi_field(field, n, stream, reason);
        }
        if (chan.csr_col_indices == nullptr ||
            chan.csr_dx == nullptr ||
            chan.csr_dy == nullptr ||
            chan.csr_dz == nullptr) {
            reason = "GPU RK DMI CSR value buffers are null for non-zero nnz";
            return false;
        }
        fullmag_cuda_dmi_csr_field_energy(
            chan.csr_row_offsets,
            chan.csr_col_indices,
            chan.csr_dx,
            chan.csr_dy,
            chan.csr_dz,
            m.x,
            m.y,
            m.z,
            gpu.materials.ms,
            gpu.mesh_metrics.lumped_mass,
            gpu.mesh_regions.magnetic_node_mask,
            field.x,
            field.y,
            field.z,
            /*energy_block_sums=*/nullptr,
            ctx.material_fields.material.saturation_magnetisation,
            n,
            stream);
    }
    return cuda_launch_ok(
        bulk_mode ? "launch GPU RK bulk DMI field" : "launch GPU RK interfacial DMI field",
        reason);
}

} // namespace

bool gpu_rk_compute_dmi_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if ((ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled) &&
        !gpu_rk_compute_one_dmi_field(ctx, m, stream, n, false, reason)) {
        return false;
    }
    if (ctx.dmi.bulk_enabled &&
        !gpu_rk_compute_one_dmi_field(ctx, m, stream, n, true, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem

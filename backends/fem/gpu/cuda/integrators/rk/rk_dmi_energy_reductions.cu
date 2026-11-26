/*
 * GPU CUDA RK DMI final energy reductions source contract.
 *
 * This source owns final interfacial and bulk DMI energy kernel launches and
 * reductions for the device-resident RK stats path. It does not own generic
 * final energy orchestration, scalar readback, stats publication, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

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

bool zero_dmi_field_and_energy(
    FemGpuComponentField &field,
    double *energy_slot,
    int n,
    cudaStream_t stream,
    std::string &reason)
{
    if (n > 0) {
        const size_t bytes = static_cast<size_t>(n) * sizeof(double);
        if (!cuda_ok(cudaMemsetAsync(field.x, 0, bytes, stream),
                "cudaMemsetAsync GPU RK DMI zero field x", reason) ||
            !cuda_ok(cudaMemsetAsync(field.y, 0, bytes, stream),
                "cudaMemsetAsync GPU RK DMI zero field y", reason) ||
            !cuda_ok(cudaMemsetAsync(field.z, 0, bytes, stream),
                "cudaMemsetAsync GPU RK DMI zero field z", reason)) {
            return false;
        }
    }
    return cuda_ok(
        cudaMemsetAsync(energy_slot, 0, sizeof(double), stream),
        "cudaMemsetAsync GPU RK DMI zero energy",
        reason);
}

} // namespace

bool gpu_rk_reduce_final_dmi_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    auto compute_dmi_energy = [&](bool bulk_mode, GpuFinalScalarSlot slot) -> bool {
        const auto &chan = bulk_mode ? gpu.dmi_csr.bulk : gpu.dmi_csr.interfacial;
        if (!chan.uploaded ||
            chan.rows != static_cast<uint64_t>(ctx.mesh.n_nodes) ||
            chan.csr_row_offsets == nullptr ||
            gpu.materials.ms == nullptr ||
            gpu.mesh_metrics.lumped_mass == nullptr) {
            reason = "GPU RK DMI energy requires device-resident CSR operator, Ms, and lumped mass buffers";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.fields.h_bulk_dmi : gpu.fields.h_dmi;
        if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
            reason = "GPU RK DMI energy requires device-resident H_dmi buffers";
            return false;
        }
        if (n <= 0) {
            return zero_dmi_field_and_energy(
                field, gpu_rk_final_scalar_result(gpu, slot), 0, stream, reason);
        }

        int block_count = 0;
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
                chan.periodic_reduced_rows >
                    static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
                chan.periodic_reduced_rows != gpu.mesh_regions.periodic_reduced_node_count) {
                reason = "GPU RK periodic DMI energy requires precomputed periodic reduced CSR buffers";
                return false;
            }
            if (chan.periodic_reduced_nnz == 0u) {
                return zero_dmi_field_and_energy(
                    field, gpu_rk_final_scalar_result(gpu, slot), n, stream, reason);
            }
            if (chan.periodic_reduced_col_indices == nullptr ||
                chan.periodic_reduced_dx == nullptr ||
                chan.periodic_reduced_dy == nullptr ||
                chan.periodic_reduced_dz == nullptr) {
                reason = "GPU RK periodic DMI CSR value buffers are null for non-zero nnz";
                return false;
            }
            const int reduced_rows = static_cast<int>(chan.periodic_reduced_rows);
            block_count = (reduced_rows + 255) / 256;
            fullmag_cuda_dmi_csr_periodic_field_energy(
                chan.periodic_reduced_row_offsets,
                chan.periodic_reduced_col_indices,
                chan.periodic_reduced_dx,
                chan.periodic_reduced_dy,
                chan.periodic_reduced_dz,
                chan.periodic_reduced_mass,
                gpu.mesh_regions.periodic_reduced_node,
                gpu.mesh_regions.periodic_reduced_representative_nodes,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.materials.ms,
                gpu.mesh_regions.magnetic_node_mask,
                chan.periodic_reduced_rx,
                chan.periodic_reduced_ry,
                chan.periodic_reduced_rz,
                field.x,
                field.y,
                field.z,
                gpu.reductions.scalar_workspace,
                ctx.material_fields.material.saturation_magnetisation,
                reduced_rows,
                n,
                stream);
        } else {
            if (chan.nnz == 0u) {
                return zero_dmi_field_and_energy(
                    field, gpu_rk_final_scalar_result(gpu, slot), n, stream, reason);
            }
            if (chan.csr_col_indices == nullptr ||
                chan.csr_dx == nullptr ||
                chan.csr_dy == nullptr ||
                chan.csr_dz == nullptr) {
                reason = "GPU RK DMI CSR value buffers are null for non-zero nnz";
                return false;
            }
            block_count = (n + 255) / 256;
            fullmag_cuda_dmi_csr_field_energy(
                chan.csr_row_offsets,
                chan.csr_col_indices,
                chan.csr_dx,
                chan.csr_dy,
                chan.csr_dz,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.materials.ms,
                gpu.mesh_metrics.lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                field.x,
                field.y,
                field.z,
                gpu.reductions.scalar_workspace,
                ctx.material_fields.material.saturation_magnetisation,
                n,
                stream);
        }
        if (!cuda_launch_ok(
                bulk_mode ? "launch GPU RK bulk DMI energy blocks" :
                            "launch GPU RK interfacial DMI energy blocks",
                reason)) {
            return false;
        }
        size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.reductions.scalar_workspace,
            block_count,
            gpu_rk_final_scalar_result(gpu, slot),
            gpu.reductions.temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok(
                bulk_mode ? "launch GPU RK bulk DMI energy reduction" :
                            "launch GPU RK interfacial DMI energy reduction",
                reason)) {
            return false;
        }
        return true;
    };
    if ((ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled) &&
        !compute_dmi_energy(false, GpuFinalScalarSlot::DmiEnergy)) {
        return false;
    }
    if (ctx.dmi.bulk_enabled &&
        !compute_dmi_energy(true, GpuFinalScalarSlot::BulkDmiEnergy)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem

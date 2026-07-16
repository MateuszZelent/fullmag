/*
 * GPU CUDA RK total energy reduction source contract.
 *
 * Owns device-side aggregation from final per-term energy scalar slots into one
 * total-energy scalar for direct minimizer control readbacks. Per-term energy
 * kernels and reductions remain owned by their dedicated RK energy modules.
 */

#include "gpu/cuda/integrators/rk/rk_total_energy_reduction.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include <cuda_runtime.h>

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

__global__ void total_energy_scalar_kernel(
    const double *scalars,
    bool demag_enabled,
    bool external_enabled,
    bool drive_enabled,
    bool uniaxial_enabled,
    bool cubic_enabled,
    bool interfacial_dmi_enabled,
    bool bulk_dmi_enabled,
    bool magnetoelastic_enabled,
    double *output)
{
    double demag_energy = 0.0;
    if (demag_enabled) {
        demag_energy = scalars[static_cast<int>(GpuFinalScalarSlot::DemagEnergy)];
    }
    const double total =
        scalars[static_cast<int>(GpuFinalScalarSlot::ExchangeEnergy)] +
        demag_energy +
        (external_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::ExternalEnergy)] : 0.0) +
        (drive_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::DriveEnergy)] : 0.0) +
        (uniaxial_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::AnisotropyEnergy)] : 0.0) +
        (cubic_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::CubicAnisotropyEnergy)] : 0.0) +
        (interfacial_dmi_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::DmiEnergy)] : 0.0) +
        (bulk_dmi_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::BulkDmiEnergy)] : 0.0) +
        (magnetoelastic_enabled ? scalars[static_cast<int>(GpuFinalScalarSlot::MagnetoelasticEnergy)] : 0.0);
    *output = total;
}

} // namespace

bool gpu_rk_reduce_total_energy_scalar(
    Context &ctx,
    cudaStream_t stream,
    double *output,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.reductions.scalar_result == nullptr || output == nullptr) {
        reason = "GPU RK total energy scalar reduction requires allocated scalar result storage";
        return false;
    }

    total_energy_scalar_kernel<<<1, 1, 0, stream>>>(
        gpu.reductions.scalar_result,
        ctx.demag.enabled,
        ctx.zeeman.has_external_field,
        !ctx.zeeman.regional_drives.empty(),
        ctx.anisotropy.uniaxial_enabled,
        ctx.anisotropy.cubic_enabled,
        ctx.dmi.interfacial_enabled,
        ctx.dmi.bulk_enabled,
        ctx.magnetoelastic.enabled,
        output);
    return cuda_ok(cudaPeekAtLastError(), "launch GPU RK total energy scalar reduction", reason);
}

} // namespace fullmag::fem

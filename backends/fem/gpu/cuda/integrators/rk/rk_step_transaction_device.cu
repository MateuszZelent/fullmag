#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"

#include <cuda_runtime.h>

namespace fullmag::fem {
namespace {

bool copy_scalar(
    const double *source,
    double *destination,
    uint64_t count,
    cudaStream_t stream,
    const char *label,
    std::string &error)
{
    if (source == nullptr) {
        return true;
    }
    if (destination == nullptr) {
        error = std::string(label) + " backup storage is unavailable";
        return false;
    }
    const auto rc = cudaMemcpyAsync(
        destination,
        source,
        static_cast<size_t>(count) * sizeof(double),
        cudaMemcpyDeviceToDevice,
        stream);
    if (rc != cudaSuccess) {
        error = std::string(label) + " failed: " + cudaGetErrorString(rc);
        return false;
    }
    return true;
}

bool copy_published_device_state(
    Context &ctx,
    bool restore,
    std::string &error)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu.lifecycle.allocated) {
        return true;
    }
    auto stream = static_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const uint64_t count = gpu.lifecycle.node_count;
    auto copy_component = [&](FemGpuComponentField &live,
                              FemGpuComponentField &backup,
                              const char *label) {
        const auto &source = restore ? backup : live;
        auto &destination = restore ? live : backup;
        return gpu_rk_copy_component_device(
            source, destination, count, stream, label, error);
    };

    auto &rk = gpu.rk;
    auto &fields = gpu.fields;
    if (!copy_component(gpu.magnetization.m, rk.transaction_m, "GPU RK transaction magnetization copy") ||
        !copy_component(rk.k[0], rk.transaction_k0, "GPU RK transaction FSAL copy") ||
        !copy_component(fields.h_ex, rk.transaction_h_ex, "GPU RK transaction H_ex copy") ||
        !copy_component(fields.h_demag, rk.transaction_h_demag, "GPU RK transaction H_demag copy") ||
        !copy_component(fields.h_drive, rk.transaction_h_drive, "GPU RK transaction H_drive copy") ||
        !copy_component(fields.h_ani, rk.transaction_h_ani, "GPU RK transaction H_ani copy") ||
        !copy_component(fields.h_cubic_ani, rk.transaction_h_cubic_ani, "GPU RK transaction H_cubic copy") ||
        !copy_component(fields.h_dmi, rk.transaction_h_dmi, "GPU RK transaction H_dmi copy") ||
        !copy_component(fields.h_bulk_dmi, rk.transaction_h_bulk_dmi, "GPU RK transaction H_bulk_dmi copy") ||
        !copy_component(fields.h_oe, rk.transaction_h_oe, "GPU RK transaction H_oe copy") ||
        !copy_component(fields.h_therm, rk.transaction_h_therm, "GPU RK transaction H_therm copy") ||
        !copy_component(fields.h_mel, rk.transaction_h_mel, "GPU RK transaction H_mel copy") ||
        !copy_component(fields.h_eff, rk.transaction_h_eff, "GPU RK transaction H_eff copy")) {
        return false;
    }

    auto copy_optional_scalar = [&](double *live, double *backup, const char *label) {
        if (live == nullptr) {
            return true;
        }
        return restore
            ? copy_scalar(backup, live, count, stream, label, error)
            : copy_scalar(live, backup, count, stream, label, error);
    };
    if (gpu.demag_poisson.poisson_solution != nullptr &&
        (!copy_optional_scalar(
             gpu.demag_poisson.poisson_solution,
             rk.transaction_poisson_solution,
             "GPU RK transaction Poisson solution copy") ||
         !copy_optional_scalar(
             gpu.demag_poisson.poisson_solution_full,
             rk.transaction_poisson_solution_full,
             "GPU RK transaction full Poisson solution copy"))) {
        return false;
    }

    if (restore) {
        const auto rc = cudaStreamSynchronize(stream);
        if (rc != cudaSuccess) {
            error = std::string("GPU RK transaction rollback synchronization failed: ") +
                cudaGetErrorString(rc);
            return false;
        }
    }
    return true;
}

} // namespace

bool gpu_rk_capture_step_transaction_device(Context &ctx, std::string &error)
{
    return copy_published_device_state(ctx, false, error);
}

bool gpu_rk_restore_step_transaction_device(Context &ctx, std::string &error)
{
    return copy_published_device_state(ctx, true, error);
}

} // namespace fullmag::fem

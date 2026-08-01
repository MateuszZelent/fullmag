/* Executed CUDA contract for guarded RK vector normalization. */

#include "context.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

template <typename T>
T *device_value(T value)
{
    T *device = nullptr;
    check_cuda(cudaMalloc(&device, sizeof(T)), "cudaMalloc guard fixture");
    check_cuda(
        cudaMemcpy(device, &value, sizeof(T), cudaMemcpyHostToDevice),
        "cudaMemcpy guard fixture H2D");
    return device;
}

double host_value(double *device)
{
    double value = 0.0;
    check_cuda(
        cudaMemcpy(&value, device, sizeof(value), cudaMemcpyDeviceToHost),
        "cudaMemcpy guard fixture D2H");
    return value;
}

void set_value(double *device, double value)
{
    check_cuda(
        cudaMemcpy(device, &value, sizeof(value), cudaMemcpyHostToDevice),
        "cudaMemcpy transaction fixture H2D");
}

void set_component(fullmag::fem::FemGpuComponentField &field, double base)
{
    set_value(field.x, base);
    set_value(field.y, base + 1.0);
    set_value(field.z, base + 2.0);
}

void check_component(
    fullmag::fem::FemGpuComponentField &field,
    double base,
    const char *message)
{
    check(host_value(field.x) == base, message);
    check(host_value(field.y) == base + 1.0, message);
    check(host_value(field.z) == base + 2.0, message);
}

void active_invalid_vectors_fail_without_repair()
{
    for (double invalid : {
             0.0,
             std::numeric_limits<double>::denorm_min(),
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity(),
         }) {
        double *mx = device_value(invalid);
        double *my = device_value(0.0);
        double *mz = device_value(0.0);
        uint8_t *mask = device_value<uint8_t>(1u);
        double *flag = device_value(0.0);
        std::string reason;

        check(
            !fullmag::fem::fullmag_cuda_normalize_vectors(
                mx, my, mz, mask, flag, 1, nullptr, reason),
            "active invalid CUDA RK vector must fail closed");
        check(!reason.empty(), "CUDA RK guard failure must carry a reason");
        const double after = host_value(mx);
        if (std::isnan(invalid)) {
            check(std::isnan(after), "NaN CUDA RK vector must not be repaired");
        } else {
            check(after == invalid, "invalid CUDA RK vector must not be mutated");
        }

        cudaFree(mx);
        cudaFree(my);
        cudaFree(mz);
        cudaFree(mask);
        cudaFree(flag);
    }
}

void inactive_airbox_vector_is_ignored()
{
    double *mx = device_value(std::numeric_limits<double>::quiet_NaN());
    double *my = device_value(0.0);
    double *mz = device_value(0.0);
    uint8_t *mask = device_value<uint8_t>(0u);
    double *flag = device_value(0.0);
    std::string reason;
    check(
        fullmag::fem::fullmag_cuda_normalize_vectors(
            mx, my, mz, mask, flag, 1, nullptr, reason),
        "inactive airbox CUDA vector must be ignored");
    check(std::isnan(host_value(mx)), "inactive airbox vector must remain untouched");
    cudaFree(mx);
    cudaFree(my);
    cudaFree(mz);
    cudaFree(mask);
    cudaFree(flag);
}

void valid_active_vector_is_normalized()
{
    double *mx = device_value(3.0);
    double *my = device_value(4.0);
    double *mz = device_value(0.0);
    uint8_t *mask = device_value<uint8_t>(1u);
    double *flag = device_value(0.0);
    std::string reason;
    check(
        fullmag::fem::fullmag_cuda_normalize_vectors(
            mx, my, mz, mask, flag, 1, nullptr, reason),
        reason.c_str());
    check(std::abs(host_value(mx) - 0.6) < 1.0e-15, "CUDA normalized x");
    check(std::abs(host_value(my) - 0.8) < 1.0e-15, "CUDA normalized y");
    cudaFree(mx);
    cudaFree(my);
    cudaFree(mz);
    cudaFree(mask);
    cudaFree(flag);
}

void complete_device_transaction_restores_published_gpu_state()
{
    fullmag::fem::Context ctx;
    const double initial_m[3] = {1.0, 0.0, 0.0};
    std::string error;
    check(
        fullmag::fem::gpu_state_initialize(
            ctx.gpu_state.device,
            1,
            FULLMAG_FEM_INTEGRATOR_RK45_DP54,
            true,
            true,
            initial_m,
            3,
            ctx.transfer_audit.audit,
            error),
        error.c_str());

    auto &gpu = ctx.gpu_state.device;
    set_component(gpu.magnetization.m, 1.0);
    set_component(gpu.rk.k[0], 4.0);
    set_component(gpu.fields.h_ex, 10.0);
    set_component(gpu.fields.h_demag, 20.0);
    set_component(gpu.fields.h_drive, 30.0);
    set_component(gpu.fields.h_ani, 40.0);
    set_component(gpu.fields.h_cubic_ani, 50.0);
    set_component(gpu.fields.h_dmi, 60.0);
    set_component(gpu.fields.h_bulk_dmi, 70.0);
    set_component(gpu.fields.h_oe, 80.0);
    set_component(gpu.fields.h_therm, 90.0);
    set_component(gpu.fields.h_mel, 100.0);
    set_component(gpu.fields.h_eff, 110.0);
    set_value(gpu.demag_poisson.poisson_solution, 120.0);
    set_value(gpu.demag_poisson.poisson_solution_full, 121.0);
    ctx.state.current_time = 2.0;
    ctx.state.step_count = 3;
    ctx.base_plan.dt_seconds = 4.0;
    ctx.adaptive_dt.current_dt = 5.0;
    ctx.adaptive_dt.prev_error_norm = 6.0;
    ctx.adaptive_dt.has_prev_error_norm = true;
    gpu.rk.fsal_valid = true;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = fullmag::fem::FemGpuSyncState::DeviceClean;
    gpu.residency.host_state = fullmag::fem::FemGpuSyncState::HostStale;

    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());
    set_component(gpu.magnetization.m, -1.0);
    set_component(gpu.rk.k[0], -4.0);
    set_component(gpu.fields.h_ex, -10.0);
    set_component(gpu.fields.h_demag, -20.0);
    set_component(gpu.fields.h_drive, -30.0);
    set_component(gpu.fields.h_ani, -40.0);
    set_component(gpu.fields.h_cubic_ani, -50.0);
    set_component(gpu.fields.h_dmi, -60.0);
    set_component(gpu.fields.h_bulk_dmi, -70.0);
    set_component(gpu.fields.h_oe, -80.0);
    set_component(gpu.fields.h_therm, -90.0);
    set_component(gpu.fields.h_mel, -100.0);
    set_component(gpu.fields.h_eff, -110.0);
    set_value(gpu.demag_poisson.poisson_solution, -120.0);
    set_value(gpu.demag_poisson.poisson_solution_full, -121.0);
    ctx.state.current_time = -2.0;
    ctx.state.step_count = 99;
    ctx.base_plan.dt_seconds = -4.0;
    ctx.adaptive_dt.current_dt = -5.0;
    ctx.adaptive_dt.prev_error_norm = -6.0;
    gpu.rk.fsal_valid = false;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    ctx.stepper.failure_injection.next =
        fullmag::fem::RkStepFailurePoint::DuringFinalStatistics;
    check(
        fullmag::fem::rk_step_inject_failure(
            ctx,
            fullmag::fem::RkStepFailurePoint::DuringFinalStatistics,
            error),
        "GPU atomicity failpoint must execute");
    check(transaction.rollback(error), error.c_str());

    check_component(gpu.magnetization.m, 1.0, "GPU transaction magnetization rollback");
    check_component(gpu.rk.k[0], 4.0, "GPU transaction FSAL rollback");
    check_component(gpu.fields.h_ex, 10.0, "GPU transaction H_ex rollback");
    check_component(gpu.fields.h_demag, 20.0, "GPU transaction H_demag rollback");
    check_component(gpu.fields.h_drive, 30.0, "GPU transaction H_drive rollback");
    check_component(gpu.fields.h_ani, 40.0, "GPU transaction H_ani rollback");
    check_component(gpu.fields.h_cubic_ani, 50.0, "GPU transaction H_cubic rollback");
    check_component(gpu.fields.h_dmi, 60.0, "GPU transaction H_dmi rollback");
    check_component(gpu.fields.h_bulk_dmi, 70.0, "GPU transaction H_bulk_dmi rollback");
    check_component(gpu.fields.h_oe, 80.0, "GPU transaction H_oe rollback");
    check_component(gpu.fields.h_therm, 90.0, "GPU transaction H_therm rollback");
    check_component(gpu.fields.h_mel, 100.0, "GPU transaction H_mel rollback");
    check_component(gpu.fields.h_eff, 110.0, "GPU transaction H_eff rollback");
    check(host_value(gpu.demag_poisson.poisson_solution) == 120.0,
          "GPU transaction Poisson solution rollback");
    check(host_value(gpu.demag_poisson.poisson_solution_full) == 121.0,
          "GPU transaction full Poisson solution rollback");
    check(ctx.state.current_time == 2.0 && ctx.state.step_count == 3,
          "GPU transaction time/index rollback");
    check(ctx.base_plan.dt_seconds == 4.0 && ctx.adaptive_dt.current_dt == 5.0,
          "GPU transaction timestep rollback");
    check(ctx.adaptive_dt.prev_error_norm == 6.0 && ctx.adaptive_dt.has_prev_error_norm,
          "GPU transaction controller-history rollback");
    check(gpu.rk.fsal_valid, "GPU transaction FSAL validity rollback");
    check(
        gpu.residency.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
            gpu.residency.device_state == fullmag::fem::FemGpuSyncState::DeviceClean &&
            gpu.residency.host_state == fullmag::fem::FemGpuSyncState::HostStale,
        "GPU transaction residency rollback");

    fullmag::fem::gpu_state_destroy(gpu);
}

} // namespace

int main()
{
    active_invalid_vectors_fail_without_repair();
    inactive_airbox_vector_is_ignored();
    valid_active_vector_is_normalized();
    complete_device_transaction_restores_published_gpu_state();
    std::printf("FEM CUDA RK guard contract PASS\n");
    return 0;
}

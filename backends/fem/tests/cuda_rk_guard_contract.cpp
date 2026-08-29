/* Executed CUDA contract for guarded RK vector normalization. */

#include "context.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"
#include "gpu/cuda/integrators/rk/rk_workspace_memory.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
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

void minimal_rk_transaction_restores_only_authoritative_gpu_state()
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
    ctx.mesh.n_nodes = 1;
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
    gpu.fields.accepted_observables_valid = true;
    gpu.fields.accepted_observables_step = ctx.state.step_count;

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
    check_component(gpu.fields.h_ex, -10.0, "GPU RK rollback must not copy derived H_ex");
    check_component(gpu.fields.h_eff, -110.0, "GPU RK rollback must not copy derived H_eff");
    check(host_value(gpu.demag_poisson.poisson_solution) == -120.0,
          "GPU RK rollback must not copy a failed Poisson guess");
    check(ctx.state.current_time == 2.0 && ctx.state.step_count == 3,
          "GPU transaction time/index rollback");
    check(ctx.base_plan.dt_seconds == 4.0 && ctx.adaptive_dt.current_dt == 5.0,
          "GPU transaction timestep rollback");
    check(ctx.adaptive_dt.prev_error_norm == 6.0 && ctx.adaptive_dt.has_prev_error_norm,
          "GPU transaction controller-history rollback");
    check(gpu.rk.fsal_valid, "GPU transaction FSAL validity rollback");
    check(!gpu.fields.accepted_observables_valid,
          "GPU RK rollback must invalidate derived accepted-endpoint observables");
    check(ctx.poisson_demag.fresh_initial_guess_required,
          "GPU RK rollback must require a fresh Poisson initial guess");
    double rejected_field[3] = {};
    check(
        fullmag::fem::context_copy_field_f64(
            ctx,
            FULLMAG_FEM_OBSERVABLE_H_EFF,
            rejected_field,
            3,
            error) == FULLMAG_FEM_ERR_INVALID,
        "invalidated GPU fields must fail closed until snapshot refresh");
    check(
        gpu.residency.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
            gpu.residency.device_state == fullmag::fem::FemGpuSyncState::DeviceClean &&
            gpu.residency.host_state == fullmag::fem::FemGpuSyncState::HostStale,
        "GPU transaction residency rollback");

    fullmag::fem::gpu_state_destroy(gpu);
}

void rk_workspace_allocates_only_minimal_transaction_journal()
{
    fullmag::fem::FemGpuRkWorkspaceDeviceState rk;
    constexpr uint64_t node_count = 5u;
    constexpr uint32_t stage_count = 7u;
    uint64_t device_bytes = 0;
    std::string error;
    check(
        fullmag::fem::gpu_rk_workspace_allocate(
            rk,
            node_count,
            stage_count,
            device_bytes,
            error),
        error.c_str());
    constexpr uint64_t component_field_count = stage_count + 5u;
    constexpr uint64_t expected_bytes =
        component_field_count * 3u * node_count * sizeof(double);
    check(device_bytes == expected_bytes,
          "GPU RK workspace VRAM must include only scratch, stages, m, and k0 journal fields");
    check(rk.transaction_m.x != nullptr && rk.transaction_k0.x != nullptr,
          "minimal GPU RK transaction journal must allocate m and k0 storage");
    fullmag::fem::gpu_rk_workspace_free(rk);
    check(rk.transaction_m.x == nullptr && rk.transaction_k0.x == nullptr,
          "minimal GPU RK transaction journal must release its storage");
}

void committed_transaction_and_external_upload_update_observable_validity()
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
    gpu.fields.accepted_observables_valid = false;
    ctx.state.step_count = 7;

    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());
    transaction.commit();
    check(gpu.fields.accepted_observables_valid,
          "committed GPU RK transaction must validate accepted-endpoint observables");
    check(gpu.fields.accepted_observables_step == 7u,
          "committed GPU RK transaction must record the accepted step");

    const double replacement_m[3] = {0.0, 1.0, 0.0};
    check(
        fullmag::fem::gpu_state_upload_magnetization_aos(
            gpu,
            replacement_m,
            3,
            ctx.transfer_audit.audit,
            error),
        error.c_str());
    check(!gpu.fields.accepted_observables_valid,
          "external magnetization upload must invalidate derived observables");
    fullmag::fem::gpu_state_destroy(gpu);
}

void profiled_device_transaction_reports_exact_payload_and_events()
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
    fullmag::fem::set_gpu_step_profile(ctx, true);
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
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;

    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_bytes == 48u,
        "profiled GPU RK capture must report only m and k0 payload bytes");
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_event_pairs_created == 1u,
        "profiled GPU RK capture must allocate one timing event pair");
    check(transaction.rollback(error), error.c_str());
    check(
        fullmag::fem::gpu_rk_collect_step_transaction_timing(ctx, error),
        error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.restore_bytes == 48u,
        "profiled GPU RK restore must report only m and k0 payload bytes");
    check(
        ctx.gpu_state.rk_transaction_telemetry.restore_event_pairs_created == 1u,
        "profiled GPU RK restore must allocate one timing event pair");

    // An energy-rejection retry belongs to the same public step, so its
    // transaction payload is aggregated before publication.
    fullmag::fem::RkStepTransaction retry_transaction(ctx);
    check(retry_transaction.begin(error), error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_bytes == 96u,
        "an RK retry must aggregate capture bytes within the public step");
    check(retry_transaction.rollback(error), error.c_str());
    check(
        fullmag::fem::gpu_rk_collect_step_transaction_timing(ctx, error),
        error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.restore_bytes == 96u,
        "an RK retry must aggregate restore bytes within the public step");

    // A subsequent public step clears the CPU transaction counters first;
    // that boundary resets the GPU sample while reusing the CUDA event pair.
    ctx.stepper.transaction_telemetry = {};
    ctx.state.step_count = 1u;
    fullmag::fem::RkStepTransaction transaction2(ctx);
    check(transaction2.begin(error), error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_bytes == 48u,
        "a new GPU RK step must reset capture bytes before recording the next snapshot");
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_event_pairs_created == 1u,
        "a new GPU RK step must reuse the existing capture timing event pair");
    check(transaction2.rollback(error), error.c_str());
    check(
        fullmag::fem::gpu_rk_collect_step_transaction_timing(ctx, error),
        error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.restore_bytes == 48u,
        "a new GPU RK step must reset restore bytes before recording rollback");
    fullmag::fem::gpu_state_destroy(gpu);
}

void profiler_off_does_not_allocate_transaction_events()
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
    fullmag::fem::set_gpu_step_profile(ctx, false);
    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());
    check(transaction.rollback(error), error.c_str());
    check(
        ctx.gpu_state.rk_transaction_telemetry.capture_event_pairs_created == 0u &&
            ctx.gpu_state.rk_transaction_telemetry.restore_event_pairs_created == 0u,
        "profiler-off GPU RK transaction must not allocate CUDA timing events");
    fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
}

} // namespace

int main()
{
    active_invalid_vectors_fail_without_repair();
    inactive_airbox_vector_is_ignored();
    valid_active_vector_is_normalized();
    minimal_rk_transaction_restores_only_authoritative_gpu_state();
    rk_workspace_allocates_only_minimal_transaction_journal();
    committed_transaction_and_external_upload_update_observable_validity();
    profiled_device_transaction_reports_exact_payload_and_events();
    profiler_off_does_not_allocate_transaction_events();
    std::printf("FEM CUDA RK guard contract PASS\n");
    return 0;
}
